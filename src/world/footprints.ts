// 建物の「足あと」（上から見た輪郭）を、1m 四方の升目で覚えておく。
// 街路樹・低木などが建物にめり込まないよう、置き場所が足あとの中かどうかを調べるために使う。
// 建物のデータは読み込みのたびに届くので、届いた分だけ書き足していく。
const BLOCK = 64; // 64×64 升を 1 つのまとまりにする

export class Footprints {
  /** 書き足しのたびに増える番号（置いた物の再点検が必要かの目印） */
  version = 0;
  private readonly blocks = new Map<number, Uint8Array>();
  /** まとまりごとに、最後に書き換えた時の version（置いた物の再点検を、変わった所の近くだけに絞るため） */
  private readonly blockVer = new Map<number, number>();
  private touched = new Set<number>();
  private dirty = false;

  clear() {
    this.queue = [];
    this.qPos = 0;
    this.blocks.clear();
    this.blockVer.clear();
    this.touched.clear();
    this.version++;
    this.dirty = false;
  }

  private block(bx: number, bz: number, make: boolean): Uint8Array | undefined {
    const key = (bx + 32768) * 65536 + (bz + 32768);
    let b = this.blocks.get(key);
    if (!b && make) { b = new Uint8Array(BLOCK * BLOCK); this.blocks.set(key, b); }
    return b;
  }

  /** 三角形（上から見た座標 x, z）の中にある升を埋める */
  addTriangle(ax: number, az: number, bx: number, bz: number, cx: number, cz: number) {
    const minX = Math.floor(Math.min(ax, bx, cx)), maxX = Math.floor(Math.max(ax, bx, cx));
    const minZ = Math.floor(Math.min(az, bz, cz)), maxZ = Math.floor(Math.max(az, bz, cz));
    if ((maxX - minX + 1) * (maxZ - minZ + 1) > 4_000_000) return; // 異常に大きい物は無視
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-9) return;
    // 升ごとに Map を引くと遅いので、同じまとまりの間は直前のまとまりを使い回す
    let cbx = NaN, cbz = NaN, cb: Uint8Array | undefined;
    for (let iz = minZ; iz <= maxZ; iz++) {
      const pz = iz + 0.5;
      const bzz = Math.floor(iz / BLOCK);
      const rowOff = (iz - bzz * BLOCK) * BLOCK;
      for (let ix = minX; ix <= maxX; ix++) {
        const px = ix + 0.5;
        const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / d;
        const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / d;
        // 升の中心が三角形の中（ふちは少しだけ広めにとる）
        if (l1 >= -0.01 && l2 >= -0.01 && 1 - l1 - l2 >= -0.01) {
          const bxx = Math.floor(ix / BLOCK);
          if (bxx !== cbx || bzz !== cbz) { cbx = bxx; cbz = bzz; cb = this.block(bxx, bzz, true); this.touched.add((bxx + 32768) * 65536 + (bzz + 32768)); }
          cb![rowOff + ix - bxx * BLOCK] = 1;
        }
      }
    }
    this.dirty = true;
  }

  private queue: Float32Array[] = [];
  private qPos = 0; // 先頭の塊の、どこまで処理したか（三角形の番号）

  /** 屋根の三角形（x, z を 3 点ぶん = 6 個ずつ）を、あとで処理する列に入れる */
  enqueue(tris: Float32Array) {
    this.queue.push(tris);
  }

  get pending(): number {
    let n = 0;
    for (const q of this.queue) n += q.length / 6;
    return n - this.qPos;
  }

  /** 列の先頭から、時間（ミリ秒）の許す範囲だけ書き込む。1 コマに 1 回呼ぶ */
  step(budgetMs: number) {
    if (this.queue.length === 0) return;
    const t0 = performance.now();
    let n = 0;
    while (this.queue.length > 0) {
      const q = this.queue[0];
      const total = q.length / 6;
      while (this.qPos < total) {
        const k = this.qPos * 6;
        this.addTriangle(q[k], q[k + 1], q[k + 2], q[k + 3], q[k + 4], q[k + 5]);
        this.qPos++;
        if ((++n & 31) === 0 && performance.now() - t0 > budgetMs) { this.commit(); return; }
      }
      this.queue.shift();
      this.qPos = 0;
    }
    this.commit();
  }

  /** 書き込みがあったら番号を進める */
  private commit() {
    if (this.dirty) {
      this.version++;
      for (const k of this.touched) this.blockVer.set(k, this.version);
      this.touched.clear();
      this.dirty = false;
    }
  }

  /** (x, z) の半径 r 以内のまとまりに、version より新しい書き込みがあったか（無ければ、再点検は要らない） */
  changedSince(x: number, z: number, r: number, version: number): boolean {
    const b0x = Math.floor((x - r) / BLOCK), b1x = Math.floor((x + r) / BLOCK);
    const b0z = Math.floor((z - r) / BLOCK), b1z = Math.floor((z + r) / BLOCK);
    for (let bx = b0x; bx <= b1x; bx++) {
      for (let bz = b0z; bz <= b1z; bz++) {
        const v = this.blockVer.get((bx + 32768) * 65536 + (bz + 32768));
        if (v !== undefined && v > version) return true;
      }
    }
    return false;
  }

  has(x: number, z: number): boolean {
    const ix = Math.floor(x), iz = Math.floor(z);
    const bx = Math.floor(ix / BLOCK), bz = Math.floor(iz / BLOCK);
    const b = this.block(bx, bz, false);
    return !!b && b[(iz - bz * BLOCK) * BLOCK + (ix - bx * BLOCK)] === 1;
  }

  /** (x, z) から半径 r 以内に足あとがあるか（中心と、上下左右・斜めの 8 点で調べる） */
  near(x: number, z: number, r: number): boolean {
    if (this.has(x, z)) return true;
    if (r <= 0) return false;
    const q = r * 0.7071;
    return this.has(x + r, z) || this.has(x - r, z) || this.has(x, z + r) || this.has(x, z - r)
      || this.has(x + q, z + q) || this.has(x - q, z + q) || this.has(x + q, z - q) || this.has(x - q, z - q);
  }
}
