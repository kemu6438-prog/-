// ゲノム（spec §6.1）。テーブル駆動の形質座位 × 相同2本 ＋ 脳の重み（単一倍体）。
// 個体あたり GENOME_LEN = 120 + 696 = 816 floats。アレルは [0,1] に正規化して持ち、
// decode() で [min,max] の実値へ写す。DOM / Three.js 非依存。

import { Rng } from './rng';

export const SCHEMA_VERSION = 1;
export const TRAIT_LOCI = 60; // 形質座位（仕様の 60。表に定義した 57 座位＋予備 3）
export const DIPLOID_LEN = TRAIT_LOCI * 2; // 120
export const BRAIN_LEN = 696; // 32*12 + 12*12 + 12*14
export const GENOME_LEN = DIPLOID_LEN + BRAIN_LEN; // 816

export interface Locus {
  id: string;
  name: string;
  min: number;
  max: number;
}

/** 形質座位の表（spec §6.1.1）。予備は RES1..RES3。 */
export const LOCI: Locus[] = [
  { id: 'M01', name: 'bodyLength', min: 0.2, max: 4.0 },
  { id: 'M02', name: 'bodyWidth', min: 0.4, max: 1.6 },
  { id: 'M03', name: 'bodyHeight', min: 0.4, max: 1.6 },
  { id: 'M04', name: 'mass', min: 0.5, max: 800 }, // 派生値（decode で上書き）
  { id: 'M05', name: 'legLength', min: 0.1, max: 2.5 },
  { id: 'M06', name: 'legThickness', min: 0.3, max: 2.0 },
  { id: 'M07', name: 'legCount', min: 2, max: 6 },
  { id: 'M08', name: 'muscleRatio', min: 0, max: 1 },
  { id: 'M09', name: 'fatRatio', min: 0, max: 1 },
  { id: 'M10', name: 'headSize', min: 0.3, max: 2.0 },
  { id: 'M11', name: 'neckLength', min: 0, max: 1.5 },
  { id: 'M12', name: 'tailLength', min: 0, max: 2.0 },
  { id: 'M13', name: 'earSize', min: 0, max: 1 },
  { id: 'M14', name: 'furDensity', min: 0, max: 1 },
  { id: 'M15', name: 'armorPlating', min: 0, max: 1 },
  { id: 'M16', name: 'clawSize', min: 0, max: 1 },
  { id: 'M17', name: 'toothType', min: 0, max: 1 },
  { id: 'M18', name: 'hornType', min: 0, max: 3 },
  { id: 'M19', name: 'hornSize', min: 0, max: 1.5 },
  { id: 'M20', name: 'eyeSize', min: 0, max: 1 },
  { id: 'M21', name: 'eyePosition', min: 0, max: 1 },
  { id: 'M22', name: 'snoutLength', min: 0, max: 1 },
  { id: 'M23', name: 'bodyHue', min: 0, max: 1 },
  { id: 'M24', name: 'bodySat', min: 0, max: 1 },
  { id: 'M25', name: 'bodyLum', min: 0, max: 1 },
  { id: 'M26', name: 'patternType', min: 0, max: 3 },
  { id: 'M27', name: 'patternScale', min: 0, max: 1 },
  { id: 'M28', name: 'bioluminescence', min: 0, max: 1 },
  { id: 'M29', name: 'webbedFeet', min: 0, max: 1 },
  { id: 'M30', name: 'metabolismRate', min: 0.5, max: 2.0 },
  { id: 'L01', name: 'diet', min: 0, max: 1 },
  { id: 'L02', name: 'digestiveEfficiency', min: 0.3, max: 0.95 },
  { id: 'L03', name: 'stomachCapacity', min: 0.5, max: 3 },
  { id: 'L04', name: 'thirstTolerance', min: 0, max: 1 },
  { id: 'L05', name: 'thermalTolerance', min: 0, max: 1 },
  { id: 'L06', name: 'preferredTemp', min: -10, max: 45 },
  { id: 'L07', name: 'maxAge', min: 1, max: 20 },
  { id: 'L08', name: 'maturityAge', min: 0.2, max: 5 },
  { id: 'L09', name: 'litterSize', min: 1, max: 8 },
  { id: 'L10', name: 'gestationCost', min: 0, max: 1 },
  { id: 'L11', name: 'parentalCare', min: 0, max: 1 },
  { id: 'L12', name: 'growthRate', min: 0.3, max: 2 },
  { id: 'L13', name: 'diseaseResistance', min: 0, max: 1 },
  { id: 'L14', name: 'toxinResistance', min: 0, max: 1 },
  { id: 'L15', name: 'circadian', min: 0, max: 1 },
  { id: 'N01', name: 'brainSize', min: 0, max: 1 },
  { id: 'N02', name: 'plasticity', min: 0, max: 1 },
  { id: 'N03', name: 'memoryDecay', min: 0, max: 1 },
  { id: 'N04', name: 'curiosity', min: 0, max: 1 },
  { id: 'N05', name: 'aggression', min: 0, max: 1 },
  { id: 'N06', name: 'boldness', min: 0, max: 1 },
  { id: 'B07', name: 'sociability', min: 0, max: 1 },
  { id: 'B08', name: 'territoriality', min: 0, max: 1 },
  { id: 'B09', name: 'mateSelectivity', min: 0, max: 1 },
  { id: 'B10', name: 'matePreferenceHue', min: 0, max: 1 },
  { id: 'B11', name: 'parentalInstinct', min: 0, max: 1 },
  { id: 'B12', name: 'startleReflex', min: 0, max: 1 },
  { id: 'RES1', name: 'reserved1', min: 0, max: 1 },
  { id: 'RES2', name: 'reserved2', min: 0, max: 1 },
  { id: 'RES3', name: 'reserved3', min: 0, max: 1 },
];

/** 名前から座位番号を引く */
export const LOCUS = Object.fromEntries(LOCI.map((l, i) => [l.name, i])) as Record<string, number>;

/** 表現型（decode の結果）。実値。 */
export interface Phenotype {
  mass: number;
  leg: number;
  fur: number;
  hue: number;
  metabolism: number;
  maxSpeedMul: number;
  preferredTemp: number;
  thermalTol: number;
  thirstTol: number;
  startle: number;
  brainSize: number;
  plasticity: number;
  memoryDecay: number;
  sociability: number;
  diet: number;
  digestEff: number;
  maxAge: number;
  maturity: number;
  litter: number;
}

/** 実値 ← 正規化アレル */
export function alleleToValue(locus: number, a: number): number {
  const l = LOCI[locus]!;
  return l.min + (l.max - l.min) * a;
}

/** 実値 → 正規化アレル */
export function valueToAllele(locus: number, v: number): number {
  const l = LOCI[locus]!;
  const a = (v - l.min) / (l.max - l.min);
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

/** 座位の（相同 2 本の平均）実値 */
export function locusValue(buf: Float32Array, off: number, locus: number): number {
  const a = (buf[off + locus * 2]! + buf[off + locus * 2 + 1]!) / 2;
  return alleleToValue(locus, a);
}

/** 表現型をデコードする（spec §6.1.2 の式の簡易版）。 */
export function decode(buf: Float32Array, off: number): Phenotype {
  const v = (name: string) => locusValue(buf, off, LOCUS[name]!);
  const bL = v('bodyLength');
  const bW = v('bodyWidth');
  const bH = v('bodyHeight');
  const muscle = v('muscleRatio');
  const fat = v('fatRatio');
  // 質量：体積 × 筋肉・脂肪の補正。デフォルト（bL=bW=bH=1, muscle 0.5）で 40 kg になるよう係数を取る（(補正) 基準個体）
  const mass = 40 * Math.pow(bL, 1.2) * Math.pow(bW, 1.5) * Math.pow(bH, 1.5) * ((0.6 + 0.4 * muscle) / 0.8) * (1 + 0.2 * fat);
  const legs = v('legCount');
  const legMul = legs > 3.5 && legs < 5 ? 1 : legs < 3.5 ? 1.15 : 0.95;
  const leg = v('legLength');
  const armor = v('armorPlating');
  return {
    mass,
    leg,
    fur: v('furDensity'),
    hue: v('bodyHue'),
    metabolism: v('metabolismRate'),
    maxSpeedMul: Math.sqrt(leg / 0.9) * legMul * (1 - 0.3 * fat) * (1 - 0.4 * armor),
    preferredTemp: v('preferredTemp'),
    thermalTol: v('thermalTolerance'),
    thirstTol: v('thirstTolerance'),
    startle: v('startleReflex'),
    brainSize: v('brainSize'),
    plasticity: v('plasticity'),
    memoryDecay: v('memoryDecay'),
    sociability: v('sociability'),
    diet: v('diet'),
    digestEff: v('digestiveEfficiency'),
    maxAge: v('maxAge'),
    maturity: v('maturityAge'),
    litter: v('litterSize'),
  };
}

/** 2 つの遺伝子の形質座位の平均差（0..1、種の分岐判定に使う）。 */
export function geneticDistance(a: Float32Array, offA: number, b: Float32Array, offB: number): number {
  let s = 0;
  const n = DIPLOID_LEN;
  for (let i = 0; i < n; i++) s += Math.abs(a[offA + i]! - b[offB + i]!);
  return s / n;
}

/** 形質を指定して遺伝子を初期化する（初期個体・放すツール用）。残りの座位は既定値付近にノイズ。 */
export function genomeFromPreset(
  buf: Float32Array,
  off: number,
  rng: Rng,
  preset: { bodyLength: number; mass: number; leg: number; fur: number; hue: number; diet: number; startle: number },
): void {
  for (let k = 0; k < DIPLOID_LEN; k++) {
    buf[off + k] = clamp01(0.5 + rng.gauss() * 0.05);
  }
  for (let k = 0; k < BRAIN_LEN; k++) buf[off + DIPLOID_LEN + k] = rng.gauss() * 0.4;
  const setLocus = (name: string, value: number) => {
    const li = LOCUS[name]!;
    const a = valueToAllele(li, value);
    buf[off + li * 2] = a;
    buf[off + li * 2 + 1] = a;
  };
  setLocus('bodyLength', preset.bodyLength);
  setLocus('bodyWidth', 1.0);
  setLocus('bodyHeight', 1.0);
  setLocus('muscleRatio', 0.5);
  setLocus('legLength', preset.leg);
  setLocus('furDensity', preset.fur);
  setLocus('bodyHue', preset.hue);
  setLocus('diet', preset.diet);
  setLocus('startleReflex', preset.startle);
  setLocus('preferredTemp', 20);
  setLocus('brainSize', 0.5);
  setLocus('plasticity', 0.5);
  setLocus('memoryDecay', 0.2);
  setLocus('legCount', 4);
  setLocus('maxAge', 8);
  setLocus('maturityAge', 1.5);
  setLocus('litterSize', 1.5);
  setLocus('digestiveEfficiency', 0.6);
  // 質量は bodyLength で決まるので、必要なら bodyLength を逆算する（mass = 40 * bL^1.2 * 1 * 1 * 1）
  const bL = Math.pow(preset.mass / 40, 1 / 1.2);
  setLocus('bodyLength', bL);
  // 体重は muscle 0.5・fat 0 を前提とする
  setLocus('fatRatio', 0);
  setLocus('armorPlating', 0); // 初期個体は装甲なし（速度を落とさない）
  // 脳の大きさは遺伝子で決まる（activeH = 4 + round(brainSize*8)）
}

/**
 * 生殖：減数分裂で各座位のアレルを親ごとに 1 つ選ぶ（相同の組換え）、
 * 脳の重みは層単位で「親 A / 親 B / 平均」から選ぶ（spec §6.5）。
 */
export function crossover(
  pa: Float32Array,
  oa: number,
  pb: Float32Array,
  ob: number,
  out: Float32Array,
  oo: number,
  rng: Rng,
): void {
  for (let l = 0; l < TRAIT_LOCI; l++) {
    out[oo + l * 2] = rng.float() < 0.5 ? pa[oa + l * 2]! : pa[oa + l * 2 + 1]!;
    out[oo + l * 2 + 1] = rng.float() < 0.5 ? pb[ob + l * 2]! : pb[ob + l * 2 + 1]!;
  }
  // 脳の重み：層（W1, W2, W3）ごとに選択
  const segs = [
    [0, 384],
    [384, 384 + 144],
    [384 + 144, BRAIN_LEN],
  ] as const;
  for (const [s, e] of segs) {
    const r = rng.float();
    for (let k = s; k < e; k++) {
      const i = DIPLOID_LEN + k;
      out[oo + i] = r < 0.4 ? pa[oa + i]! : r < 0.8 ? pb[ob + i]! : 0.5 * (pa[oa + i]! + pb[ob + i]!);
    }
  }
}

/** 突然変異：アレルは確率 rate で σ のガウス変異。脳の重みも同様（σ は重みの尺度）。 */
export function mutate(buf: Float32Array, off: number, rng: Rng, rate: number, sigma: number, jumpProb: number, jumpSigma: number): void {
  for (let k = 0; k < DIPLOID_LEN; k++) {
    if (rng.float() < rate) {
      const s = rng.float() < jumpProb ? jumpSigma : sigma;
      buf[off + k] = clamp01(buf[off + k]! + rng.gauss() * s);
    }
  }
  for (let k = 0; k < BRAIN_LEN; k++) {
    if (rng.float() < rate) {
      buf[off + DIPLOID_LEN + k] = buf[off + DIPLOID_LEN + k]! + rng.gauss() * sigma * 1.5;
    }
  }
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
