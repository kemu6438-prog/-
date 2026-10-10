// 版 24: 箱（LOD1）の建物に「屋根の形」と「屋上の小物」を付け足す。
// ・低くて小さな建物（戸建てなど）: いちばん長い辺に沿って 切妻屋根（三角の屋根、軒つき）を載せる
// ・平らな屋根のままの建物: 塔屋・室外機・アンテナを載せる（街の空に凸凹が出る）
// three.js に依存しない純粋な処理（型だけ使う）。出力は モデルの座標系（入力と同じ）。

export type ExtrasGeom = { pos: Float32Array; nrm: Float32Array; col: Float32Array; idx: Uint32Array };

/** 3×3 の逆行列（列優先 16 要素の左上 3×3）。無ければ null */
function inv3(e: ArrayLike<number>): number[] | null {
  const a = e[0], b = e[4], c = e[8];
  const d = e[1], f = e[5], g = e[9];
  const h = e[2], i = e[6], j = e[10];
  const A = f * j - g * i, B = g * h - d * j, C = d * i - f * h;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [A * k, (c * i - b * j) * k, (b * g - c * f) * k, B * k, (a * j - c * h) * k, (c * d - a * g) * k, C * k, (b * h - a * i) * k, (a * f - b * d) * k];
}

/** 簡単な決定論ハッシュ（同じ建物にはいつも同じ結果を） */
function hash01(x: number): number {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/** 2D の凸包（x, z が交互に並んだ配列 → 反時計回りの頂点番号） */
function hull2(pts: Float64Array): number[] {
  const n = pts.length / 2;
  const order = [...Array(n).keys()].sort((a, b) => pts[a * 2] - pts[b * 2] || pts[a * 2 + 1] - pts[b * 2 + 1]);
  const cross = (o: number, a: number, b: number) => (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) - (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2]);
  const lower: number[] = [], upper: number[] = [];
  for (const i of order) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop(); lower.push(i); }
  for (let k = n - 1; k >= 0; k--) { const i = order[k]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop(); upper.push(i); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** 頂点を足す入れ物 */
class Bag {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; idx: number[] = [];
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, r: number, g: number, b: number, nx: number, ny: number, nz: number) {
    const k = this.pos.length / 3;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) { this.nrm.push(nx, ny, nz); this.col.push(r, g, b); }
    this.idx.push(k, k + 1, k + 2);
  }
  quad(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, r: number, g: number, b: number, nx: number, ny: number, nz: number) {
    const k = this.pos.length / 3;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let i = 0; i < 4; i++) { this.nrm.push(nx, ny, nz); this.col.push(r, g, b); }
    this.idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  }
}

const ROOF_COLORS: [number, number, number][] = [
  [0.32, 0.36, 0.42], // 瓦（灰）
  [0.45, 0.30, 0.22], // 茶
  [0.25, 0.32, 0.45], // 藍
  [0.50, 0.50, 0.49], // グレー
  [0.38, 0.42, 0.35], // 深緑
];

/** 建物ごとの屋根の三角形（ワールド座標 9 個ずつ）・屋根の高さ・足もとの高さ（収集用） */
type Roof = { tris: number[]; wy: number; minY: number };

/**
 * モデル（LOD1 の箱）から、切妻屋根・屋上小物の幾何を作る。
 * @param g 建物の幾何（モデルの座標）
 * @param idName 建物 ID の頂点属性名（無ければ null → 何もしない）
 * @param toWorld モデルの座標 → 表示の座標（y が上）の行列（列優先 16 要素）
 * @param houses 三角形の屋根を付けるか（住宅らしく見せる設定。?gable=0 で無効）
 */
export function buildRoofExtras(g: { getAttribute(n: string): { getX(i: number): number; getY(i: number): number; getZ(i: number): number; count: number; itemSize: number } | null; index: { getX(i: number): number; count: number } | null }, idName: string | null, toWorld: ArrayLike<number>, houses = true): ExtrasGeom | null {
  const pos = g.getAttribute("position");
  const ids = idName ? g.getAttribute(idName) : null;
  if (!pos || !ids || pos.itemSize < 3) return null;
  const inv = inv3(toWorld);
  if (!inv) return null;
  const t = [toWorld[12], toWorld[13], toWorld[14]];
  const n = pos.count;
  const idx = g.index;
  const tri = idx ? Math.floor(idx.count / 3) : Math.floor(n / 3);

  // --- 建物（ID）ごとに: 屋根の頂点・屋根の高さ・足もとの高さを集める ---
  const byId = new Map<number, Roof>();
  const wp = (i: number): [number, number, number] => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    return [toWorld[0] * x + toWorld[4] * y + toWorld[8] * z + t[0], toWorld[1] * x + toWorld[5] * y + toWorld[9] * z + t[1], toWorld[2] * x + toWorld[6] * y + toWorld[10] * z + t[2]];
  };
  // まずすべての建物の、いちばん低い所（足もと）を調べる
  const minOf = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const y = toWorld[1] * pos.getX(i) + toWorld[5] * pos.getY(i) + toWorld[9] * pos.getZ(i) + t[1];
    const id = ids.getX(i);
    const c = minOf.get(id);
    if (c === undefined || y < c) minOf.set(id, y);
  }
  for (let ti = 0; ti < tri; ti++) {
    const k = ti * 3;
    const a = idx ? idx.getX(k) : k, b = idx ? idx.getX(k + 1) : k + 1, c = idx ? idx.getX(k + 2) : k + 2;
    const A = wp(a), B = wp(b), C = wp(c);
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9 || Math.abs(ny) / len < 0.97) continue; // ほぼ水平な面（屋根）だけ
    const id = ids.getX(a);
    let r = byId.get(id);
    if (!r) { r = { tris: [], wy: -Infinity, minY: minOf.get(id) ?? 0 }; byId.set(id, r); }
    r.tris.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
    const my = Math.max(A[1], B[1], C[1]);
    if (my > r.wy) r.wy = my;
  }
  if (byId.size === 0) return null;

  const bag = new Bag();
  // ワールドで作った点 → モデルの座標に戻す
  const toLocal = (x: number, y: number, z: number): [number, number, number] => {
    const dx = x - t[0], dy = y - t[1], dz = z - t[2];
    return [inv[0] * dx + inv[3] * dy + inv[6] * dz, inv[1] * dx + inv[4] * dy + inv[7] * dz, inv[2] * dx + inv[5] * dy + inv[8] * dz];
  };
  const nLocal = (x: number, y: number, z: number): [number, number, number] => {
    const p = [inv[0] * x + inv[3] * y + inv[6] * z, inv[1] * x + inv[4] * y + inv[7] * z, inv[2] * x + inv[5] * y + inv[8] * z];
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    return [p[0] / l, p[1] / l, p[2] / l];
  };
  const triW = (A: number[], B: number[], C: number[], col: number[], nw: number[]) => {
    const p1 = toLocal(A[0], A[1], A[2]), p2 = toLocal(B[0], B[1], B[2]), p3 = toLocal(C[0], C[1], C[2]);
    const nl = nLocal(nw[0], nw[1], nw[2]);
    bag.tri(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2], col[0], col[1], col[2], nl[0], nl[1], nl[2]);
  };
  const quadW = (A: number[], B: number[], C: number[], D: number[], col: number[], nw: number[]) => {
    const p1 = toLocal(A[0], A[1], A[2]), p2 = toLocal(B[0], B[1], B[2]), p3 = toLocal(C[0], C[1], C[2]), p4 = toLocal(D[0], D[1], D[2]);
    const nl = nLocal(nw[0], nw[1], nw[2]);
    bag.quad(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2], p4[0], p4[1], p4[2], col[0], col[1], col[2], nl[0], nl[1], nl[2]);
  };
  const boxW = (cx: number, cz: number, y0: number, sx: number, sy: number, sz: number, ux: number, uz: number, col: number[]) => {
    // ワールドで箱を作る（toLocal へ渡すため、いったん自前で組み立てる）
    const vx = -uz, vz = ux, hx = sx / 2, hz = sz / 2, y1 = y0 + sy;
    const pt = (a: number, b2: number, y: number) => [cx + ux * a * hx + vx * b2 * hz, y, cz + uz * a * hx + vz * b2 * hz];
    const p = [pt(-1, -1, y0), pt(1, -1, y0), pt(1, 1, y0), pt(-1, 1, y0), pt(-1, -1, y1), pt(1, -1, y1), pt(1, 1, y1), pt(-1, 1, y1)];
    quadW(p[4], p[5], p[6], p[7], col, [0, 1, 0]);
    quadW(p[0], p[5], p[1], p[4], col, [vx * -1 === 0 ? 0 : -vx, 0, -vz]);
    quadW(p[1], p[6], p[2], p[5], col, [ux, 0, uz]);
    quadW(p[2], p[7], p[3], p[6], col, [-vx, 0, -vz]);
    quadW(p[3], p[4], p[0], p[7], col, [-ux, 0, -uz]);
  };

  for (const [id, r] of byId) {
    // いちばん上の面（平らな屋根そのもの）だけを取り出す（床・中間の面は除く）
    const top = r.wy;
    const uniq = new Map<string, number>();
    const pts: number[] = [];
    let roofArea = 0;
    for (let k = 0; k < r.tris.length; k += 9) {
      const y0 = r.tris[k + 1], y1 = r.tris[k + 4], y2 = r.tris[k + 7];
      if (Math.min(y0, y1, y2) < top - 0.6) continue;
      const ax = r.tris[k], az = r.tris[k + 2], bx = r.tris[k + 3], bz = r.tris[k + 5], cx2 = r.tris[k + 6], cz2 = r.tris[k + 8];
      roofArea += Math.abs((bx - ax) * (cz2 - az) - (cx2 - ax) * (bz - az)) / 2;
      for (const [px, pz] of [[ax, az], [bx, bz], [cx2, cz2]] as const) {
        const key = `${px.toFixed(2)},${pz.toFixed(2)}`;
        if (uniq.has(key)) continue;
        uniq.set(key, pts.length / 2);
        pts.push(px, pz);
      }
    }
    if (pts.length / 2 < 3 || pts.length / 2 > 400) continue;
    const h = hull2(Float64Array.from(pts));
    if (h.length < 3) continue;
    // いちばん長い辺の向きを、屋根の流れ（軒の向き）とする
    let best = 0, ux = 1, uz = 0;
    for (let i = 0; i < h.length; i++) {
      const a = h[i] * 2, b = h[(i + 1) % h.length] * 2;
      const dx = pts[b] - pts[a], dz = pts[b + 1] - pts[a + 1];
      const l = dx * dx + dz * dz;
      if (l > best) { best = l; ux = dx / Math.sqrt(l); uz = dz / Math.sqrt(l); }
    }
    // その向きでの外接の四角（OBB）
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    const vx = -uz, vz2 = ux;
    for (const i of h) {
      const u = pts[i * 2] * ux + pts[i * 2 + 1] * uz;
      const v = pts[i * 2] * vx + pts[i * 2 + 1] * vz2;
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
    const L = (uMax - uMin) / 2, W = (vMax - vMin) / 2;
    if (best < 1 || L < 2 || W < 2.2) continue;
    // 本物の屋根の面積 / 外接四角 の割合（L 字など、大きなくぼみのある形には載せない）
    const cx = (uMin + L) * ux + (vMin + W) * vx;
    const cz = (uMin + L) * uz + (vMin + W) * vz2;
    const high = r.wy; // 屋根の面（表示の高さ）
    const hgt = high - r.minY; // 建物の高さ
    const fill = roofArea / (L * W * 4); // 1.0 に近いほど長方形。L 字（大きな欠け）は外す
    const hsh = hash01(id * 1.31);

    if (houses && hgt <= 14 && W <= 9 && L <= 22 && L * W * 4 <= 420 && fill >= 0.92 && hsh < 0.72) {
      // --- 切妻屋根（いちばん長い向きに棟、短い向きに流す。軒つき） ---
      const eave = 0.45;
      const rise = Math.min(Math.max(W * 0.58, 1.1), 3.6); // 勾配 5.8 寸くらい
      const ridgeY = high + rise;
      const eaveY = high + 0.12;
      const col = ROOF_COLORS[Math.floor(hash01(id * 7.7) * ROOF_COLORS.length) % ROOF_COLORS.length];
      const gable: number[] = [0.84, 0.82, 0.78]; // 妻面（壁っぽい色）
      // 勾配に垂直な向き（面の法線。×2 面で反対向き）
      const slope = rise / (W + eave);
      const ny = 1 / Math.hypot(slope, 1);
      for (const sg of [-1, 1]) {
        const nx = vx * slope * -sg * ny, nz2 = vz2 * slope * -sg * ny;
        // 棟の両端 → 軒の両端（長辺方向は棟と同じ長さ、短辺方向は軒ぶん出る）
        const rEnd = (s: number): number[] => [cx + ux * s * (L + eave), ridgeY, cz + uz * s * (L + eave)];
        const eEnd = (s: number): number[] => [cx + ux * s * (L + eave) + vx * sg * (W + eave), eaveY, cz + uz * s * (L + eave) + vz2 * sg * (W + eave)];
        const rm = rEnd(-1), rp2 = rEnd(1), em = eEnd(-1), ep = eEnd(1);
        if (sg > 0) quadW(rm, rp2, ep, em, col, [nx, ny, nz2]);
        else quadW(rm, ep, rp2, em, col, [nx, ny, nz2]);
        // 妻面（三角）。軒の分だけ外に出す
        const gw = (s: number): number[][] => {
          const o = eave * 0.35 * s;
          return [
            [cx + ux * (L + o) * s + vx * (W + eave) - ux * 0, eaveY, cz + uz * (L + o) * s + vz2 * (W + eave)],
            [cx + ux * (L + o) * s - vx * (W + eave), eaveY, cz + uz * (L + o) * s - vz2 * (W + eave)],
            [cx + ux * (L + o) * s, ridgeY, cz + uz * (L + o) * s],
          ];
        };
        const g = gw(sg);
        triW(g[0], g[2], g[1], gable, [ux * sg, 0, uz * sg]);
      }
    } else if (!houses || hgt >= 9) {
      // --- 平らな屋根の小物: 塔屋（高い建物）・室外機（中くらい）・アンテナ ---
      const light: number[] = [0.68, 0.69, 0.70];
      if (hgt >= 18) {
        // 塔屋（階段室の出っ張り）: 端の方に 1 つ
        const s = 2.6 + hash01(id * 3.1) * 1.8;
        boxW(cx + ux * L * 0.52, cz + uz * L * 0.52, high, s, 2.3, s * 0.8, ux, uz, light);
        if (hash01(id * 5.3) < 0.6) {
          // アンテナ（細い棒＋横棒 2 本）
          const ax = cx - ux * L * 0.4, az = cz - uz * L * 0.4;
          const poleH = 4 + hash01(id * 9.7) * 3;
          boxW(ax, az, high, 0.12, poleH, 0.12, ux, uz, [0.35, 0.36, 0.38]);
          for (let i = 1; i <= 2; i++) boxW(ax, az, high + poleH * (0.5 + i * 0.22), 0.1, 0.06, 1.6 - i * 0.3, ux, uz, [0.35, 0.36, 0.38]);
        }
      } else if (hgt >= 5.5 && hash01(id * 11.3) < 0.45) {
        // 室外機 1〜2 台
        const nAC = 1 + (hash01(id * 13.7) < 0.4 ? 1 : 0);
        for (let i = 0; i < nAC; i++) {
          const ox = (hash01(id * 17.9 + i) - 0.5) * L * 1.4;
          const oz = (hash01(id * 19.1 + i) - 0.5) * W * 1.4;
          boxW(cx + ux * ox + vx * oz, cz + uz * ox + vz2 * oz, high, 0.95, 0.7, 0.4, ux, uz, [0.75, 0.76, 0.75]);
        }
      }
    }
  }

  if (bag.idx.length === 0) return null;
  return { pos: Float32Array.from(bag.pos), nrm: Float32Array.from(bag.nrm), col: Float32Array.from(bag.col), idx: Uint32Array.from(bag.idx) };
}
