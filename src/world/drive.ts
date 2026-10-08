// 自動運転で道路を走る「車に乗るモード」の動き（計算だけ。画面や three.js には依存しない）。
//  - 左側通行。道の中心線から少し左を走る
//  - 信号のある交差点では停止線で止まる（赤・黄）。青で発進
//  - 交差点では、まっすぐを優先しつつ、ときどき曲がる
//  - 速さは道の幅の区分ごとの「仮の制限速度」（実際の制限速度のデータは無いため）
import { analyzeNodes, halfRoad, needsSignal, type RoadLine, type RoadNode } from "./roadData";
import { nodePhase } from "./roadFurniture";
import { signalState } from "./signal";

/** 道の幅の区分ごとの制限速度（km/h）。実データが入るまでの仮の値 */
export const LIMIT_KMH = [15, 20, 30, 40, 50];
const ACCEL = 1.3; // m/s²
const DECEL = 1.9; // ふつうのブレーキ
const DECEL_MAX = 3.6; // これより強くは止まれない（黄色で突っ込むかの判断に使う）
export const EYE_Y = 1.25; // 乗っている人の目の高さ（m）

type V2 = { x: number; z: number };
export type Pose = { x: number; z: number; hx: number; hz: number };

/** 線上の位置を、道に沿った距離で引く */
class Poly {
  readonly cum: number[] = [0];
  constructor(readonly pts: Float32Array) {
    for (let i = 2; i < pts.length; i += 2) this.cum.push(this.cum[this.cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
  }
  get length() {
    return this.cum[this.cum.length - 1];
  }
  point(s: number): V2 {
    const c = this.cum;
    const n = c.length;
    if (s <= 0) return { x: this.pts[0], z: this.pts[1] };
    if (s >= c[n - 1]) return { x: this.pts[(n - 1) * 2], z: this.pts[(n - 1) * 2 + 1] };
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (c[m] <= s) lo = m; else hi = m;
    }
    const t = (s - c[lo]) / Math.max(1e-6, c[hi] - c[lo]);
    return { x: this.pts[lo * 2] + (this.pts[hi * 2] - this.pts[lo * 2]) * t, z: this.pts[lo * 2 + 1] + (this.pts[hi * 2 + 1] - this.pts[lo * 2 + 1]) * t };
  }
}

type Piece = {
  kind: "line" | "turn";
  len: number;
  at(u: number): Pose;
  /** 速さの上限（m/s） */
  limit: number;
  /** この部品の終わり（停止線）で守る信号 */
  signal?: { phase: number; axis: number };
  /** kind が line のときだけ: どの道を、どちら向きに走るか */
  line?: RoadLine;
  dir?: 1 | -1;
};

type End = { line: RoadLine; atStart: boolean };

const key = (x: number, z: number) => `${Math.round(x / 1.5)},${Math.round(z / 1.5)}`;

/** 点 a から向き ha へ伸ばした半直線と、点 b の手前（向き hb の逆）へ伸ばした半直線の交点 */
function rayCross(a: Pose, b: Pose): V2 | null {
  const det = a.hx * b.hz - a.hz * b.hx;
  if (Math.abs(det) < 0.05) return null;
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = (dx * b.hz - dz * b.hx) / det; // a から前へ
  const w = (a.hx * dz - a.hz * dx) / det; // b から後ろへ
  if (t < -0.5 || w < -0.5 || t > 45 || w > 45) return null;
  return { x: a.x + a.hx * t, z: a.z + a.hz * t };
}

export class Driver {
  private readonly polys = new Map<RoadLine, Poly>();
  private readonly ends = new Map<string, End[]>();
  private readonly nodeById = new Map<number, RoadNode>();
  private cur: Piece | null = null;
  private queue: Piece[] = [];
  private u = 0;
  speed = 0;
  /** 画面表示用 */
  waiting = false;
  limitKmh = 0;
  pose: Pose = { x: 0, z: 0, hx: 0, hz: -1 };
  yaw = 0;
  private yawInit = false;

  constructor(lines: RoadLine[], nodes: RoadNode[] = analyzeNodes(lines), private readonly rand: () => number = Math.random) {
    for (const n of nodes) this.nodeById.set(n.id, n);
    for (const l of lines) {
      this.polys.set(l, new Poly(l.pts));
      const n = l.pts.length / 2;
      for (const [atStart, i] of [[true, 0], [false, n - 1]] as const) {
        const k = key(l.pts[i * 2], l.pts[i * 2 + 1]);
        const a = this.ends.get(k);
        if (a) a.push({ line: l, atStart }); else this.ends.set(k, [{ line: l, atStart }]);
      }
    }
  }

  get ready() {
    return this.polys.size > 0;
  }

  /** 指定の場所に近い、ある程度太い道の上から出発する。出発できたら true */
  start(x: number, z: number, minRank = 2): boolean {
    type Best = { line: RoadLine; s: number; d: number };
    let best = null as Best | null;
    for (const pass of [minRank, 0]) {
      for (const [line, poly] of this.polys) {
        if (line.rank < pass || line.length < 30) continue;
        for (let s = 0; s <= poly.length; s += 10) {
          const p = poly.point(s);
          const d = Math.hypot(p.x - x, p.z - z);
          if (!best || d < best.d) best = { line, s, d };
        }
      }
      if (best) break;
    }
    if (!best) return false;
    const poly = this.polys.get(best.line)!;
    const dir: 1 | -1 = best.s < poly.length / 2 ? 1 : -1; // 近い端から遠い端へ向かう
    this.cur = this.linePiece(best.line, dir, best.s);
    this.queue = [];
    this.extend();
    this.u = 0;
    this.speed = 0;
    this.yawInit = false;
    this.pose = this.cur.at(0);
    return true;
  }

  private laneOffset(rank: number) {
    return Math.max(0.8, Math.min(3.6, halfRoad(rank) * 0.45));
  }

  /** 道 line を dir の向き（+1: 点の並びの向き / -1: 逆）に、点の並びでの位置 sFrom から、終端の手前（交差点の分）まで走る部品 */
  private linePiece(line: RoadLine, dir: 1 | -1, sFrom: number): Piece {
    const poly = this.polys.get(line)!;
    const L = poly.length;
    const toS = (d: number) => (dir === 1 ? d : L - d); // 進んだ距離 → 点の並びでの位置
    const dFrom = dir === 1 ? sFrom : L - sFrom;
    const towardStart = dir === -1; // 進む先が始点側か
    const shift = towardStart ? line.startShift : line.endShift;
    const nodeId = towardStart ? line.startNode : line.endNode;
    const node = nodeId >= 0 ? this.nodeById.get(nodeId) : undefined;
    const hasSignal = !!node && needsSignal(node) && line.rank >= 2 && line.length >= 22;
    const margin = shift >= 0 ? shift + (hasSignal ? 5.8 : 3.0) : 0;
    const dTo = Math.max(dFrom, L - Math.min(margin, L * 0.45));
    const off = this.laneOffset(line.rank);
    const at = (u: number): Pose => {
      const d = dFrom + Math.max(0, Math.min(u, dTo - dFrom));
      const p0 = poly.point(toS(d - 3));
      const p1 = poly.point(toS(d + 3));
      let hx = dir === 1 ? p1.x - p0.x : p0.x - p1.x;
      let hz = dir === 1 ? p1.z - p0.z : p0.z - p1.z;
      const hl = Math.hypot(hx, hz) || 1;
      hx /= hl; hz /= hl;
      const c = poly.point(toS(d));
      return { x: c.x + hz * off, z: c.z - hx * off, hx, hz }; // 左 = (hz, -hx)
    };
    let signal: Piece["signal"];
    if (hasSignal && node) {
      const arm = node.arms.find((a) => a.line === line && a.atStart === towardStart);
      if (arm) signal = { phase: nodePhase(node.id), axis: Math.abs(arm.ax) > Math.abs(arm.az) ? 1 : 0 };
    }
    return { kind: "line", len: dTo - dFrom, at, limit: LIMIT_KMH[line.rank] / 3.6, signal, line, dir };
  }

  /** 道の部品 prev の終わりから、交差点を抜ける曲線と、次の道の部品を作る */
  private next(prev: Piece): [Piece, Piece] {
    const line = prev.line!;
    const dir = prev.dir!;
    const towardStart = dir === -1;
    const end = prev.at(prev.len);
    const poly = this.polys.get(line)!;
    const endPt = poly.point(towardStart ? 0 : poly.length);
    const cands = (this.ends.get(key(endPt.x, endPt.z)) ?? []).filter((e) => !(e.line === line && e.atStart === towardStart));
    type Cand = { e: End; w: number };
    const list: Cand[] = [];
    for (const e of cands) {
      const p = this.polys.get(e.line)!;
      const o = e.atStart ? p.point(0) : p.point(p.length);
      const a = e.atStart ? p.point(Math.min(8, p.length)) : p.point(Math.max(0, p.length - 8));
      let ax = a.x - o.x, az = a.z - o.z;
      const al = Math.hypot(ax, az) || 1;
      ax /= al; az /= al;
      const dot = ax * end.hx + az * end.hz;
      if (dot < -0.85 && cands.length > 1) continue; // Uターンは他に道があるうちはしない
      const straight = Math.max(0, dot);
      list.push({ e, w: (0.5 + 2.5 * straight * straight) * (1 + e.line.rank * 0.5) * (e.line.length < 15 ? 0.3 : 1) });
    }
    let nl: RoadLine;
    let ndir: 1 | -1;
    let fromStart: boolean;
    if (list.length === 0) {
      // 行き止まり: 同じ道を逆向きに戻る
      nl = line;
      ndir = dir === 1 ? -1 : 1;
      fromStart = !towardStart;
    } else {
      let sum = 0;
      for (const c of list) sum += c.w;
      let r = this.rand() * sum;
      let pick = list[list.length - 1];
      for (const c of list) {
        r -= c.w;
        if (r <= 0) { pick = c; break; }
      }
      nl = pick.e.line;
      fromStart = pick.e.atStart;
      ndir = fromStart ? 1 : -1;
    }
    // 次の道は、出口側の交差点の分だけ内側から走り始める
    const shiftIn = fromStart ? nl.startShift : nl.endShift;
    const nodeId = fromStart ? nl.startNode : nl.endNode;
    const node = nodeId >= 0 ? this.nodeById.get(nodeId) : undefined;
    const sig = !!node && needsSignal(node) && nl.rank >= 2 && nl.length >= 22;
    const skip = shiftIn >= 0 ? Math.min(shiftIn + (sig ? 5.8 : 3.0), nl.length * 0.45) : 0;
    const lp = this.linePiece(nl, ndir, fromStart ? skip : nl.length - skip);
    const start = lp.at(0);
    // ベジェ曲線: 手前の車線の延長線と、次の車線の延長線の交点を制御点にする
    const c: V2 = rayCross(end, start) ?? { x: (end.x + start.x) / 2 + end.hx * 3, z: (end.z + start.z) / 2 + end.hz * 3 };
    const N = 12;
    const bez = (t: number): V2 => {
      const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
      return { x: a * end.x + b * c.x + d * start.x, z: a * end.z + b * c.z + d * start.z };
    };
    const tbl: number[] = [0];
    let pp = bez(0);
    for (let i = 1; i <= N; i++) {
      const p = bez(i / N);
      tbl.push(tbl[i - 1] + Math.hypot(p.x - pp.x, p.z - pp.z));
      pp = p;
    }
    const len = tbl[N];
    const turnAngle = Math.acos(Math.max(-1, Math.min(1, end.hx * start.hx + end.hz * start.hz)));
    const turn: Piece = {
      kind: "turn",
      len,
      at: (u: number): Pose => {
        const uu = Math.max(0, Math.min(len, u));
        let i = 0;
        while (i < N - 1 && tbl[i + 1] < uu) i++;
        const t = (i + (uu - tbl[i]) / Math.max(1e-6, tbl[i + 1] - tbl[i])) / N;
        const p = bez(t);
        const q = bez(Math.min(1, t + 0.03));
        const o = bez(Math.max(0, t - 0.03));
        let hx = q.x - o.x, hz = q.z - o.z;
        const hl = Math.hypot(hx, hz);
        if (hl < 1e-6) return { x: p.x, z: p.z, hx: end.hx, hz: end.hz };
        hx /= hl; hz /= hl;
        return { x: p.x, z: p.z, hx, hz };
      },
      limit: turnAngle > 0.5 ? 4.5 : 8.5,
    };
    return [turn, lp];
  }

  /** 先 2 部品ぶん（曲線＋道）を常に用意しておく */
  private extend() {
    let last: Piece = this.queue.length ? this.queue[this.queue.length - 1] : this.cur!;
    while (this.queue.length < 2) {
      if (last.kind !== "line") break;
      const [t, l] = this.next(last);
      this.queue.push(t, l);
      last = l;
    }
  }

  /** dt: 秒, t: 信号の時計（秒。画面の信号と同じ値） */
  update(dt: number, t: number) {
    const cur = this.cur;
    if (!cur) return;
    dt = Math.min(dt, 0.1);
    const dist = cur.len - this.u;
    let mustStop = false;
    if (cur.signal) {
      const st = signalState(t, cur.signal.phase, cur.signal.axis);
      const canStop = dist > (this.speed * this.speed) / (2 * DECEL_MAX) - 0.6;
      if (st !== 0 && canStop) mustStop = true;
    }
    const nxt = this.queue[0];
    const endV = mustStop ? 0 : Math.min(nxt ? nxt.limit : cur.limit, cur.limit);
    const allowed = Math.sqrt(endV * endV + 2 * DECEL * Math.max(0, dist - (mustStop ? 0.2 : 0)));
    const target = Math.min(cur.limit, allowed);
    if (target > this.speed) this.speed = Math.min(target, this.speed + ACCEL * dt);
    else this.speed = Math.max(target, this.speed - DECEL_MAX * dt);
    if (mustStop && this.speed < 0.05 && dist < 0.8) this.speed = 0;
    this.waiting = mustStop && this.speed < 0.3 && dist < 4;
    this.limitKmh = Math.round(cur.limit * 3.6);

    this.u += this.speed * dt;
    if (mustStop && this.u > cur.len - 0.15) this.u = cur.len - 0.15;
    let guard = 0;
    while (this.cur && this.u >= this.cur.len && this.queue.length > 0 && guard++ < 4) {
      this.u -= this.cur.len;
      this.cur = this.queue.shift()!;
      this.extend();
    }
    const p = this.cur!.at(this.u);
    this.pose = p;
    const ty = Math.atan2(-p.hx, -p.hz);
    if (!this.yawInit) {
      this.yaw = ty;
      this.yawInit = true;
    } else {
      let d = ty - this.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.yaw += d * Math.min(1, dt * 5);
    }
  }

  get speedKmh() {
    return this.speed * 3.6;
  }
}
