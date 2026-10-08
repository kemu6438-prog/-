// 建物を、車（カメラ）の周りだけ読み込んで表示する。
import { TilesRenderer } from "3d-tiles-renderer";
import { GLTFExtensionsPlugin, LoadRegionPlugin, SphereRegion } from "3d-tiles-renderer/plugins";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import * as THREE from "three/webgpu";
import type { LocalFrame } from "../core/geo";
import { ensureFloatAttribute, facadeMaterial, findIdAttribute } from "./facade";

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
  radius = 2000;
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
      this.loadedTiles++;
      let tri = 0;
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry;
        tri += (g.index ? g.index.count : (g.getAttribute("position")?.count ?? 0)) / 3;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (this.lod !== 1) return; // LOD2 は元の材質（壁の写真つき）のまま
        if (!g.getAttribute("normal")) g.computeVertexNormals();
        const idName = findIdAttribute(g);
        if (idName) ensureFloatAttribute(g, idName);
        mesh.material = facadeMaterial(idName);
      });
      this.triOf.set(scene, tri);
      this.triangles += tri;
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
    // 読み込む範囲は、地球中心座標（建物データの座標）で指定する
    const centerEcef = this.camera.position.clone().applyMatrix4(this.frame.localToEcef);
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
