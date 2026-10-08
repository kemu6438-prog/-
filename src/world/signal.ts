// 信号の色の移り変わり。画面（光り方）と、あとで作る車の判断（赤で止まる）で同じ計算を使う。
import { uniform } from "three/tsl";

/** 1 周の長さ（秒）。縦方向が青 → 横方向が青、の繰り返し */
export const SIGNAL_PERIOD = 80;
export const GREEN_END = 32;
export const YELLOW_END = 35;

/** 信号が進んでいる時間（秒）。毎コマ更新する */
export const signalClock = uniform(0);

export type Light = 0 | 1 | 2; // 0 青 / 1 黄 / 2 赤

/**
 * t: 時計（秒）, phase: 交差点ごとのずれ（秒）, axis: 0=縦方向（北南）から来る車 / 1=横方向（東西）から来る車
 */
export function signalState(t: number, phase: number, axis: number): Light {
  const x = (((t + phase + axis * (SIGNAL_PERIOD / 2)) % SIGNAL_PERIOD) + SIGNAL_PERIOD) % SIGNAL_PERIOD;
  if (x < GREEN_END) return 0;
  if (x < YELLOW_END) return 1;
  return 2;
}
