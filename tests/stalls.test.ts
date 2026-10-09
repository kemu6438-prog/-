import { describe, expect, it } from "vitest";
import { overlapRatio } from "../src/core/stalls";

describe("overlapRatio", () => {
  const spans = [{ s: 0, e: 10 }, { s: 20, e: 30 }];
  it("完全に区間の中なら 1", () => expect(overlapRatio(spans, 21, 29)).toBe(1));
  it("区間の外なら 0", () => expect(overlapRatio(spans, 11, 19)).toBe(0));
  it("半分だけ重なれば 0.5", () => expect(overlapRatio(spans, 5, 15)).toBeCloseTo(0.5));
  it("長さ 0 は 0", () => expect(overlapRatio(spans, 5, 5)).toBe(0));
});
