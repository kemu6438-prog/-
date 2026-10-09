// 道路・歩道・街路樹・街灯などを、国土地理院の道路データから作って画面に置く。
import * as THREE from "three/webgpu";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import {
  attribute, clamp, dFdx, dFdy, float, floor, fract, length, max, min, mix, positionView, positionWorld,
  smoothstep, step, vec2, vec3, vertexColor,
} from "three/tsl";
import type { LocalFrame } from "../core/geo";
import { hash21, vnoise, type N } from "../render/noise";
import { TEX } from "../render/assets";
import {
  ZOOM, analyzeNodes, fetchRoadTile, latToTileY, lonToTileX, parseRoadLayer, type RoadLine, type RoadNode,
} from "./roadData";
import { buildRibbon, roadExtra, sidewalkExtra, type Ribbon } from "./roadGeometry";
import { placeFurniture, type Furniture } from "./roadFurniture";

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
  const wheel: N = smoothstep(0.1, 0.0, abs(lane.sub(0.36))).mul(0.5).add(0.0).mul(step(1.5, rank)); // 車輪の通る所は少し明るく磨かれる
  const gw: N = float(1.0).sub(TEX.asphalt.on.mul(0.75)); // 素材が読めたら自作の粒を弱める
  const base: N = mix(vec3(0.17, 0.17, 0.18), vec3(0.3, 0.295, 0.29), n2)
    .mul(float(0.9).add(g1.mul(0.3).mul(near).mul(gw)))
    .mul(float(1.0).add(wheel.mul(0.1)))
    .mul(TEX.asphalt.detail(pw)); // ネットの素材（読み込めたら）の本物のアスファルトの粒（1 枚だけ読む＝軽い）
  // 路肩（縁）は少し汚れて暗い
  const gutter: N = smoothstep(hr.sub(0.7), hr.sub(0.05), abs(u));
  const asphalt: N = mix(base, base.mul(vec3(0.78, 0.76, 0.72)), gutter);

  // --- 白線 ---
  const aaU: N = max(abs(dFdx(u)).add(abs(dFdy(u))), 0.003);
  const aaV: N = max(abs(dFdx(v)).add(abs(dFdy(v))), 0.003);
  const aaS: N = max(abs(dFdx(dS)).add(abs(dFdy(dS))), 0.003).min(abs(dFdx(dE)).add(abs(dFdy(dE))).max(0.003)).max(0.003);
  const hasLines: N = step(1.5, rank);
  const big: N = step(2.5, rank);
  // 外側線
  const edgeL: N = cover(abs(u).sub(hr.sub(0.4)), 0.15, aaU).mul(hasLines);
  // 中央線: 中くらいの道は白の破線、広い道は白の二重線
  const dashed: N = cover(u, 0.15, aaU).mul(dash(v, 10.0, 0.5, aaV));
  const dbl: N = cover(abs(u).sub(0.17), 0.14, aaU);
  const centre: N = mix(dashed, dbl, big).mul(hasLines);
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
const hash3 = (x: number, y: number, z: number) => {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
};

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

/** 丸っこい葉のかたまり。形を少しいびつにする */
function blob(rx: number, ry: number, rz: number, x: number, y: number, z: number, color: number, seed: number) {
  const ico = new THREE.IcosahedronGeometry(1, 1);
  ico.deleteAttribute("uv");
  ico.deleteAttribute("normal");
  const g: THREE.BufferGeometry = mergeVertices(ico, 1e-4);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const k = 1 + (hash3(p.getX(i) + seed, p.getY(i), p.getZ(i)) - 0.5) * 0.34;
    p.setXYZ(i, p.getX(i) * rx * k + x, p.getY(i) * ry * k + y, p.getZ(i) * rz * k + z);
  }
  g.computeVertexNormals();
  return paint(bare(g), color, (yy) => 0.5 + 0.5 * THREE.MathUtils.smoothstep(yy, 3.4, 8.2));
}

function treeGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.11, 0.2, 3.6, 6);
  trunk.translate(0, 1.8, 0);
  const parts = [
    paint(bare(trunk), 0x6b5440),
    blob(2.5, 2.1, 2.5, 0, 5.4, 0, 0x3f7a26, 1),
    blob(1.9, 1.7, 1.9, 1.2, 4.6, 0.7, 0x4b8a2c, 2),
  ];
  for (const g of parts) {
    g.deleteAttribute("uv");
    if (!g.getAttribute("normal")) g.computeVertexNormals();
  }
  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))!;
  merged.computeBoundingSphere();
  return merged;
}

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

/** 低木: 低ポリの丸い茂み（地面すれすれから 0.9m ほど） */
function shrubGeometry(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 0);
  ico.deleteAttribute("uv");
  ico.deleteAttribute("normal");
  const g: THREE.BufferGeometry = mergeVertices(ico, 1e-4);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const k = 1 + (hash3(p.getX(i) * 3.1, p.getY(i) * 2.3, p.getZ(i) * 1.7) - 0.5) * 0.4;
    p.setXYZ(i, p.getX(i) * 0.62 * k, Math.max(p.getY(i) * 0.5 * k, -0.1) + 0.38, p.getZ(i) * 0.62 * k);
  }
  g.computeVertexNormals();
  return paint(bare(g), 0x3f7a26, (y) => 0.6 + 0.6 * THREE.MathUtils.smoothstep(y, 0.0, 0.9));
}

/** 草むら: 細い三角の葉を 9 枚、外へ少し倒して束ねる。両面を描き、光は上向きの面として当てる */
function tuftGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const nor: number[] = [];
  const base = new THREE.Color(0x5e9c33);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + hash3(i, 1.3, 0.7);
    const rad = 0.06 + hash3(i, 5.1, 2.2) * 0.16;
    const h = 0.32 + hash3(i, 9.7, 4.1) * 0.35;
    const lean = 0.1 + hash3(i, 3.3, 8.8) * 0.2;
    const w = 0.045;
    const bx = Math.cos(a) * rad, bz = Math.sin(a) * rad;
    const tx = bx + Math.cos(a) * lean, tz = bz + Math.sin(a) * lean;
    const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
    pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, tx, h, tz);
    for (let k = 0; k < 3; k++) {
      const f = k === 2 ? 1.25 : 0.65;
      col.push(base.r * f, base.g * f, base.b * f);
      nor.push(0, 1, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return g;
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
/** 場所ごとの箱（250 m 四方）に分けて並べる。見えない箱は描かれない */
function chunkedInstances<T extends { x: number; z: number }>(
  parent: THREE.Group,
  geom: THREE.BufferGeometry,
  mat: THREE.Material,
  items: T[],
  place: (it: T, m: THREE.Matrix4) => void,
  opts: { cast?: boolean; color?: (it: T, c: THREE.Color) => void; extra?: (g: THREE.BufferGeometry, list: T[]) => void; cell?: number } = {},
) {
  const cell = opts.cell ?? 250;
  const bins = new Map<string, T[]>();
  for (const it of items) {
    const k = `${Math.floor(it.x / cell)},${Math.floor(it.z / cell)}`;
    let a = bins.get(k);
    if (!a) bins.set(k, (a = []));
    a.push(it);
  }
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const made: THREE.InstancedMesh[] = [];
  for (const list of bins.values()) {
    const g = geom.clone();
    opts.extra?.(g, list);
    const mesh = new THREE.InstancedMesh(g, mat, list.length);
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
    mesh.castShadow = !!opts.cast;
    mesh.receiveShadow = true;
    parent.add(mesh);
    made.push(mesh);
  }
  return made;
}

/** 道ばたの物の塊を、カメラからの距離で出したり隠したりする（遠くの小さな物は描かない・影も落とさない） */
type Lod = { meshes: THREE.InstancedMesh[]; draw: number; shadow: number };

export type RoadStats = { tiles: number; failedTiles: number; lines: number; nodes: number; trees: number; lamps: number; triangles: number };

export class Roads {
  readonly group = new THREE.Group();
  /** 読み込んだ道（自動運転が使う） */
  lines: RoadLine[] = [];
  nodes: RoadNode[] = [];
  stats: RoadStats = { tiles: 0, failedTiles: 0, lines: 0, nodes: 0, trees: 0, lamps: 0, triangles: 0 };
  private readonly mats = [0, 1, 2, 3, 4].map((l) => roadMaterial(l));
  private readonly walkMat = sidewalkMaterial();
  private readonly treeGeo = treeGeometry();
  private readonly lampGeo = lampGeometry();
  private readonly hedgeGeo = hedgeGeometry();
  private readonly signGeo = signGeometry();
  private readonly vendGeo = vendGeometry();
  private readonly shrubGeo = shrubGeometry();
  private readonly tuftGeo = tuftGeometry();
  private readonly tuftMat: THREE.MeshStandardNodeMaterial;
  private readonly treeMat: THREE.MeshStandardNodeMaterial;
  private readonly metalMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.3, vertexColors: true });
  private token = 0;
  radius = 1500;
  treeRadius = 800;
  private lods: Lod[] = [];
  /** 測定用: 木・街灯などを全部隠す */
  hideInstanced = false;

  constructor(private readonly log: (m: string) => void, private readonly tileUrlOf?: (z: number, x: number, y: number) => string) {
    this.group.name = "roads";
    // 葉: 色むら（葉の細かい明暗）
    const tm = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0, vertexColors: true });
    const pw: N = positionWorld;
    const leaf: N = vnoise(vec2(pw.x.add(pw.y.mul(0.7)), pw.z.add(pw.y.mul(0.4))).mul(2.2)).mul(0.5)
      .add(vnoise(vec2(pw.x, pw.z.add(pw.y)).mul(7.0)).mul(0.35)).add(0.55);
    // 色合いの個体差は、葉の部分（緑の頂点）にだけ掛ける。幹は茶色のまま
    const vc: N = vertexColor().rgb;
    const crown: N = step(1.15, vc.g.div(vc.r.max(0.01)));
    const tint: N = attribute("tint", "float");
    const leafTint: N = mix(vec3(1.18, 1.0, 0.7), vec3(0.85, 1.05, 0.9), tint);
    tm.colorNode = mix(vec3(1, 1, 1), leafTint.mul(leaf), crown);
    this.treeMat = tm;
    this.tuftMat = tm.clone();
    this.tuftMat.side = THREE.DoubleSide;
  }

  private get treeDraw() {
    return this.treeRadius > 500 ? 550 : 380;
  }

  /** 毎コマ呼ぶ。カメラから遠い塊は描かず、近い塊だけ影を落とす */
  updateLod(cam: THREE.Vector3) {
    for (const l of this.lods) {
      for (const m of l.meshes) {
        const b = m.boundingSphere;
        if (!b) continue;
        const d = Math.hypot(b.center.x - cam.x, b.center.z - cam.z) - b.radius;
        m.visible = !this.hideInstanced && d < l.draw;
        if (l.shadow > 0) m.castShadow = d < l.shadow;
      }
    }
  }

  clear() {
    this.token++;
    this.lods = [];
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry !== this.treeGeo && mesh.geometry !== this.lampGeo && mesh.geometry !== this.hedgeGeo && mesh.geometry !== this.signGeo && mesh.geometry !== this.vendGeo) mesh.geometry.dispose();
      });
    }
  }

  async load(frame: LocalFrame, lat: number, lon: number, groundH: number) {
    const my = ++this.token;
    const t0 = performance.now();
    const cx = Math.floor(lonToTileX(lon, ZOOM));
    const cy = Math.floor(latToTileY(lat, ZOOM));
    const tileM = (40075016 * Math.cos((lat * Math.PI) / 180)) / 2 ** ZOOM;
    const n = Math.max(1, Math.ceil(this.radius / tileM));
    const jobs: [number, number][] = [];
    for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) jobs.push([cx + dx, cy + dy]);
    // 近い順に並べ、6 つずつ同時に読み込む
    jobs.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    const tmp = new THREE.Vector3();
    const toXZ = (lo: number, la: number): [number, number] => {
      frame.toLocal(la, lo, groundH, tmp);
      return [tmp.x, tmp.z];
    };
    let id = 0;
    const lines: RoadLine[] = [];
    let failed = 0;
    let layerSeen = 0;
    const queue = [...jobs];
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          const layer = await fetchRoadTile(job[0], job[1], this.tileUrlOf);
          if (my !== this.token) return;
          if (!layer) continue;
          layerSeen++;
          lines.push(...parseRoadLayer(layer, job[0], job[1], toXZ, () => id++));
        } catch (e) {
          failed++;
          if (failed <= 2) this.log(`道路タイルの読み込み失敗: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (my !== this.token) return;
    // 遠すぎる線は捨てる（読み込み範囲の外側）
    const R2 = this.radius * this.radius * 1.2;
    const near = lines.filter((l) => l.pts[0] * l.pts[0] + l.pts[1] * l.pts[1] < R2);
    const nodes = analyzeNodes(near);
    this.lines = near;
    this.nodes = nodes;
    this.stats = { ...this.stats, tiles: layerSeen, failedTiles: failed, lines: near.length, nodes: nodes.length };
    this.log(`道路データ: タイル ${layerSeen}/${jobs.length}（失敗 ${failed}） / 道 ${near.length} 本 / 交差点 ${nodes.length}`);
    if (near.length === 0) {
      this.log("道路データが 0 件でした（通信できないか、データが空）");
      return;
    }

    // --- 道（幅員区分ごとに別の面にして、太い道ほど手前に描く） ---
    let tris = 0;
    const addRibbon = (rb: Ribbon, mat: THREE.Material, y: number, order: number) => {
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
      mesh.renderOrder = order;
      mesh.position.y = 0;
      this.group.add(mesh);
      tris += rb.index.length / 3;
      void y;
    };
    // 道を 500 m 四方ごとの塊に分ける（画面の外の塊は描かない。1 枚の巨大な面だと、後ろ向きでも毎回全部を処理してしまう）
    const CELL = 500;
    const cells = new Map<string, RoadLine[]>();
    for (const l of near) {
      const k = `${Math.floor(l.pts[0] / CELL)},${Math.floor(l.pts[1] / CELL)}`;
      const a = cells.get(k);
      if (a) a.push(l);
      else cells.set(k, [l]);
    }
    let cellNo = 0;
    for (const cellLines of cells.values()) {
      cellNo++;
      // 描く順番: 歩道 → 幅員区分 0 → … → 4（箱ごとにも固定の順番を付けて、重なる所で入れ替わらないようにする）
      addRibbon(buildRibbon(cellLines, sidewalkExtra, 0.01), this.walkMat, 0.01, 100 + cellNo);
      for (let r = 0; r <= 4; r++) {
        const ls = cellLines.filter((l) => l.rank === r);
        addRibbon(buildRibbon(ls, roadExtra, 0.02 + r * 0.004), this.mats[r], 0, 100 + (r + 1) * 1000 + cellNo);
      }
    }

    // --- 道ばたの物 ---
    const f: Furniture = placeFurniture(near, nodes, { treeRadius: this.treeRadius });
    this.lods = [];
    this.lods.push({ draw: this.treeDraw, shadow: 220, meshes: chunkedInstances(this.group, this.treeGeo, this.treeMat, f.trees, (t, m) => {
      m.compose(new THREE.Vector3(t.x, 0, t.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot), new THREE.Vector3(t.scale, t.scale * (0.9 + t.tint * 0.25), t.scale));
    }, {
      cast: true,
      extra: (g, list) => {
        g.setAttribute("tint", new THREE.InstancedBufferAttribute(Float32Array.from(list, (t) => t.tint), 1));
      },
    }) });
    this.lods.push({ draw: 350, shadow: 0, meshes: chunkedInstances(this.group, this.lampGeo, this.metalMat, f.lamps, (l, m) => {
      m.compose(new THREE.Vector3(l.x, 0, l.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), l.rot), new THREE.Vector3(1, 1, 1));
    }) });
    // 生け垣・標識・自動販売機（近くだけ描く）
    const Y = new THREE.Vector3(0, 1, 0);
    this.lods.push({ draw: 260, shadow: 0, meshes: chunkedInstances(this.group, this.hedgeGeo, this.treeMat, f.hedges, (h, m) => {
      m.compose(new THREE.Vector3(h.x, 0, h.z), new THREE.Quaternion().setFromAxisAngle(Y, h.rot), new THREE.Vector3(h.scale, 0.85 + h.tint * 0.4, 1));
    }, {
      extra: (g, list) => {
        g.setAttribute("tint", new THREE.InstancedBufferAttribute(Float32Array.from(list, (t) => t.tint), 1));
      },
      cell: 200,
    }) });
    this.lods.push({ draw: 240, shadow: 0, meshes: chunkedInstances(this.group, this.shrubGeo, this.treeMat, f.shrubs, (h, m) => {
      m.compose(new THREE.Vector3(h.x, 0, h.z), new THREE.Quaternion().setFromAxisAngle(Y, h.rot), new THREE.Vector3(h.scale, h.scale * (0.8 + h.tint * 0.4), h.scale));
    }, {
      extra: (g, list) => { g.setAttribute("tint", new THREE.InstancedBufferAttribute(Float32Array.from(list, (t) => t.tint), 1)); },
      cell: 200,
    }) });
    this.lods.push({ draw: 160, shadow: 0, meshes: chunkedInstances(this.group, this.tuftGeo, this.tuftMat, f.tufts, (h, m) => {
      m.compose(new THREE.Vector3(h.x, 0, h.z), new THREE.Quaternion().setFromAxisAngle(Y, h.rot), new THREE.Vector3(h.scale, h.scale, h.scale));
    }, {
      extra: (g, list) => { g.setAttribute("tint", new THREE.InstancedBufferAttribute(Float32Array.from(list, (t) => t.tint), 1)); },
      cell: 160,
    }) });
    this.lods.push({ draw: 260, shadow: 0, meshes: chunkedInstances(this.group, this.signGeo, this.metalMat, f.signs, (p, m) => {
      m.compose(new THREE.Vector3(p.x, 0, p.z), new THREE.Quaternion().setFromAxisAngle(Y, p.rot), new THREE.Vector3(1, 1, 1));
    }, { cell: 200 }) });
    this.lods.push({ draw: 200, shadow: 0, meshes: chunkedInstances(this.group, this.vendGeo, this.metalMat, f.vends, (p, m) => {
      m.compose(new THREE.Vector3(p.x, 0, p.z), new THREE.Quaternion().setFromAxisAngle(Y, p.rot), new THREE.Vector3(1, 1, 1));
    }, { cell: 200 }) });
    const triOf = (g: THREE.BufferGeometry, k: number) => (g.index ? g.index.count : g.getAttribute("position").count) / 3 * k;
    tris += triOf(this.treeGeo, f.trees.length) + triOf(this.lampGeo, f.lamps.length)
      + triOf(this.shrubGeo, f.shrubs.length) + triOf(this.tuftGeo, f.tufts.length) + triOf(this.hedgeGeo, f.hedges.length) + triOf(this.signGeo, f.signs.length) + triOf(this.vendGeo, f.vends.length);
    this.stats = { ...this.stats, trees: f.trees.length, lamps: f.lamps.length, triangles: tris };
    this.log(
      `道路を表示: 街路樹 ${f.trees.length} / 街灯 ${f.lamps.length} / 生け垣 ${f.hedges.length} / 低木 ${f.shrubs.length} / 草むら ${f.tufts.length} / 標識 ${f.signs.length} / 自販機 ${f.vends.length} / 三角形 ${(tris / 1e6).toFixed(2)} 百万 / ${(performance.now() - t0).toFixed(0)} ms`,
    );
  }
}

