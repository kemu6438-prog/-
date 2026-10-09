import { describe, expect, it } from "vitest";
import { BoxGeometry, BufferAttribute, BufferGeometry } from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { Footprints } from "../src/world/footprints";
import { WALL_ATTR, addWallTangents } from "../src/world/walls";

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 中心 (cx, cz)、幅 w、奥行き d、高さ h の箱を、y 軸まわりに rot 回した行列つきで作る（位置だけで頂点を共有した版もある） */
function box(shared: boolean, w = 20, d = 10, h = 30) {
  let g: BufferGeometry = new BoxGeometry(w, h, d);
  g.translate(0, h / 2, 0);
  if (shared) {
    g.deleteAttribute("normal");
    g.deleteAttribute("uv");
    g = mergeVertices(g);
  }
  return g;
}
function rotY(a: number, cx: number, cz: number) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, cx, 0, cz, 1];
}

/** 壁の頂点の向きから、壁ごとの向きの集合を取り出す（法線で壁を見分ける） */
function tangentsByWall(g: BufferGeometry, m: number[]) {
  const pos = g.getAttribute("position"), t = g.getAttribute(WALL_ATTR), ix = g.index!;
  const res: number[][] = [];
  for (let k = 0; k < ix.count; k += 3) {
    const [a, b, c] = [ix.getX(k), ix.getX(k + 1), ix.getX(k + 2)];
    const p = (i: number) => [pos.getX(i), pos.getY(i), pos.getZ(i)];
    const [pa, pb, pc] = [p(a), p(b), p(c)];
    const u = pb.map((v, i) => v - pa[i]), v = pc.map((x, i) => x - pa[i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (Math.abs(n[1]) / Math.hypot(...n) > 0.5) continue;
    // 壁の三角形: 3 頂点の向きが、この三角形の向きと一致しているか
    const wn = [m[0] * n[0] + m[4] * n[1] + m[8] * n[2], m[2] * n[0] + m[6] * n[1] + m[10] * n[2]];
    const hl = Math.hypot(wn[0], wn[1]);
    let ex = -wn[1] / hl, ez = wn[0] / hl;
    if (ex * Math.cos(0.37) + ez * Math.sin(0.37) < 0) { ex = -ex; ez = -ez; }
    for (const i of [a, b, c]) res.push([t.getX(i) - ex, t.getY(i) - ez]);
  }
  return res;
}

describe("壁の向きを頂点に書き込む", () => {
  for (const shared of [false, true]) {
    for (const rot of [0, 0.5, 1.9, -2.7]) {
      it(`${shared ? "頂点を共有した箱" : "面ごとに頂点を持つ箱"}（回転 ${rot}）: どの壁の三角形も、頂点の向きが壁の向きと一致する`, () => {
        const g = box(shared);
        const m = rotY(rot, 300, -150);
        const st = addWallTangents(g, m, null)!;
        expect(st.walls).toBe(8);
        if (shared) expect(st.duplicated).toBeGreaterThan(0);
        for (const [dx, dz] of tangentsByWall(g, m)) {
          expect(Math.abs(dx)).toBeLessThan(1e-4);
          expect(Math.abs(dz)).toBeLessThan(1e-4);
        }
        // 頂点数と属性の長さが合っている
        const n = g.getAttribute("position").count;
        expect(g.getAttribute(WALL_ATTR).count).toBe(n);
        expect(g.getAttribute("position").count).toBe(n);
        if (g.getAttribute("normal")) expect(g.getAttribute("normal").count).toBe(n);
      });
    }
  }

  it("巻き方向が逆の壁でも、向きの正負はそろう", () => {
    const g = box(false);
    const a = new BoxGeometry(20, 30, 10);
    const i = g.index!;
    // 全部の三角形の巻き方向を反転
    for (let k = 0; k < i.count; k += 3) { const t = i.getX(k + 1); i.setX(k + 1, i.getX(k + 2)); i.setX(k + 2, t); }
    const g2 = box(false);
    addWallTangents(g, I, null);
    addWallTangents(g2, I, null);
    const A = g.getAttribute(WALL_ATTR), B = g2.getAttribute(WALL_ATTR);
    for (let k = 0; k < A.count; k++) {
      expect(A.getX(k)).toBeCloseTo(B.getX(k), 5);
      expect(A.getY(k)).toBeCloseTo(B.getY(k), 5);
    }
    void a;
  });

  it("屋根の輪郭が足あとに書き込まれる", () => {
    const fp = new Footprints();
    const g = box(false, 20, 10, 30);
    addWallTangents(g, rotY(0, 100, 50), fp);
    expect(fp.pending).toBeGreaterThan(0);
    expect(fp.has(100, 50)).toBe(false); // まだ書き込まれていない
    fp.step(1e9);
    expect(fp.pending).toBe(0);
    expect(fp.version).toBeGreaterThan(0);
    expect(fp.has(100, 50)).toBe(true);
    expect(fp.has(109, 54)).toBe(true);
    expect(fp.has(111, 50)).toBe(false);
    expect(fp.has(100, 56)).toBe(false);
    expect(fp.near(111.4, 50, 2)).toBe(true);
    expect(fp.near(115, 50, 2)).toBe(false);
  });

  it("回した建物でも足あとが合う", () => {
    const fp = new Footprints();
    const g = box(false, 40, 8, 20);
    addWallTangents(g, rotY(Math.PI / 4, -200, 300), fp);
    fp.step(1e9);
    // 45 度回した長い建物: 中心から (14, 14) 方向（長辺の向き）は中、直角方向 (6, -6) は外
    expect(fp.has(-200 + 14, 300 - 14)).toBe(true);
    expect(fp.has(-200 + 6, 300 + 6)).toBe(false);
  });
});
