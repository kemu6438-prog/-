import { describe, expect, it } from "vitest";
import { BufferAttribute, BufferGeometry } from "three";
import { SKIRT, addSkirt } from "../src/world/skirt";

/** 底が高さ base、屋根が高さ top の箱（上向きの軸を axis にして作る）。ID は id */
function box(axis: 0 | 1 | 2, base: number, top: number, id: number, ox = 0): { pos: number[]; nor: number[]; ids: number[] } {
  const pos: number[] = [], nor: number[] = [], ids: number[] = [];
  const put = (h: number, a: number, b: number, n: [number, number, number]) => {
    const p = [0, 0, 0];
    p[axis] = h; p[(axis + 1) % 3] = a + ox; p[(axis + 2) % 3] = b;
    pos.push(...p);
    const q = [0, 0, 0];
    q[axis] = n[0]; q[(axis + 1) % 3] = n[1]; q[(axis + 2) % 3] = n[2];
    nor.push(...q);
    ids.push(id);
  };
  // 屋根 3 頂点 ×2 面、壁の下の頂点、壁の上の頂点
  for (let k = 0; k < 6; k++) put(top, k, k * 2, [1, 0, 0]);
  for (let k = 0; k < 6; k++) put(base, k, k * 2, [0, 1, 0]); // 壁の足もと
  for (let k = 0; k < 6; k++) put(top, k, k * 2, [0, 1, 0]); // 壁の上
  return { pos, nor, ids };
}

describe("建物の足もとを伸ばす", () => {
  for (const [axis, flip, scale] of [[0, 1, 1], [1, 1, 1], [2, 1, 1], [2, -1, 0.5]] as const) {
    it(`上向きの軸が ${"xyz"[axis]}（向き ${flip}、拡大 ${scale}）でも、足もとだけが下がる`, () => {
      const sgn = flip, a = box(axis, 5 * sgn, 30 * sgn, 1), b = box(axis, 2 * sgn, 12 * sgn, 2, 100);
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(new Float32Array([...a.pos, ...b.pos]), 3));
      g.setAttribute("normal", new BufferAttribute(new Float32Array([...a.nor, ...b.nor]), 3));
      g.setAttribute("_batchid", new BufferAttribute(new Float32Array([...a.ids, ...b.ids]), 1));
      // モデルの axis 軸が表示の y（上）になる行列。flip=true なら向きが逆、scale は拡大率
      const e = new Array(16).fill(0);
      e[15] = 1;
      const others = [0, 1, 2].filter((k) => k !== axis);
      e[axis * 4 + 1] = flip * scale; // 列 axis の y 成分
      e[others[0] * 4 + 0] = 1; e[others[1] * 4 + 2] = 1;
      expect(addSkirt(g, "_batchid", e)).toBe(true);
      const p = g.getAttribute("position");
      const hs: number[] = [];
      for (let i = 0; i < p.count; i++) hs.push(axis === 0 ? p.getX(i) : axis === 1 ? p.getY(i) : p.getZ(i));
      // 表示での高さ（= flip * scale * 座標）で比べる
      const w = hs.map((h) => h * flip * scale);
      const k = scale;
      expect(Math.min(...w.slice(0, 18))).toBeCloseTo(5 * k - SKIRT);
      expect(Math.max(...w.slice(0, 18))).toBeCloseTo(30 * k);
      expect(Math.min(...w.slice(18))).toBeCloseTo(2 * k - SKIRT);
      expect(Math.max(...w.slice(18))).toBeCloseTo(12 * k);
    });
  }
  it("建物 ID が無ければ何もしない", () => {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(9), 3));
    g.setAttribute("normal", new BufferAttribute(new Float32Array(9), 3));
    expect(addSkirt(g, null, new Array(16).fill(0))).toBe(false);
  });

  it("頂点の順番がばらばら（建物 ID が交互）でも、結果は同じ", () => {
    const a = box(1, 5, 30, 1), b = box(1, 2, 12, 2, 100);
    const mk = (order: number[]) => {
      const P = [...a.pos, ...b.pos], I = [...a.ids, ...b.ids];
      const pos: number[] = [], ids: number[] = [];
      for (const i of order) { pos.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); ids.push(I[i]); }
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute("_batchid", new BufferAttribute(new Float32Array(ids), 1));
      return g;
    };
    const n = a.ids.length + b.ids.length;
    const straight = Array.from({ length: n }, (_, i) => i);
    const shuffled = straight.slice().sort((i, j) => ((i * 7) % 11) - ((j * 7) % 11) || i - j);
    const g1 = mk(straight), g2 = mk(shuffled);
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(addSkirt(g1, "_batchid", I)).toBe(true);
    expect(addSkirt(g2, "_batchid", I)).toBe(true);
    const p1 = g1.getAttribute("position"), p2 = g2.getAttribute("position");
    shuffled.forEach((orig, k) => {
      expect(p2.getY(k)).toBeCloseTo(p1.getY(orig), 5);
    });
  });
});
