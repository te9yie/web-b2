import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractH1, extractLinks, maskCode, parsePage, splitFrontMatter } from "./page";

// fixtures/notes の全ページで期待する title と links。見本を足したらここにも足す
const expected: Record<string, { title: string; links: string[]; created: string | null; updated: string | null }> = {
  "2026-01-05-settings": {
    title: "settings",
    // トップの [[{{date}}]] は展開前の文字がそのまま入る。script.js と style.css の中は見ない
    links: ["{{date}}", "2026-01-10-reading-list"],
    created: "2026-01-05",
    updated: "2026-01-20",
  },
  "2026-01-10-reading-list": {
    title: "読書リスト",
    // 「）#読了」の # は空白の直後ではないのでタグにならない。`[[著者名]]` はインラインコード
    links: ["reading", "books", "2026-01-12-book-a", "架空 太郎", "架空 花子", "2026-01-15-book-c"],
    created: "2026-01-10",
    updated: "2026-01-18",
  },
  "2026-01-12-book-a": {
    title: "見本の本A",
    links: ["books", "架空 太郎", "2026-01-10-reading-list", "2026-01-15-book-c"],
    created: "2026-01-12",
    updated: "2026-01-12",
  },
  "2026-01-15-book-c": {
    title: "見本の本C",
    links: ["books", "架空 太郎", "読了", "要約待ち", "見本の本A"],
    created: "2026-01-15",
    updated: "2026-01-18",
  },
  "2026-01-16-mermaid-sample": {
    title: "Mermaidの見本",
    links: ["diagram", "2026-01-05-settings"],
    created: "2026-01-16",
    updated: "2026-01-16",
  },
  "2026-01-17-code-samples": {
    title: "コードブロックの見本",
    links: ["code", "2026-01-16-mermaid-sample"],
    created: "2026-01-17",
    updated: "2026-01-17",
  },
  "2026-01-18-no-title": {
    title: "2026-01-18-no-title",
    links: ["2026-01-10-reading-list"],
    created: "2026-01-18",
    updated: "2026-01-18",
  },
  "2026-01-19-no-frontmatter": {
    title: "front matterのないページ",
    links: ["まだないページ"],
    created: "2026-01-19",
    updated: null,
  },
  "2026-01-20-macro-usage": {
    title: "マクロの見本",
    // {{embed 2026-01-10-reading-list#読んだ}} の # は空白の直後ではない
    links: [],
    created: "2026-01-20",
    updated: "2026-01-20",
  },
  "2026-01-21-duplicate-title-old": {
    title: "同じタイトル",
    links: ["2026-01-22-duplicate-title-new"],
    created: "2026-01-21",
    updated: "2026-01-21",
  },
  "2026-01-22-duplicate-title-new": {
    title: "同じタイトル",
    links: ["2026-01-21-duplicate-title-old"],
    created: "2026-01-22",
    updated: "2026-01-25",
  },
  "2026-01-23-image": {
    title: "画像の見本",
    // 画像と .md への通常のリンクは links に入れない
    links: [],
    created: "2026-01-23",
    updated: "2026-01-23",
  },
  "2026-01-24-two-hop": {
    title: "2 hop linkの見本",
    links: ["books", "架空 太郎", "2026-01-12-book-a", "2026-01-15-book-c"],
    created: "2026-01-24",
    updated: "2026-01-24",
  },
  "2026-01-25": {
    title: "2026-01-25",
    links: ["2026-01-22-duplicate-title-new"],
    created: "2026-01-25",
    updated: "2026-01-25",
  },
  "2026-01-26-143210": {
    title: "2026-01-26-143210",
    links: [],
    created: "2026-01-26",
    updated: "2026-01-26",
  },
  "2026-01-26-capture": {
    title: "取り込みの見本",
    links: ["2026-01-26", "要約待ち"],
    created: "2026-01-26",
    updated: "2026-01-26",
  },
};

describe("parsePage: fixtures/notes の全ページ", async () => {
  const dir = join("fixtures", "notes");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();

  it("見本の一覧と期待の表が一致している", () => {
    expect(files.map((f) => f.slice(0, -3))).toEqual(Object.keys(expected).sort());
  });

  for (const file of files) {
    const name = file.slice(0, -3);
    it(name, async () => {
      const content = await readFile(join(dir, file), "utf8");
      const page = parsePage({ path: `notes/${file}`, content, sha: "abc" });
      expect(page.name).toBe(name);
      expect(page.sha).toBe("abc");
      expect({ title: page.title, links: page.links, created: page.created, updated: page.updated }).toEqual(
        expected[name],
      );
      expect(page.body.startsWith("---")).toBe(false);
    });
  }

  it("CRLFでも同じ title と links になる", async () => {
    for (const file of files) {
      const lf = (await readFile(join(dir, file), "utf8")).replace(/\r\n/g, "\n");
      const crlf = lf.replace(/\n/g, "\r\n");
      const a = parsePage({ path: file, content: lf });
      const b = parsePage({ path: file, content: crlf });
      expect(b.title).toBe(a.title);
      expect(b.links).toEqual(a.links);
      expect(b.created).toBe(a.created);
      expect(b.updated).toBe(a.updated);
    }
  });
});

describe("splitFrontMatter", () => {
  it("--- で囲まれた項目を読み、本文から取り除く", () => {
    const fm = splitFrontMatter("---\ncreated: 2026-01-01\ntags: [a, b]\n---\n\n# 見出し\n");
    expect(fm.data).toEqual({ created: "2026-01-01", tags: ["a", "b"] });
    expect(fm.body).toBe("\n# 見出し\n");
  });

  it("箸条書きの配列と引用符を読む", () => {
    const fm = splitFrontMatter('---\ntags:\n  - "a"\n  - b\nupdated: "2026-01-02"\n---\n本文');
    expect(fm.data).toEqual({ tags: ["a", "b"], updated: "2026-01-02" });
    expect(fm.body).toBe("本文");
  });

  it("先頭が --- でなければfront matterなし", () => {
    const fm = splitFrontMatter("# 見出し\n---\nx: 1\n---\n");
    expect(fm.raw).toBeNull();
    expect(fm.body).toBe("# 見出し\n---\nx: 1\n---\n");
  });

  it("閉じる --- がなければfront matterなし", () => {
    const fm = splitFrontMatter("---\ncreated: 2026-01-01\n");
    expect(fm.raw).toBeNull();
    expect(fm.data).toEqual({});
  });

  it("CRLFとBOMを扱える", () => {
    const fm = splitFrontMatter("﻿---\r\ncreated: 2026-01-01\r\n---\r\n# a\r\n");
    expect(fm.data).toEqual({ created: "2026-01-01" });
    expect(fm.body).toBe("# a\r\n");
  });
});

describe("maskCode", () => {
  it("コードを区切りごと置き換え、位置と改行を変えない", () => {
    const md = "a `b` c\n```js x\nd\n```\ne";
    const masked = maskCode(md);
    expect(masked.length).toBe(md.length);
    expect(masked.split("\n").length).toBe(md.split("\n").length);
    expect(masked).toMatch(/^a ... c\n.......\n.\n...\ne$/u);
    expect(masked).not.toMatch(/[`bdjsx]/);
  });

  it("~~~ の囲いと、長い囲いの中の短い囲いを扱う", () => {
    const md = "~~~\n[[a]]\n~~~\n````\n```\n[[b]]\n```\n````\n[[c]]";
    expect(extractLinks(md)).toEqual(["c"]);
  });

  it("閉じないコードブロックは末尾まで", () => {
    expect(extractLinks("```\n[[a]]\n[[b]]")).toEqual([]);
  });

  it("バッククォートの数が同じもので閉じる", () => {
    expect(extractLinks("`` ` [[a]] `` [[b]] `[[c]]")).toEqual(["b", "c"]);
  });

  it("インラインコードは空行をまたがない", () => {
    expect(extractLinks("`x\n\n[[a]]` [[b]]")).toEqual(["a", "b"]);
  });

  it("末尾のバッククォートと、閉じないものの後に閉じるものが続く形", () => {
    expect(extractLinks("[[a]] `")).toEqual(["a"]);
    expect(extractLinks("``[[a]]`[[b]]` [[c]]")).toEqual(["a", "c"]);
    expect(extractLinks("`[[a]]``[[b]]` [[c]]")).toEqual(["c"]);
    expect(maskCode("a `b` `")).toBe(`a ${"".repeat(3)} \``);
  });
});

describe("extractLinks", () => {
  it("表示名を除き、前後の空白を落とす", () => {
    expect(extractLinks("[[ a ]] [[b|表示]] [[c|]]")).toEqual(["a", "b", "c"]);
  });

  it("重複は一つにし、出てきた順を保つ", () => {
    expect(extractLinks("#t1 [[a]] #t1 [[a]] [[b]]")).toEqual(["t1", "a", "b"]);
  });

  it("タグは行頭か空白の直後の # だけ", () => {
    expect(extractLinks("#a\n b#c d #e\thttps://example.com/x#f\n#g#h")).toEqual(["a", "e", "g"]);
  });

  it("見出しはタグにしない", () => {
    expect(extractLinks("# 見出し\n## 見出し2\n#\n#タグ")).toEqual(["タグ"]);
  });

  it("コードの直前直後でも判定が変わらない", () => {
    // `x`#a の # は空白の直後ではない。#b の直後にコードがあっても b だけ
    expect(extractLinks("`x`#a #b`y`")).toEqual(["b"]);
  });

  it("[[ ]] の中に改行や [ ] があれば無視する", () => {
    expect(extractLinks("[[a\nb]] [[c]d]] [[]]")).toEqual([]);
  });
});

describe("extractH1", () => {
  it("最初の # 行を取り、コードブロックの中は見ない", () => {
    expect(extractH1("```sh\n# コメント\n```\n\n#タグ\n# 見出し  \n# 二つ目")).toBe("見出し");
  });

  it("なければ null", () => {
    expect(extractH1("## 小見出し\n本文")).toBeNull();
  });
});

describe("parsePage", () => {
  it("created がなければファイル名の先頭の日付、なければ null", () => {
    expect(parsePage({ path: "notes/2026-02-03-x.md", content: "本文" }).created).toBe("2026-02-03");
    expect(parsePage({ path: "notes/x.md", content: "本文" }).created).toBeNull();
  });

  it("name はディレクトリと拡張子を除いたもの", () => {
    expect(parsePage({ path: "notes/sub/dir/a-b.md", content: "" }).name).toBe("a-b");
  });

  it("tags が一つの文字列でも読む。先頭の # は落とす", () => {
    expect(parsePage({ path: "a.md", content: "---\ntags: '#x'\n---\n" }).links).toEqual(["x"]);
  });

  it("sha を渡さなければ null", () => {
    expect(parsePage({ path: "a.md", content: "" }).sha).toBeNull();
  });
});
