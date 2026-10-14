// 草食獣。SoA（Float32Array）で個体を持ち、GC を発生させない。
// 行動は 2 方式から選べる（controller）：
//  - 'fsm'  ：Phase 1 の有限状態機械（比較・フォールバック用）
//  - 'brain'：遺伝子の脳（MLP 32→12→12→14）が行動を決める。生得的な反射・バイアスを少し加える。
// 生涯学習（learning）は出力層直前の重みを報酬で更新する（3 因子 Hebb）。

import { CFG, DAYS_PER_YEAR } from './config';
import { Rng } from './rng';
import { World, WORLD, BIOME } from './world';
import {
  DIPLOID_LEN,
  GENOME_LEN,
  crossover,
  decode,
  genomeFromPreset,
  geneticDistance,
  mutate,
  type Phenotype,
} from './genome';
import { BRAIN_W, ELIG_LEN, H1, H2, IN, OUT, activeUnits, forwardBatch, learnOne } from './brain';
import { SpeciesRegistry } from './species';

export const ST = { WANDER: 0, GRAZE: 1, DRINK: 2, REST: 3, MATE: 4, FLEE: 5 } as const;
export const ST_NAMES = ['うろつき', '採食', '水飲み', '休息', '求愛', '逃走'];
export type Cause = 'starve' | 'thirst' | 'old' | 'heat' | 'drown' | 'predated' | 'disease' | 'impact';
export type Controller = 'fsm' | 'brain';

export interface Traits {
  mass: number; // kg
  leg: number; // 脚長 m
  fur: number; // 0..1
  hue: number; // 0..1 体色
}
export interface DeathCounts {
  starve: number;
  thirst: number;
  old: number;
  heat: number;
  drown: number;
  predated: number;
  disease: number;
  impact: number;
}
export function emptyDeaths(): DeathCounts {
  return { starve: 0, thirst: 0, old: 0, heat: 0, drown: 0, predated: 0, disease: 0, impact: 0 };
}

/** 捕食者の読み取り専用ビュー（循環 import を避けるための型）。 */
export interface Hunters {
  readonly highWater: number;
  readonly alive: Uint8Array;
  readonly x: Float32Array;
  readonly z: Float32Array;
}

export function maxEnergy(mass: number): number {
  return 100 * Math.pow(mass, 0.9);
}

const MAX = CFG.MAX_AGENTS;
const MATURE_DAYS = CFG.MATURITY_YEARS * DAYS_PER_YEAR;
const MAX_AGE_DAYS = CFG.MAX_AGE_YEARS * DAYS_PER_YEAR;
const GCELL = CFG.SPATIAL_HASH_CELL;
const G = Math.ceil(WORLD / GCELL);
/** 脳の判断周期（step 単位）。行動は毎 step、判断は 2 step ごと（計算量の節約） */
const BRAIN_EVERY = 2;
/** 学習率（spec §6.6 LEARN_RATE_BASE） */
const LEARN_RATE = 0.004;
/** 種の分岐しきい値（相同座位の平均差）(仮) */
export const SPECIES_THRESHOLD = 0.06;
/** 学習の最大報酬スケール */
const REWARD_SCALE = 20;

export class Herbivores {
  readonly x = new Float32Array(MAX);
  readonly z = new Float32Array(MAX);
  readonly heading = new Float32Array(MAX);
  readonly energy = new Float32Array(MAX);
  readonly health = new Float32Array(MAX);
  readonly hydration = new Float32Array(MAX);
  readonly age = new Float32Array(MAX); // 日
  readonly mass = new Float32Array(MAX);
  readonly leg = new Float32Array(MAX);
  readonly fur = new Float32Array(MAX);
  readonly hue = new Float32Array(MAX);
  readonly cooldown = new Float32Array(MAX);
  readonly wander = new Float32Array(MAX);
  readonly speed = new Float32Array(MAX);
  readonly mate = new Int32Array(MAX).fill(-1);
  readonly alive = new Uint8Array(MAX);
  readonly state = new Uint8Array(MAX);

  // ---- 遺伝・表現型 ----
  /** 個体ごとのゲノム（816 floats）。spec §6.1 */
  readonly genome = new Float32Array(MAX * GENOME_LEN);
  readonly species = new Int32Array(MAX);
  readonly pheno: Phenotype[] = new Array(MAX);
  /** 脳（生涯学習で変化する現在の重み）。遺伝子の脳部分から始まる */
  readonly brainW = new Float32Array(MAX * BRAIN_W);
  readonly elig = new Float32Array(MAX * ELIG_LEN);
  readonly activeH = new Uint8Array(MAX);

  // ---- 脳の入出力（判断ごとに更新、表示用に保持） ----
  readonly lastIn = new Float32Array(MAX * IN);
  readonly lastOut = new Float32Array(MAX * OUT);
  readonly lastH2 = new Float32Array(MAX * H2);
  private readonly lastH1 = new Float32Array(MAX * H1);
  private readonly prevEnergy = new Float32Array(MAX);
  private readonly prevHealth = new Float32Array(MAX);
  /** ナビゲーション目標（水・草・配偶者）と重み */
  private readonly navX = new Float32Array(MAX);
  private readonly navZ = new Float32Array(MAX);
  private readonly navW = new Float32Array(MAX);
  /** 最寄りの捕食者（距離 -1 = なし） */
  private readonly thrD = new Float32Array(MAX).fill(-1);
  private readonly thrX = new Float32Array(MAX);
  private readonly thrZ = new Float32Array(MAX);

  /** 生存個体の最大インデックス + 1（ループ上限） */
  highWater = 0;
  count = 0;
  births = 0;
  deaths: DeathCounts = emptyDeaths();
  /** 行動方式と学習の有無（設定から切り替え） */
  controller: Controller = 'brain';
  learning = true;
  /** 時計：その日の経過割合 [0,1) と、年内の日 */
  dayFrac01 = 0;
  doy = 0;
  readonly registry = new SpeciesRegistry();
  /** 種の分岐などの通知先 */
  onEvent: ((msg: string) => void) | null = null;
  /** 直近の日（分岐の記録用） */
  dayNow = 0;

  private free = new Int32Array(MAX);
  private freeTop = 0;
  private gridHead = new Int32Array(G * G);
  private gridNext = new Int32Array(MAX);
  private predHead = new Int32Array(G * G);
  private predNext = new Int32Array(MAX);
  private hunters: Hunters | null = null;
  private stepNo = 0;
  private tgx = 0;
  private tgz = 0;
  private threatX = 0;
  private threatZ = 0;
  // 判断用の作業バッファ
  private bSlots = new Int32Array(MAX);
  private bX = new Float32Array(MAX * IN);
  private bH1 = new Float32Array(MAX * H1);
  private bH2 = new Float32Array(MAX * H2);
  private bO = new Float32Array(MAX * OUT);
  private bAct = new Uint8Array(MAX);

  constructor(
    private readonly world: World,
    private readonly rng: Rng,
  ) {
    for (let i = MAX - 1; i >= 0; i--) this.free[this.freeTop++] = i;
  }

  // ------------------------------------------------------------------
  // 生成・死亡
  // ------------------------------------------------------------------

  private allocSlot(): number {
    if (this.freeTop === 0) return -1;
    const i = this.free[--this.freeTop]!;
    this.alive[i] = 1;
    this.count++;
    if (i + 1 > this.highWater) this.highWater = i + 1;
    return i;
  }

  /** 形質（Traits）から遺伝子を作って生成する（初期個体・放すツール）。 */
  spawn(x: number, z: number, t: Traits, energyAbs: number, ageDays: number): number {
    const i = this.allocSlot();
    if (i < 0) return -1;
    genomeFromPreset(this.genome, i * GENOME_LEN, this.rng, {
      bodyLength: 1,
      mass: t.mass,
      leg: t.leg,
      fur: t.fur,
      hue: t.hue,
      diet: 0,
      startle: 0.6,
    });
    this.species[i] = 0;
    this.initSlot(i, x, z, energyAbs, ageDays);
    return i;
  }

  private initSlot(i: number, x: number, z: number, energyAbs: number, ageDays: number): void {
    const p = decode(this.genome, i * GENOME_LEN);
    this.pheno[i] = p;
    this.mass[i] = p.mass;
    this.leg[i] = p.leg;
    this.fur[i] = p.fur;
    this.hue[i] = p.hue;
    this.activeH[i] = activeUnits(p.brainSize);
    this.brainW.set(this.genome.subarray(i * GENOME_LEN + DIPLOID_LEN, i * GENOME_LEN + GENOME_LEN), i * BRAIN_W);
    this.elig.fill(0, i * ELIG_LEN, (i + 1) * ELIG_LEN);
    this.x[i] = x;
    this.z[i] = z;
    this.heading[i] = this.rng.float() * Math.PI * 2;
    this.energy[i] = energyAbs;
    this.health[i] = 100;
    this.hydration[i] = 100;
    this.age[i] = ageDays;
    this.cooldown[i] = 0;
    this.wander[i] = this.rng.range(0, 3);
    this.speed[i] = 0;
    this.mate[i] = -1;
    this.state[i] = ST.WANDER;
    this.prevEnergy[i] = energyAbs;
    this.prevHealth[i] = 100;
    this.thrD[i] = -1;
    this.navW[i] = 0;
    if (i + 1 > this.highWater) this.highWater = i + 1;
  }

  /** 外部（捕食・疫病・隕石）による死。 */
  killExternal(i: number, cause: Cause): void {
    if (!this.alive[i]) return;
    this.kill(i, cause);
  }

  private kill(i: number, cause: Cause): void {
    this.alive[i] = 0;
    this.count--;
    this.free[this.freeTop++] = i;
    this.deaths[cause]++;
    // 死体は土壌窒素になる（分解の簡易版）
    const c = this.world.cellIndexOf(this.x[i]!, this.z[i]!);
    this.world.soilN[c] = Math.min(1, this.world.soilN[c]! + 0.02);
  }

  // ------------------------------------------------------------------
  // 1 step
  // ------------------------------------------------------------------

  /** 1 step（STEP_TICKS tick 分）進める。dt は秒。 */
  step(dt: number, hunters: Hunters | null = null): void {
    this.stepNo++;
    this.buildGrid();
    this.hunters = hunters;
    this.buildPredGrid();
    const hw = this.highWater;
    if (this.controller === 'brain' && this.stepNo % BRAIN_EVERY === 0) this.decideBrain(hw);
    for (let i = 0; i < hw; i++) {
      if (this.alive[i]) this.updateOne(i, dt);
    }
  }

  private buildGrid(): void {
    this.gridHead.fill(-1);
    const hw = this.highWater;
    for (let i = 0; i < hw; i++) {
      if (!this.alive[i]) continue;
      const cx = clampi(Math.floor(this.x[i]! / GCELL), 0, G - 1);
      const cz = clampi(Math.floor(this.z[i]! / GCELL), 0, G - 1);
      const c = cz * G + cx;
      this.gridNext[i] = this.gridHead[c]!;
      this.gridHead[c] = i;
    }
  }

  private buildPredGrid(): void {
    this.predHead.fill(-1);
    const h = this.hunters;
    if (!h) return;
    for (let j = 0; j < h.highWater; j++) {
      if (!h.alive[j]) continue;
      const cx = clampi(Math.floor(h.x[j]! / GCELL), 0, G - 1);
      const cz = clampi(Math.floor(h.z[j]! / GCELL), 0, G - 1);
      const c = cz * G + cx;
      this.predNext[j] = this.predHead[c]!;
      this.predHead[c] = j;
    }
  }

  /** 視界内で最も近い捕食者を探す。見つかれば脅威座標を保存して true。 */
  private nearestPredator(x: number, z: number): boolean {
    if (!this.hunters) return false;
    const r = CFG.HERB_SIGHT;
    const cx0 = clampi(Math.floor((x - r) / GCELL), 0, G - 1);
    const cx1 = clampi(Math.floor((x + r) / GCELL), 0, G - 1);
    const cz0 = clampi(Math.floor((z - r) / GCELL), 0, G - 1);
    const cz1 = clampi(Math.floor((z + r) / GCELL), 0, G - 1);
    let bestD = r * r;
    let found = false;
    const h = this.hunters;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let j = this.predHead[cz * G + cx]!; j !== -1; j = this.predNext[j]!) {
          const dx = h.x[j]! - x;
          const dz = h.z[j]! - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD) {
            bestD = d2;
            this.threatX = h.x[j]!;
            this.threatZ = h.z[j]!;
            found = true;
          }
        }
      }
    }
    return found;
  }

  private canMate(j: number): boolean {
    if (!this.alive[j]) return false;
    if (this.age[j]! < MATURE_DAYS) return false;
    if (this.cooldown[j]! > 0) return false;
    return this.energy[j]! / maxEnergy(this.mass[j]!) >= CFG.REPRO_THRESHOLD;
  }

  private findMate(i: number): number {
    const x = this.x[i]!;
    const z = this.z[i]!;
    const r = CFG.MATE_SEARCH_RADIUS;
    const cx0 = clampi(Math.floor((x - r) / GCELL), 0, G - 1);
    const cx1 = clampi(Math.floor((x + r) / GCELL), 0, G - 1);
    const cz0 = clampi(Math.floor((z - r) / GCELL), 0, G - 1);
    const cz1 = clampi(Math.floor((z + r) / GCELL), 0, G - 1);
    let best = -1;
    let bestD = r * r;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let j = this.gridHead[cz * G + cx]!; j !== -1; j = this.gridNext[j]!) {
          if (j === i || !this.canMate(j)) continue;
          const dx = this.x[j]! - x;
          const dz = this.z[j]! - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD) {
            bestD = d2;
            best = j;
          }
        }
      }
    }
    return best;
  }

  /** 近傍（半径 r）の同種の数。 */
  private crowd(i: number): number {
    const x = this.x[i]!;
    const z = this.z[i]!;
    const cx = clampi(Math.floor(x / GCELL), 0, G - 1);
    const cz = clampi(Math.floor(z / GCELL), 0, G - 1);
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx;
        const gz = cz + dz;
        if (gx < 0 || gz < 0 || gx >= G || gz >= G) continue;
        for (let j = this.gridHead[gz * G + gx]!; j !== -1; j = this.gridNext[j]!) n++;
      }
    }
    return n - 1;
  }

  /** 8方向のうち、arr（セル値）が最も良くなる方向へ目標点を決める。 */
  private gradient(arr: Float32Array, x: number, z: number, maximize: boolean): boolean {
    const w = this.world;
    let best = arr[w.cellIndexOf(x, z)]!;
    let found = false;
    // 近傍（6m）と遠方（18m）の 2 リングを見る。遠方まで見ないと、食べ尽くした斑から抜け出せない
    for (let ring = 0; ring < 2; ring++) {
      const r = ring === 0 ? 6 : 18;
      const n = ring === 0 ? 8 : 16;
      for (let k = 0; k < n; k++) {
        const a = (k * 2 * Math.PI) / n + (ring === 1 ? Math.PI / 16 : 0);
        const px = x + Math.sin(a) * r;
        const pz = z + Math.cos(a) * r;
        if (px < 0 || pz < 0 || px >= WORLD || pz >= WORLD) continue;
        if (w.heightAt(px, pz) < w.sea) continue; // 目標は陸地だけ（水の中へ向かうと泳ぎで消耗する）
        const v = arr[w.cellIndexOf(px, pz)]!;
        if (maximize ? v > best + 1e-4 : v < best - 1e-4) {
          best = v;
          this.tgx = px;
          this.tgz = pz;
          found = true;
        }
      }
    }
    return found;
  }

  private wanderDrift(i: number, dt: number): void {
    this.wander[i] = this.wander[i]! - dt;
    if (this.wander[i]! <= 0) {
      this.heading[i] = this.heading[i]! + this.rng.gauss() * 1.0;
      this.wander[i] = this.rng.range(2, 7);
    }
  }

  // ------------------------------------------------------------------
  // 脳による判断（判断周期ごと）
  // ------------------------------------------------------------------

  /** 時計を更新する（sim から毎 step）。 */
  setClock(dayFrac01: number, doy: number): void {
    this.dayFrac01 = dayFrac01;
    this.doy = doy;
  }

  /** 感覚入力 32 次元を作り、層ループで順伝播、学習、出力の保存までを行う。 */
  private decideBrain(hw: number): void {
    const w = this.world;
    void w;
    const phase = this.stepNo % BRAIN_EVERY;
    let n = 0;
    for (let i = 0; i < hw; i++) {
      if (!this.alive[i]) continue;
      // 判断を個体ごとに時間差で分散（同じ step に全員が判断しないように）
      if ((i + phase) % BRAIN_EVERY !== 0) continue;
      const k = n++;
      this.bSlots[k] = i;
      this.bAct[k] = this.activeH[i]!;
      this.buildInputs(i, k);
    }
    if (n === 0) return;
    forwardBatch(this.brainW, this.bSlots, n, this.bX, this.bH1, this.bH2, this.bO, this.bAct);
    for (let k = 0; k < n; k++) {
      const i = this.bSlots[k]!;
      // 保存（表示・学習・行動用）
      this.lastIn.set(this.bX.subarray(k * IN, k * IN + IN), i * IN);
      this.lastOut.set(this.bO.subarray(k * OUT, k * OUT + OUT), i * OUT);
      this.lastH2.set(this.bH2.subarray(k * H2, k * H2 + H2), i * H2);
      this.lastH1.set(this.bH1.subarray(k * H1, k * H1 + H1), i * H1);
      // 報酬：前回判断からのエネルギー変化と体力の損失
      if (this.learning) {
        const mE = maxEnergy(this.mass[i]!);
        const dE = (this.energy[i]! - this.prevEnergy[i]!) / mE;
        const dH = Math.max(0, this.prevHealth[i]! - this.health[i]!) / 100;
        const r = Math.max(-1, Math.min(1, REWARD_SCALE * dE - 2 * dH));
        const p = this.pheno[i]!;
        if (Math.abs(r) > 1e-3 && p.plasticity > 0) {
          learnOne(
            this.brainW,
            i,
            this.elig,
            this.lastH2,
            i * H2,
            this.lastOut,
            i * OUT,
            r,
            p.plasticity,
            LEARN_RATE,
            0.8,
            this.genome,
            i * GENOME_LEN + DIPLOID_LEN,
            p.memoryDecay,
          );
        }
      }
      this.prevEnergy[i] = this.energy[i]!;
      this.prevHealth[i] = this.health[i]!;
    }
  }

  /** 個体 i の感覚入力を bX の k 番目へ書く（32 次元、[-1,1]）。ナビゲーション目標も更新する。 */
  private buildInputs(i: number, k: number): void {
    const w = this.world;
    const x = this.x[i]!;
    const z = this.z[i]!;
    const h = this.heading[i]!;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const rx = Math.cos(h);
    const rz = -Math.sin(h);
    const xb = k * IN;
    const X = this.bX;
    const p = this.pheno[i]!;
    const c = w.cellIndexOf(x, z);
    const mE = maxEnergy(this.mass[i]!);
    const e = this.energy[i]! / mE;
    const mature = this.age[i]! >= MATURE_DAYS;
    const clamp1 = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);
    // 方向ベクトル（自分の向きを基準にした 左右・前後）
    const dirOf = (tx: number, tz: number, out: number): number => {
      const dx = tx - x;
      const dz = tz - z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) {
        X[xb + out] = 0;
        X[xb + out + 1] = 0;
        return -1;
      }
      X[xb + out] = (dx * rx + dz * rz) / d;
      X[xb + out + 1] = (dx * fx + dz * fz) / d;
      return d;
    };

    X[xb + 0] = clamp1(e * 2 - 1);
    X[xb + 1] = clamp1(this.hydration[i]! / 50 - 1);
    X[xb + 2] = clamp1(this.health[i]! / 50 - 1);
    X[xb + 3] = clamp1((w.ambient[c]! - p.preferredTemp) / 20);
    X[xb + 4] = clamp1((this.age[i]! / MAX_AGE_DAYS) * 2 - 1);
    X[xb + 5] = this.cooldown[i]! > 0 ? 1 : -1;
    X[xb + 6] = mature && this.cooldown[i]! <= 0 && e >= CFG.REPRO_THRESHOLD ? 1 : -1;
    X[xb + 7] = mature ? -1 : 1;

    // 食物：草の勾配の目標
    const hasFood = this.gradient(w.grass, x, z, true);
    if (hasFood) {
      dirOf(this.tgx, this.tgz, 8);
      X[xb + 10] = clamp1(2 * (w.grass[w.cellIndexOf(this.tgx, this.tgz)]! / Math.max(1, w.cap[c]!)) - 1);
    } else {
      X[xb + 8] = 0;
      X[xb + 9] = 0;
      X[xb + 10] = -1;
    }
    X[xb + 11] = -1; // 食物の種類：草
    X[xb + 12] = -1; // 食物の大きさ（草は対象外）
    this.navX[i] = hasFood ? this.tgx : x;
    this.navZ[i] = hasFood ? this.tgz : z;
    this.navW[i] = hasFood ? 0.4 : 0;
    // 水
    const hasWater = this.gradient(w.distWater, x, z, false);
    if (hasWater) {
      dirOf(this.tgx, this.tgz, 21);
    } else {
      X[xb + 21] = 0;
      X[xb + 22] = 0;
    }
    const waterX = hasWater ? this.tgx : x;
    const waterZ = hasWater ? this.tgz : z;
    // 捕食者
    const threat = this.nearestPredator(x, z);
    if (threat) {
      const d = dirOf(this.threatX, this.threatZ, 13);
      X[xb + 15] = clamp1(2 * (1 - d / CFG.HERB_SIGHT) - 1);
      this.thrD[i] = d;
      this.thrX[i] = this.threatX;
      this.thrZ[i] = this.threatZ;
    } else {
      X[xb + 13] = 0;
      X[xb + 14] = 0;
      X[xb + 15] = -1;
      this.thrD[i] = -1;
    }
    X[xb + 16] = 0;
    // 配偶者
    const m = mature && e >= CFG.REPRO_THRESHOLD * 0.8 ? this.findMate(i) : -1;
    this.mate[i] = m;
    if (m >= 0) {
      const d = dirOf(this.x[m]!, this.z[m]!, 17);
      X[xb + 19] = clamp1(2 * (1 - d / CFG.MATE_SEARCH_RADIUS) - 1);
      X[xb + 20] = clamp1(1 - 4 * Math.abs(this.hue[i]! - this.hue[m]!));
      this.navX[i] = this.x[m]!;
      this.navZ[i] = this.z[m]!;
      this.navW[i] = 0.7;
    } else {
      X[xb + 17] = 0;
      X[xb + 18] = 0;
      X[xb + 19] = -1;
      X[xb + 20] = -1;
    }
    // 渇きの方が強い要求のときは水へ向かう
    if (this.hydration[i]! < CFG.THIRST_THRESHOLD && hasWater) {
      this.navX[i] = waterX;
      this.navZ[i] = waterZ;
      this.navW[i] = 0.6;
    } else if (!hasFood && !hasWater) {
      this.navW[i] = 0;
    }
    X[xb + 23] = clamp1(this.crowd(i) / 10 * 2 - 1);
    const fwdH = w.heightAt(x + fx * 2, z + fz * 2);
    X[xb + 24] = clamp1((fwdH - w.heightAt(x, z)) / 2);
    const dw = w.distWater[c]!;
    X[xb + 25] = clamp1(2 * Math.min(1, dw / 20) - 1);
    X[xb + 26] = clamp1(2 * (this.hueWithin(w.grass[c]!, w.cap[c]!)) - 1);
    X[xb + 27] = w.biome[c] === BIOME.WATER ? -1 : 1;
    X[xb + 28] = Math.sin(Math.PI * 2 * this.dayFrac01);
    X[xb + 29] = Math.cos((2 * Math.PI * this.doy) / DAYS_PER_YEAR);
    X[xb + 30] = 0;
    X[xb + 31] = 1; // バイアス
  }

  private hueWithin(g: number, cap: number): number {
    return cap > 0 ? Math.min(1, g / cap) : 0;
  }

  // ------------------------------------------------------------------
  // 個体の更新（行動・生理）
  // ------------------------------------------------------------------

  private updateOne(i: number, dt: number): void {
    const w = this.world;
    const rng = this.rng;
    const dayFrac = dt / CFG.DAY_SECONDS;
    const p = this.pheno[i]!;

    this.age[i] = this.age[i]! + dayFrac;
    this.cooldown[i] = Math.max(0, this.cooldown[i]! - dayFrac);
    if (this.age[i]! >= MAX_AGE_DAYS * (p.maxAge / 8)) {
      this.kill(i, 'old');
      return;
    }

    const mass = this.mass[i]!;
    const leg = this.leg[i]!;
    const fur = this.fur[i]!;
    const x = this.x[i]!;
    const z = this.z[i]!;
    const c = w.cellIndexOf(x, z);
    const h = w.heightAt(x, z);
    const depth = w.sea - h;
    const swimming = depth > CFG.SWIM_DEPTH_TRIGGER * leg;
    const T = w.ambient[c]!;
    const stress = Math.max(0, CFG.COMFORT_TEMP_LOW - T) + Math.max(0, T - CFG.COMFORT_TEMP_HIGH);
    const insul = 1 + CFG.FUR_INSULATION * fur;
    const mE = maxEnergy(mass);
    const mature = this.age[i]! >= MATURE_DAYS;
    const metab = p.metabolism;

    // 代謝（基礎代謝 + 体温調節）。移動コストは後で加算。
    let cost = CFG.BMR_COEF * Math.pow(mass, 0.75) * CFG.ENERGY_SCALE * metab * dayFrac;
    cost += (CFG.THERMO_COST_COEF * 20 * stress * dayFrac) / insul;
    let hydration = this.hydration[i]! - CFG.HYDRATION_DRAIN_PER_DAY * dayFrac;

    let hd = this.heading[i]!;
    let spd = 0; // 0..1（最大速度に対する割合）
    let intake = 0; // エネルギー獲得
    let st: number = ST.WANDER;
    let hasTarget = false;

    if (this.controller === 'brain') {
      // ---- 脳の出力を行動に変換（毎 step）----
      const O = this.lastOut;
      const ob = i * OUT;
      const e = this.energy[i]! / mE;
      const threatD = this.thrD[i]!;
      const fleeing = threatD >= 0;
      // 生得的な反射：捕食者の接近（B12 startleReflex の強さに比例）
      let startleR = 0;
      if (fleeing) {
        startleR = Math.min(1, p.startle * (1 - threatD / CFG.HERB_SIGHT) * 2);
      }
      // 生得的なバイアス：草の上で空腹なら食べる、水辺で渇いたら飲む
      const onGrass = w.grass[c]! > CFG.GRAZE_MIN_GRASS;
      const o0 = O[ob + 0]!;
      const o1 = O[ob + 1]!;
      const oDrink = O[ob + 2]! + (w.distWater[c]! <= 2 && this.hydration[i]! < 70 ? 0.8 : 0);
      const oEat = O[ob + 3]! + (onGrass ? 1.5 * (1 - e) : 0);
      const oRest = O[ob + 8]!;
      const oFlee = O[ob + 5]! + startleR;
      // 生得的なバイアス：配偶者が近くにいて繁殖可能なら求愛する
      const mateNear = this.mate[i]! >= 0 && this.canMateSelf(i) && this.nearMate(i);
      const oCourt = O[ob + 6]! + (mateNear ? 0.6 : 0);

      // 水・草の摂取
      if (oDrink > 0 && w.distWater[c]! <= 2) {
        hydration = Math.min(100, hydration + CFG.DRINK_PER_DAY * dayFrac);
        st = ST.DRINK;
      }
      if (oEat > 0 && onGrass) {
        const g = w.grass[c]!;
        const bite = Math.min(g, CFG.GRAZE_BITE_PER_STEP * (dt / (CFG.STEP_TICKS / CFG.SIM_HZ)));
        w.grass[c] = g - bite;
        intake = bite * CFG.ENERGY_PER_GRASS_UNIT * CFG.ENERGY_SCALE;
        st = ST.GRAZE;
      }

      // 生存の反射：エネルギー・水分が危機的なら休息を禁止し、移動を速め、目標へ強く向かう
      const critical = e < 0.3 || this.hydration[i]! < 30;

      // 速度（逃走で加速、休息で停止）
      if (oRest > 0.5 && !fleeing && !critical) {
        this.health[i] = Math.min(100, this.health[i]! + 4 * dayFrac);
        spd = 0;
        st = ST.REST;
      } else {
        spd = Math.max(critical && !onGrass ? 0.6 : 0, Math.min(1, (o0 + 1) / 2));
        // 生得的反射：草の上で空腹なら、その場で食べる（速度を落とす）
        if (onGrass && e < CFG.GRAZE_UNTIL && !fleeing) spd = Math.min(spd, 0.15);
        if (fleeing) {
          spd = Math.max(spd, CFG.HERB_FLEE_SPEED) * (1 + 0.3 * Math.max(0, oFlee));
          st = ST.FLEE;
        }
      }

      // 向き：NN の旋回出力 ＋ ナビゲーション（水・草・配偶者）＋ 逃走反射
      hd += o1 * CFG.BASE_TURN_RATE * dt;
      if (this.navW[i]! > 0 && !fleeing) {
        const nw = critical ? 0.9 : this.navW[i]!;
        hd = turnTo(hd, Math.atan2(this.navX[i]! - x, this.navZ[i]! - z), nw * CFG.BASE_TURN_RATE * dt);
        hasTarget = true;
      }
      if (fleeing && startleR > 0) {
        const ax = x + (x - this.thrX[i]!);
        const az = z + (z - this.thrZ[i]!);
        hd = turnTo(hd, Math.atan2(ax - x, az - z), startleR * 2 * CFG.BASE_TURN_RATE * dt);
      }

      // 交配：配偶者が近く、求愛出力が十分
      const m = this.mate[i]!;
      if (m >= 0 && oCourt > 0.3 && mature && this.canMateSelf(i)) {
        const dx = this.x[m]! - x;
        const dz = this.z[m]! - z;
        if (dx * dx + dz * dz < CFG.MATE_RADIUS * CFG.MATE_RADIUS && this.canMate(m)) {
          this.breed(i, m);
          st = ST.MATE;
          spd = 0;
        } else if (st === ST.WANDER) {
          st = ST.MATE;
        }
      }
    } else {
      // ---- FSM（Phase 1 の有限状態機械。比較用）----
      const e = this.energy[i]! / mE;
      const prev = this.state[i]!;
      const threat = this.nearestPredator(x, z);
      if (threat) st = ST.FLEE;
      else if (prev === ST.DRINK && hydration < CFG.DRINK_UNTIL && e >= 0.1) st = ST.DRINK;
      else if (hydration < 20) st = ST.DRINK;
      else if (hydration < CFG.THIRST_THRESHOLD && e >= 0.3) st = ST.DRINK;
      else if (e < 0.5) st = ST.GRAZE;
      else if (this.health[i]! < 40) st = ST.REST;
      else if (e >= CFG.REPRO_THRESHOLD && mature && this.cooldown[i]! <= 0 && this.health[i]! >= CFG.REPRO_HEALTH_MIN) st = ST.MATE;
      else if (e < CFG.GRAZE_UNTIL) st = ST.GRAZE;
      else st = ST.WANDER;

      switch (st) {
        case ST.DRINK: {
          if (w.distWater[c]! <= 2) {
            hydration = Math.min(100, hydration + CFG.DRINK_PER_DAY * dayFrac);
            spd = 0;
          } else if (this.gradient(w.distWater, x, z, false)) {
            this.navTo(this.tgx, this.tgz);
            hasTarget = true;
            spd = 0.8;
          } else {
            this.wanderDrift(i, dt);
            spd = 0.5;
          }
          break;
        }
        case ST.GRAZE: {
          const g = w.grass[c]!;
          if (g > CFG.GRAZE_MIN_GRASS) {
            const bite = Math.min(g, CFG.GRAZE_BITE_PER_STEP * (dt / (CFG.STEP_TICKS / CFG.SIM_HZ)));
            w.grass[c] = g - bite;
            intake = bite * CFG.ENERGY_PER_GRASS_UNIT * CFG.ENERGY_SCALE;
            spd = 0.1;
          } else if (this.gradient(w.grass, x, z, true)) {
            this.navTo(this.tgx, this.tgz);
            hasTarget = true;
            spd = 0.7;
          } else {
            this.wanderDrift(i, dt);
            spd = 0.5;
          }
          break;
        }
        case ST.FLEE: {
          this.navTo(x + (x - this.threatX) * 10, z + (z - this.threatZ) * 10);
          hasTarget = true;
          spd = CFG.HERB_FLEE_SPEED;
          break;
        }
        case ST.REST: {
          this.health[i] = Math.min(100, this.health[i]! + 4 * dayFrac);
          spd = 0;
          break;
        }
        case ST.MATE: {
          let pm = this.mate[i]!;
          if (pm >= 0 && !this.canMate(pm)) pm = -1;
          if (pm < 0 && (this.stepNo + i) % 10 === 0) pm = this.findMate(i);
          this.mate[i] = pm;
          if (pm < 0) {
            this.wanderDrift(i, dt);
            spd = 0.5;
          } else {
            const dx = this.x[pm]! - x;
            const dz = this.z[pm]! - z;
            if (dx * dx + dz * dz < CFG.MATE_RADIUS * CFG.MATE_RADIUS) {
              this.breed(i, pm);
              spd = 0;
            } else {
              this.navTo(this.x[pm]!, this.z[pm]!);
              hasTarget = true;
              spd = 1.0;
            }
          }
          break;
        }
        default: {
          this.wanderDrift(i, dt);
          spd = 0.5;
        }
      }
      if (st !== ST.MATE) this.mate[i] = -1;
      hd = this.heading[i]!;
      if (hasTarget) hd = turnTo(hd, Math.atan2(this.tgx - x, this.tgz - z), CFG.BASE_TURN_RATE * dt);
      this.heading[i] = hd;
    }
    this.state[i] = st;
    hd = this.controller === 'brain' ? hd : this.heading[i]!;

    // 泳いでいて水飲み以外なら、陸地（世界の中心方向）へ戻る
    if (swimming && st !== ST.DRINK && !hasTarget) {
      hd = turnTo(hd, Math.atan2(WORLD / 2 - x, WORLD / 2 - z), CFG.BASE_TURN_RATE * dt);
    }

    // 速度（脚長・幼体・坂・水で補正）
    const maxSp = CFG.BASE_MAX_SPEED * p.maxSpeedMul * (mature ? 1 : CFG.JUVENILE_SPEED_MUL);
    let v = spd * maxSp;
    const sx = Math.sin(hd);
    const sz = Math.cos(hd);
    const slope = Math.abs(w.heightAt(x + sx * 2, z + sz * 2) - h) / 2;
    if (slope > CFG.SLOPE_MAX) v *= Math.max(0.1, 1 - CFG.SLOPE_PENALTY_COEF * (slope - CFG.SLOPE_MAX));
    if (swimming) v *= 0.4;

    let nx = x + sx * v * dt;
    let nz = z + sz * v * dt;
    if (nx < 2 || nx > WORLD - 2 || nz < 2 || nz > WORLD - 2) {
      hd = Math.atan2(WORLD / 2 - x, WORLD / 2 - z); // 世界の端では中心へ向き直す
      nx = Math.min(WORLD - 2, Math.max(2, nx));
      nz = Math.min(WORLD - 2, Math.max(2, nz));
      v *= 0.5;
    }
    if (w.heightAt(nx, nz) < w.sea - CFG.DEEP_WATER) {
      // 深い水には入らない（その場で向きを変える）
      hd += (rng.float() - 0.5) * 2.5;
      nx = x;
      nz = z;
      v = 0;
    }
    this.x[i] = nx;
    this.z[i] = nz;
    this.heading[i] = hd;
    this.speed[i] = v;

    // 移動コスト
    cost += (CFG.MOVE_COST_COEF * CFG.MOVE_COST_SCALE * mass * v * v) / 1000 * dt * CFG.ENERGY_SCALE * (swimming ? CFG.SWIM_COST_MUL : 1);
    const energy = this.energy[i]! + intake - cost;
    this.energy[i] = energy;

    // 生理的ダメージ
    let health = this.health[i]!;
    let cause: Cause | null = null;
    if (energy <= 0) {
      this.energy[i] = 0;
      health -= CFG.STARVE_DAMAGE * dt;
      cause = 'starve';
    } else if (energy > mE * 0.5 && hydration > 50 && health < 100) {
      health = Math.min(100, health + 1.5 * dayFrac);
    }
    if (hydration <= 0) {
      hydration = 0;
      health -= 3 * dt;
      cause = cause ?? 'thirst';
    }
    if (stress > 12) {
      health -= 0.5 * dt;
      cause = cause ?? 'heat';
    }
    if (depth > CFG.DROWN_DEPTH) {
      health -= CFG.DROWN_DAMAGE * dt;
      cause = cause ?? 'drown';
    }
    this.hydration[i] = Math.min(100, hydration);
    this.health[i] = health;
    if (health <= 0 && cause) this.kill(i, cause);
  }

  private navTo(x: number, z: number): void {
    this.tgx = x;
    this.tgz = z;
  }

  /** 配偶者が交配距離の内側にいるか。 */
  private nearMate(i: number): boolean {
    const m = this.mate[i]!;
    if (m < 0 || !this.canMate(m)) return false;
    const dx = this.x[m]! - this.x[i]!;
    const dz = this.z[m]! - this.z[i]!;
    return dx * dx + dz * dz < CFG.MATE_RADIUS * CFG.MATE_RADIUS * 4;
  }

  private canMateSelf(i: number): boolean {
    return this.cooldown[i]! <= 0 && this.age[i]! >= MATURE_DAYS;
  }

  // ------------------------------------------------------------------
  // 生殖と遺伝
  // ------------------------------------------------------------------

  /** 交配：親 a が子を産む（コストは a が負担）。子の遺伝子は減数分裂＋組換え＋変異。 */
  private breed(a: number, b: number): void {
    const litter = this.rng.float() < 0.15 ? 2 : 1;
    for (let k = 0; k < litter; k++) {
      if (this.freeTop === 0) break;
      if (this.count > CFG.SOFT_AGENT_CAP && this.rng.float() < 0.5) break;
      const share = CFG.OFFSPRING_ENERGY_SHARE * this.energy[a]!;
      if (this.energy[a]! - share < 0.2 * maxEnergy(this.mass[a]!)) break;
      this.energy[a] = this.energy[a]! - share;
      const c = this.allocSlot();
      if (c < 0) break;
      const sigma = CFG.MUTATION_SIGMA * (this.count < CFG.STRESS_POP ? 2 : 1);
      crossover(this.genome, a * GENOME_LEN, this.genome, b * GENOME_LEN, this.genome, c * GENOME_LEN, this.rng);
      mutate(
        this.genome,
        c * GENOME_LEN,
        this.rng,
        0.03,
        sigma,
        CFG.MUTATION_JUMP_PROB,
        CFG.MUTATION_JUMP_SIGMA,
      );
      // 種：親の種の始祖から遠くなったら分岐
      const sp = this.species[a]!;
      this.species[c] = sp;
      const d = geneticDistance(this.genome, c * GENOME_LEN, this.registry.founders, sp * DIPLOID_LEN);
      if (d > SPECIES_THRESHOLD && this.registry.count < 256) {
        const pheno = decode(this.genome, c * GENOME_LEN);
        const nsp = this.registry.create(sp, this.genome, c * GENOME_LEN, this.dayNow, pheno.mass, pheno.fur);
        if (nsp !== sp) {
          this.species[c] = nsp;
          this.onEvent?.(`🌿 分岐：${this.registry.list[sp]?.name ?? ''} から「${this.registry.list[nsp]!.name}」が誕生（${this.dayNow / DAYS_PER_YEAR | 0}年目）`);
        }
      }
      this.x[c] = this.x[a]! + this.rng.gauss() * 1.5;
      this.z[c] = this.z[a]! + this.rng.gauss() * 1.5;
      if (this.world.heightAt(this.x[c]!, this.z[c]!) < this.world.sea) {
        this.x[c] = this.x[a]!;
        this.z[c] = this.z[a]!;
      }
      this.initSlot(c, this.x[c]!, this.z[c]!, share, 0);
      this.births++;
    }
    this.cooldown[a] = CFG.MATE_COOLDOWN_DAYS;
    this.cooldown[b] = CFG.MATE_COOLDOWN_DAYS;
  }

  /** 生存個体の平均値（統計用）。 */
  meanStats(): { mass: number; leg: number; fur: number; energy: number } {
    let m = 0;
    let l = 0;
    let f = 0;
    let e = 0;
    let n = 0;
    const hw = this.highWater;
    for (let i = 0; i < hw; i++) {
      if (!this.alive[i]) continue;
      m += this.mass[i]!;
      l += this.leg[i]!;
      f += this.fur[i]!;
      e += this.energy[i]! / maxEnergy(this.mass[i]!);
      n++;
    }
    if (n === 0) return { mass: 0, leg: 0, fur: 0, energy: 0 };
    return { mass: m / n, leg: l / n, fur: f / n, energy: e / n };
  }

  /** 生存個体の種ごとの頭数（系統樹表示用）。 */
  speciesCounts(): Int32Array {
    const out = new Int32Array(this.registry.count);
    for (let i = 0; i < this.highWater; i++) if (this.alive[i]) out[this.species[i]!]!++;
    return out;
  }
}

function clampi(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapPi(a: number): number {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
}

function turnTo(cur: number, want: number, maxStep: number): number {
  const d = wrapPi(want - cur);
  if (Math.abs(d) <= maxStep) return cur + d;
  return cur + Math.sign(d) * maxStep;
}
