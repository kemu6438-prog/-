// 脳（spec §6.5）：固定トポロジー MLP 32 → 12 → 12 → 14（tanh）、重み 696。
// 順伝播は「層ループ（全個体をまとめて層ごとに処理）」で書く（キャッシュ効率）。
// 学習は出力層直前の重み（H2→OUT）のみ。3 因子 Hebb：ΔW = η · plasticity · reward · eligibility。

export const IN = 32;
export const H1 = 12;
export const H2 = 12;
export const OUT = 14;
const W1_OFF = 0;
const W2_OFF = IN * H1; // 384
const W3_OFF = W2_OFF + H1 * H2; // 528
export const BRAIN_W = W3_OFF + H2 * OUT; // 696
export const ELIG_LEN = H2 * OUT; // 168

/** brainSize 遺伝子から有効な隠れユニット数（4〜12）。 */
export function activeUnits(brainSize: number): number {
  return 4 + Math.round(Math.max(0, Math.min(1, brainSize)) * 8);
}

/**
 * 層ループの順伝播。
 * slots[k] は個体のスロット番号。W は全個体の重み（slot*BRAIN_W で参照）。
 * X: n*IN、H1a: n*H1、H2a: n*H2、O: n*OUT。active[k] は有効隠れユニット数。
 */
export function forwardBatch(
  W: Float32Array,
  slots: Int32Array,
  n: number,
  X: Float32Array,
  H1a: Float32Array,
  H2a: Float32Array,
  O: Float32Array,
  active: Uint8Array,
): void {
  // 層 1：入力 → 隠れ1
  for (let k = 0; k < n; k++) {
    const wb = slots[k]! * BRAIN_W + W1_OFF;
    const xb = k * IN;
    const hb = k * H1;
    const act = active[k]!;
    for (let h = 0; h < H1; h++) {
      if (h >= act) {
        H1a[hb + h] = 0;
        continue;
      }
      let s = 0;
      for (let i = 0; i < IN; i++) s += X[xb + i]! * W[wb + i * H1 + h]!;
      H1a[hb + h] = Math.tanh(s);
    }
  }
  // 層 2：隠れ1 → 隠れ2
  for (let k = 0; k < n; k++) {
    const wb = slots[k]! * BRAIN_W + W2_OFF;
    const hb = k * H1;
    const hb2 = k * H2;
    const act = active[k]!;
    for (let h = 0; h < H2; h++) {
      if (h >= act) {
        H2a[hb2 + h] = 0;
        continue;
      }
      let s = 0;
      for (let i = 0; i < H1; i++) s += H1a[hb + i]! * W[wb + i * H2 + h]!;
      H2a[hb2 + h] = Math.tanh(s);
    }
  }
  // 層 3：隠れ2 → 出力
  for (let k = 0; k < n; k++) {
    const wb = slots[k]! * BRAIN_W + W3_OFF;
    const hb2 = k * H2;
    const ob = k * OUT;
    for (let o = 0; o < OUT; o++) {
      let s = 0;
      for (let h = 0; h < H2; h++) s += H2a[hb2 + h]! * W[wb + h * OUT + o]!;
      O[ob + o] = Math.tanh(s);
    }
  }
}

/**
 * 1 個体ぶんの学習（出力層直前の重みのみ）。
 * E は適格性トレース（個体ごとに ELIG_LEN）。reward は [-1, 1]。
 */
export function learnOne(
  W: Float32Array,
  slot: number,
  E: Float32Array,
  H2v: Float32Array,
  H2off: number,
  O: Float32Array,
  Ooff: number,
  reward: number,
  plasticity: number,
  lr: number,
  decay: number,
  base: Float32Array,
  baseOff: number,
  memoryDecay: number,
): void {
  const wb = slot * BRAIN_W + W3_OFF;
  const eb = slot * ELIG_LEN;
  const pl = lr * plasticity;
  for (let h = 0; h < H2; h++) {
    const pre = H2v[H2off + h]!;
    for (let o = 0; o < OUT; o++) {
      const idx = h * OUT + o;
      const e = E[eb + idx]! * decay + pre * O[Ooff + o]!;
      E[eb + idx] = e;
      let w = W[wb + idx]! + pl * reward * e;
      // 記憶の忘却：遺伝子（base）へ緩やかに戻る
      if (memoryDecay > 0) w += memoryDecay * 0.001 * (base[baseOff + W3_OFF + idx]! - w);
      W[wb + idx] = w < -4 ? -4 : w > 4 ? 4 : w;
    }
  }
}
