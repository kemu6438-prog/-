// 建物を、車（カメラ）の周りだけ読み込んで表示する。
import { TilesRenderer } from "3d-tiles-renderer";
import { PriorityQueue } from "3d-tiles-renderer/core";
import { GLTFExtensionsPlugin, LoadRegionPlugin, SphereRegion } from "3d-tiles-renderer/plugins";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import * as THREE from "three/webgpu";
import type { LocalFrame } from "../core/geo";
import { depthPrepassMaterial, ensureFloatAttribute, facadeMaterial, farFacadeMaterial, findIdAttribute, plainMaterial } from "./facade";
import { addSkirt } from "./skirt";
import { buildRoofExtras, type ExtrasGeom } from "./roofExtras";
import type { Warmup } from "../render/warmup";
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
  private readonly parseQueue = (() => { const q = new PriorityQueue(); q.maxJobs = 2; return q; })();
  private loadedTiles = 0;
  /** 建物タイルの受け取り処理にかかった時間（ms）の、前回取り出してからの合計 */
  private loadMs = 0;
  takeLoadMs(): number { const v = this.loadMs; this.loadMs = 0; return v; }
  /** 初めての描き方の準備を裏でやる（画面を止めない）。準備ができるまで、その建物は見せない */
  private warm: Warmup | null = null;
  setWarmup(w: Warmup) { this.warm = w; }
  private skirtOk = 0;
  private skirtNo = 0;
  radius = 2000;
  /** いま実際に読み込む半径。近くから少しずつ広げる（一気に数百枚を読み込むと、その間ずっと重くなる） */
  private curRadius = 300;
  private lastUpdate = 0;
  /** 遠くの建物は軽い材質にする（距離 m。PC / スマホ）。近づいたら元に戻す（ヒステリシス付き） */
  private readonly farOn = matchMedia("(pointer: coarse)").matches ? 300 : 480;
  private readonly farOff = this.farOn * 0.82;
  private readonly styled = new Set<THREE.Mesh>();
  private styledList: THREE.Mesh[] = [];
  private styledDirty = false;
  private styledCursor = 0;
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
  /** 版 24: 屋根の形（切妻）・屋上の小物を付け足す（?extra=0 で無効。重さの比較用） */
  roofExtrasOn = new URLSearchParams(location.search).get("extra") !== "0";
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
    // 覚えておく量。小さいと、動くたびに捨てては読み直す（無駄な読み込み）。PC は大きめ、スマホは従来どおり
    const mobile = matchMedia("(pointer: coarse)").matches;
    // PC は大きく取る（?cache=メガバイト で変えられる。上限はその 1.6 倍）
    const cacheMB = Number(new URLSearchParams(location.search).get("cache")) || (mobile ? 120 : 600);
    tiles.lruCache.minBytesSize = cacheMB * 1024 ** 2;
    tiles.lruCache.maxBytesSize = cacheMB * 1.6 * 1024 ** 2;
    // 建物の読み込み処理（解析・組み立て）は同時に 2 つまで。5 つが同時に終わると、1 コマに処理が集中して止まる
    tiles.parseQueue = this.parseQueue;
    tiles.setCamera(this.camera);
    this.setResolution(tiles);
    tiles.addEventListener("load-model", ({ scene }) => {
      const tLoad0 = performance.now();
      this.loadedTiles++;
      let tri = 0;
      // 版 24: 切妻屋根・屋上小物（モデルの座標で作って、元の建物と同じ行列・同じ親に置くための作業用）
      const extraJobs: { ex: ExtrasGeom; parent: THREE.Object3D; mtx: THREE.Matrix4 }[] = [];
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
        if (this.facadeOn) {
          mesh.userData.idName = idName; mesh.userData.far = false; this.styled.add(mesh); this.styledDirty = true;
          // 届いた時点で遠いタイルは、最初から軽い材質にする（一瞬だけ重い材質で描くのを避ける）
          if (!g.boundingSphere) g.computeBoundingSphere();
          const bs = g.boundingSphere!;
          const d = this.tmpC.copy(bs.center).applyMatrix4(m).distanceTo(this.camera.position) - bs.radius;
          if (d > this.farOn) { mesh.userData.far = true; mesh.material = farFacadeMaterial(idName); mesh.castShadow = false; }
        }
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
        // 版 24: 屋根の形（切妻）・屋上の小物（塔屋・室外機・アンテナ）を、純粋な計算で作ってあとで置く
        if (this.roofExtrasOn && idName) {
          const ex = buildRoofExtras(g, idName, m.elements);
          if (ex) { extraJobs.push({ ex, parent: mesh.parent ?? scene, mtx: mesh.matrix.clone() }); tri += ex.idx.length / 3; }
        }
      });
      // 版 24: 作った凸凹を、元の建物と同じ置き方（同じ行列・同じ親）でタイルに足す
      if (extraJobs.length > 0) {
        const exMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true });
        exMat.roughness = 0.94;
        exMat.metalness = 0.0;
        for (const j of extraJobs) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(j.ex.pos, 3));
          geo.setAttribute("normal", new THREE.BufferAttribute(j.ex.nrm, 3));
          geo.setAttribute("color", new THREE.BufferAttribute(j.ex.col, 3));
          geo.setIndex(new THREE.BufferAttribute(j.ex.idx, 1));
          const xm = new THREE.Mesh(geo, exMat);
          xm.castShadow = true;
          xm.receiveShadow = false;
          xm.matrixAutoUpdate = false;
          xm.matrix.copy(j.mtx);
          xm.userData.roofExtra = true;
          j.parent.add(xm);
        }
      }
      // 初めて描く組み合わせ（材質 × 形の持ち物）は、準備ができるまで見せない。準備は裏で、1 つずつ
      const w = this.warm;
      if (w && w.enabled && this.lod === 1 && this.facadeOn) {
        scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh || mesh.userData.isPrepass) return;
          const mat = mesh.material as THREE.Material;
          const pre = mesh.children.find((c) => c.userData.isPrepass) as THREE.Mesh | undefined;
          const need: Promise<void>[] = [];
          if (!w.ready(mesh, mat)) need.push(w.request(mesh, mat));
          if (pre && !w.ready(pre, pre.material as THREE.Material)) need.push(w.request(pre, pre.material as THREE.Material));
          if (need.length > 0) {
            mesh.visible = false;
            void Promise.all(need).then(() => { mesh.visible = true; });
          }
          // 反対側（近い ⇄ 遠い）の材質も、裏で準備しておく（切り替えの瞬間に止まらないように）
          const id = (mesh.userData.idName ?? null) as string | null;
          const other = mesh.userData.far === true ? facadeMaterial(id) : farFacadeMaterial(id);
          if (!w.ready(mesh, other)) void w.request(mesh, other);
        });
      }
      this.triOf.set(scene, tri);
      this.triangles += tri;
      // 1 回の処理が長いと、その 1 コマだけ引っかかる。長かったものは記録する（確認用）
      const dtLoad = performance.now() - tLoad0;
      this.loadMs += dtLoad;
      if (dtLoad > 20) this.onMessage(`建物タイル 1 枚の処理が長かった: ${dtLoad.toFixed(0)} ms（三角形 ${(tri / 1000).toFixed(0)} 千）`);
    });
    tiles.addEventListener("dispose-model", ({ scene }) => {
      this.loadedTiles = Math.max(0, this.loadedTiles - 1);
      scene.traverse((o) => { if (this.styled.delete(o as THREE.Mesh)) this.styledDirty = true; });
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
    this.styled.clear();
    this.styledDirty = true;
    this.curRadius = 300;
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
    this.footprints.step(1.2); // 屋根の輪郭の書き込み（1 コマ 1.2 ミリ秒まで）
    // 読み込む半径は、近くから少しずつ広げる（毎秒 70 m）。遠くまで一度に頼むと、数百枚が一気に届いて止まる
    const now = performance.now();
    const dt = Math.min(0.2, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;
    this.curRadius = this.curRadius < this.radius ? Math.min(this.radius, this.curRadius + 70 * dt) : this.radius;
    // 読み込む範囲は、地球中心座標（建物データの座標）で指定する
    const centerEcef = this.tmpEcef.copy(this.camera.position).applyMatrix4(this.frame.localToEcef);
    for (const r of this.renderers) {
      r.region.sphere.set(centerEcef, this.curRadius);
      r.tiles.update();
    }
    this.updateFar();
  }

  private readonly tmpC = new THREE.Vector3();
  /** 遠いタイルは軽い材質・影を落とさない、近いタイルは元の材質。1 コマに 24 枚ずつ、順番に見直す */
  private updateFar() {
    if (this.styledDirty) { this.styledList = [...this.styled]; this.styledDirty = false; }
    const list = this.styledList;
    if (list.length === 0) return;
    const cam = this.camera.position;
    for (let n = 0; n < 24; n++) {
      const mesh = list[this.styledCursor++ % list.length];
      if (!mesh.parent || !this.styled.has(mesh)) continue;
      const g = mesh.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const bs = g.boundingSphere!;
      mesh.updateWorldMatrix(true, false);
      this.tmpC.copy(bs.center).applyMatrix4(mesh.matrixWorld);
      const d = this.tmpC.distanceTo(cam) - bs.radius;
      const far = mesh.userData.far === true;
      const w = this.warm;
      // 切り替え先の準備ができていなければ、頼んでおいて今回は見送る（次の見直しで切り替える）
      if (w && w.enabled) {
        const id = (mesh.userData.idName ?? null) as string | null;
        if ((!far && d > this.farOn) || (far && d < this.farOff)) {
          const next = far ? facadeMaterial(id) : farFacadeMaterial(id);
          if (!w.ready(mesh, next)) { void w.request(mesh, next); continue; }
        }
      }
      if (!far && d > this.farOn) {
        mesh.userData.far = true;
        mesh.material = farFacadeMaterial(mesh.userData.idName ?? null);
        mesh.castShadow = false;
      } else if (far && d < this.farOff) {
        mesh.userData.far = false;
        mesh.material = facadeMaterial(mesh.userData.idName ?? null);
        mesh.castShadow = true;
      }
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
