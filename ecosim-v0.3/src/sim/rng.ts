// 決定論的乱数（xorshift128 + splitmix32 初期化）。
// 同じシードなら同じ世界・同じ進化になる（リプレイ・デバッグ用）。
// DOM / Math.random には依存しない。

export class Rng {
  private x: number;
  private y: number;
  private z: number;
  private w: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    const next = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 16), 0x85ebca6b) >>> 0;
      t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35) >>> 0;
      return (t ^ (t >>> 16)) >>> 0;
    };
    this.x = next();
    this.y = next();
    this.z = next();
    this.w = next();
    if ((this.x | this.y | this.z | this.w) === 0) this.x = 1;
  }

  u32(): number {
    const t = this.x ^ (this.x << 11);
    this.x = this.y;
    this.y = this.z;
    this.z = this.w;
    this.w = (this.w ^ (this.w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return this.w;
  }

  /** [0, 1) */
  float(): number {
    return this.u32() / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.float();
  }

  /** [0, n) の整数 */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }

  /** 標準正規分布（Box-Muller） */
  gauss(): number {
    let u = 0;
    while (u === 0) u = this.float();
    const v = this.float();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
