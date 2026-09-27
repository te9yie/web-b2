import { describe, expect, it } from "vitest";
import { clearDraft, openNewDraft } from "./drafts";
import { Kb } from "./kb";
import { MemoryStore } from "./store";
import { allocateNewPageFile, newPageFile } from "./view";

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

  it("name が null なら時刻のファイル名で、見出しを付けない", () => {
    const { path, content } = newPageFile(null, "notes", now);
    expect(path).toBe("notes/2026-09-27-210509.md");
    expect(content).toBe("---\ncreated: 2026-09-27\nupdated: 2026-09-27\n---\n\n");
  });
});

describe("allocateNewPageFile", () => {
  it("索引か下書きにある path を避けて1秒ずつ進める", async () => {
    const now = new Date(2026, 8, 27, 21, 5, 9);
    const kb = await Kb.open(new MemoryStore());
    await kb.put({ path: "notes/2026-09-27-210509.md", sha: "s", content: "# x\n" });
    openNewDraft("y", "notes/2026-09-27-210510.md", "");
    try {
      expect(allocateNewPageFile(kb, null, "notes", now).path).toBe("notes/2026-09-27-210511.md");
      expect(allocateNewPageFile(kb, "z", "notes", now).content).toContain("# z");
      // 渡した now は変えない
      expect(now.getSeconds()).toBe(9);
    } finally {
      clearDraft("notes/2026-09-27-210510.md");
    }
  });
});
