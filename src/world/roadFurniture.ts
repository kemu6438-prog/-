// 道ばたの物（街路樹・街灯・信号）をどこに置くかを決める。純粋な計算（単体テストできる）。
import { SIDEWALK_WIDTH, halfRoad, needsSignal, type RoadLine, type RoadNode } from "./roadData";

export type TreeInst = { x: number; z: number; rot: number; scale: number; tint: number };
export type LampInst = { x: number; z: number; rot: number };
export type SignalInst = { x: number; z: number; rot: number; phase: number; axis: number; reach: number };
export type Furniture = { trees: TreeInst[]; lamps: LampInst[]; signals: SignalInst[] };

function rng(seed: number) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 他の道の車道の上に物を置かないための、線分の格子（空間ハッシュ） */
class SegGrid {
  private cell = 24;
  private map = new Map<number, number[]>();
  private segs: { line: RoadLine; x0: number; z0: number; x1: number; z1: number; r: number }[] = [];
  constructor(lines: RoadLine[]) {
    for (const line of lines) {
      const r = halfRoad(line.rank) + 0.8;
      const p = line.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const id = this.segs.length;
        this.segs.push({ line, x0: p[i], z0: p[i + 1], x1: p[i + 2], z1: p[i + 3], r });
        const minX = Math.min(p[i], p[i + 2]) - r, maxX = Math.max(p[i], p[i + 2]) + r;
        const minZ = Math.min(p[i + 1], p[i + 3]) - r, maxZ = Math.max(p[i + 1], p[i + 3]) + r;
        for (let cx = Math.floor(minX / this.cell); cx <= Math.floor(maxX / this.cell); cx++)
          for (let cz = Math.floor(minZ / this.cell); cz <= Math.floor(maxZ / this.cell); cz++) {
            const k = cx * 100003 + cz;
            let a = this.map.get(k);
            if (!a) this.map.set(k, (a = []));
            a.push(id);
          }
      }
    }
  }
  /** 自分以外の道の車道に入っていれば true */
  blocked(x: number, z: number, self: RoadLine): boolean {
    const a = this.map.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell));
    if (!a) return false;
    for (const id of a) {
      const s = this.segs[id];
      if (s.line === self) continue;
      const dx = s.x1 - s.x0, dz = s.z1 - s.z0;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s.x0) * dx + (z - s.z0) * dz) / l2));
      if (Math.hypot(x - (s.x0 + dx * t), z - (s.z0 + dz * t)) < s.r) return true;
    }
    return false;
  }
}

/** 線の上を一定の間隔で歩きながら、(位置, 向き, 道の端からの距離) を返す */
function* walk(line: RoadLine, start: number, step: number, jitter: () => number) {
  const p = line.pts;
  let s = start;
  let seg = 0;
  let segStart = 0;
  while (seg * 2 + 3 < p.length) {
    const x0 = p[seg * 2], z0 = p[seg * 2 + 1], x1 = p[seg * 2 + 2], z1 = p[seg * 2 + 3];
    const l = Math.hypot(x1 - x0, z1 - z0);
    if (s > segStart + l) {
      segStart += l;
      seg++;
      continue;
    }
    const t = l > 0 ? (s - segStart) / l : 0;
    yield { x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, dx: (x1 - x0) / l, dz: (z1 - z0) / l, s };
    s += step + jitter();
  }
}

export function placeFurniture(lines: RoadLine[], nodes: RoadNode[], opts: { treeRadius: number }): Furniture {
  const grid = new SegGrid(lines);
  const trees: TreeInst[] = [];
  const lamps: LampInst[] = [];
  const signals: SignalInst[] = [];
  const R2 = opts.treeRadius * opts.treeRadius;

  for (const line of lines) {
    if (line.rank < 2 || line.length < 20) continue;
    const r = rng(line.id + 11);
    const hr = halfRoad(line.rank);
    const sw = SIDEWALK_WIDTH[line.rank];
    const treeLine = line.rank >= 3 ? 0.95 : r() < 0.45 ? 0.85 : 0;
    const edgeFree = (s: number, margin: number) =>
      !(line.startShift >= 0 && s < line.startShift + margin) &&
      !(line.endShift >= 0 && line.length - s < line.endShift + margin);

    // 街路樹（道の両側）
    if (treeLine > 0) {
      const step = line.rank >= 3 ? 8.5 : 10.5;
      for (const q of walk(line, 5 + r() * 4, step, () => (r() - 0.5) * 1.6)) {
        if (!edgeFree(q.s, 11)) continue;
        for (const sg of [1, -1]) {
          const x = q.x + -q.dz * sg * (hr + Math.min(1.3, sw * 0.5));
          const z = q.z + q.dx * sg * (hr + Math.min(1.3, sw * 0.5));
          if (x * x + z * z > R2) continue;
          if (r() > treeLine) continue;
          if (grid.blocked(x, z, line)) continue;
          trees.push({ x, z, rot: r() * 6.283, scale: 0.8 + r() * 0.55, tint: r() });
        }
      }
    }
    // 街灯（片側。木と位置がぶつからないようにずらす）
    {
      const sg = r() < 0.5 ? 1 : -1;
      for (const q of walk(line, 16 + r() * 8, 30, () => (r() - 0.5) * 3)) {
        if (!edgeFree(q.s, 8)) continue;
        const off = hr + 0.55;
        const x = q.x + -q.dz * sg * off;
        const z = q.z + q.dx * sg * off;
        if (grid.blocked(x, z, line)) continue;
        // 道の中心へ向かう向きに、腕を伸ばす
        const tx = q.dz * sg, tz = -q.dx * sg;
        lamps.push({ x, z, rot: Math.atan2(-tz, tx) });
      }
    }
  }

  // 信号（交差点の、車が入ってくる道ごとに 1 本）
  for (const node of nodes) {
    if (!needsSignal(node)) continue;
    const phase = rng(node.id + 5)() * 80;
    for (const arm of node.arms) {
      const line = arm.line;
      if (line.rank < 2 || line.length < 22) continue;
      const hr = halfRoad(line.rank);
      const cross = arm.atStart ? line.startShift : line.endShift;
      const along = cross + 6.4;
      // 車は交差点に向かってくる。その左側の歩道に立てる
      const lx = -arm.az, lz = arm.ax;
      const x = node.x + arm.ax * along + lx * (hr + 0.6);
      const z = node.z + arm.az * along + lz * (hr + 0.6);
      signals.push({
        x, z,
        rot: Math.atan2(arm.ax, arm.az),
        phase,
        axis: Math.abs(arm.ax) > Math.abs(arm.az) ? 1 : 0,
        reach: Math.min(hr + 0.3, 7.5),
      });
    }
  }
  return { trees, lamps, signals };
}
