import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { codeBlock, listItems, section } from "./md";
import { parsePage } from "./page";
import { DEFAULT_HEADER, parseSettings } from "./settings";

describe("section", () => {
  const md = "# T\n\nintro\n\n## A\n\na1\n\n### A-1\n\na11\n\n## B\n\n```\n## not a heading\n```\n\nb1\n";
  it("見出しの次の行から、同じかより浅い見出しの手前まで", () => {
    expect(section(md, "A")).toBe("\na1\n\n### A-1\n\na11\n\n");
    expect(section(md, "A-1")).toBe("\na11\n\n");
    expect(section(md, "B")).toBe("\n```\n## not a heading\n```\n\nb1\n");
    expect(section(md, "T")).toBe("\nintro\n\n## A\n\na1\n\n### A-1\n\na11\n\n## B\n\n```\n## not a heading\n```\n\nb1\n");
  });

  it("なければ null。コードブロックの中の見出しは見ない。末尾の # と CRLF を扱う", () => {
    expect(section(md, "not a heading")).toBeNull();
    expect(section("## X ##\r\nx\r\n## Y\r\ny", "X")).toBe("x\r\n");
    expect(section("## X\n", "X")).toBe("");
  });
});

describe("codeBlock", () => {
  it("言語の後ろの語が名前のブロックの中身。同名は連結。なければ null", () => {
    const md = "```js script.js\na();\n```\n\n```css style.css\nbody {}\n```\n\n~~~js script.js\nb();\n~~~\n\n```js\nc();\n```\n";
    expect(codeBlock(md, "script.js")).toBe("a();\nb();");
    expect(codeBlock(md, "style.css")).toBe("body {}");
    expect(codeBlock(md, "other")).toBeNull();
  });

  it("閉じないブロックは末尾まで。長い囲いの中の短い囲いは中身", () => {
    expect(codeBlock("```js x\na", "x")).toBe("a");
    expect(codeBlock("````md x\n```\ninner\n```\n````\n", "x")).toBe("```\ninner\n```");
  });
});

describe("listItems", () => {
  it("箇条書きの中身を取り出す。番号付きと入れ子も", () => {
    expect(listItems("- a\n* b\n  - c\n1. d\n2) e\ntext\n")).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("parseSettings", () => {
  it("見本の settings を読む", async () => {
    const page = parsePage({ path: "notes/2026-01-05-settings.md", content: await readFile("fixtures/notes/2026-01-05-settings.md", "utf8") });
    const s = parseSettings(page.body);
    // トップはマクロの展開前の文字。展開は段階4
    expect(s.top).toBe("{{date}}");
    expect(s.header).toEqual([
      { label: "今日", target: "/", page: false },
      { label: "一覧", target: "/all", page: false },
      { label: "読書", target: "2026-01-10-reading-list", page: true },
    ]);
    expect(s.css).toBe("article { line-height: 1.7; }");
    expect(s.script).toContain('kb.macro("date"');
  });

  it("ページがなければ既定。見出しがなければその項目は既定", () => {
    expect(parseSettings(null)).toEqual({ top: null, header: DEFAULT_HEADER, css: null, script: null });
    const s = parseSettings("# settings\n\n## トップ\n\n- [[2026-01-25]]\n");
    expect(s.top).toBe("2026-01-25");
    expect(s.header).toBe(DEFAULT_HEADER);
    expect(s.css).toBeNull();
  });

  it("ヘッダーの項目は [表示名](URL) と [[ページ]]。読めない項目は飛ばし、一つもなければ既定", () => {
    const s = parseSettings("# settings\n\n## ヘッダー\n\n- [[a]]\n- [b](/x \"t\")\n- ただの文字\n");
    expect(s.header).toEqual([
      { label: "a", target: "a", page: true },
      { label: "b", target: "/x", page: false },
    ]);
    expect(parseSettings("# settings\n\n## ヘッダー\n\nなし\n").header).toBe(DEFAULT_HEADER);
  });
});
