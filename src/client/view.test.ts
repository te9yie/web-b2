import { describe, expect, it } from "vitest";
import { newPageFile } from "./view";

describe("newPageFile", () => {
  const now = new Date(2026, 8, 27, 21, 5, 9);

  it("日付でない名前は時刻のファイル名にし、1行目を # 名前 にする", () => {
    const { path, content } = newPageFile("新しいページ", "notes", now);
    expect(path).toBe("notes/2026-09-27-210509.md");
    expect(content).toBe("---\ncreated: 2026-09-27\nupdated: 2026-09-27\n---\n\n# 新しいページ\n\n");
  });

  it("日付の名前はファイル名も日付。dir が空ならルート直下", () => {
    expect(newPageFile("2026-01-31", "notes", now).path).toBe("notes/2026-01-31.md");
    expect(newPageFile("2026-01-31", "", now).path).toBe("2026-01-31.md");
    expect(newPageFile("2026-1-31", "notes", now).path).toBe("notes/2026-09-27-210509.md");
  });
});
