// 切妻屋根・屋上小物（src/world/roofExtras.ts）のテスト。three.js には入れず純粋な計算だけ試す
import { describe, expect, it } from "vitest";
import { BufferAttribute, BufferGeometry } from "three";
import { buildRoofExtras } from "../src/world/roofExtras";

/** 幅 w（x）× 奥行き d（z）× 高さ h の箱（上向きは y）。id で 1 棟ぶん */
function boxGeo(w: number, d: number, h: number, id: number): BufferGeometry {
  const x = w / 2, z = d / 2;
  // 8 頂点（0-3 下、4-7 上）
  const v = [[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z], [-x, h, -z], [x, h, -z], [x, h, z], [-x, h, z]];
  const faces = [
    [4, 5, 6], [4, 6, 7], // 上
    [1, 0, 3], [1, 3, 2], // 下
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  const pos: number[] = [], ids: number[] = [], idx: number[] = [];
  for (const f of faces) for (const k of f) { pos.push(...v[k]); ids.push(id); idx.push(pos.length / 3 - 1); }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("_batchid", new BufferAttribute(new Float32Array(ids), 1));
  g.setIndex(idx);
  return g;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const maxY = (ex: { pos: Float32Array }) => { let m = -Infinity; for (let i = 1; i < ex.pos.length; i += 3) m = Math.max(m, ex.pos[i]); return m; };
const maxZ = (ex: { pos: Float32Array }) => { let m = -Infinity; for (let i = 2; i < ex.pos.length; i += 3) m = Math.max(m, ex.pos[i]); return m; };

describe("箱の建物に屋根・小物を付け足す", () => {
  it("小さく低い建物には、切妻屋根（頂上が 1.2〜3.8 m 高くなる）が付くことがある", () => {
    let gable = 0, tried = 0;
    for (let id = 1; id <= 40; id++) {
      const ex = buildRoofExtras(boxGeo(8, 6, 4, id), "_batchid", IDENTITY);
      tried++;
      if (!ex) continue;
      const m = maxY(ex);
      expect(m).toBeLessThanOrEqual(4 + 3.8); // 高すぎる屋根は作らない
      if (m > 4 + 1.2) gable++;
    }
    expect(gable).toBeGreaterThan(tried * 0.3); // 一定の割合で切妻にする
  });

  it("高い建物には切妻は付かず、塔屋（屋上の箱 2.3 m）だけが付く", () => {
    const ex = buildRoofExtras(boxGeo(10, 10, 40, 3), "_batchid", IDENTITY);
    expect(ex).not.toBeNull();
    const m = maxY(ex!);
    expect(m).toBeGreaterThan(40 + 2); // 塔屋の上端
    expect(m).toBeLessThan(40 + 8); // アンテナまで入れても、切妻のような大きな盛り上がりにはならない
  });

  it("座標系がちがう（モデルは z が上）でも、ローカルの座標で正しく作れる", () => {
    // z が上の箱（8×6、高さは z 方向 4）
    const gz = ((): BufferGeometry => {
      const x = 4, z = 3, h = 4;
      const v = [[-x, -z, 0], [x, -z, 0], [x, z, 0], [-x, z, 0], [-x, -z, h], [x, -z, h], [x, z, h], [-x, z, h]];
      const faces = [[4, 5, 6], [4, 6, 7], [1, 0, 3], [1, 3, 2], [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0]];
      const pos: number[] = [], ids: number[] = [], idx: number[] = [];
      for (const f of faces) for (const k of f) { pos.push(...v[k]); ids.push(1); idx.push(pos.length / 3 - 1); }
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute("_batchid", new BufferAttribute(new Float32Array(ids), 1));
      g.setIndex(idx);
      return g;
    })();
    // モデルの z 軸が表示の y（上）になる行列（skirt のテストと同じやり方。列優先: e[9] が「列2 の y」）
    const e = new Array(16).fill(0); e[15] = 1; e[0] = 1; e[6] = 1; e[9] = 1;
    let gable = 0, tried = 0;
    for (let id = 1; id <= 40; id++) {
      const g2 = gz.clone();
      (g2.getAttribute("_batchid").array as Float32Array).fill(id);
      const ex = buildRoofExtras(g2, "_batchid", e);
      tried++;
      if (!ex) continue;
      if (maxZ(ex) > 4 + 1.2) gable++;
    }
    expect(gable).toBeGreaterThan(tried * 0.3);
  });

  it("L 字（大きな欠けのある形）には切妻を付けない", () => {
    // 1 枚の L 字の建物: 角を 1 つ欠いた 8×6（欠けた所の屋根に屋根を載せると、空中に浮く）
    const h = 4;
    const ring = [[0, 0], [8, 0], [8, 3], [5, 3], [5, 6], [0, 6]];
    const pos: number[] = [], ids: number[] = [], idx: number[] = [];
    const put = (x: number, y: number, z: number) => { pos.push(x, y, z); ids.push(1); return pos.length / 3 - 1; };
    // 上の面（扇形に三角形分割）
    for (let i = 1; i < ring.length - 1; i++) {
      idx.push(put(ring[0][0], h, ring[0][1]), put(ring[i + 1][0], h, ring[i + 1][1]), put(ring[i][0], h, ring[i][1]));
    }
    // 壁（上と下の四角形を巻く）
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const b0 = put(a[0], 0, a[1]), a0 = put(b[0], 0, b[1]), a1 = put(b[0], h, b[1]), b1 = put(a[0], h, a[1]);
      idx.push(b0, a0, a1, b0, a1, b1);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute("_batchid", new BufferAttribute(new Float32Array(ids), 1));
    g.setIndex(idx);
    const ex = buildRoofExtras(g, "_batchid", IDENTITY);
    if (ex) expect(maxY(ex)).toBeLessThanOrEqual(4 + 0.9); // 切妻（1.1 m 以上）が付いていない
  });

  it("建物 ID が無いときは何もしない", () => {
    expect(buildRoofExtras(boxGeo(8, 6, 4, 1), null, IDENTITY)).toBeNull();
  });
});
