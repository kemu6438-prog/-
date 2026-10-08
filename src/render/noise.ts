// 画像ファイルを使わずに「ざらつき・むら」を作るための小さな乱数（シェーダー用）
import * as THREE from "three/webgpu";
import { dot, float, floor, fract, mix, sin, texture, vec2 } from "three/tsl";

// TSL の型定義は複雑なので、式の組み立てではゆるい型を使う
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type N = any;

/** 2 次元の座標から 0〜1 の疑似乱数（同じ入力なら同じ値） */
export const hash21 = (p: N): N => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));

/**
 * 乱数の画像（256×256、起動時に計算で作る。ダウンロードはしない）。
 * sin を何度も計算する代わりに、この画像を 1 回読むだけで「なめらかな乱数」を得る（重い GPU 計算を減らすため）。
 */
const noiseData = (() => {
  const n = 256;
  const a = new Uint8Array(n * n * 4);
  let x = 123456789;
  for (let i = 0; i < a.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; // xorshift
    a[i] = (x >>> 0) & 255;
  }
  const t = new THREE.DataTexture(a, n, n, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
})();

/** なめらかな乱数（雲のようなむら）。0〜1。p の 1 単位ごとに値が変わり、256 単位でくり返す */
export const vnoise = (p: N): N => texture(noiseData, p.mul(1.0 / 256.0)).r;

/** 元の計算式（sin を使う重い版）。比較・予備用 */
export const vnoiseExact = (p: N): N => {
  const i: N = floor(p);
  const f: N = fract(p);
  const w: N = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  const a = hash21(i);
  const b = hash21(i.add(vec2(1.0, 0.0)));
  const c = hash21(i.add(vec2(0.0, 1.0)));
  const d = hash21(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
};
