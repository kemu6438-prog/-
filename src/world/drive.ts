// 自動運転で道路を走る「車に乗るモード」の動き（計算だけ。画面や three.js には依存しない）。
//  - 左側通行。道の中心線から少し左の車線を走る
//  - 道の折れ曲がりはなめらかな曲線に直して、曲がり角はカーブの強さに応じて減速する
//  - 信号のある交差点では停止線で止まる（赤・黄）。青で発進
//  - 交差点では、まっすぐを優先しつつ、ときどき曲がる。行き止まりではＵターンする
//  - 速さは道の幅の区分ごとの「仮の制限速度」（実際の制限速度のデータは無いため）
import { analyzeNodes, halfRoad, needsSignal, type RoadLine, type RoadNode } from "./roadData";
import { nodePhase } from "./roadFurniture";
import { signalState } from "./signal";

/** 道の幅の区分ごとの制限速度（km/h）。実データが入るまでの仮の値 */
export const LIMIT_KMH = [30, 30, 40, 50, 60];
const ACCEL = 1.7; // m/s²
const DECEL = 1.3; // ふつうのブレーキ（先読みの計算に使う）
const DECEL_MAX = 3.8; // これより強くは止まれない
const JERK = 2.6; // 加速度の変わり方（m/s³）。小さいほど、ゆったり
const LAT_ACC = 2.6; // カーブで横にかかってよい加速度（m/s²）
const STEP = 1.0; // 道を点に直すときの間隔（m）
export const EYE_Y = 1.25; // 乗っている人の目の高さ（m）

type V2 = { x: number; z: number };
export type Pose = { x: number; z: number; hx: number; hz: number };

/** 曲がり角を丸める（Chaikin）。両端の位置と向きは変えない */
function chaikin(p: V2[], times: number): V2[] {
  let a = p;
  for (let k = 0; k < times; k++) {
    if (a.length < 3) break;
    const b: V2[] = [a[0]];
    for (let i = 0; i + 1 < a.length; i++) {
      const p0 = a[i], p1 = a[i + 1];
      if (i > 0) b.push({ x: 0.75 * p0.x + 0.25 * p1.x, z: 0.75 * p0.z + 0.25 * p1.z });
      if (i + 2 < a.length) b.push({ x: 0.25 * p0.x + 0.75 * p1.x, z: 0.25 * p0.z + 0.75 * p1.z });
    }
    b.push(a[a.length - 1]);
    a = b;
  }
  return a;
}

/** 一定の間隔の点列。位置・向き・カーブでの速さの上限を、道に沿った距離で引ける */
class Path {
  readonly x: number[] = [];
  readonly z: number[] = [];
  readonly hx: number[] = [];
  readonly hz: number[] = [];
  /** 各点での、カーブから決まる速さの上限（m/s） */
  readonly lim: number[] = [];
  readonly len: number;
  private readonly step: number;

  constructor(raw: V2[]) {
    // 一定間隔に取り直す
    const pts: V2[] = [raw[0]];
    let carry = 0;
    for (let i = 0; i + 1 < raw.length; i++) {
      const a = raw[i], b = raw[i + 1];
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      if (l < 1e-6) continue;
      let s = STEP - carry;
      while (s <= l) {
        pts.push({ x: a.x + ((b.x - a.x) * s) / l, z: a.z + ((b.z - a.z) * s) / l });
        s += STEP;
      }
      carry = l - (s - STEP);
    }
    const last = raw[raw.length - 1];
    const tail = pts[pts.length - 1];
    if (Math.hypot(last.x - tail.x, last.z - tail.z) > 0.05) pts.push(last);
    if (pts.length < 2) pts.push({ x: last.x + 0.01, z: last.z });
    const n = pts.length;
    for (const p of pts) { this.x.push(p.x); this.z.push(p.z); }
    // 向き: 前後 2 点（約 ±2m）の差。両端は片側だけ
    const K = 2;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - K), b = Math.min(n - 1, i + K);
      let dx = this.x[b] - this.x[a], dz = this.z[b] - this.z[a];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      this.hx.push(dx); this.hz.push(dz);
    }
    // カーブの強さ（向きの変わり方）から、速さの上限
    const raw2: number[] = [];
    const W = 3;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - W), b = Math.min(n - 1, i + W);
      const dot = Math.max(-1, Math.min(1, this.hx[a] * this.hx[b] + this.hz[a] * this.hz[b]));
      const ang = Math.acos(dot);
      const ds = Math.max(1, (b - a) * STEP);
      const kappa = ang / ds;
      raw2.push(kappa < 1e-3 ? 99 : Math.sqrt(LAT_ACC / kappa));
    }
    // 近くの最小値にそろえる（カーブの手前で先に減速できるように）
    for (let i = 0; i < n; i++) {
      let m = 99;
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) m = Math.min(m, raw2[j]);
      this.lim.push(m);
    }
    // 最後の区間だけ STEP より短いことがあるので、長さを実際の合計にする
    let tot = 0;
    for (let i = 1; i < n; i++) tot += Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]);
    this.len = tot;
    this.step = tot / (n - 1);
  }

  private idx(s: number): [number, number] {
    const n = this.x.length;
    const f = Math.max(0, Math.min(n - 1 - 1e-9, s / this.step));
    const i = Math.floor(f);
    return [i, f - i];
  }

  at(s: number): Pose {
    const [i, t] = this.idx(s);
    let hx = this.hx[i] + (this.hx[i + 1] - this.hx[i]) * t;
    let hz = this.hz[i] + (this.hz[i + 1] - this.hz[i]) * t;
    const l = Math.hypot(hx, hz) || 1;
    hx /= l; hz /= l;
    return { x: this.x[i] + (this.x[i + 1] - this.x[i]) * t, z: this.z[i] + (this.z[i + 1] - this.z[i]) * t, hx, hz };
  }

  limAt(s: number): number {
    const [i, t] = this.idx(s);
    return this.lim[i] + (this.lim[i + 1] - this.lim[i]) * t;
  }
}

type Piece = {
  kind: "line" | "turn";
  path: Path;
  /** 点列の中で、この部品が始まる距離 */
  from: number;
  len: number;
  /** 道の区分で決まる速さの上限（m/s） */
  limit: number;
  /** この部品の終わり（停止線）で守る信号 */
  signal?: { phase: number; axis: number };
  /** kind が line のときだけ: どの道を、どちら向きに走るか */
  line?: RoadLine;
  dir?: 1 | -1;
};

const pieceAt = (p: Piece, u: number): Pose => p.path.at(p.from + Math.max(0, Math.min(u, p.len)));
const pieceLim = (p: Piece, u: number): number => Math.min(p.limit, p.path.limAt(p.from + Math.max(0, Math.min(u, p.len))));

type End = { line: RoadLine; atStart: boolean };

const key = (x: number, z: number) => `${Math.round(x / 1.5)},${Math.round(z / 1.5)}`;

/** 点 a から向き ha へ伸ばした半直線と、点 b の手前（向き hb の逆）へ伸ばした半直線の交点 */
function rayCross(a: Pose, b: Pose, maxT: number): (V2 & { t: number; w: number }) | null {
  const det = a.hx * b.hz - a.hz * b.hx;
  if (Math.abs(det) < 0.08) return null;
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = (dx * b.hz - dz * b.hx) / det; // a から前へ
  const w = (a.hx * dz - a.hz * dx) / det; // b から後ろへ
  if (t < -0.5 || w < -0.5 || t > maxT || w > maxT) return null;
  return { x: a.x + a.hx * t, z: a.z + a.hz * t, t, w };
}

/** 交差点の手前の止まる位置 / 通り抜けるときの余白（交差点の縁から、車の中心まで） */
const MARGIN_SIGNAL = 7.4;
const MARGIN_PLAIN = 3.2;

export class Driver {
  private readonly rawLines = new Map<RoadLine, V2[]>();
  private readonly lanes = new Map<string, { path: Path; L: number }>();
  private readonly ends = new Map<string, End[]>();
  private readonly nodeById = new Map<number, RoadNode>();
  private cur: Piece | null = null;
  private queue: Piece[] = [];
  private u = 0;
  /** 青のまま通り抜けると決めた信号の部品 */
  private committed: Piece | null = null;
  speed = 0;
  private acc = 0;
  /** 画面表示用 */
  waiting = false;
  limitKmh = 0;
  pose: Pose = { x: 0, z: 0, hx: 0, hz: -1 };
  /** なめらかにした車の向き（カメラの yaw と同じ約束: 前 = (-sin, -cos)） */
  yaw = 0;
  private yawInit = false;

  constructor(lines: RoadLine[], nodes: RoadNode[] = analyzeNodes(lines), private readonly rand: () => number = Math.random) {
    for (const n of nodes) this.nodeById.set(n.id, n);
    for (const l of lines) {
      const pts: V2[] = [];
      for (let i = 0; i + 1 < l.pts.length; i += 2) {
        const x = l.pts[i], z = l.pts[i + 1];
        const q = pts[pts.length - 1];
        if (q && Math.hypot(x - q.x, z - q.z) < 0.3) continue;
        pts.push({ x, z });
      }
      if (pts.length < 2) continue;
      this.rawLines.set(l, pts);
      for (const [atStart, p] of [[true, pts[0]], [false, pts[pts.length - 1]]] as const) {
        const k = key(p.x, p.z);
        const a = this.ends.get(k);
        if (a) a.push({ line: l, atStart }); else this.ends.set(k, [{ line: l, atStart }]);
      }
    }
  }

  get ready() {
    return this.rawLines.size > 0;
  }

  private laneOffset(rank: number) {
    return Math.max(0.8, Math.min(3.6, halfRoad(rank) * 0.45));
  }

  /** 道の端から、どれだけ手前で止まる・曲がり始めるか（交差点の縁から車の中心まで）。交差点でなくても、他の道とつながる端では余白を取る */
  private endMargin(line: RoadLine, atStart: boolean, signal: boolean): number {
    const shift = atStart ? line.startShift : line.endShift;
    if (shift >= 0) return shift + (signal ? MARGIN_SIGNAL : MARGIN_PLAIN);
    const pts = this.rawLines.get(line)!;
    const p = atStart ? pts[0] : pts[pts.length - 1];
    const others = (this.ends.get(key(p.x, p.z)) ?? []).length > 1;
    return others ? 2.5 + 2 * this.laneOffset(line.rank) : 0;
  }

  /** 道 line を dir の向きに走るときの、左の車線の点列（曲がり角は丸めてある）。L は中心線の長さ */
  private lane(line: RoadLine, dir: 1 | -1): { path: Path; L: number } {
    const k = `${line.id}:${dir}`;
    const hit = this.lanes.get(k);
    if (hit) return hit;
    const src = this.rawLines.get(line)!;
    const pts = dir === 1 ? src : [...src].reverse();
    const off = this.laneOffset(line.rank);
    const n = pts.length;
    const seg: V2[] = []; // 区間ごとの進行方向
    let L = 0;
    for (let i = 0; i + 1 < n; i++) {
      const dx = pts[i + 1].x - pts[i].x, dz = pts[i + 1].z - pts[i].z;
      const l = Math.hypot(dx, dz) || 1;
      L += l;
      seg.push({ x: dx / l, z: dz / l });
    }
    const shifted: V2[] = [];
    for (let i = 0; i < n; i++) {
      const a = seg[Math.max(0, i - 1)], b = seg[Math.min(n - 2, i)];
      let hx = a.x + b.x, hz = a.z + b.z;
      const hl = Math.hypot(hx, hz);
      if (hl < 1e-6) { hx = b.x; hz = b.z; } else { hx /= hl; hz /= hl; }
      // 左 = (hz, -hx)。急な角では離れすぎないように伸ばす量を抑える
      const cosHalf = Math.max(0.5, hx * b.x + hz * b.z);
      const m = off / cosHalf;
      shifted.push({ x: pts[i].x + hz * m, z: pts[i].z - hx * m });
    }
    const path = new Path(chaikin(shifted, 3));
    const res = { path, L };
    this.lanes.set(k, res);
    return res;
  }

  /** 道 line を dir の向きに、点の並びでの位置 sFrom から、終端の手前（交差点の分）まで走る部品 */
  private linePiece(line: RoadLine, dir: 1 | -1, sFrom: number): Piece {
    const { path, L } = this.lane(line, dir);
    const scale = path.len / L;
    const dFrom = dir === 1 ? sFrom : L - sFrom;
    const towardStart = dir === -1; // 進む先が始点側か
    const shift = towardStart ? line.startShift : line.endShift;
    const nodeId = towardStart ? line.startNode : line.endNode;
    const node = nodeId >= 0 ? this.nodeById.get(nodeId) : undefined;
    const hasSignal = !!node && needsSignal(node) && line.rank >= 2 && line.length >= 22;
    const margin = this.endMargin(line, towardStart, hasSignal);
    const dTo = Math.max(dFrom, L - Math.min(margin, L * 0.45));
    let signal: Piece["signal"];
    if (hasSignal && node) {
      const arm = node.arms.find((a) => a.line === line && a.atStart === towardStart);
      if (arm) signal = { phase: nodePhase(node.id), axis: Math.abs(arm.ax) > Math.abs(arm.az) ? 1 : 0 };
    }
    const from = Math.min(dFrom * scale, path.len);
    const to = Math.max(from, Math.min(dTo * scale, path.len));
    return { kind: "line", path, from, len: to - from, limit: LIMIT_KMH[Math.max(0, Math.min(4, line.rank))] / 3.6, signal, line, dir };
  }

  /** 指定の場所に近い、ある程度太い道の上から出発する。出発できたら true */
  start(x: number, z: number, minRank = 2): boolean {
    type Best = { line: RoadLine; s: number; d: number };
    let best = null as Best | null;
    for (const pass of [minRank, 0]) {
      for (const [line, pts] of this.rawLines) {
        if (line.rank < pass || line.length < 30) continue;
        let s = 0;
        for (let i = 0; i < pts.length; i++) {
          if (i > 0) {
            const a = pts[i - 1], b = pts[i];
            const l = Math.hypot(b.x - a.x, b.z - a.z);
            // 区間の途中も 8m おきに調べる（点の少ない長い直線でも、いちばん近い所から出発できるように）
            for (let k = 8; k < l; k += 8) {
              const px = a.x + ((b.x - a.x) * k) / l, pz = a.z + ((b.z - a.z) * k) / l;
              const d = Math.hypot(px - x, pz - z);
              if (!best || d < best.d) best = { line, s: s + k, d };
            }
            s += l;
          }
          const d = Math.hypot(pts[i].x - x, pts[i].z - z);
          if (!best || d < best.d) best = { line, s, d };
        }
      }
      if (best) break;
    }
    if (!best) return false;
    const dir: 1 | -1 = best.s < best.line.length / 2 ? 1 : -1; // 近い端から遠い端へ向かう
    // 点の並びでの位置 → 線の長さに合わせる
    const L = this.lane(best.line, dir).L;
    this.cur = this.linePiece(best.line, dir, Math.min(best.s, L));
    this.queue = [];
    this.extend();
    this.u = 0;
    this.speed = 0;
    this.acc = 0;
    this.committed = null;
    this.pose = pieceAt(this.cur, 0);
    this.yaw = Math.atan2(-this.pose.hx, -this.pose.hz);
    this.yawInit = true;
    return true;
  }

  /** 道の部品 prev の終わりから、交差点を抜ける曲線と、次の道の部品を作る */
  private next(prev: Piece): [Piece, Piece] {
    const line = prev.line!;
    const dir = prev.dir!;
    const towardStart = dir === -1;
    const end = pieceAt(prev, prev.len);
    const pts = this.rawLines.get(line)!;
    const endPt = towardStart ? pts[0] : pts[pts.length - 1];
    const cands = (this.ends.get(key(endPt.x, endPt.z)) ?? []).filter((e) => !(e.line === line && e.atStart === towardStart));
    type Cand = { e: End; w: number };
    const list: Cand[] = [];
    for (const e of cands) {
      const q = this.rawLines.get(e.line)!;
      const o = e.atStart ? q[0] : q[q.length - 1];
      // 出ていく向き: 端から 8m ほど先の点
      let acc = 0, ax = 0, az = 0;
      for (let i = 1; i < q.length; i++) {
        const a = e.atStart ? q[i - 1] : q[q.length - i];
        const b = e.atStart ? q[i] : q[q.length - 1 - i];
        acc += Math.hypot(b.x - a.x, b.z - a.z);
        ax = b.x - o.x; az = b.z - o.z;
        if (acc >= 8) break;
      }
      const al = Math.hypot(ax, az) || 1;
      ax /= al; az /= al;
      const dot = ax * end.hx + az * end.hz;
      if (dot < -0.85 && cands.length > 1) continue; // Uターンは他に道があるうちはしない
      const straight = Math.max(0, dot);
      list.push({ e, w: (0.5 + 2.5 * straight * straight) * (1 + e.line.rank * 0.7) * (e.line.length < 15 ? 0.3 : 1) });
    }
    let nl: RoadLine;
    let ndir: 1 | -1;
    let fromStart: boolean;
    if (list.length === 0) {
      // 行き止まり: 同じ道を逆向きに戻る
      nl = line;
      ndir = dir === 1 ? -1 : 1;
      fromStart = towardStart; // 行き止まりの端から、同じ道に逆向きで入り直す
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
    const skip = Math.min(this.endMargin(nl, fromStart, sig), nl.length * 0.45);
    const lp = this.linePiece(nl, ndir, fromStart ? skip : nl.length - skip);
    const start = pieceAt(lp, 0);

    // 曲線: 手前の車線の延長線と、次の車線の延長線の交点を制御点にした 2 次ベジェ（Ｕターンは 3 次）
    const chord = Math.hypot(start.x - end.x, start.z - end.z);
    const dotH = end.hx * start.hx + end.hz * start.hz;
    let samples: V2[];
    const M = 28;
    let turnR = 99; // 曲がる半径（m）。速さの上限に使う
    if (dotH < -0.9) {
      // Ｕターン（行き止まり）: 右側（反対車線）へ大きく回る
      const k = Math.max(3.5, chord * 0.9 + 2.5);
      turnR = Math.max(2.5, chord / 2);
      const p0 = end, p3 = start;
      const p1 = { x: p0.x + p0.hx * k, z: p0.z + p0.hz * k };
      const p2 = { x: p3.x - p3.hx * k, z: p3.z - p3.hz * k };
      samples = [];
      for (let i = 0; i <= M; i++) {
        const t = i / M, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, d = t ** 3;
        samples.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, z: a * p0.z + b * p1.z + c * p2.z + d * p3.z });
      }
    } else {
      const X = rayCross(end, start, chord * 2.2 + 6);
      const cross = end.hx * start.hz - end.hz * start.hx;
      const alpha = Math.atan2(cross, dotH);
      const theta = Math.abs(alpha);
      samples = [];
      if (!X || theta < 0.03) {
        if (!X && theta > 0.3) {
          // 交点が取れない形: 向きをつなぐなめらかな 3 次曲線
          const k = chord * 0.4 + 1;
          const p1 = { x: end.x + end.hx * k, z: end.z + end.hz * k };
          const p2 = { x: start.x - start.hx * k, z: start.z - start.hz * k };
          for (let i = 0; i <= M; i++) {
            const t = i / M, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, d = t ** 3;
            samples.push({ x: a * end.x + b * p1.x + c * p2.x + d * start.x, z: a * end.z + b * p1.z + c * p2.z + d * start.z });
          }
        } else {
          samples.push({ x: end.x, z: end.z }, { x: start.x, z: start.z });
        }
      } else {
        // まっすぐ → 一定の半径の円弧 → まっすぐ（車の曲がり方）。左折は小さめ、右折は大きめの半径
        const tanH = Math.tan(theta / 2);
        const minLeg = Math.max(0.5, Math.min(X.t, X.w) - 0.3);
        const R0 = Math.max(2.5, Math.min(cross < 0 ? 7.5 : 10.5, minLeg / tanH));
        const T = Math.min(R0 * tanH, minLeg);
        const R = T / tanH; // 実際に使う半径
        turnR = R;
        const p1 = { x: X.x - end.hx * T, z: X.z - end.hz * T };
        const sgn = alpha > 0 ? 1 : -1;
        const ctr = { x: p1.x + sgn * R * -end.hz, z: p1.z + sgn * R * end.hx };
        const vx = p1.x - ctr.x, vz = p1.z - ctr.z;
        samples.push({ x: end.x, z: end.z }, p1);
        for (let i = 1; i <= M; i++) {
          const a = (alpha * i) / M;
          const ca = Math.cos(a), sa = Math.sin(a);
          samples.push({ x: ctr.x + (vx * ca - vz * sa), z: ctr.z + (vx * sa + vz * ca) });
        }
        samples.push({ x: start.x, z: start.z });
      }
    }
    const path = new Path(samples);
    const turn: Piece = { kind: "turn", path, from: 0, len: path.len, limit: Math.min(prev.limit, lp.limit, Math.sqrt(LAT_ACC * turnR)) };
    return [turn, lp];
  }

  /** 先の 2 組（曲線＋道）を常に用意しておく（先の曲がり角を見て減速するため） */
  private extend() {
    let last: Piece = this.queue.length ? this.queue[this.queue.length - 1] : this.cur!;
    let guard = 0;
    while (this.queue.length < 4 && guard++ < 4) {
      if (last.kind !== "line") break;
      const [t, l] = this.next(last);
      this.queue.push(t, l);
      last = l;
    }
  }

  /** いまから d メートル先での、速さの上限 */
  private limitAhead(d: number): number {
    let piece = this.cur!;
    let u = this.u;
    let qi = 0;
    for (;;) {
      const rest = piece.len - u;
      if (d <= rest) return pieceLim(piece, u + d);
      d -= rest;
      u = 0;
      const nx = this.queue[qi++];
      if (!nx) return pieceLim(piece, piece.len);
      piece = nx;
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
      // 青のとき: 着くまでに赤になりそうなら、早めにゆるやかに止まる準備をする。間に合うなら、そのまま通り抜ける
      if (st === 0 && dist < 130 && this.committed !== cur) {
        let tg = 40;
        for (let k = 0.5; k <= 40; k += 0.5) {
          if (signalState(t + k, cur.signal.phase, cur.signal.axis) !== 0) { tg = k; break; }
        }
        const ta = dist / Math.max(this.speed * 0.9, 2.5);
        if (ta > tg - 1.0) mustStop = true; else this.committed = cur;
      }
    }
    // 先読み: これから先のカーブ・停止位置で守れる速さ
    const horizon = Math.min(120, (this.speed * this.speed) / (2 * DECEL) + 14);
    let allowed = pieceLim(cur, this.u);
    for (let d = 3; d <= horizon; d += 3) {
      allowed = Math.min(allowed, Math.sqrt(this.limitAhead(d) ** 2 + 2 * DECEL * d));
    }
    if (mustStop) allowed = Math.min(allowed, Math.sqrt(2 * 1.35 * Math.max(0, dist - 1.0)));
    // 目標へ向かう加速度を、急に変わらないようにして速さを決める
    const wanted = Math.max(-DECEL_MAX, Math.min(ACCEL, (allowed - this.speed) * 2.5));
    const dj = JERK * dt;
    this.acc += Math.max(-dj * 1.6, Math.min(dj, wanted - this.acc));
    this.speed = Math.max(0, this.speed + this.acc * dt);
    if (this.speed > cur.limit) this.speed = Math.max(cur.limit, this.speed - DECEL_MAX * dt);
    if (this.speed > allowed + 0.4) this.speed = Math.max(allowed + 0.4, this.speed - DECEL_MAX * dt);
    if (mustStop && this.speed < 0.08 && dist < 1.0) { this.speed = 0; this.acc = 0; }
    this.waiting = mustStop && this.speed < 0.3 && dist < 4;
    this.limitKmh = Math.round(pieceLim(cur, this.u) * 3.6);
    if (cur.kind === "turn") this.limitKmh = Math.round(Math.min(cur.limit, cur.path.limAt(cur.from + this.u)) * 3.6);

    this.u += this.speed * dt;
    if (mustStop && this.u > cur.len - 0.15) { this.u = cur.len - 0.15; this.speed = 0; this.acc = 0; }
    let guard = 0;
    while (this.cur && this.u >= this.cur.len && this.queue.length > 0 && guard++ < 4) {
      this.u -= this.cur.len;
      this.cur = this.queue.shift()!;
      this.extend();
    }
    const p = pieceAt(this.cur!, this.u);
    this.pose = p;
    const ty = Math.atan2(-p.hx, -p.hz);
    if (!this.yawInit) {
      this.yaw = ty;
      this.yawInit = true;
    } else {
      let d = ty - this.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.yaw += d * (1 - Math.exp(-dt * 9));
    }
  }

  get speedKmh() {
    return this.speed * 3.6;
  }
}
