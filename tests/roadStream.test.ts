import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
// @ts-expect-error 型定義がない
import vtpbf from "vt-pbf";
import { LocalFrame } from "../src/core/geo";
import { Driver } from "../src/world/drive";

/** どのタイルにも、十字路が 1 つある地図を返す */
function tileBytes(): Uint8Array {
  const tags = (rank: number) => ({ ftCode: 2701, rdCtg: 2, rnkWidth: rank, lvOrder: 0 });
  const L = (pts: number[][], rank: number) => ({ type: 2, geometry: [pts], tags: tags(rank) });
  const features = [
    L([[2048, 0], [2048, 2048]], 3), L([[2048, 2048], [2048, 4096]], 3),
    L([[0, 2048], [2048, 2048]], 1), L([[2048, 2048], [4096, 2048]], 1),
  ];
  return vtpbf.fromGeojsonVt({ road: { features, x: 0, y: 0, z: 16, numPoints: 0, extent: 4096 } }, { version: 2, extent: 4096 });
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

vi.stubGlobal("location", { search: "" });

describe("Roads: カメラの近くのタイルを読み込む", () => {
  it("遠くへ移動しても、新しい場所に道と木が作られ、古い所は捨てられる", async () => {
    const { Roads } = await import("../src/world/roads");
    const bytes = tileBytes();
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => { fetched.push(u); return new Response(bytes, { status: 200 }); });
    const frame = new LocalFrame({ lat: 35.17, lon: 136.88, h: 0 });
    const roads = new Roads(() => {}, (z, x, y) => `http://t/${z}/${x}/${y}.pbf`);
    roads.radius = 900;
    roads.begin(frame, 0);
    const cam = new THREE.Vector3(0, 100, 0);
    let now = 0;
    const run = async (n: number) => { for (let i = 0; i < n; i++) { now += 500; roads.update(cam, now); await flush(); } };
    await run(40);
    const s1 = roads.stats;
    expect(s1.tiles).toBeGreaterThan(3);
    expect(s1.lines).toBe(s1.tiles * 4);
    expect(s1.trees).toBeGreaterThan(0);
    expect(roads.group.children.length).toBeGreaterThan(s1.tiles);
    const first = roads.takeNewLines();
    expect(first.length).toBe(s1.lines);
    expect(roads.takeNewLines().length).toBe(0);
    const driver = new Driver(roads.lines, roads.nodes);
    // 3 km 東へ
    cam.x = 3000;
    await run(60);
    const s2 = roads.stats;
    expect(s2.tiles).toBeGreaterThan(3);
    expect(s2.lines).toBe(s2.tiles * 4);
    const nl = roads.takeNewLines();
    expect(nl.length).toBeGreaterThan(0);
    expect(() => driver.addLines(nl)).not.toThrow();
    // 近くの道が、東の端の外へ出ていない（古い場所のタイルは残っていない）
    for (const l of roads.lines) expect(Math.abs(l.pts[0] - 3000)).toBeLessThan(1500);
    // 戻ると、また作られる（取得済みのものは取り直さない）
    const nFetch = fetched.length;
    cam.x = 0;
    await run(60);
    expect(roads.stats.tiles).toBeGreaterThan(3);
    expect(fetched.length - nFetch).toBeLessThanOrEqual(roads.stats.tiles + 6);
    roads.clear();
    expect(roads.stats.tiles).toBe(0);
    vi.unstubAllGlobals();
  });
});
