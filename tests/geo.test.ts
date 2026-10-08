import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { LocalFrame, ecefToGeodetic, geodeticToEcef } from "../src/core/geo";

describe("geo", () => {
  it("緯度経度→地球中心座標→緯度経度で元に戻る", () => {
    const p = geodeticToEcef(35.17095, 136.8816, 41);
    const g = ecefToGeodetic(p.x, p.y, p.z);
    expect(g.lat).toBeCloseTo(35.17095, 8);
    expect(g.lon).toBeCloseTo(136.8816, 8);
    expect(g.h).toBeCloseTo(41, 3);
  });

  it("原点は (0,0,0)、真上に 100m 行くと y=100", () => {
    const f = new LocalFrame({ lat: 35.17, lon: 136.88, h: 41 });
    const o = f.toLocal(35.17, 136.88, 41);
    expect(o.length()).toBeLessThan(1e-6);
    const up = f.toLocal(35.17, 136.88, 141);
    expect(up.y).toBeCloseTo(100, 4);
    expect(Math.hypot(up.x, up.z)).toBeLessThan(1e-4);
  });

  it("北へ行くと -z、東へ行くと +x になる", () => {
    const f = new LocalFrame({ lat: 35.17, lon: 136.88, h: 41 });
    const north = f.toLocal(35.18, 136.88, 41);
    const east = f.toLocal(35.17, 136.89, 41);
    expect(north.z).toBeLessThan(-1000); // 0.01° ≒ 1.1 km
    expect(Math.abs(north.x)).toBeLessThan(5);
    expect(east.x).toBeGreaterThan(800); // 緯度 35° の経度 0.01° ≒ 0.9 km
  });

  it("画面用座標→緯度経度で元に戻る", () => {
    const f = new LocalFrame({ lat: 35.17, lon: 136.88, h: 41 });
    const g = f.toGeodetic(new Vector3(300, 50, -200));
    const back = f.toLocal(g.lat, g.lon, g.h);
    expect(back.x).toBeCloseTo(300, 3);
    expect(back.y).toBeCloseTo(50, 3);
    expect(back.z).toBeCloseTo(-200, 3);
  });
});
