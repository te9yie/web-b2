import { describe, expect, it } from "vitest";
import { today } from "./date";

describe("today", () => {
  it("月と日を2桁にそろえる", () => {
    expect(today(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("ローカル時刻の日付を返す", () => {
    expect(today(new Date(2026, 11, 31, 23, 59, 59))).toBe("2026-12-31");
  });
});
