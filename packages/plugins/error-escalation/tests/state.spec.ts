import { describe, expect, it } from "vitest";
import { withRecordLock } from "../src/state.js";

describe("escalation record lock", () => {
  it("does not overlap mutations of the same escalation", async () => {
    let current = 0;
    let max = 0;
    await Promise.all([1, 2, 3, 4].map(() => withRecordLock("esc-lock", async () => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 15));
      current -= 1;
    })));
    expect(max).toBe(1);
  });
});