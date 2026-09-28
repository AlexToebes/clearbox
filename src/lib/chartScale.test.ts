import { describe, expect, it } from "vitest";
import { niceTicks } from "./chartScale";

describe("niceTicks", () => {
  it.each([
    [1733, [0, 500, 1000, 1500, 2000]],
    [7, [0, 2, 4, 6, 8]],
    [0, [0, 1]],
    [-5, [0, 1]],
    [1000, [0, 250, 500, 750, 1000]],
    [42, [0, 20, 40, 60]],
    [3, [0, 1, 2, 3]],
  ])("niceTicks(%d) === %j", (max, expected) => {
    expect(niceTicks(max)).toEqual(expected);
  });

  it("respects a smaller targetTicks", () => {
    expect(niceTicks(100, 3)).toEqual([0, 50, 100]);
  });
});
