// 道の中心線から、地面に貼りつく帯（リボン）の形を作る。純粋な計算（単体テストできる）。
import { SIDEWALK_WIDTH, halfRoad, type RoadLine } from "./roadData";

export type Ribbon = {
  position: Float32Array;
  normal: Float32Array;
  /** (道の中心からの横の距離 m, 線に沿った距離 m) */
  rpos: Float32Array;
  /** (道の幅の半分, 幅員区分, 始点側の交差点からの距離, 終点側の交差点からの距離) */
  rd: Float32Array;
  index: Uint32Array;
  vertexCount: number;
};

/**
 * @param extra 道の縁から外側へ広げる幅（歩道用）。0 なら車道だけ
 * @param y     帯の高さ
 */
export function buildRibbon(lines: RoadLine[], extra: (rank: number) => number, y: number): Ribbon {
  // 先に頂点の数を数える
  let nv = 0;
  let ni = 0;
  const cleaned: { line: RoadLine; p: number[] }[] = [];
  for (const line of lines) {
    if (extra(line.rank) < 0) continue;
    const p: number[] = [];
    for (let i = 0; i < line.pts.length; i += 2) {
      const x = line.pts[i], z = line.pts[i + 1];
      const n = p.length;
      if (n >= 2 && Math.hypot(x - p[n - 2], z - p[n - 1]) < 0.05) continue;
      p.push(x, z);
    }
    if (p.length < 4) continue;
    cleaned.push({ line, p });
    nv += (p.length / 2) * 2;
    ni += (p.length / 2 - 1) * 6;
  }
  const position = new Float32Array(nv * 3);
  const normal = new Float32Array(nv * 3);
  const rpos = new Float32Array(nv * 2);
  const rd = new Float32Array(nv * 4);
  const index = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const { line, p } of cleaned) {
    const n = p.length / 2;
    const hr = halfRoad(line.rank);
    const w = hr + extra(line.rank);
    // 区間ごとの向き
    const dxs: number[] = [], dzs: number[] = [], cum: number[] = [0];
    for (let i = 0; i < n - 1; i++) {
      const dx = p[i * 2 + 2] - p[i * 2], dz = p[i * 2 + 3] - p[i * 2 + 1];
      const l = Math.hypot(dx, dz);
      dxs.push(dx / l);
      dzs.push(dz / l);
      cum.push(cum[i] + l);
    }
    const total = cum[n - 1];
    const base = vo;
    for (let i = 0; i < n; i++) {
      // この点での向き（前後の区間の平均）。右側の法線 = (-dz, dx)
      const a = Math.max(0, i - 1), b = Math.min(n - 2, i);
      let nx = -dzs[a] - dzs[b], nz = dxs[a] + dxs[b];
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl;
      nz /= nl;
      // 角の所で幅が縮まないように伸ばす（伸ばしすぎない）
      const cosHalf = Math.max(0.4, nx * -dzs[b] + nz * dxs[b]);
      const m = w / cosHalf;
      const s = cum[i];
      const dS = line.startShift >= 0 ? s - line.startShift : s + 1000;
      const dE = line.endShift >= 0 ? total - s - line.endShift : total - s + 1000;
      for (let side = 0; side < 2; side++) {
        const sg = side === 0 ? 1 : -1; // 0: 右, 1: 左
        const k = vo++;
        position[k * 3] = p[i * 2] + nx * m * sg;
        position[k * 3 + 1] = y;
        position[k * 3 + 2] = p[i * 2 + 1] + nz * m * sg;
        normal[k * 3 + 1] = 1;
        rpos[k * 2] = w * sg;
        rpos[k * 2 + 1] = s;
        rd[k * 4] = hr;
        rd[k * 4 + 1] = line.rank;
        rd[k * 4 + 2] = dS;
        rd[k * 4 + 3] = dE;
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const a0 = base + i * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
      // 上から見て表になる向き（右 → 次の右 → 左）
      index[io++] = a0; index[io++] = a1; index[io++] = b0;
      index[io++] = b0; index[io++] = a1; index[io++] = b1;
    }
  }
  return { position, normal, rpos, rd, index, vertexCount: vo };
}

export const roadExtra = () => 0;
export const sidewalkExtra = (rank: number) => (SIDEWALK_WIDTH[rank] > 0 ? SIDEWALK_WIDTH[rank] : -1);
