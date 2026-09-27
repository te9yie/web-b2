import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { appendBody, captureTitle, captureWarnings, endsWithBody, normalizeBody, planCapture } from "./capture";
import { KbIndex } from "./kb-index";
import { parsePage } from "./page";

describe("captureTitle", () => {
  it("前後の空白と改行を落とし、中の空白を1つにまとめる。空白だけなら null", () => {
    expect(captureTitle("  見本の本A\n")).toBe("見本の本A");
    expect(captureTitle("a\n\tb  c")).toBe("a b c");
    expect(captureTitle(" \n ")).toBeNull();
    expect(captureTitle("")).toBeNull();
  });
});

describe("normalizeBody", () => {
  it("改行を LF にそろえ、末尾の改行を落とす。先頭の空白と途中の空行は残す", () => {
    expect(normalizeBody("a\r\nb\rc\n\n")).toBe("a\nb\nc");
    expect(normalizeBody("  a\n\n\nb")).toBe("  a\n\n\nb");
  });
});

describe("appendBody", () => {
  it("区切りは空行1つ。既存の末尾の空白は変えず、結果は \\n で終わる", () => {
    expect(appendBody("", "x")).toBe("x\n");
    expect(appendBody("a\n\n", "x")).toBe("a\n\nx\n");
    expect(appendBody("a\n", "x")).toBe("a\n\nx\n");
    expect(appendBody("a", "x")).toBe("a\n\nx\n");
    expect(appendBody("a\n\n\n", "x")).toBe("a\n\n\nx\n");
  });

  it("本文が空なら中身のまま", () => {
    expect(appendBody("a\n", "")).toBe("a\n");
    expect(appendBody("a\n", " \n")).toBe("a\n");
  });
});

describe("endsWithBody", () => {
  it("前後の空白の違いを無視して末尾との一致を見る。途中にあるだけなら偽", () => {
    expect(endsWithBody("a\n\nhttps://example.com/x\n", "https://example.com/x")).toBe(true);
    expect(endsWithBody("a\n\nhttps://example.com/x", " https://example.com/x\n")).toBe(true);
    expect(endsWithBody("https://example.com/x\n\nb\n", "https://example.com/x")).toBe(false);
    expect(endsWithBody("a\n", "")).toBe(false);
  });
});

describe("planCapture: fixtures/notes", () => {
  let index: KbIndex;
  beforeAll(async () => {
    const dir = join("fixtures", "notes");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    index = new KbIndex(
      await Promise.all(files.map(async (f) => parsePage({ path: `notes/${f}`, content: await readFile(join(dir, f), "utf8") }))),
    );
  });
  const newRoute = (title: string, body: string) => ({ kind: "new" as const, title, body });
  const appendRoute = (page: string, body: string) => ({ kind: "append" as const, page, body });

  it("/new: title も body もなければ保存できない。title がなければ title なしで作る", () => {
    expect(planCapture(index, newRoute("", ""))).toEqual({ kind: "invalid", reason: "title も body もない" });
    expect(planCapture(index, newRoute(" ", "\n"))).toMatchObject({ kind: "invalid" });
    expect(planCapture(index, newRoute("", "x"))).toEqual({ kind: "create", name: null, settings: false });
  });

  it("/new: まだないページなら作る。整えてから解決する", () => {
    expect(planCapture(index, newRoute("  新しい取り込み\n", "x"))).toEqual({ kind: "create", name: "新しい取り込み", settings: false });
    expect(planCapture(index, newRoute("新しい取り込み", ""))).toEqual({ kind: "create", name: "新しい取り込み", settings: false });
  });

  it("/new: title が既存のページ（H1 でも name でも）なら、そのページへの追記。本文がなければ保存できない", () => {
    expect(planCapture(index, newRoute("見本の本A", "x"))).toMatchObject({ kind: "append", name: "2026-01-12-book-a" });
    expect(planCapture(index, newRoute("  見本の本A\n", "x"))).toMatchObject({ kind: "append", name: "2026-01-12-book-a" });
    expect(planCapture(index, newRoute("2026-01-25", "x"))).toMatchObject({ kind: "append", name: "2026-01-25" });
    expect(planCapture(index, newRoute("見本の本A", ""))).toEqual({ kind: "invalid", reason: "同じ名前のページがある", name: "2026-01-12-book-a" });
  });

  it("/append: page か body がなければ保存できない", () => {
    expect(planCapture(index, appendRoute("", "x"))).toEqual({ kind: "invalid", reason: "page がない" });
    expect(planCapture(index, appendRoute("[[ ]]", "x"))).toEqual({ kind: "invalid", reason: "page がない" });
    expect(planCapture(index, appendRoute("見本の本A", ""))).toMatchObject({ kind: "invalid", reason: "body がない" });
  });

  it("/append: 既存のページ（[[ ]] 付きでも）なら追記、なければ作る", () => {
    const found = planCapture(index, appendRoute("[[見本の本A]]", "x"));
    expect(found).toMatchObject({ kind: "append", name: "2026-01-12-book-a", settings: false });
    if (found.kind === "append") expect(found.meta.path).toBe("notes/2026-01-12-book-a.md");
    expect(planCapture(index, appendRoute("まだない取り込み先", "x"))).toEqual({ kind: "create", name: "まだない取り込み先", settings: false });
  });

  it("行き先が settings ページなら印を付ける（name でも title でも）", () => {
    expect(planCapture(index, appendRoute("settings", "x"))).toMatchObject({ kind: "append", settings: true });
    expect(planCapture(index, appendRoute("2026-01-05-settings", "x"))).toMatchObject({ kind: "append", settings: true });
    expect(planCapture(index, newRoute("settings", "x"))).toMatchObject({ kind: "append", settings: true });
    expect(planCapture(new KbIndex(), newRoute("settings", "x"))).toEqual({ kind: "create", name: "settings", settings: true });
  });
});

describe("captureWarnings", () => {
  const html = "本文に HTML が含まれている。保存すると、表示のときにそのまま動く（スクリプトも）";

  it("HTML らしい本文で注意を出す。比較の < では出さない", () => {
    for (const body of ["<script>x</script>", '<img src=x onerror="y">', "[a](javascript:x)", "<!-- c -->", "a </b>", 'x onclick = "y"']) {
      expect(captureWarnings(body)).toContain(html);
    }
    for (const body of ["a < b", "1<2", "once upon a time"]) expect(captureWarnings(body)).toEqual([]);
  });

  it("文字化け、settings ページ、同じ内容が末尾にあるときに注意を出す", () => {
    expect(captureWarnings("a�b")).toEqual(["文字化けした文字（�）が含まれている。ブックマークレットのエンコードを確かめる"]);
    expect(captureWarnings("x", { settings: true, content: null })).toEqual([
      "settings ページに書く。script.js や style.css のコードブロックを含むと、次の表示から動く",
    ]);
    expect(captureWarnings("x", { settings: false, content: "a\n\nx\n" })).toEqual(["同じ内容がすでに末尾にある"]);
    expect(captureWarnings("x", { settings: false, content: "x\n\na\n" })).toEqual([]);
  });
});
