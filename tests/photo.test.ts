// 地図タイル（航空写真の座標計算）のテスト
import { describe, expect, it } from "vitest";
import { latToTileY, lonToTileX, metersPerDeg, photoUrl, planTileRange, tileToLat, tileToLon } from "../src/world/geoTiles";

// 名古屋駅あたり
const LAT = 35.17095;
const LON = 136.8816;

describe("地図タイルの計算", () => {
  it("緯度経度 → タイル番号 → 緯度経度で戻る（西端・北端）", () => {
    for (const z of [12, 16, 17]) {
      const x = lonToTileX(LON, z);
      const y = latToTileY(LAT, z);
      // 元の点が、このタイルの中に入っていること
      expect(tileToLon(x, z)).toBeLessThanOrEqual(LON);
      expect(tileToLon(x + 1, z)).toBeGreaterThan(LON);
      expect(tileToLat(y, z)).toBeGreaterThanOrEqual(LAT);
      expect(tileToLat(y + 1, z)).toBeLessThan(LAT);
    }
  });

  it("タイルの範囲: 中心から四方 cover メートル以上を必ず覆う", () => {
    const z = 17;
    const cover = 520;
    const r = planTileRange(LAT, LON, z, cover);
    const m = metersPerDeg(LAT);
    // 範囲の端から中心までの概算距離（緯度経度で戻して測る）
    const marginW = (LON - tileToLon(r.x0, z)) * m.lon;
    const marginE = (tileToLon(r.x1 + 1, z) - LON) * m.lon;
    const marginN = (tileToLat(r.y0, z) - LAT) * m.lat;
    const marginS = (LAT - tileToLat(r.y1 + 1, z)) * m.lat;
    expect(marginW).toBeGreaterThanOrEqual(cover * 0.99);
    expect(marginE).toBeGreaterThanOrEqual(cover * 0.99);
    expect(marginN).toBeGreaterThanOrEqual(cover * 0.99);
    expect(marginS).toBeGreaterThanOrEqual(cover * 0.99);
  });

  it("タイルの範囲: 大きさが妥当（無駄に広く取らない）", () => {
    const z = 17;
    const r = planTileRange(LAT, LON, z, 520);
    // z17 の 1 タイルは名古屋で 約 245 m 四方。1040 m を覆うには多くて 6×6 まで
    expect(r.x1 - r.x0 + 1).toBeLessThanOrEqual(6);
    expect(r.y1 - r.y0 + 1).toBeLessThanOrEqual(6);
  });

  it("URL の形（国土地理院シームレス写真）", () => {
    expect(photoUrl(17, 115373, 51841)).toBe("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/17/115373/51841.jpg");
  });

  it("既知のタイル番号と一致する（名古屋駅 z17 = 115373/51841）", () => {
    // 検算用: 名古屋駅が z17 でこの番号に入ること（計算式の検算）
    expect(lonToTileX(136.8816, 17)).toBe(115373);
    expect(latToTileY(35.17095, 17)).toBe(51841);
  });
});
