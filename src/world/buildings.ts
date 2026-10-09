// 建物を、車（カメラ）の周りだけ読み込んで表示する。
import { TilesRenderer } from "3d-tiles-renderer";
import { GLTFExtensionsPlugin, LoadRegionPlugin, SphereRegion } from "3d-tiles-renderer/plugins";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import * as THREE from "three/webgpu";
import type { LocalFrame } from "../core/geo";
import { depthPrepassMaterial, ensureFloatAttribute, facadeMaterial, findIdAttribute, plainMaterial } from "./facade";
import { addSkirt } from "./skirt";
import { Footprints } from "./footprints";
import { WALL_ATTR, addWallTangents, ensureWallAttribute } from "./walls";

let draco: DRACOLoader | null = null;
function sharedDraco() {
  draco ??= new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`).setWorkerLimit(2);
  return draco;
}

export type BuildingStats = {
  downloading: number;
  parsing: number;
  queued: number;
  failed: number;
  visible: number;
  loadedTiles: number;
  cacheMB: number;
  progress: number;
  triangles: number;
};

export class Buildings {
  readonly group = new THREE.Group();
  private readonly renderers: { tiles: TilesRenderer; region: SphereRegion }[] = [];
  private loadedTiles = 0;
  /** 建物タイルの受け取り処理にかかった時間（ms）の、前回取り出してからの合計 */
  private loadMs = 0;
  takeLoadMs(): number { const v = this.loadMs; this.loadMs = 0; return v; }
  private skirtOk = 0;
  private skirtNo = 0;
  radius = 2000;
  /** 奥行きだけの先描きを使うか（?prepass=0 で無効） */
  /** 建物の足あと（街路樹などを建物から避けるのに使う） */
  readonly footprints = new Footprints();
  wallDup = 0; wallTris = 0; roofTris = 0;
  /** 建物の壁が影を受けるか（重いので既定は受けない。?wallshadow=1 で受ける）。地面・道路・木には、建物の影は落ちる */
  wallShadow = new URLSearchParams(location.search).get("wallshadow") === "1";
  private readonly tmpEcef = new THREE.Vector3();
  prepass = new URLSearchParams(location.search).get("prepass") !== "0";
  /** ?facade=0 で壁の凝った塗りをやめて単色にする（重さの原因が壁の塗りかどうかを調べる比較用） */
  facadeOn = new URLSearchParams(location.search).get("facade") !== "0";
  /** 1: 箱形(LOD1)に窓や色を塗る / 2: 詳細モデル(LOD2)をそのまま表示（重い） */
  lod: 1 | 2 = 1;
  /** 読み込み済みタイルの三角形の数（重さの目安） */
  private triangles = 0;
  private readonly triOf = new WeakMap<object, number>();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly renderer: THREE.WebGPURenderer,
    private frame: LocalFrame,
    private readonly onMessage: (m: string) => void,
    errorTarget: number,
  ) {
    this.errorTarget = errorTarget;
  }
  private errorTarget: number;

  setErrorTarget(v: number) {
    this.errorTarget = v;
    for (const r of this.renderers) r.tiles.errorTarget = v;
  }

  /** 建物データ（tileset.json の場所）を追加する */
  add(url: string, label: string) {
    const tiles = new TilesRenderer(url);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ rtc: true, dracoLoader: sharedDraco() }));
    const region = new SphereRegion({ mask: true, errorTarget: 1e9 });
    const regions = new LoadRegionPlugin();
    regions.addRegion(region);
    tiles.registerPlugin(regions);
    tiles.errorTarget = this.errorTarget;
    tiles.lruCache.minBytesSize = 120 * 1024 ** 2;
    tiles.lruCache.maxBytesSize = 200 * 1024 ** 2;
    tiles.setCamera(this.camera);
    this.setResolution(tiles);
    tiles.addEventListener("load-model", ({ scene }) => {
      const tLoad0 = performance.now();
      this.loadedTiles++;
      let tri = 0;
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || mesh.userData.isPrepass) return;
        const g = mesh.geometry;
        tri += (g.index ? g.index.count : (g.getAttribute("position")?.count ?? 0)) / 3;
        mesh.castShadow = true;
        mesh.receiveShadow = this.wallShadow;
        if (this.lod !== 1) return; // LOD2 は元の材質（壁の写真つき）のまま
        if (!g.getAttribute("normal")) g.computeVertexNormals();
        const idName = findIdAttribute(g);
        if (idName) ensureFloatAttribute(g, idName);
        // この建物の座標 → 表示の座標（y が上）の行列。タイルの読み込み直後は、持ち主（scene）より上の行列がまだ掛かっていないので手で掛ける
        const m = mesh.matrix.clone();
        mesh.updateMatrix();
        m.copy(mesh.matrix);
        for (let p = mesh.parent; p && p !== scene; p = p.parent) { p.updateMatrix(); m.premultiply(p.matrix); }
        m.premultiply(scene.matrix).premultiply(this.frame.ecefToLocal);
        const ok = idName ? addSkirt(g, idName, m.elements) : false;
        // 壁の向きを頂点に書き込む（窓の縁のざらつき対策）＋ 屋根の輪郭を覚える（街路樹を建物から避けるため）
        if (!g.getAttribute(WALL_ATTR)) {
          const st = addWallTangents(g, m.elements, this.footprints);
          if (!st) ensureWallAttribute(g);
          else { this.wallDup += st.duplicated; this.wallTris += st.walls; this.roofTris += st.roofs; }
        }
        if (ok) this.skirtOk++; else this.skirtNo++;
        if ((this.skirtOk + this.skirtNo) % 40 === 1) this.onMessage(`建物の足もと補強（浮き対策）: 済み ${this.skirtOk} / 対象外 ${this.skirtNo} / 壁 ${this.wallTris} 面・屋根 ${this.roofTris} 面・頂点の複製 ${this.wallDup}`);
        mesh.material = this.facadeOn ? facadeMaterial(idName) : plainMaterial();
        // 奥行きだけを先に描く（?prepass=0 で無効にして比べられる）
        if (this.prepass && !mesh.userData.hasPrepass) {
          const pre = new THREE.Mesh(g, depthPrepassMaterial());
          pre.renderOrder = -100;
          pre.userData.isPrepass = true;
          pre.castShadow = false;
          pre.receiveShadow = false;
          pre.matrixAutoUpdate = false;
          mesh.add(pre);
          mesh.userData.hasPrepass = true;
        }
      });
      this.triOf.set(scene, tri);
      this.triangles += tri;
      // 1 回の処理が長いと、その 1 コマだけ引っかかる。長かったものは記録する（確認用）
      const dtLoad = performance.now() - tLoad0;
      this.loadMs += dtLoad;
      if (dtLoad > 20) this.onMessage(`建物タイル 1 枚の処理が長かった: ${dtLoad.toFixed(0)} ms（三角形 ${(tri / 1000).toFixed(0)} 千）`);
    });
    tiles.addEventListener("dispose-model", ({ scene }) => {
      this.loadedTiles = Math.max(0, this.loadedTiles - 1);
      this.triangles -= this.triOf.get(scene) ?? 0;
    });
    tiles.addEventListener("load-error", ({ error, url }) => {
      this.onMessage(`読み込み失敗: ${error?.message ?? error} (${String(url).slice(-60)})`);
    });
    tiles.addEventListener("load-tileset", () => this.onMessage(`建物データの目次を読めた: ${label}`));
    this.applyFrame(tiles);
    this.group.add(tiles.group);
    this.renderers.push({ tiles, region });
  }

  /** 場所を変える（原点を付け替える） */
  setFrame(frame: LocalFrame) {
    this.frame = frame;
    for (const r of this.renderers) this.applyFrame(r.tiles);
  }

  clear() {
    for (const r of this.renderers) {
      this.group.remove(r.tiles.group);
      r.tiles.dispose();
    }
    this.renderers.length = 0;
    this.footprints.clear();
    this.loadedTiles = 0;
    this.triangles = 0;
  }

  private applyFrame(tiles: TilesRenderer) {
    tiles.group.matrixAutoUpdate = false;
    tiles.group.matrix.copy(this.frame.ecefToLocal);
    tiles.group.updateMatrixWorld(true);
  }

  private setResolution(tiles: TilesRenderer) {
    const size = this.renderer.getSize(new THREE.Vector2());
    tiles.setResolution(this.camera, size.x, size.y);
  }

  onResize() {
    for (const r of this.renderers) this.setResolution(r.tiles);
  }

  update() {
    this.camera.updateMatrixWorld();
    this.footprints.step(2); // 屋根の輪郭の書き込み（1 コマ 2 ミリ秒まで）
    // 読み込む範囲は、地球中心座標（建物データの座標）で指定する
    const centerEcef = this.tmpEcef.copy(this.camera.position).applyMatrix4(this.frame.localToEcef);
    for (const r of this.renderers) {
      r.region.sphere.set(centerEcef, this.radius);
      r.tiles.update();
    }
  }

  stats(): BuildingStats {
    const s = { downloading: 0, parsing: 0, queued: 0, failed: 0, visible: 0, bytes: 0, progress: 1 };
    for (const r of this.renderers) {
      // 型定義に無いが、実行時には存在する（3d-tiles-renderer 0.5.3 で確認）
      const st = (r.tiles as unknown as { stats: Record<string, number> }).stats;
      s.downloading += st.downloading;
      s.parsing += st.parsing;
      s.queued += st.queued;
      s.failed += st.failed;
      s.visible += st.visible;
      s.progress = Math.min(s.progress, r.tiles.loadProgress);
    }
    // メモリの枠は全部の建物データで共有されている（1 つだけ数える。足し算すると何倍にもなる）
    const first = this.renderers[0]?.tiles.lruCache as unknown as { cachedBytes: number } | undefined;
    s.bytes = first?.cachedBytes ?? 0;
    return {
      downloading: s.downloading,
      parsing: s.parsing,
      queued: s.queued,
      failed: s.failed,
      visible: s.visible,
      loadedTiles: this.loadedTiles,
      cacheMB: s.bytes / 1024 ** 2,
      progress: s.progress,
      triangles: this.triangles,
    };
  }
}
