import { describe, expect, it } from "vitest";
import { linkify, pageUrl, renderMarkdown, resolveHref, resolveRelative } from "./render";

const ctx = (exists: string[] = []) => ({ pagePath: "notes/sub/page.md", exists: (ref: string) => exists.includes(ref) });

describe("linkify", () => {
  it("[[x]]・[[x|表示名]]・#タグ を /p/ へのリンクにし、まだないページには missing を付ける", () => {
    const html = linkify("[[a]] と [[b|表示]] と #t", ctx(["a", "t"]));
    expect(html).toBe(
      `<a href="/p/a" class="wikilink">a</a> と <a href="/p/b" class="wikilink missing">表示</a> と <a href="/p/t" class="tag">#t</a>`,
    );
  });

  it("コードの中は置き換えない。表示名の HTML はエスケープする", () => {
    expect(linkify("`[[a]]` [[b|<i>]]\n```\n#t [[c]]\n```", ctx())).toBe(
      "`[[a]]` <a href=\"/p/b\" class=\"wikilink missing\">&lt;i&gt;</a>\n```\n#t [[c]]\n```",
    );
  });

  it("空白や区切りを含む名前は URL エンコードする", () => {
    expect(linkify("[[架空 太郎]] [[a/b]]", ctx())).toContain(`href="${pageUrl("架空 太郎")}"`);
    expect(linkify("[[a/b]]", ctx())).toContain(`href="/p/a%2Fb"`);
  });
});

describe("resolveRelative / resolveHref", () => {
  it("ページのディレクトリから相対パスを解決し、.. を畳む", () => {
    expect(resolveRelative("notes/sub/page.md", "img/dot.png")).toBe("notes/sub/img/dot.png");
    expect(resolveRelative("notes/sub/page.md", "../img/dot.png")).toBe("notes/img/dot.png");
    expect(resolveRelative("notes/sub/page.md", "./a.md")).toBe("notes/sub/a.md");
    expect(resolveRelative("notes/page.md", "/attachments/x.pdf")).toBe("attachments/x.pdf");
    expect(resolveRelative("notes/page.md", "../../x")).toBeNull();
  });

  it(".md はページへ、それ以外は添付ファイルへ。外部 URL とページ内リンクはそのまま", () => {
    expect(resolveHref("notes/sub/page.md", "other.md")).toBe("/p/other");
    expect(resolveHref("notes/sub/page.md", "../2026-01-16-mermaid-sample.md#a")).toBe("/p/2026-01-16-mermaid-sample#a");
    expect(resolveHref("notes/sub/page.md", "img/a%20b.png")).toBe("/api/files/notes/sub/img/a%20b.png");
    expect(resolveHref("notes/page.md", "https://example.com/x.md")).toBe("https://example.com/x.md");
    expect(resolveHref("notes/page.md", "mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(resolveHref("notes/page.md", "#section")).toBe("#section");
    expect(resolveHref("notes/page.md", "../../out.md")).toBe("../../out.md");
  });
});

describe("renderMarkdown", () => {
  it("リンクと画像の相対パスを直し、Mermaid は pre.mermaid にする", () => {
    const html = renderMarkdown(
      "# 見出し\n\n![点](img/dot.png) [他](other.md)\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```js\nconst x = 1;\n```\n",
      ctx(),
    );
    expect(html).toContain(`<img src="/api/files/notes/sub/img/dot.png" alt="点">`);
    expect(html).toContain(`<a href="/p/other">他</a>`);
    expect(html).toContain(`<pre class="mermaid">flowchart LR\n  A --&gt; B</pre>`);
    expect(html).toContain(`<code class="language-js">`);
    expect(html).toContain("<h1>見出し</h1>");
  });

  it("[[リンク]] が段落の中で <a> になり、インラインコードの中は残る", () => {
    // SPEC.md「ページのモデル」どおり、除外するのは囲いのコードブロックとインラインコードだけ（字下げのコードブロックは見ない）
    const html = renderMarkdown("本文 [[a]]。`[[inline]]`", ctx(["a"]));
    expect(html).toContain(`<a href="/p/a" class="wikilink">a</a>`);
    expect(html).toContain("<code>[[inline]]</code>");
  });
});
