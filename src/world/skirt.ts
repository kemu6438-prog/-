// 建物の足もとを地面の下へ伸ばして、地面との隙間（浮き）を隠す。
// three.js に依存しない純粋な処理（型だけ使う）。「どちらが上か」は、行列（モデル → 表示用の座標）から求める。
import type { BufferGeometry } from "three";

/** 建物の足もとを地面の下へ伸ばす長さ（m）。地面は平らな仮のものなので、本当の地面が高い所で建物が浮いて見えるのを隠す */
export const SKIRT = 6;

/** 3×3 の逆行列（列優先の 16 要素の行列の左上 3×3 を使う）。逆行列が無ければ null */
function inv3(e: ArrayLike<number>): number[] | null {
  const a = e[0], b = e[4], c = e[8];
  const d = e[1], f = e[5], g = e[9];
  const h = e[2], i = e[6], j = e[10];
  const A = f * j - g * i, B = g * h - d * j, C = d * i - f * h;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  // 行優先で返す
  return [
    A * k, (c * i - b * j) * k, (b * g - c * f) * k,
    B * k, (a * j - c * h) * k, (c * d - a * g) * k,
    C * k, (b * h - a * i) * k, (a * f - b * d) * k,
  ];
}

/**
 * 建物ごとに、いちばん低い頂点（足もと）を SKIRT だけ真下へ下げる。壁が地面の下まで伸びて、浮いて見えなくなる。
 * @param toWorld モデルの座標 → 表示の座標（y が上）の行列（列優先 16 要素）
 * 建物 ID が無いときは何もしない。
 */
export function addSkirt(g: BufferGeometry, idName: string | null, toWorld: ArrayLike<number>): boolean {
  const pos = g.getAttribute("position");
  const ids = idName ? g.getAttribute(idName) : null;
  if (!pos || !ids || pos.itemSize < 3) return false;
  const inv = inv3(toWorld);
  if (!inv) return false;
  // 表示の上向き（0,1,0）に対応する、モデル座標での向き（長さは、表示で 1m になるように）
  const dx = inv[1], dy = inv[4], dz = inv[7];
  // 高さ = 表示の y 座標（位置に依存しない定数は省く）
  const r0 = toWorld[1], r1 = toWorld[5], r2 = toWorld[9];
  const n = pos.count;
  const low = new Map<number, number>();
  const hs = new Float32Array(n);
  // 同じ建物の頂点は並んでいることが多いので、直前の建物の値は手元に持って、Map は建物が変わるときだけ触る（結果は同じで、読み込み時の時間が減る）
  let curId = NaN, curLow = Infinity;
  for (let i = 0; i < n; i++) {
    const h = r0 * pos.getX(i) + r1 * pos.getY(i) + r2 * pos.getZ(i);
    hs[i] = h;
    const id = ids.getX(i);
    if (id !== curId) {
      if (curId === curId) { const c = low.get(curId); if (c === undefined || curLow < c) low.set(curId, curLow); }
      curId = id;
      curLow = Infinity;
    }
    if (h < curLow) curLow = h;
  }
  if (curId === curId) { const c = low.get(curId); if (c === undefined || curLow < c) low.set(curId, curLow); }
  let lastId = NaN, lastLow = 0;
  for (let i = 0; i < n; i++) {
    const id = ids.getX(i);
    if (id !== lastId) { lastId = id; lastLow = low.get(id) as number; }
    if (hs[i] <= lastLow + 0.08) {
      pos.setXYZ(i, pos.getX(i) - dx * SKIRT, pos.getY(i) - dy * SKIRT, pos.getZ(i) - dz * SKIRT);
    }
  }
  pos.needsUpdate = true;
  g.boundingBox = null;
  g.boundingSphere = null;
  return true;
}
