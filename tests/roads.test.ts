import { describe, expect, it } from "vitest";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
// @ts-expect-error 型定義がない
import vtpbf from "vt-pbf";
import { ZOOM, analyzeNodes, latToTileY, lonToTileX, needsSignal, parseRoadLayer, tileXToLon, tileYToLat } from "../src/world/roadData";
import { buildRibbon, roadExtra, sidewalkExtra } from "../src/world/roadGeometry";
import { placeFurniture } from "../src/world/roadFurniture";
import { signalState } from "../src/world/signal";

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
    expect(needsSignal(nodes[0])).toBe(true);
    // 幅員区分 3 の道の縁までは 7.75 m、区分 2 は 4.3 m
    const ns = ls[0].endShift; // 区分 3 の線の終点 → 交わる相手のうち最も広いのは区分 3（もう 1 本）
    expect(ns).toBeCloseTo(7.75, 2);
    const f = placeFurniture(ls, nodes, { treeRadius: 1000 });
    expect(f.signals.length).toBe(4);
    // 信号の柱は、車道の外（歩道）に立つ
    for (const s of f.signals) expect(Math.min(Math.abs(s.x), Math.abs(s.z))).toBeGreaterThan(4);
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

describe("信号", () => {
  it("縦が青の間、横は赤。黄色をはさんで入れ替わる", () => {
    expect(signalState(0, 0, 0)).toBe(0);
    expect(signalState(0, 0, 1)).toBe(2);
    expect(signalState(33, 0, 0)).toBe(1);
    expect(signalState(36, 0, 0)).toBe(2);
    expect(signalState(41, 0, 1)).toBe(0);
    // 縦と横が同時に青にはならない
    for (let t = 0; t < 80; t += 0.5) expect(signalState(t, 7, 0) === 0 && signalState(t, 7, 1) === 0).toBe(false);
  });
});
