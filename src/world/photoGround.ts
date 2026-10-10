// 国土地理院の「シームレス写真」（航空写真）を地面に貼る。
// 近く・中くらい・遠くの 3 つの範囲を、別々の細かさで読み込み、全部読めた範囲から写真に切り替わる。
// 読めない（通信できない等）ときは、今までどおりの簡易な地面のまま動く（止まらない）。
// 画面に出すまでに何度も絵を送り直すと引っかかりの原因になるため、
// タイルは裏で集めてから 1 回だけ切り替える（切り替わるまでは簡易な地面）。
import * as THREE from "three/webgpu";
import { positionWorld, texture, uniform, vec2 } from "three/tsl";
import type { N } from "../render/noise";
import type { LocalFrame } from "../core/geo";
import { makeGroundMaterial, type GroundPhoto } from "../render/groundMaterials";
import { photoUrl, planTileRange, tileToLat, tileToLon } from "./geoTiles";

/** 写真の範囲の設定。cover はカメラから四方これだけ余分に覆うメートル、reanchor はこれだけ動いたら読み直すメートル */
const REGIONS = [
  { name: "near", label: "近く", zoom: 17, cover: 520, reanchor: 150 },
  { name: "mid", label: "中くらい", zoom: 16, cover: 2300, reanchor: 250 },
  { name: "far", label: "遠く", zoom: 12, cover: 14500, reanchor: 2000 },
] as const;

const TILE_PX = 256;
/** 通信の同時本数（多いとサーバにも画面にも悪い） */
const CONCURRENCY = 3;
/** 写真が読めなかったときの、タイルの穴を埋める色（簡易な地面に近い色） */
const FILL = "rgb(205,203,198)";

type TileTask = {
  gen: number;
  tiles: { x: number; y: number }[];
  next: number;
  flying: number;
  ok: number;
  fail: number;
  /** 出来上がりの写真の範囲（画面用座標のメートル） */
  rect: { x0: number; z0: number; x1: number; z1: number };
};

class PhotoRegion {
  readonly material: THREE.MeshStandardNodeMaterial;
  frame: LocalFrame;
  private readonly canvas = document.createElement("canvas");
  private readonly on = uniform(0);
  private readonly ox = uniform(0);
  private readonly oz = uniform(0);
  private readonly sx = uniform(1);
  private readonly sz = uniform(1);
  private readonly photoNode: { value: unknown };
  private tex: THREE.DataTexture | null = null;
  private anchor: { x: number; z: number } | null = null;
  private task: TileTask | null = null;
  private disabled = false;
  private gen = 0;

  constructor(private readonly def: (typeof REGIONS)[number], frame: LocalFrame, private readonly log: (m: string) => void) {
    this.frame = frame;
    // 写真の受け口。最初は 1×1 の空っぽの絵（on=0 なので見えない）
    const placeholder = new THREE.DataTexture(new Uint8Array([205, 203, 198, 255]), 1, 1, THREE.RGBAFormat);
    placeholder.needsUpdate = true;
    const uv: N = vec2(positionWorld.x.sub(this.ox).div(this.sx), positionWorld.z.sub(this.oz).div(this.sz));
    const node = texture(placeholder, uv);
    this.photoNode = node as unknown as { value: unknown };
    const photo: GroundPhoto = { on: this.on as unknown as N, colorNode: (node as unknown as N).rgb as N };
    this.material = makeGroundMaterial(photo);
  }

  /** 毎コマ。カメラが anchor から reanchor 以上離れたら、その周りで読み直す */
  update(pos: THREE.Vector3) {
    if (this.disabled) return;
    const a = this.anchor;
    if (!a || Math.hypot(pos.x - a.x, pos.z - a.z) > this.def.reanchor) this.plan(pos);
  }

  /** 場所・地面の高さが変わったとき（原点が変わるので読み直す） */
  setFrame(frame: LocalFrame) {
    this.frame = frame;
    this.anchor = null;
    this.gen++; // 前のタイルの結果は捨てる
  }

  /** 読むタイルを決めて、取得を始める */
  private plan(pos: THREE.Vector3) {
    const gen = ++this.gen;
    this.anchor = { x: pos.x, z: pos.z };
    const g = this.frame.toGeodetic(new THREE.Vector3(pos.x, 0, pos.z));
    const r = planTileRange(g.lat, g.lon, this.def.zoom, this.def.cover);
    // 余計な大きさになりすぎないよう上限をかける（極端にズレてもたくさん読まない）
    const MAX = 100;
    const tiles: { x: number; y: number }[] = [];
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    for (let x = r.x0; x <= r.x1; x++)
      for (let y = r.y0; y <= r.y1; y++) tiles.push({ x, y });
    tiles.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    if (tiles.length > MAX) tiles.length = MAX;

    // 絵の配置: 全体の範囲（画面用座標）を決め、タイルごとに「そのタイルの場所」に描く（ずれない）
    const nw = this.frame.toLocal(tileToLat(r.y0, this.def.zoom), tileToLon(r.x0, this.def.zoom), 0);
    const se = this.frame.toLocal(tileToLat(r.y1 + 1, this.def.zoom), tileToLon(r.x1 + 1, this.def.zoom), 0);
    const rect = { x0: Math.min(nw.x, se.x), z0: Math.min(nw.z, se.z), x1: Math.max(nw.x, se.x), z1: Math.max(nw.z, se.z) };
    this.canvas.width = (r.x1 - r.x0 + 1) * TILE_PX;
    this.canvas.height = (r.y1 - r.y0 + 1) * TILE_PX;
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) { this.disabled = true; return; }
    ctx.fillStyle = FILL;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.task = { gen, tiles, next: 0, flying: 0, ok: 0, fail: 0, rect };
    this.log(`地面の写真（${this.def.label}）: 読み込み中（${tiles.length} 枚）`);
    this.pump(ctx, r.x0, r.y0, rect);
  }

  /** 同時本数を守りつつタイルを取っていく */
  private pump(ctx: CanvasRenderingContext2D, tx0: number, ty0: number, rect: TileTask["rect"]) {
    const task = this.task;
    if (!task) return;
    while (task.flying < CONCURRENCY && task.next < task.tiles.length) {
      const t = task.tiles[task.next++];
      task.flying++;
      void fetch(photoUrl(this.def.zoom, t.x, t.y))
        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
        .then((blob) => createImageBitmap(blob))
        .then((img) => {
          if (task.gen === this.gen) {
            // タイルの世界での位置（画面用座標）から、canvas のどこに描くかを毎タイル正確に求める
            const nw = this.frame.toLocal(tileToLat(t.y, this.def.zoom), tileToLon(t.x, this.def.zoom), 0);
            const se = this.frame.toLocal(tileToLat(t.y + 1, this.def.zoom), tileToLon(t.x + 1, this.def.zoom), 0);
            const wx0 = Math.min(nw.x, se.x), wx1 = Math.max(nw.x, se.x);
            const wz0 = Math.min(nw.z, se.z), wz1 = Math.max(nw.z, se.z);
            const kx = this.canvas.width / (rect.x1 - rect.x0);
            const kz = this.canvas.height / (rect.z1 - rect.z0);
            ctx.drawImage(img, (wx0 - rect.x0) * kx, (wz0 - rect.z0) * kz, (wx1 - wx0) * kx, (wz1 - wz0) * kz);
            task.ok++;
          }
          img.close();
        })
        .catch(() => { task.fail++; })
        .finally(() => {
          task.flying--;
          if (task.gen !== this.gen) return;
          if (task.next < task.tiles.length) this.pump(ctx, tx0, ty0, rect);
          else if (task.flying === 0) this.finish(task);
        });
    }
  }

  /** 全部そろった（8 割読めれば OK）→ 裏で 1 枚の絵にして、見た目を写真に切り替える */
  private finish(task: TileTask) {
    const need = Math.max(1, Math.ceil(task.tiles.length * 0.8));
    if (task.ok < need) {
      this.log(`地面の写真（${this.def.label}）: 読めなかった（成功 ${task.ok} / 失敗 ${task.fail}）→ 簡易な地面のまま`);
      this.disabled = true;
      return;
    }
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) { this.disabled = true; return; }
    const d = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    const tex = new THREE.DataTexture(new Uint8Array(d.buffer.slice(0)), this.canvas.width, this.canvas.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    tex.flipY = false;
    tex.needsUpdate = true;
    const prev = this.tex;
    this.tex = tex;
    this.photoNode.value = tex;
    this.ox.value = task.rect.x0;
    this.oz.value = task.rect.z0;
    this.sx.value = task.rect.x1 - task.rect.x0;
    this.sz.value = task.rect.z1 - task.rect.z0;
    this.on.value = 1;
    prev?.dispose();
    this.log(`地面の写真（${this.def.label}）: 切り替わりました（${task.ok} 枚${task.fail ? `・一部失敗 ${task.fail}` : ""}）`);
  }
}

/** 地面 3 枚（近く・中くらい・遠く）の写真をまとめて管理する */
export class PhotoGround {
  readonly materials: { near: THREE.MeshStandardNodeMaterial; mid: THREE.MeshStandardNodeMaterial; far: THREE.MeshStandardNodeMaterial };
  private readonly regions: PhotoRegion[] | null = null;

  constructor(frame: LocalFrame, log: (m: string) => void, opts: { enabled: boolean; isMobile: boolean }) {
    // スマホは最適化が後回し（メモリが増えるので、いったん簡易な地面のまま）。?photo=0 でも切れる
    const on = opts.enabled && !opts.isMobile;
    if (on) {
      this.regions = REGIONS.map((def) => new PhotoRegion(def, frame, log));
      this.materials = { near: this.regions[0].material, mid: this.regions[1].material, far: this.regions[2].material };
      log("地面の写真: 国土地理院シームレス写真を読み込みます（全部そろった範囲から切り替わります）。?photo=0 で無効");
    } else {
      this.materials = { near: makeGroundMaterial(), mid: makeGroundMaterial(), far: makeGroundMaterial() };
    }
  }

  setFrame(frame: LocalFrame) { for (const r of this.regions ?? []) r.setFrame(frame); }
  update(pos: THREE.Vector3) { for (const r of this.regions ?? []) r.update(pos); }
}
