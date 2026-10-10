// 道路・歩道・街路樹・街灯などを、国土地理院の道路データから作って画面に置く。
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  attribute, clamp, dFdx, dFdy, float, floor, fract, length, max, min, mix, positionView, positionWorld,
  smoothstep, step, vec2, vec3, vertexColor,
} from "three/tsl";
import type { LocalFrame } from "../core/geo";
import { hash21, vnoise, type N } from "../render/noise";
import { TEX } from "../render/assets";
import {
  ZOOM, analyzeNodes, fetchRoadTile, latToTileY, lonToTileX, parseRoadLayer, tileXToLon, tileYToLat, type RoadLayerLike, type RoadLine, type RoadNode,
} from "./roadData";
import { buildRibbon, roadExtra, sidewalkExtra, type Ribbon } from "./roadGeometry";
import { placeFurniture, type Furniture, type TreeInst } from "./roadFurniture";
import type { Footprints } from "./footprints";
import type { Warmup } from "../render/warmup";
import { bushCardGeometry, cardMaterial, treeCardGeometry } from "../render/plants";

// ---------------------------------------------------------------------------
// 見た目（シェーダー）
// ---------------------------------------------------------------------------
const abs = (x: N): N => x.abs();

/** 幅 w の線（中心 0）を、画素の大きさ aa で縁をなめらかにした時の濃さ（0〜1） */
const cover = (d: N, w: number | N, aa: N): N => {
  const half: N = float(w as N).mul(0.5);
  const ad: N = abs(d);
  return clamp(min(ad.add(aa.mul(0.5)), half).sub(max(ad.sub(aa.mul(0.5)), half.negate())), 0.0, 1e3)
    .div(aa)
    .min(1.0);
};

/** 線に沿って繰り返す破線（period m ごとに duty の割合だけ塗る）。細かすぎる時は平均に近づける */
const dash = (v: N, period: number, duty: number, aaV: N): N => {
  const t: N = fract(v.div(period));
  const a: N = aaV.div(period);
  const ac: N = a.min(0.5);
  const raw: N = clamp(t.div(ac), 0.0, 1.0).mul(clamp(float(duty).sub(t).div(ac), 0.0, 1.0));
  return mix(raw, float(duty), smoothstep(0.25, 0.6, a));
};

const box1 = (x: N, a: number, b: number, aa: N): N =>
  cover(x.sub((a + b) * 0.5), b - a, aa);

function roadMaterial(level: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  const rp: N = attribute("rpos", "vec2");
  const rd: N = attribute("rd", "vec4");
  const u: N = rp.x;
  const v: N = rp.y;
  const hr: N = rd.x;
  const rank: N = rd.y;
  const dS: N = rd.z;
  const dE: N = rd.w;
  const dist: N = length(positionView as N);
  const pw: N = vec2(positionWorld.x, positionWorld.z);
  const near: N = float(1.0).sub(smoothstep(15.0, 140.0, dist));

  // --- アスファルト: 暗い灰色に、細かい砂粒・タイヤの通り道・つぎはぎ ---
  const n2: N = vnoise(pw.mul(0.35));
  const g1: N = vnoise(pw.mul(22.0));
  const lane: N = abs(fract(abs(u).div(3.5)).sub(0.5)); // 車線の中央で 0.5 付近
  // 交差点の中（ほかの道と重なる所）では、路肩の汚れ・タイヤの跡を出さない。出すと、横切る道の上に暗い帯・明るい帯が見えて、継ぎ目が目立つ
  const jk: N = smoothstep(-0.3, 1.5, dS).mul(smoothstep(-0.3, 1.5, dE));
  const wheel: N = smoothstep(0.1, 0.0, abs(lane.sub(0.36))).mul(0.5).add(0.0).mul(step(1.5, rank)).mul(jk); // 車輪の通る所は少し明るく磨かれる
  const gw: N = float(1.0).sub(TEX.asphalt.on.mul(0.75)); // 素材が読めたら自作の粒を弱める
  const base: N = mix(vec3(0.17, 0.17, 0.18), vec3(0.3, 0.295, 0.29), n2)
    .mul(float(0.9).add(g1.mul(0.3).mul(near).mul(gw)))
    .mul(float(1.0).add(wheel.mul(0.1)))
    .mul(TEX.asphalt.detail(pw)); // ネットの素材（読み込めたら）の本物のアスファルトの粒（1 枚だけ読む＝軽い）
  // 路肩（縁）は少し汚れて暗い
  const gutter: N = smoothstep(hr.sub(0.7), hr.sub(0.05), abs(u)).mul(jk);
  const asphalt: N = mix(base, base.mul(vec3(0.78, 0.76, 0.72)), gutter);

  // --- 白線 ---
  const aaU: N = max(abs(dFdx(u)).add(abs(dFdy(u))), 0.003);
  const aaV: N = max(abs(dFdx(v)).add(abs(dFdy(v))), 0.003);
  const aaS: N = max(abs(dFdx(dS)).add(abs(dFdy(dS))), 0.003).min(abs(dFdx(dE)).add(abs(dFdy(dE))).max(0.003)).max(0.003);
  const hasLines: N = step(1.5, rank);
  const hasCentre: N = step(0.5, rank); // 脇道（幅員区分 1）にも中央の破線、区分 0 には外側線だけ
  const big: N = step(2.5, rank);
  // 外側線
  const edgeL: N = cover(abs(u).sub(hr.sub(0.4)), 0.15, aaU);
  // 中央線: 中くらいの道は白の破線、広い道は白の二重線
  const dashed: N = cover(u, 0.15, aaU).mul(dash(v, 10.0, 0.5, aaV));
  const dbl: N = cover(abs(u).sub(0.17), 0.14, aaU);
  const centre: N = mix(dashed, dbl, big).mul(hasCentre);
  // 車線の境目（破線）
  const nl: N = floor(hr.div(3.5));
  const kk: N = (abs(u).div(3.5) as N).add(0.5).floor();
  const lanes: N = cover(abs(u).sub(kk.mul(3.5)), 0.15, aaU)
    .mul(dash(v, 8.0, 0.375, aaV))
    .mul(step(1.0, kk))
    .mul(step(kk.add(0.5), nl))
    .mul(big);
  // 交差点の手前では線を切る（停止線・横断歩道のため）
  const keep: N = smoothstep(4.3, 4.8, dS).mul(smoothstep(4.3, 4.8, dE));
  const lines: N = max(max(edgeL, centre), lanes).mul(keep);
  // 停止線（車は左側通行。交差点に向かう車線 = 進行方向の左 = u<0 側が終点向き）
  const inRoad: N = step(abs(u), hr.sub(0.2));
  // 横断歩道（縞）
  const zebra: N = cover(fract(u.div(0.9)).sub(0.5), 0.5 / 0.9, aaU.div(0.9));
  const crossE: N = box1(dE, 1.3, 4.2, aaS).mul(zebra).mul(inRoad).mul(hasLines);
  const crossS: N = box1(dS, 1.3, 4.2, aaS).mul(zebra).mul(inRoad).mul(hasLines);
  const paint: N = max(lines, max(crossE, crossS));
  const worn: N = float(0.72).add(vnoise(pw.mul(2.3)).mul(0.28));
  const farFade: N = float(1.0).sub(smoothstep(380.0, 800.0, dist));
  const mark: N = paint.mul(worn).mul(farFade);
  const white: N = vec3(0.8, 0.8, 0.76);
  m.colorNode = mix(asphalt, white, mark);
  m.roughnessNode = mix(float(0.92), float(0.6), mark);
  // 道路の面どうしは奥行きで勝ち負けを決めず、描く順番（歩道 → 細い道 → 太い道）で重ねる。奥行きの精度に左右されず、白線がちらつかない
  m.depthWrite = false;

  m.polygonOffset = true;
  m.polygonOffsetFactor = -(2 + level);
  m.polygonOffsetUnits = -(2 + level);
  return m;
}

function sidewalkMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
  m.depthWrite = false; // 描く順番で重ねる（roadMaterial と同じ）
  const rp: N = attribute("rpos", "vec2");
  const rd: N = attribute("rd", "vec4");
  const u: N = abs(rp.x);
  const v: N = rp.y;
  const hr: N = rd.x;
  const rank: N = rd.y;
  const dist: N = length(positionView as N);
  const pw: N = vec2(positionWorld.x, positionWorld.z);
  const near: N = float(1.0).sub(smoothstep(12.0, 90.0, dist));
  // 舗装ブロック（30cm 角）。ブロックごとに少し色が違い、目地が入る
  const cell: N = vec2(u.div(0.3), v.div(0.3));
  const id: N = vec2(floor(cell.x), floor(cell.y));
  const tone: N = hash21(id.add(vec2(floor(v.div(40.0)), 0.0)));
  const f: N = fract(cell);
  const joint: N = max(smoothstep(0.06, 0.0, f.x.min(f.y)), smoothstep(0.94, 1.0, f.x.max(f.y))).mul(near);
  const base: N = mix(vec3(0.5, 0.49, 0.47), vec3(0.62, 0.61, 0.58), vnoise(pw.mul(0.5)).mul(0.5).add(tone.mul(0.5)));
  let col: N = base.mul(float(0.93).add(tone.mul(0.1).mul(near))).mul(float(1.0).sub(joint.mul(0.25)));
  col = col.mul(float(0.92).add(vnoise(pw.mul(30.0)).mul(0.14).mul(near)));
  col = col.mul(TEX.pavers.detail(pw));
  // 縁石（車道との境の石）
  const kerb: N = smoothstep(hr.add(0.28), hr.add(0.18), u);
  col = mix(col, vec3(0.7, 0.69, 0.66), kerb);
  // 視覚障害者用の誘導ブロック（黄色）。広い道の歩道の建物側に 1 本
  const sw: N = mix(float(2.0), mix(float(3.2), float(4.0), step(3.5, rank)), step(2.5, rank));
  const guide: N = box1(u.sub(hr.add(sw).sub(0.55)), -0.15, 0.15, max(abs(dFdx(u)).add(abs(dFdy(u))), 0.003))
    .mul(step(2.5, rank));
  const bump: N = step(0.5, fract(v.div(0.3)).sub(0.5).abs().mul(2.0).add(fract(u.div(0.3)).sub(0.5).abs().mul(2.0)).mul(0.5));
  col = mix(col, vec3(0.78, 0.62, 0.12).mul(float(0.9).add(bump.mul(0.12))), guide.mul(0.95));
  m.colorNode = col;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -1;
  return m;
}

// ---------------------------------------------------------------------------
// 道ばたの物の形
// ---------------------------------------------------------------------------
function paint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, f?: (y: number) => number) {
  const c = new THREE.Color(color);
  const pos = g.getAttribute("position");
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = f ? f(pos.getY(i)) : 1;
    arr[i * 3] = c.r * k;
    arr[i * 3 + 1] = c.g * k;
    arr[i * 3 + 2] = c.b * k;
  }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

const bare = (g: THREE.BufferGeometry) => {
  g.deleteAttribute("uv");
  return g.index ? g.toNonIndexed() : g;
};

/** 生け垣: 長さ 1 の箱（置くときに長さを掛ける）。上の角を少し丸めて見せる */
function hedgeGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 0.95, 0.75, 1, 2, 1);
  g.translate(0, 0.475, 0);
  g.deleteAttribute("uv");
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0.9) pos.setZ(i, pos.getZ(i) * 0.82);
  }
  g.computeVertexNormals();
  return paint(bare(g), 0x44842b, (y) => 0.7 + 0.4 * THREE.MathUtils.smoothstep(y, 0.0, 0.95));
}

/** 道路標識（丸い規制標識）: 柱・赤い縁・白地・黒い横棒。前面は +z */
function signGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const pole = new THREE.CylinderGeometry(0.035, 0.04, 2.7, 6);
  pole.translate(0, 1.35, 0);
  parts.push(paint(bare(pole), 0x8a8d90));
  const disc = (rad: number, thick: number, z: number, color: number) => {
    const d = new THREE.CylinderGeometry(rad, rad, thick, 16);
    d.rotateX(Math.PI / 2);
    d.translate(0, 2.4, z);
    parts.push(paint(bare(d), color));
  };
  disc(0.31, 0.03, 0.0, 0xc8202a);
  disc(0.31, 0.03, -0.001, 0xc8202a);
  disc(0.235, 0.034, 0.002, 0xf4f4f0);
  const bar = new THREE.BoxGeometry(0.32, 0.07, 0.04);
  bar.translate(0, 2.4, 0.004);
  parts.push(paint(bare(bar), 0x1c1c22));
  return mergeGeometries(parts.map((g) => (g.deleteAttribute("uv"), g)))!;
}

/** 自動販売機: 白い本体に、暗い窓と色つきの商品の列。前面は +z */
function vendGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const b = (w: number, h: number, d: number, x: number, y: number, z: number, color: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(paint(bare(g), color));
  };
  b(0.78, 1.75, 0.72, 0, 0.875, 0, 0xe4e8ec);
  b(0.64, 1.02, 0.02, 0, 1.08, 0.365, 0x1b2430);
  const cols = [0xd62f2f, 0x2f6fd6, 0x3aa65b, 0xe8b730, 0xd62f2f];
  cols.forEach((c, i) => b(0.58, 0.06, 0.02, 0, 1.44 - i * 0.2, 0.378, c));
  b(0.7, 0.2, 0.03, 0, 1.64, 0.37, 0xe03a3a);
  b(0.5, 0.12, 0.02, 0, 0.36, 0.365, 0x15181c);
  return mergeGeometries(parts.map((g) => (g.deleteAttribute("uv"), g)))!;
}

function lampGeometry(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.06, 0.1, 6.6, 5);
  pole.translate(0, 3.3, 0);
  const arm = new THREE.BoxGeometry(2.1, 0.07, 0.07);
  arm.translate(1.0, 6.55, 0);
  const head = new THREE.BoxGeometry(0.8, 0.12, 0.32);
  head.translate(2.0, 6.45, 0);
  return mergeGeometries([
    paint(bare(pole), 0x7c8084), paint(bare(arm), 0x7c8084), paint(bare(head), 0xb9bcbf),
  ].map((g) => (g.deleteAttribute("uv"), g)))!;
}

// ---------------------------------------------------------------------------
// 置く側
// ---------------------------------------------------------------------------
type CullInfo = {
  items: Array<{ x: number; z: number }>; alive: Uint8Array; version: number; margin: number;
  /** 建物に近すぎたとき、この距離（m）まで動かして置き直す（0 なら動かさず消す） */
  nudge: number;
  /** 余白を、物の大きさ（scale）倍にするか */
  byScale: boolean;
  place: (it: { x: number; z: number }, m: THREE.Matrix4) => void;
};
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0).setPosition(0, -500, 0);

/** 場所ごとの箱（250 m 四方）に分けて並べる。見えない箱は描かれない */
function chunkedInstances<T extends { x: number; z: number }>(
  parent: THREE.Group,
  geom: THREE.BufferGeometry,
  mat: THREE.Material,
  items: T[],
  place: (it: T, m: THREE.Matrix4) => void,
  opts: { nudge?: number; byScale?: boolean; cast?: boolean; color?: (it: T, c: THREE.Color) => void; extra?: (g: THREE.BufferGeometry, list: T[]) => void; cell?: number; receive?: boolean; margin?: number; origin?: [number, number] } = {},
) {
  // タイルの原点（角）が渡されたときは、タイル 1 枚 = 1 つの塊。塊が多いと、毎コマの描画の準備（CPU）が重くなる
  const cell = opts.cell ?? (opts.origin ? 1000 : 250);
  const [ox, oz] = opts.origin ?? [0, 0];
  const bins = new Map<string, T[]>();
  for (const it of items) {
    const k = `${Math.floor((it.x - ox) / cell)},${Math.floor((it.z - oz) / cell)}`;
    let a = bins.get(k);
    if (!a) bins.set(k, (a = []));
    a.push(it);
  }
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const made: THREE.InstancedMesh[] = [];
  for (const list of bins.values()) {
    // 個別の属性（葉の色むら）がなければ、形は全部の塊で共有する（GPU の buffer を塊ごとに作ると、読み込みの瞬間に引っかかる）
    let g = geom;
    if (opts.extra) { g = geom.clone(); opts.extra(g, list); } else geom.userData.shared = true;
    // 同じ形を並べる物（インスタンス）は、個数が違うと別のシェーダーになる（行列の入れ物の大きさが個数で決まるため）。
    // 個数を段階（64 / 1024）に切り上げて入れ物を作り、描く個数だけ count で指定する。段階が同じなら、シェーダーは共通。
    // 段階は 2 つだけ（以前は 32/128/512/1024 の 4 つ）。実機で「止まり」の原因になっていたシェーダーの種類を減らすため
    const cap = list.length <= 64 ? 64 : list.length <= 1024 ? 1024 : list.length;
    const mesh = new THREE.InstancedMesh(g, mat, cap);
    mesh.count = list.length;
    for (let i = 0; i < list.length; i++) {
      place(list[i], m);
      mesh.setMatrixAt(i, m);
      if (opts.color) {
        opts.color(list[i], c);
        mesh.setColorAt(i, c);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    // 建物の足あとと重なった物を後から消すための情報
    mesh.userData.cull = { items: list, alive: new Uint8Array(list.length).fill(1), version: -1, margin: opts.margin ?? 0.5, nudge: opts.nudge ?? 0, byScale: opts.byScale ?? false, place: place as (it: { x: number; z: number }, m: THREE.Matrix4) => void } satisfies CullInfo;
    mesh.castShadow = !!opts.cast;
    mesh.receiveShadow = opts.receive ?? true; // 草むらなど小さい物は影を受けなくてよい（影の見え方が変わらず、1 画素あたりの計算が減る）
    parent.add(mesh);
    made.push(mesh);
  }
  return made;
}

/** 道ばたの物の塊を、カメラからの距離で出したり隠したりする（遠くの小さな物は描かない・影も落とさない） */
type Lod = { meshes: THREE.InstancedMesh[]; draw: number; shadow: number };

export type RoadStats = { tiles: number; failedTiles: number; lines: number; nodes: number; trees: number; lamps: number; triangles: number };

/** 道のタイル 1 枚ぶんの、作った物 */
type TileRec = {
  key: string;
  tx: number;
  ty: number;
  /** タイルの中心（画面の座標） */
  cx: number;
  cz: number;
  group: THREE.Group;
  lines: RoadLine[];
  nodes: RoadNode[];
  /** 木・街灯などの入れ物（カメラが近づいてから作る。遠くなったら捨てる） */
  fgroup: THREE.Group | null;
  lods: Lod[];
  trees: number;
  lamps: number;
  tris: number;
};

type Fetched = { state: "pending" } | { state: "ready"; layer: RoadLayerLike | null } | { state: "failed"; at: number };

/**
 * 道・歩道・木などを、カメラの近くのタイルだけ読み込んで置く。
 * 以前は「最初の場所の周り」を 1 回だけ作っていたので、遠くまで走ると道も木も無くなっていた。
 * 今は、カメラが動くたびに、近づいたタイルを 1 コマに 1 枚ずつ作り、遠くなったタイルは捨てる。
 */
export class Roads {
  readonly group = new THREE.Group();
  stats: RoadStats = { tiles: 0, failedTiles: 0, lines: 0, nodes: 0, trees: 0, lamps: 0, triangles: 0 };
  private readonly mats = [0, 1, 2, 3, 4].map((l) => roadMaterial(l));
  private readonly walkMat = sidewalkMaterial();
  private readonly treeGeoA = treeCardGeometry(0);
  private readonly treeGeoB = treeCardGeometry(1);
  private readonly lampGeo = lampGeometry();
  private readonly hedgeGeo = hedgeGeometry();
  private readonly signGeo = signGeometry();
  private readonly vendGeo = vendGeometry();
  private readonly shrubGeo = bushCardGeometry();
  private readonly cardMat = cardMaterial();
  /** 初めての描き方の準備（画面を止めない）。準備ができるまで、その塊は見せない */
  private warm: Warmup | null = null;
  setWarmup(w: Warmup) { this.warm = w; }
  private readonly treeMat: THREE.MeshStandardNodeMaterial;
  private readonly metalMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.3, vertexColors: true });
  private token = 0;
  /** 道を読み込む範囲（カメラから m） */
  radius = 1500;
  treeRadius = 800;
  /** 測定用: 木・街灯などを全部隠す */
  hideInstanced = false;

  private frame: LocalFrame | null = null;
  private groundH = 0;
  private readonly tiles = new Map<string, TileRec>();
  private readonly fetched = new Map<string, Fetched>();
  private readonly centres = new Map<string, [number, number]>();
  private readyQ: string[] = [];
  private pending = 0;
  private failed = 0;
  private idSeq = 0;
  private lastPlan = -1e9;
  private lastLog = -1e9;
  private logged = 0;
  private flat: { mesh: THREE.InstancedMesh; lod: Lod }[] = [];
  private flatDirty = false;
  private linesCache: RoadLine[] = [];
  private nodesCache: RoadNode[] = [];
  private linesDirty = false;
  /** 運転が、あとから増えた道を受け取るための列 */
  private newLines: RoadLine[] = [];
  /** 作ってからすぐには表示せず、1 コマに少しずつ表示する（初めて描くときに GPU へ送る処理が、1 コマに集中しないように） */
  private revealQ: THREE.Object3D[] = [];
  /** 道の面と木などの塊の数（確認用） */
  meshCount = 0;

  constructor(private readonly log: (m: string) => void, private readonly tileUrlOf?: (z: number, x: number, y: number) => string) {
    this.group.name = "roads";
    // 生け垣用の材質: 葉の色むら（頂点の緑の部分だけ）
    const tm = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, vertexColors: true });
    const pw: N = positionWorld;
    const leaf: N = vnoise(vec2(pw.x.add(pw.y.mul(0.7)), pw.z.add(pw.y.mul(0.4))).mul(2.2)).mul(0.5)
      .add(vnoise(vec2(pw.x, pw.z.add(pw.y)).mul(7.0)).mul(0.35)).add(0.55);
    const vc: N = vertexColor().rgb;
    const crown: N = step(1.15, vc.g.div(vc.r.max(0.01)));
    const tint: N = attribute("tint", "float");
    const leafTint: N = mix(vec3(1.18, 1.0, 0.7), vec3(0.85, 1.05, 0.9), tint);
    tm.colorNode = mix(vec3(1, 1, 1), leafTint.mul(leaf), crown);
    this.treeMat = tm;
  }

  /** 読み込んだ道（自動運転が使う） */
  get lines(): RoadLine[] { this.refreshLines(); return this.linesCache; }
  get nodes(): RoadNode[] { this.refreshLines(); return this.nodesCache; }
  /** あとから増えた道を取り出す（取り出すと空になる） */
  takeNewLines(): RoadLine[] {
    if (this.newLines.length === 0) return this.newLines;
    const a = this.newLines;
    this.newLines = [];
    return a;
  }
  private refreshLines() {
    if (!this.linesDirty) return;
    this.linesDirty = false;
    this.linesCache = [];
    this.nodesCache = [];
    for (const t of this.tiles.values()) {
      for (const l of t.lines) this.linesCache.push(l);
      for (const n of t.nodes) this.nodesCache.push(n);
    }
  }

  private get treeDraw() {
    return this.treeRadius > 500 ? 300 : 220; // 木を描く距離（m）。近くだけ
  }
  /** この距離（m）より近いタイルには、木などを置く / これより遠くなったら捨てる */
  private get furnIn() { return this.treeDraw + 350; } // タイルの中心から。タイルは約 500 m 四方
  private get furnOut() { return this.furnIn + 400; }

  private refreshFlat() {
    if (!this.flatDirty) return;
    this.flatDirty = false;
    this.flat = [];
    for (const t of this.tiles.values()) for (const l of t.lods) for (const m of l.meshes) this.flat.push({ mesh: m, lod: l });
  }

  /** 毎コマ呼ぶ。カメラから遠い塊は描かず、近い塊だけ影を落とす */
  private lodTick = 0;
  updateLod(cam: THREE.Vector3) {
    this.refreshFlat();
    // 出す/隠すの判定は 3 コマに 1 回で足りる（8 m/s で動いても 1 コマ 0.15 m）
    if (this.lodTick++ % 3 !== 0 && !this.flatDirty) return;
    // 影を落とし始める塊は、1 回の見直しで 1 つまで（初めて影を落とすとき、その塊の影用の準備が走って、1 コマ重くなるため）
    let flips = 0;
    for (const { mesh: m, lod: l } of this.flat) {
      const b = m.boundingSphere;
      if (!b) continue;
      const d = Math.hypot(b.center.x - cam.x, b.center.z - cam.z) - b.radius;
      m.visible = m.userData.live === true && !this.hideInstanced && d < l.draw;
      if (l.shadow > 0) {
        const want = d < l.shadow;
        if (want && !m.castShadow) { if (flips < 1 && m.visible) { m.castShadow = true; flips++; } }
        else m.castShadow = want;
      }
    }
  }

  private cullCursor = 0;
  /** 建物の足あとの中に入ってしまった物（木など）を、動かすか消す。近くの塊だけを、1 コマあたり少しずつ点検する */
  cullByFootprints(fp: Footprints, cam: THREE.Vector3, budgetMs = 0.8) {
    this.refreshFlat();
    const t0 = performance.now();
    const all = this.flat;
    const N = all.length;
    for (let step = 0; step < N; step++) {
      const mesh = all[(this.cullCursor + step) % N].mesh;
      const c = mesh.userData.cull as CullInfo | undefined;
      if (!c || c.version === fp.version) continue;
      if (!mesh.visible) continue; // 描かれていない塊（遠い・まだ表示待ち）は、見えるようになってから点検する
      let changed = false;
      for (let i = 0; i < c.items.length; i++) {
        if (!c.alive[i]) continue;
        const it = c.items[i];
        const mg = c.byScale ? c.margin * ((it as { scale?: number }).scale ?? 1) : c.margin;
        // 前に点検してから、近くの足あとが書き換わっていなければ、点検しない（同じ物を何度も調べ直さない）
        if (c.version >= 0 && !fp.changedSince(it.x, it.z, mg + 1.5, c.version)) continue;
        if (fp.near(it.x, it.z, mg)) {
          changed = true;
          if (c.nudge > 0 && this.nudge(fp, it, c, mg)) {
            c.place(it, this.tmpM);
            mesh.setMatrixAt(i, this.tmpM);
            this.moved++;
          } else {
            c.alive[i] = 0;
            mesh.setMatrixAt(i, HIDE);
            this.culled++;
          }
        }
      }
      if (changed) mesh.instanceMatrix.needsUpdate = true;
      c.version = fp.version;
      if (performance.now() - t0 > budgetMs) { this.cullCursor = (this.cullCursor + step + 1) % N; return; }
    }
  }
  private readonly tmpM = new THREE.Matrix4();
  /** 建物に近すぎる物を、近い順に 16 方向へ動かして、空いている所に置き直す。置けたら true */
  private nudge(fp: Footprints, it: { x: number; z: number }, c: CullInfo, margin: number): boolean {
    for (let r = 0.6; r <= c.nudge + 1e-6; r += 0.6) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = it.x + Math.cos(a) * r, z = it.z + Math.sin(a) * r;
        if (!fp.near(x, z, margin)) { it.x = x; it.z = z; return true; }
      }
    }
    return false;
  }
  /** 建物と重なって消した物の数・ずらして置き直した物の数（確認用） */
  culled = 0;
  moved = 0;

  private disposeGroup(g: THREE.Object3D) {
    g.removeFromParent();
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.geometry.userData.shared) mesh.geometry.dispose();
      (mesh as unknown as THREE.InstancedMesh).dispose?.();
    });
  }

  clear() {
    this.token++;
    this.culled = 0;
    this.moved = 0;
    for (const t of this.tiles.values()) { this.disposeGroup(t.group); if (t.fgroup) this.disposeGroup(t.fgroup); }
    this.tiles.clear();
    this.fetched.clear();
    this.centres.clear();
    this.readyQ = [];
    this.pending = 0;
    this.failed = 0;
    this.flat = [];
    this.flatDirty = false;
    this.linesCache = [];
    this.nodesCache = [];
    this.linesDirty = false;
    this.newLines = [];
    this.lastPlan = -1e9;
    this.frame = null;
    this.stats = { tiles: 0, failedTiles: 0, lines: 0, nodes: 0, trees: 0, lamps: 0, triangles: 0 };
  }

  /** 場所が決まったとき。あとは update() が、カメラの近くのタイルを読み込んでいく */
  begin(frame: LocalFrame, groundH: number) {
    this.clear();
    this.frame = frame;
    this.groundH = groundH;
  }

  private tileCentre(tx: number, ty: number): [number, number] {
    const key = `${tx},${ty}`;
    let c = this.centres.get(key);
    if (!c) {
      const v = this.frame!.toLocal(tileYToLat(ty + 0.5, ZOOM), tileXToLon(tx + 0.5, ZOOM), this.groundH, new THREE.Vector3());
      c = [v.x, v.z];
      this.centres.set(key, c);
    }
    return c;
  }

  /** 毎コマ呼ぶ（中で間引く）。カメラの近くのタイルを読み込み、1 コマに 1 つだけ作る */
  update(cam: THREE.Vector3, now: number) {
    if (!this.frame) return;
    if (now - this.lastPlan > 2500) { this.lastPlan = now; this.plan(cam, now); }
    this.buildOne(cam);
  }

  private plan(cam: THREE.Vector3, now: number) {
    const frame = this.frame!;
    const g = frame.toGeodetic(cam);
    const cx = Math.floor(lonToTileX(g.lon, ZOOM)), cy = Math.floor(latToTileY(g.lat, ZOOM));
    const tileM = (40075016 * Math.cos((g.lat * Math.PI) / 180)) / 2 ** ZOOM;
    const n = Math.max(1, Math.ceil(this.radius / tileM)) + 1;
    const want: { key: string; tx: number; ty: number; d: number }[] = [];
    for (let dy = -n; dy <= n; dy++) {
      for (let dx = -n; dx <= n; dx++) {
        const tx = cx + dx, ty = cy + dy;
        const [x, z] = this.tileCentre(tx, ty);
        const d = Math.hypot(x - cam.x, z - cam.z);
        if (d > this.radius + tileM * 0.5) continue;
        want.push({ key: `${tx},${ty}`, tx, ty, d });
      }
    }
    want.sort((a, b) => a.d - b.d);
    for (const w of want) {
      if (this.pending >= 4) break;
      const f = this.fetched.get(w.key);
      if (f && !(f.state === "failed" && now - f.at > 20000)) continue;
      this.fetchTile(w.key, w.tx, w.ty);
    }
    // 遠くなったタイルを捨てる
    for (const t of [...this.tiles.values()]) {
      const d = Math.hypot(t.cx - cam.x, t.cz - cam.z);
      if (d > this.radius + tileM * 1.3) this.dropTile(t);
    }
  }

  private fetchTile(key: string, tx: number, ty: number) {
    const my = this.token;
    this.fetched.set(key, { state: "pending" });
    this.pending++;
    fetchRoadTile(tx, ty, this.tileUrlOf).then(
      (layer) => {
        if (my !== this.token) return;
        this.pending--;
        this.fetched.set(key, { state: "ready", layer });
        this.readyQ.push(key);
      },
      (e: Error) => {
        if (my !== this.token) return;
        this.pending--;
        this.failed++;
        this.fetched.set(key, { state: "failed", at: performance.now() });
        if (this.failed <= 2) this.log(`道路タイルの読み込み失敗: ${e.message}`);
      },
    );
  }

  private dropTile(t: TileRec) {
    this.disposeGroup(t.group);
    if (t.fgroup) this.disposeGroup(t.fgroup);
    this.tiles.delete(t.key);
    this.fetched.delete(t.key); // 戻ってきたら、また読み込む
    this.linesDirty = true;
    this.flatDirty = true;
    this.refreshStats();
  }

  private refreshStats() {
    let lines = 0, nodes = 0, trees = 0, lamps = 0, tris = 0;
    for (const t of this.tiles.values()) { lines += t.lines.length; nodes += t.nodes.length; trees += t.trees; lamps += t.lamps; tris += t.tris; }
    let mc = 0;
    for (const t of this.tiles.values()) { mc += t.group.children.length; for (const l of t.lods) mc += l.meshes.length; }
    this.meshCount = mc;
    this.stats = { tiles: this.tiles.size, failedTiles: this.failed, lines, nodes, trees, lamps, triangles: tris };
  }

  /** 1 コマに 1 つだけ、重い作業をする: ① 届いたタイルを道の面にする ② 近いタイルに木などを置く ③ 遠くの木などを捨てる */
  private buildOne(cam: THREE.Vector3) {
    // 表示待ちの物が溜まっているうちは、新しく作らない（作る速さを、表示する速さに合わせる）
    const w = this.warm;
    for (let i = 0, shown = 0; i < this.revealQ.length && shown < 6;) {
      const o = this.revealQ[i];
      const m = o as THREE.Mesh;
      // 初めて描く組み合わせは、裏で準備ができるまで待つ（待たずに描くと、その瞬間に画面が止まる）
      if (w && w.enabled && !w.ready(m, m.material as THREE.Material)) { void w.request(m, m.material as THREE.Material); i++; continue; }
      this.revealQ.splice(i, 1);
      o.userData.live = true;
      if (o.userData.ribbon) o.visible = true;
      shown++;
    }
    if (this.revealQ.length > 12) return;
    if (this.readyQ.length > 0) {
      let bi = -1, bd = Infinity;
      for (let i = 0; i < this.readyQ.length; i++) {
        const [tx, ty] = this.readyQ[i].split(",").map(Number);
        const [x, z] = this.tileCentre(tx, ty);
        const d = Math.hypot(x - cam.x, z - cam.z);
        if (d < bd) { bd = d; bi = i; }
      }
      const key = this.readyQ.splice(bi, 1)[0];
      const f = this.fetched.get(key);
      if (f && f.state === "ready") {
        const [tx, ty] = key.split(",").map(Number);
        this.buildTile(key, tx, ty, f.layer);
        return;
      }
    }
    let best: TileRec | null = null, bestD = Infinity;
    for (const t of this.tiles.values()) {
      if (t.fgroup) continue;
      const d = Math.hypot(t.cx - cam.x, t.cz - cam.z);
      if (d < this.furnIn && d < bestD) { best = t; bestD = d; }
    }
    if (best) { this.buildFurniture(best); return; }
    for (const t of this.tiles.values()) {
      if (!t.fgroup) continue;
      if (Math.hypot(t.cx - cam.x, t.cz - cam.z) > this.furnOut) {
        this.disposeGroup(t.fgroup);
        t.fgroup = null;
        t.lods = [];
        t.trees = 0; t.lamps = 0;
        this.flatDirty = true;
        this.refreshStats();
        return;
      }
    }
  }

  /** タイル 1 枚の道・歩道の面を作る */
  private buildTile(key: string, tx: number, ty: number, layer: RoadLayerLike | null) {
    const frame = this.frame!;
    const tmp = new THREE.Vector3();
    const toXZ = (lo: number, la: number): [number, number] => {
      frame.toLocal(la, lo, this.groundH, tmp);
      return [tmp.x, tmp.z];
    };
    const lines = layer ? parseRoadLayer(layer, tx, ty, toXZ, () => this.idSeq++) : [];
    const nodes = analyzeNodes(lines);
    const [cx, cz] = this.tileCentre(tx, ty);
    const group = new THREE.Group();
    group.name = `road-tile-${key}`;
    let tris = 0;
    // 描く順番: 歩道 → 幅員区分 0 → … → 4。タイルごとにも固定の順番（座標から決める）を付けて、重なる所で入れ替わらないようにする
    const order = (((tx % 30) + 30) % 30) * 30 + (((ty % 30) + 30) % 30);
    const addRibbon = (rb: Ribbon, mat: THREE.Material, ord: number) => {
      if (rb.vertexCount === 0) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(rb.position, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(rb.normal, 3));
      g.setAttribute("rpos", new THREE.BufferAttribute(rb.rpos, 2));
      g.setAttribute("rd", new THREE.BufferAttribute(rb.rd, 4));
      g.setIndex(new THREE.BufferAttribute(rb.index, 1));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.renderOrder = ord;
      mesh.visible = false;
      mesh.userData.ribbon = true;
      this.revealQ.push(mesh);
      group.add(mesh);
      tris += rb.index.length / 3;
    };
    if (lines.length > 0) {
      addRibbon(buildRibbon(lines, sidewalkExtra, 0.01), this.walkMat, 100 + order);
      for (let r = 0; r <= 4; r++) {
        const ls = lines.filter((l) => l.rank === r);
        addRibbon(buildRibbon(ls, roadExtra, 0.02 + r * 0.004), this.mats[r], 100 + (r + 1) * 1000 + order);
      }
    }
    this.group.add(group);
    const rec: TileRec = { key, tx, ty, cx, cz, group, lines, nodes, fgroup: null, lods: [], trees: 0, lamps: 0, tris };
    this.tiles.set(key, rec);
    for (const l of lines) this.newLines.push(l);
    this.linesDirty = true;
    this.refreshStats();
    const now = performance.now();
    if (now - this.lastLog > 4000 && this.readyQ.length === 0 && this.pending === 0) {
      this.lastLog = now;
      this.log(`道路データ: タイル ${this.tiles.size} 枚 / 道 ${this.stats.lines} 本 / 交差点 ${this.stats.nodes} / 道の三角形 ${(this.stats.triangles / 1000).toFixed(0)} 千 / 描く塊 ${this.meshCount}（失敗 ${this.failed}）`);
    }
  }

  /** タイル 1 枚の、木・街灯・生け垣・低木・草むら・標識・自販機を置く */
  private buildFurniture(t: TileRec) {
    const others: RoadLine[] = [];
    for (const o of this.tiles.values()) {
      if (o !== t && Math.abs(o.tx - t.tx) <= 1 && Math.abs(o.ty - t.ty) <= 1) for (const l of o.lines) others.push(l);
    }
    const f: Furniture = placeFurniture(t.lines, t.nodes, { others });
    const fg = new THREE.Group();
    fg.name = `road-furniture-${t.key}`;
    const lods: Lod[] = [];
    const origin: [number, number] = [t.cx - 250, t.cz - 250]; // タイルの角から 250 m 升（タイル 1 枚 = 最大 4 塊）。遠い塊は描かない
    const Y = new THREE.Vector3(0, 1, 0);
    const placeTree = (tr: TreeInst, m: THREE.Matrix4) => {
      m.compose(new THREE.Vector3(tr.x, 0, tr.z), new THREE.Quaternion().setFromAxisAngle(Y, tr.rot), new THREE.Vector3(tr.scale, tr.scale * (0.9 + tr.tint * 0.25), tr.scale));
    };
    const tintAttr = (g: THREE.BufferGeometry, list: { tint: number }[]) => {
      g.setAttribute("tint", new THREE.InstancedBufferAttribute(Float32Array.from(list, (x) => x.tint), 1));
    };
    // 街路樹は葉の形が違う 2 種類。建物（葉の広がり = 木の大きさ × 約 2.4 m）に近すぎる木は、少しずらして置き直す（置けなければ消す）
    const treeMeshes: THREE.InstancedMesh[] = [];
    for (const [geo, pick] of [[this.treeGeoA, (x: TreeInst) => x.tint < 0.5], [this.treeGeoB, (x: TreeInst) => x.tint >= 0.5]] as const) {
      treeMeshes.push(...chunkedInstances(fg, geo, this.cardMat, f.trees.filter(pick), placeTree, {
        origin, cell: 250, cast: true, margin: 2.4, byScale: true, nudge: 1.4, receive: false, extra: tintAttr,
      }));
    }
    lods.push({ draw: this.treeDraw, shadow: 130, meshes: treeMeshes });
    lods.push({ draw: 230, shadow: 0, meshes: chunkedInstances(fg, this.lampGeo, this.metalMat, f.lamps, (l, m) => {
      m.compose(new THREE.Vector3(l.x, 0, l.z), new THREE.Quaternion().setFromAxisAngle(Y, l.rot), new THREE.Vector3(1, 1, 1));
    }, { origin, cell: 250, margin: 0.2 }) });
    lods.push({ draw: 200, shadow: 0, meshes: chunkedInstances(fg, this.hedgeGeo, this.treeMat, f.hedges, (h, m) => {
      m.compose(new THREE.Vector3(h.x, 0, h.z), new THREE.Quaternion().setFromAxisAngle(Y, h.rot), new THREE.Vector3(h.scale, 0.85 + h.tint * 0.4, 1));
    }, { origin, extra: tintAttr, cell: 250, margin: 0.6 }) });
    lods.push({ draw: 180, shadow: 0, meshes: chunkedInstances(fg, this.shrubGeo, this.cardMat, f.shrubs, (h, m) => {
      m.compose(new THREE.Vector3(h.x, 0, h.z), new THREE.Quaternion().setFromAxisAngle(Y, h.rot), new THREE.Vector3(h.scale, h.scale * (0.8 + h.tint * 0.4), h.scale));
    }, { origin, extra: tintAttr, cell: 250, receive: false, margin: 0.8, nudge: 1.4 }) });
    lods.push({ draw: 180, shadow: 0, meshes: chunkedInstances(fg, this.signGeo, this.metalMat, f.signs, (p, m) => {
      m.compose(new THREE.Vector3(p.x, 0, p.z), new THREE.Quaternion().setFromAxisAngle(Y, p.rot), new THREE.Vector3(1, 1, 1));
    }, { origin, cell: 250, margin: 0.2 }) });
    lods.push({ draw: 150, shadow: 0, meshes: chunkedInstances(fg, this.vendGeo, this.metalMat, f.vends, (p, m) => {
      m.compose(new THREE.Vector3(p.x, 0, p.z), new THREE.Quaternion().setFromAxisAngle(Y, p.rot), new THREE.Vector3(1, 1, 1));
    }, { origin, cell: 250, margin: 0 }) });
    const triOf = (g: THREE.BufferGeometry, k: number) => (g.index ? g.index.count : g.getAttribute("position").count) / 3 * k;
    t.tris = t.tris + triOf(this.treeGeoA, f.trees.length) + triOf(this.lampGeo, f.lamps.length)
      + triOf(this.shrubGeo, f.shrubs.length) + triOf(this.hedgeGeo, f.hedges.length) + triOf(this.signGeo, f.signs.length) + triOf(this.vendGeo, f.vends.length);
    t.trees = f.trees.length;
    t.lamps = f.lamps.length;
    t.fgroup = fg;
    t.lods = lods;
    for (const l of lods) for (const m of l.meshes) this.revealQ.push(m);
    this.group.add(fg);
    this.flatDirty = true;
    this.refreshStats();
  }
}
