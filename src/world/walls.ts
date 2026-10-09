// 建物（LOD1 の箱）の壁ごとの「横方向の向き」を、読み込み時に頂点へ書き込む。
//
// 壁の窓の並び（横方向の座標 u）は「位置 · 壁の向き」で計算する。
// 以前は壁の向きを画面の変化量（dFdx/dFdy）から画素ごとに求めていたが、GPU の計算誤差で画素ごとに少し揺れる。
// その揺れが「建物の座標の大きさ（数百 m）」倍に拡大されて、窓の縁がざらざらにじんでいた。
// 頂点に書き込んだ向きは、同じ壁の中でどの頂点も同じ値なので、補間しても揺れない。
//
// ついでに、屋根（水平な面）の輪郭を Footprints に書き込む（街路樹などを建物から避けるため）。
import { BufferAttribute, BufferGeometry } from "three";
import type { Footprints } from "./footprints";

/** 向きの正負をそろえる基準（0 度・45 度・90 度のような、よくある壁の向きを避けた半端な角度） */
const REF = { x: Math.cos(0.37), z: Math.sin(0.37) };
/** 同じ壁とみなす向きの違い（約 1.7 度） */
const SAME = 0.03;

export const WALL_ATTR = "wallT";

export type WallStats = { walls: number; roofs: number; duplicated: number };

/** 向きの属性が無い・作れなかったときの既定値（x 方向）を入れる */
export function ensureWallAttribute(g: BufferGeometry) {
  if (g.getAttribute(WALL_ATTR)) return;
  const n = g.getAttribute("position")?.count ?? 0;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) a[i * 2] = 1;
  g.setAttribute(WALL_ATTR, new BufferAttribute(a, 2));
}

/**
 * @param toWorld モデルの座標 → 表示の座標（y が上）の行列（列優先 16 要素）
 * @param fp 屋根の輪郭の書き込み先（省略可）
 */
export function addWallTangents(g: BufferGeometry, toWorld: ArrayLike<number>, fp?: Footprints | null): WallStats | null {
  const pos = g.getAttribute("position");
  if (!pos || pos.itemSize < 3) { ensureWallAttribute(g); return null; }
  const n = pos.count;
  const idx = g.index;
  const tri = idx ? Math.floor(idx.count / 3) : Math.floor(n / 3);
  const m = toWorld;
  // 表示の座標に直した頂点
  const wx = new Float64Array(n), wy = new Float64Array(n), wz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    wx[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    wy[i] = m[1] * x + m[5] * y + m[9] * z + m[13];
    wz[i] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  const ia = idx ? idx.array : null;
  const tx = new Float32Array(n), tz = new Float32Array(n);
  const set = new Uint8Array(n);
  // 向きが食い違う頂点（別の壁と共有している角）は、頂点を複製して別々の向きを持たせる
  const extraSrc: number[] = [];
  const extraT: number[] = [];
  const dups = new Map<number, number[]>(); // 元の頂点 → 複製した頂点の番号
  const newIndex: Array<[number, number]> = []; // [index 配列の位置, 新しい頂点番号]
  const canDup = !!ia && ![...Object.values(g.attributes)].some((a) => (a as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute);
  let walls = 0, roofs = 0;
  const roofList: number[] = [];

  for (let t = 0; t < tri; t++) {
    const k = t * 3;
    const a = ia ? ia[k] : k, b = ia ? ia[k + 1] : k + 1, c = ia ? ia[k + 2] : k + 2;
    const ux = wx[b] - wx[a], uy = wy[b] - wy[a], uz = wz[b] - wz[a];
    const vx = wx[c] - wx[a], vy = wy[c] - wy[a], vz = wz[c] - wz[a];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    const upy = Math.abs(ny) / len;
    if (upy >= 0.5) {
      // 屋根・床（水平に近い面）
      if (fp && upy > 0.97) { roofList.push(wx[a], wz[a], wx[b], wz[b], wx[c], wz[c]); roofs++; }
      continue;
    }
    // 壁。横方向の向き = (-nz, nx)。正負は、巻き方向に左右されないようにそろえる
    const hl = Math.hypot(nx, nz);
    let ex = -nz / hl, ez = nx / hl;
    if (ex * REF.x + ez * REF.z < 0) { ex = -ex; ez = -ez; }
    walls++;
    for (let s = 0; s < 3; s++) {
      const v = s === 0 ? a : s === 1 ? b : c;
      if (!set[v]) { set[v] = 1; tx[v] = ex; tz[v] = ez; continue; }
      if (Math.hypot(tx[v] - ex, tz[v] - ez) <= SAME) continue;
      if (!canDup) continue; // 複製できないときは、最初の向きのままにする
      let found = -1;
      const list = dups.get(v);
      if (list) for (const d of list) { const q = (d - n) * 2; if (Math.hypot(extraT[q] - ex, extraT[q + 1] - ez) <= SAME) { found = d; break; } }
      if (found < 0) {
        found = n + extraSrc.length;
        extraSrc.push(v);
        extraT.push(ex, ez);
        if (list) list.push(found); else dups.set(v, [found]);
      }
      newIndex.push([k + s, found]);
    }
  }

  const extra = extraSrc.length;
  const total = n + extra;
  const out = new Float32Array(total * 2);
  for (let i = 0; i < n; i++) { out[i * 2] = set[i] ? tx[i] : 1; out[i * 2 + 1] = set[i] ? tz[i] : 0; }
  for (let j = 0; j < extra; j++) { out[(n + j) * 2] = extraT[j * 2]; out[(n + j) * 2 + 1] = extraT[j * 2 + 1]; }

  if (extra > 0 && idx && ia) {
    // すべての属性を、複製した頂点ぶん延ばす
    for (const name of Object.keys(g.attributes)) {
      const at = g.getAttribute(name) as BufferAttribute;
      const is = at.itemSize;
      const Ctor = at.array.constructor as new (len: number) => typeof at.array;
      const arr = new Ctor(total * is);
      arr.set(at.array.subarray(0, n * is));
      for (let j = 0; j < extra; j++) arr.set(at.array.subarray(extraSrc[j] * is, extraSrc[j] * is + is), (n + j) * is);
      g.setAttribute(name, new BufferAttribute(arr, is, at.normalized));
    }
    const Ix = total > 65535 ? Uint32Array : (ia.constructor as typeof Uint32Array);
    const ni = new Ix(ia.length);
    ni.set(ia);
    for (const [at, v] of newIndex) ni[at] = v;
    g.setIndex(new BufferAttribute(ni, 1));
  }
  g.setAttribute(WALL_ATTR, new BufferAttribute(out, 2));
  if (fp && roofList.length) fp.enqueue(Float32Array.from(roofList)); // 屋根の輪郭は、あとで少しずつ書き込む（読み込みの瞬間に時間をかけない）
  return { walls, roofs, duplicated: extra };
}
