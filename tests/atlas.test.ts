import { describe, expect, it } from "vitest";
// canvas が無い環境でも読める定数だけを調べる（画像そのものは、ブラウザで確認する）
import { ATLAS_H, GROUND_H, GUTTER, KINDS, KIND_BLOCK, UPPER_H, groundTop, upperTop } from "../src/render/facadeAtlas";

describe("壁の画像の並び", () => {
  it("帯が画像の中に収まり、のりしろを含めて重ならない", () => {
    expect(ATLAS_H).toBe(KINDS * KIND_BLOCK);
    for (let k = 0; k < KINDS; k++) {
      expect(upperTop(k) - GUTTER).toBeGreaterThanOrEqual(k * KIND_BLOCK);
      expect(upperTop(k) + UPPER_H + GUTTER).toBeLessThanOrEqual(groundTop(k) - GUTTER);
      expect(groundTop(k) + GROUND_H + GUTTER).toBeLessThanOrEqual((k + 1) * KIND_BLOCK);
    }
    expect(ATLAS_H).toBeLessThanOrEqual(8192);
  });
});
