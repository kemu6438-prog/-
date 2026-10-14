// 地形・気候・植物（草）のフィールド。DOM / Three.js 非依存。

import { CFG, DAYS_PER_YEAR } from './config';
import { fbm } from './noise';

export const N = CFG.TERRAIN_CELLS; // セル数（一辺）
export const V = N + 1; // 頂点数（一辺）
export const CELL = CFG.CELL_M;
export const WORLD = CFG.WORLD_SIZE_M;

export const BIOME = { COLD: 0, DESERT: 1, GRASS: 2, FOREST: 3, RAIN: 4, WATER: 5 } as const;
export const BIOME_NAMES = ['寒帯・雪原', '乾燥・砂漠', '草原', '森林', '熱帯雨林', '水域'];
const BIOME_CAP = [CFG.CAP_COLD, CFG.CAP_DESERT, CFG.CAP_GRASSLAND, CFG.CAP_FOREST, CFG.CAP_RAINFOREST, 0];

function smooth01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

function tempFactor(T: number): number {
  const lo = CFG.GRASS_TEMP_MIN;
  const hi = CFG.GRASS_TEMP_MAX;
  const opt = CFG.GRASS_TEMP_OPT;
  if (T <= lo || T >= hi) return 0;
  return T < opt ? (T - lo) / (opt - lo) : (hi - T) / (hi - opt);
}

/** 土壌水分（rain/1000 の簡易指標）に対する成長係数。最適帯 [0.3, 0.8] で 1。 */
function waterFactor(m: number): number {
  if (m < 0.3) return Math.max(0, m / 0.3);
  if (m > 0.8) return Math.max(0.5, 1 - (m - 0.8) / 0.4);
  return 1;
}

export class World {
  readonly seed: number;
  readonly sea = CFG.SEA_LEVEL;
  /** 頂点の高さ (V*V) */
  readonly vertH = new Float32Array(V * V);
  /** セル平均の高さ (N*N) */
  readonly cellH = new Float32Array(N * N);
  readonly tempMean = new Float32Array(N * N);
  readonly rain = new Float32Array(N * N);
  /** 現在の日の気温 */
  readonly ambient = new Float32Array(N * N);
  /** 草の収容量（バイオーム由来） */
  readonly cap = new Float32Array(N * N);
  /** 草のバイオマス */
  readonly grass = new Float32Array(N * N);
  readonly soilN = new Float32Array(N * N);
  readonly biome = new Uint8Array(N * N);
  /** 最寄りの水までの距離 [m]（BFS） */
  readonly distWater = new Float32Array(N * N);

  /** 気候の操作量（プレイヤーのスライダー × イベントの合成値）。 */
  tempOffset = 0;
  rainMul = 1;
  seasonAmp: number = CFG.SEASONAL_AMPLITUDE;

  constructor(seed: number) {
    this.seed = seed;
    const half = WORLD / 2;

    // 島の形：中心が高く、外周は海（fbm で起伏）
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const x = i * CELL;
        const z = j * CELL;
        const n = fbm(x * 0.011, z * 0.011, seed, 5);
        const d = Math.hypot(x - half, z - half) / half;
        const f = smooth01((1.05 - d) / 0.6);
        const h = (n - 0.42) * 150 * f - (1 - f) * 14;
        this.vertH[j * V + i] = Math.max(CFG.HEIGHT_MIN, Math.min(CFG.HEIGHT_MAX, h));
      }
    }

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const a = j * V + i;
        const h = (this.vertH[a]! + this.vertH[a + 1]! + this.vertH[a + V]! + this.vertH[a + V + 1]!) / 4;
        this.cellH[k] = h;
        const x = (i + 0.5) * CELL;
        const z = (j + 0.5) * CELL;
        const ta = fbm(x * 0.006 + 100, z * 0.006, seed + 7, 3);
        const rn = fbm(x * 0.008 + 300, z * 0.008, seed + 13, 4);
        // 気温：標高による減率 + 大域的な気候ムラ（緯度の代用）
        this.tempMean[k] = CFG.BASE_TEMP - (CFG.LAPSE_RATE * Math.max(0, h)) / 100 + (ta - 0.5) * 50;
        this.rain[k] = 150 + 1900 * Math.pow(rn, 1.2);
        const b = this.classify(k, h);
        this.biome[k] = b;
        this.cap[k] = BIOME_CAP[b] ?? 0;
        this.grass[k] = this.cap[k]! * 0.6;
        this.soilN[k] = 0.5;
      }
    }
    this.computeDistWater();
    this.updateAmbient(0);
  }

  private classify(k: number, h: number): number {
    if (h < this.sea) return BIOME.WATER;
    const t = this.tempMean[k]!;
    const r = this.rain[k]!;
    if (t < 0) return BIOME.COLD;
    if (r < 200) return BIOME.DESERT;
    if (t > 22 && r > 1800) return BIOME.RAIN;
    if (t >= 5 && t <= 25 && r >= 900 && r <= 1800) return BIOME.FOREST;
    return BIOME.GRASS;
  }

  private computeDistWater(): void {
    const q = new Int32Array(N * N);
    let qh = 0;
    let qt = 0;
    this.distWater.fill(1e9);
    for (let k = 0; k < N * N; k++) {
      if (this.cellH[k]! < this.sea) {
        this.distWater[k] = 0;
        q[qt++] = k;
      }
    }
    const relax = (from: number, to: number) => {
      const d = this.distWater[from]! + CELL;
      if (d < this.distWater[to]!) {
        this.distWater[to] = d;
        q[qt++] = to;
      }
    };
    while (qh < qt) {
      const k = q[qh++]!;
      const i = k % N;
      const j = (k / N) | 0;
      if (i > 0) relax(k, k - 1);
      if (i < N - 1) relax(k, k + 1);
      if (j > 0) relax(k, k - N);
      if (j < N - 1) relax(k, k + N);
    }
  }

  updateAmbient(doy: number): void {
    const s = -this.seasonAmp * Math.cos((2 * Math.PI * doy) / DAYS_PER_YEAR) + this.tempOffset;
    for (let k = 0; k < N * N; k++) this.ambient[k] = this.tempMean[k]! + s;
  }

  /** 1日分の植物更新（セル単位・1日1回）。 */
  daily(doy: number): void {
    this.updateAmbient(doy);
    const rate = CFG.GRASS_BASE_RATE;
    for (let k = 0; k < N * N; k++) {
      const K = this.cap[k]!;
      if (K <= 0) continue;
      const ft = tempFactor(this.ambient[k]!);
      const fw = waterFactor((this.rain[k]! * this.rainMul) / 1000);
      const fn = Math.min(1, this.soilN[k]! / CFG.GRASS_NUTRIENT_HALF);
      const B0 = this.grass[k]!;
      let g = rate * B0 * (1 - B0 / K) * ft * fw * fn;
      if (B0 < CFG.OVERGRAZE_THRESHOLD * K) g *= CFG.OVERGRAZE_RECOVERY_MUL;
      let B = B0 + g;
      if (B < 0.5 && ft * fw > 0.2) B += CFG.GRASS_SEED_BANK;
      this.grass[k] = B > K ? K : B < 0 ? 0 : B;
      // 成長は土壌窒素を消費し、ゆっくり平衡値 0.5 へ戻る
      const sn = this.soilN[k]! - Math.max(0, g) * 0.01 + (0.5 - this.soilN[k]!) * 0.01;
      this.soilN[k] = sn < 0 ? 0 : sn > 1 ? 1 : sn;
    }
  }

  /** 草を範囲内から取り除く（隕石・山火事の共通処理）。 */
  clearGrass(x: number, z: number, r: number): number {
    return this.burn(x, z, r);
  }

  /** 山火事：範囲内の草を焼き払う。灰で土壌窒素が少し増える。 */
  burn(x: number, z: number, r: number): number {
    const i0 = Math.max(0, Math.floor((x - r) / CELL));
    const i1 = Math.min(N - 1, Math.floor((x + r) / CELL));
    const j0 = Math.max(0, Math.floor((z - r) / CELL));
    const j1 = Math.min(N - 1, Math.floor((z + r) / CELL));
    let count = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * CELL - x;
        const cz = (j + 0.5) * CELL - z;
        if (cx * cx + cz * cz > r * r) continue;
        const k = j * N + i;
        if (this.grass[k]! > 0) count++;
        this.grass[k] = 0;
        this.soilN[k] = Math.min(1, this.soilN[k]! + 0.1);
      }
    }
    return count;
  }

  /** 頂点の双一次補間で地表の高さを返す。 */
  heightAt(x: number, z: number): number {
    let gx = x / CELL;
    let gz = z / CELL;
    if (gx < 0) gx = 0;
    else if (gx > N) gx = N;
    if (gz < 0) gz = 0;
    else if (gz > N) gz = N;
    let i = Math.floor(gx);
    let j = Math.floor(gz);
    if (i >= N) i = N - 1;
    if (j >= N) j = N - 1;
    const fx = gx - i;
    const fz = gz - j;
    const a = j * V + i;
    const h00 = this.vertH[a]!;
    const h10 = this.vertH[a + 1]!;
    const h01 = this.vertH[a + V]!;
    const h11 = this.vertH[a + V + 1]!;
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  cellIndexOf(x: number, z: number): number {
    let i = Math.floor(x / CELL);
    let j = Math.floor(z / CELL);
    if (i < 0) i = 0;
    else if (i >= N) i = N - 1;
    if (j < 0) j = 0;
    else if (j >= N) j = N - 1;
    return j * N + i;
  }

  /** 草の充足率（バイオマス / 収容量）。描画・統計用。 */
  grassRatio(): Float32Array {
    const out = new Float32Array(N * N);
    for (let k = 0; k < N * N; k++) {
      const K = this.cap[k]!;
      out[k] = K > 0 ? this.grass[k]! / K : 0;
    }
    return out;
  }

  /** 陸地の草の平均充足率。 */
  meanGrassRatio(): number {
    let sum = 0;
    let n = 0;
    for (let k = 0; k < N * N; k++) {
      const K = this.cap[k]!;
      if (K <= 0) continue;
      sum += this.grass[k]! / K;
      n++;
    }
    return n > 0 ? sum / n : 0;
  }
}
