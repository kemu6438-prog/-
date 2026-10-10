// 道ばたの物（街路樹・街灯・生け垣など。信号は廃止）をどこに置くかを決める。純粋な計算（単体テストできる）。
import { SIDEWALK_WIDTH, halfRoad, type RoadLine, type RoadNode } from "./roadData";

export type TreeInst = { x: number; z: number; rot: number; scale: number; tint: number };
export type LampInst = { x: number; z: number; rot: number };
/** 生け垣・標識・自動販売機など、向きと大きさだけを持つ小物 */
export type PropInst = { x: number; z: number; rot: number; scale: number; tint: number };
export type Furniture = { trees: TreeInst[]; lamps: LampInst[]; hedges: PropInst[]; signs: PropInst[]; vends: PropInst[]; shrubs: PropInst[]; tufts: PropInst[]; poles: LampInst[]; wires: number[] };

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

export function placeFurniture(lines: RoadLine[], _nodes: RoadNode[], opts: { others?: RoadLine[]; poles?: boolean } = {}): Furniture {
  // となりのタイルの道も「車道に入っているか」の判定に使う（タイルの境目で、他の道の上に置かないため）
  const grid = new SegGrid(opts.others ? lines.concat(opts.others) : lines);
  const trees: TreeInst[] = [];
  const lamps: LampInst[] = [];
  const hedges: PropInst[] = [];
  const signs: PropInst[] = [];
  const vends: PropInst[] = [];
  const shrubs: PropInst[] = [];
  const tufts: PropInst[] = [];
  const poles: LampInst[] = [];
  const wires: number[] = [];

  for (const line of lines) {
    if (line.rank < 2 || line.length < 20) continue;
    const r = rng(line.id + 11);
    const hr = halfRoad(line.rank);
    const sw = SIDEWALK_WIDTH[line.rank];
    // 街路樹は、広い道（13m 以上）にだけ植える（狭い道では建物に埋もれるため）
    const treeLine = line.rank >= 3 ? 0.95 : 0;
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
          if (r() > treeLine * 0.8) continue; // 木は絵の板（軽い）になったので、本数を増やす
          if (grid.blocked(x, z, line)) continue;
          trees.push({ x, z, rot: r() * 6.283, scale: 0.8 + r() * 0.55, tint: r() });
        }
      }
    }
    // 歩道ぞいの小物: 生け垣（植え込み）・低木・草むら・自動販売機・道路標識（建物に埋もれないよう歩道の上に置く）
    {
      const rp = rng(line.id + 777);
      const ok = (x: number, z: number) => !grid.blocked(x, z, line);
      for (const sg of [1, -1]) {
        const at = (q: { x: number; z: number; dx: number; dz: number }, off: number) => ({ x: q.x - q.dz * sg * off, z: q.z + q.dx * sg * off });
        // 生け垣
        for (const q of walk(line, rp() * 9, 8, () => (rp() - 0.5) * 6)) {
          if (!edgeFree(q.s, 10) || rp() > 0.5) continue;
          const o = at(q, hr + sw - 0.3);
          if (!ok(o.x, o.z)) continue;
          hedges.push({ x: o.x, z: o.z, rot: Math.atan2(-q.dz, q.dx), scale: 2.5 + rp() * 4, tint: rp() });
        }
        // 低木（丸い茂み・草のように見える葉の板）は、やめた（shrubs は常に空）。生け垣（四角い塊）は残す
        // 草むら（地面に生える草の板）は、いったんやめた（tufts は常に空）
        // 自動販売機（歩道の建物側。道のほうを向く）
        for (const q of walk(line, rp() * 24, 24, () => (rp() - 0.5) * 12)) {
          if (!edgeFree(q.s, 12) || rp() > 0.38) continue;
          const o = at(q, hr + sw - 0.7);
          if (!ok(o.x, o.z)) continue;
          vends.push({ x: o.x, z: o.z, rot: Math.atan2(q.dz * sg, -q.dx * sg), scale: 1, tint: rp() });
        }
        // 道路標識（縁石のそば。道の流れに向けて）
        for (const q of walk(line, rp() * 35, 35, () => (rp() - 0.5) * 14)) {
          if (!edgeFree(q.s, 14) || rp() > 0.55) continue;
          const o = at(q, hr + 0.6);
          if (!ok(o.x, o.z)) continue;
          signs.push({ x: o.x, z: o.z, rot: Math.atan2(-q.dx, -q.dz) + (sg > 0 ? 0 : Math.PI), scale: 1, tint: rp() });
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
    // 版 24: 電柱と電線（少なめ。広い道の片側に、およそ 60 m おき。以前「なし」で、見た目重視で少し戻す）
    if (opts.poles && line.length >= 50) {
      const sg = rng(line.id + 3131)() < 0.5 ? 1 : -1;
      const off = hr + 0.45;
      const rpp = rng(line.id + 3131);
      let prev: { x: number; z: number } | null = null;
      for (const q of walk(line, 8 + rpp() * 22, 58, () => 0)) {
        if (!edgeFree(q.s, 10)) { prev = null; continue; }
        const x = q.x - q.dz * sg * off, z = q.z + q.dx * sg * off;
        if (grid.blocked(x, z, line)) { prev = null; continue; }
        // 腕は道と直角（道の中心側 → 歩道側の向き）
        const ax = -q.dz * sg, az = q.dx * sg;
        poles.push({ x, z, rot: Math.atan2(-az, ax) });
        if (prev) {
          // 電線 3 本（てっぺん 1 本・腕の両はし 2 本）。少したるませる（4 つの短い線分で近似的に）
          const d = Math.hypot(x - prev.x, z - prev.z);
          if (d <= 90) {
            const sag = Math.min(Math.max(d * 0.035, 0.3), 2.0);
            for (const [yA, yB, armA, armB] of [[11.75, 11.75, 0, 0], [10.1, 10.1, 1.08, 1.08], [10.1, 10.1, -1.08, -1.08]] as const) {
              const x0 = prev.x + ax * armA, z0 = prev.z + az * armA;
              const x1 = x + ax * armB, z1 = z + az * armB;
              for (let i = 0; i < 4; i++) {
                const t0 = i / 4, t1 = (i + 1) / 4;
                const dip = (tt: number) => 4 * sag * tt * (1 - tt); // 両はし 0、真ん中がいちばん下がる放物線
                wires.push(
                  x0 + (x1 - x0) * t0, yA + (yB - yA) * t0 - dip(t0), z0 + (z1 - z0) * t0,
                  x0 + (x1 - x0) * t1, yA + (yB - yA) * t1 - dip(t1), z0 + (z1 - z0) * t1,
                );
              }
            }
          }
        }
        prev = { x, z };
      }
    }
  }

  return { trees, lamps, hedges, signs, vends, shrubs, tufts, poles, wires };
}
