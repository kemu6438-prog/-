import { describe, expect, it } from "vitest";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
// @ts-expect-error 型定義がない
import vtpbf from "vt-pbf";
import { ZOOM, analyzeNodes, latToTileY, lonToTileX, parseRoadLayer, tileXToLon, tileYToLat } from "../src/world/roadData";
import { buildRibbon, roadExtra, sidewalkExtra } from "../src/world/roadGeometry";
import { placeFurniture } from "../src/world/roadFurniture";

function mockTile() {
  const tags = (rank: number) => ({ ftCode: 2701, rdCtg: 2, rnkWidth: rank, lvOrder: 0 });
  const L = (pts: number[][], rank: number) => ({ type: 2, geometry: [pts], tags: tags(rank) });
  // 中央(2048,2048)で 4 本が交わる十字路 + タイルの端で切れた線 + 高架（無視される）
  const features = [
    L([[2048, 0], [2048, 2048]], 3),
    L([[2048, 2048], [2048, 4096]], 3),
    L([[0, 2048], [2048, 2048]], 2),
    L([[2048, 2048], [4096, 2048]], 2),
    { type: 2, geometry: [[[100, 100], [900, 100]]], tags: { ...tags(2), lvOrder: 1 } },
    { type: 2, geometry: [[[100, 3000], [900, 3000]]], tags: { ftCode: 5301, rnkWidth: 2, lvOrder: 0 } },
  ];
  const buf = vtpbf.fromGeojsonVt({ road: { features, x: 0, y: 0, z: 16, numPoints: 0, extent: 4096 } }, { version: 2, extent: 4096 });
  const tile = new VectorTile(new Pbf(buf));
  return tile.layers.road;
}

describe("タイル計算", () => {
  it("経度緯度 ↔ タイル番号", () => {
    const x = lonToTileX(136.8816, ZOOM), y = latToTileY(35.17095, ZOOM);
    expect(tileXToLon(x, ZOOM)).toBeCloseTo(136.8816, 6);
    expect(tileYToLat(y, ZOOM)).toBeCloseTo(35.17095, 6);
  });
});

describe("道路データ", () => {
  const toXZ = (lon: number, lat: number): [number, number] => [(lon + 180) * 91000, -lat * 111000];
  const lines = parseRoadLayer(mockTile() as any, 0, 0, toXZ, (() => { let i = 0; return () => i++; })());
  it("道路中心線だけを取り出す（高架・道路でない物は除く）", () => {
    expect(lines.length).toBe(4);
  });
  it("十字路を交差点として見つけ、幅の広い方の半分を縁までの距離にする", () => {
    // 位置は適当な座標に置き直す
    const pts = [
      [0, -100, 0, 0], [0, 0, 0, 100], [-100, 0, 0, 0], [0, 0, 100, 0],
    ];
    const ls = lines.map((l, i) => ({ ...l, pts: new Float32Array(pts[i]), startCut: false, endCut: false, startShift: -1, endShift: -1, startNode: -1, endNode: -1 }));
    const nodes = analyzeNodes(ls);
    expect(nodes.length).toBe(1);
    expect(nodes[0].arms.length).toBe(4);
    // 幅員区分 3 の道の縁までは 7.75 m、区分 2 は 4.3 m
    const ns = ls[0].endShift; // 区分 3 の線の終点 → 交わる相手のうち最も広いのは区分 3（もう 1 本）
    expect(ns).toBeCloseTo(7.75, 2);
    // 街路樹は広い道（区分 3 以上）にだけ。区分 2 の道だけなら 1 本も植えない
    const f = placeFurniture(ls, nodes, { treeRadius: 1000 });
    expect(f.trees.length).toBeGreaterThan(0);
    const narrowOnly = ls.map((l) => ({ ...l, rank: 2 }));
    expect(placeFurniture(narrowOnly, nodes, { treeRadius: 1000 }).trees.length).toBe(0);
  });
  it("端がタイルの境目の線は交差点にしない", () => {
    expect(lines[0].startCut).toBe(true);
    expect(lines[0].endCut).toBe(false);
  });
});

describe("道の帯", () => {
  it("上向きの面になり、幅が正しい", () => {
    const line = {
      id: 1, pts: new Float32Array([0, 0, 0, -50]), rank: 2, ctg: 2, startShift: -1, endShift: -1,
      startNode: -1, endNode: -1, startCut: true, endCut: true, length: 50,
    };
    const rb = buildRibbon([line], roadExtra, 0.02);
    expect(rb.vertexCount).toBe(4);
    const p = rb.position;
    const v = (i: number) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
    for (let t = 0; t < rb.index.length; t += 3) {
      const a = v(rb.index[t]), b = v(rb.index[t + 1]), c = v(rb.index[t + 2]);
      const e1 = [b[0] - a[0], b[2] - a[2]], e2 = [c[0] - a[0], c[2] - a[2]];
      // 上から見て反時計回り（x=東, z=南の座標で）になっていれば法線は +y
      const ny = e1[1] * e2[0] - e1[0] * e2[1];
      expect(ny).toBeGreaterThan(0);
    }
    expect(Math.abs(rb.position[0] - rb.position[3])).toBeCloseTo(8.6, 3);
    const sw = buildRibbon([line], sidewalkExtra, 0.01);
    expect(Math.abs(sw.position[0] - sw.position[3])).toBeCloseTo(8.6 + 4.0, 3);
  });
});

describe("電柱と電線", () => {
  const straight = (len: number): import("../src/world/roadData").RoadLine => ({
    id: 7,
    pts: Float32Array.from([0, 0, 0, -len]),
    rank: 2,
    ctg: 0,
    startShift: -1,
    endShift: -1,
    startNode: -1,
    endNode: -1,
    startCut: false,
    endCut: false,
    length: len,
  });

  it("広い道には柱が並び、となりどうしが 3 本の線でつながる（数は控えめ）", () => {
    const f = placeFurniture([straight(300)], [], { poles: true });
    expect(f.poles.length).toBeGreaterThan(2);
    expect(f.poles.length).toBeLessThan(300 / 30); // 間隔は 58 m おきが目安
    // 柱は道の中心から、道の外（歩道ぎわ）に置かれている（この線は -z 方向へ進む）
    for (const p of f.poles) expect(Math.abs(p.x)).toBeGreaterThan(1);
    expect(f.wires.length % 24).toBe(0); // 1 区間 = 3 本 × 4 線分 ×（2 点 × 3 成分）
    if (f.wires.length > 0) {
      for (let i = 1; i < f.wires.length; i += 3) {
        expect(f.wires[i]).toBeGreaterThan(7.5); // 高すぎず低すぎず（柱の高さの範囲）
        expect(f.wires[i]).toBeLessThan(12.1);
      }
    }
  });

  it("電柱なしの指定なら置かない", () => {
    const f = placeFurniture([straight(300)], [], {});
    expect(f.poles.length).toBe(0);
    expect(f.wires.length).toBe(0);
  });
});
