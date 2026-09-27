import { describe, expect, it } from "vitest";
import { pageUrl, renderMarkdown, resolveHref, resolveRelative } from "./render";

const ctx = (exists: string[] = []) => ({ pagePath: "notes/sub/page.md", exists: (ref: string) => exists.includes(ref) });

describe("renderMarkdown: [[リンク]] と #タグ", () => {
  it("[[x]]・[[x|表示名]]・#タグ を /p/ へのリンクにし、まだないページには missing を付ける", () => {
    expect(renderMarkdown("[[a]] と [[b|表示]] と #t", ctx(["a", "t"]))).toBe(
      `<p><a href="/p/a" class="wikilink">a</a> と <a href="/p/b" class="wikilink missing">表示</a> と <a href="/p/t" class="tag">#t</a></p>\n`,
    );
  });

  it("見出し・箇条書き・強調・表の中でも置き換える", () => {
    const html = renderMarkdown("## 見出し [[a]]\n\n- 項目 #t\n- **太字 [[b]]**\n\n| x | y |\n| - | - |\n| [[c|表]] | #u |\n", ctx());
    expect(html).toContain(`<h2>見出し <a href="/p/a" class="wikilink missing">a</a></h2>`);
    expect(html).toContain(`<li>項目 <a href="/p/t" class="tag missing">#t</a></li>`);
    expect(html).toContain(`<strong>太字 <a href="/p/b" class="wikilink missing">b</a></strong>`);
    expect(html).toContain(`<td><a href="/p/c" class="wikilink missing">表</a></td>`);
    expect(html).toContain(`<td><a href="/p/u" class="tag missing">#u</a></td>`);
  });

  it("コードブロック・インラインコード・字下げのコードの中は置き換えない", () => {
    const html = renderMarkdown("`[[a]]` と `#t`\n\n```\n#t [[c]]\n```\n\n    #u [[d]]\n", ctx());
    expect(html).toContain("<code>[[a]]</code>");
    expect(html).toContain("<code>#t</code>");
    expect(html).toContain("<code>#t [[c]]\n</code>");
    expect(html).toContain("<code>#u [[d]]\n</code>");
    expect(html).not.toContain("/p/");
  });

  it("Markdown のリンクの表示名、画像の代替文、HTML の属性、<style> の中は置き換えない", () => {
    const html = renderMarkdown(
      '[see #foo](http://x.example/a)\n\n![see [[a]]](img.png "title [[t]]")\n\n<img src="x.png" alt="see #t">\n\n<style>\n#a { color: red }\n</style>\n',
      ctx(),
    );
    expect(html).toContain(`<a href="http://x.example/a">see #foo</a>`);
    expect(html).toContain(`alt="see [[a]]" title="title [[t]]"`);
    expect(html).toContain(`<img src="x.png" alt="see #t">`);
    expect(html).toContain("#a { color: red }");
    expect(html).not.toContain("/p/");
  });

  it("タグは行頭か空白の直後だけ。リンクの直後の # はタグにしない。表示名の HTML はエスケープする", () => {
    const html = renderMarkdown("[[a]]#x b#y #z\n#w [[b|a<b]]", ctx());
    expect(html).toContain(`</a>#x b#y <a href="/p/z" class="tag missing">#z</a>`);
    expect(html).toContain(`<a href="/p/w" class="tag missing">#w</a>`);
    expect(html).toContain(`>a&lt;b</a>`);
  });

  it("表の外の [[x|y]] はそのまま。表の行では | を \\| にしてセルが割れないようにする", () => {
    expect(renderMarkdown("a [[x|y]] b", ctx())).toContain(`<a href="/p/x" class="wikilink missing">y</a>`);
    const html = renderMarkdown("| h1 | h2 |\n| - | - |\n| [[x|y]] | [[z]] |\n", ctx());
    expect(html).toContain(`<td><a href="/p/x" class="wikilink missing">y</a></td>`);
    expect(html).toContain(`<td><a href="/p/z" class="wikilink missing">z</a></td>`);
    // コードブロックの中の表は触らない
    expect(renderMarkdown("```\n| [[x|y]] |\n```\n", ctx())).toContain("| [[x|y]] |");
  });

  it("空白や区切りを含む名前は URL エンコードする", () => {
    expect(renderMarkdown("[[架空 太郎]]", ctx())).toContain(`href="${pageUrl("架空 太郎")}"`);
    expect(renderMarkdown("[[a/b]]", ctx())).toContain(`href="/p/a%2Fb"`);
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
    expect(resolveHref("notes/page.md", "?q=1")).toBe("?q=1");
    expect(resolveHref("notes/page.md", "//host/x.md")).toBe("//host/x.md");
    expect(resolveHref("notes/page.md", "../../out.md")).toBe("../../out.md");
  });

  it("? から後ろは付け直し、%XX でない % はそのままの文字として扱う", () => {
    expect(resolveHref("notes/page.md", "other.md?x=1")).toBe("/p/other?x=1");
    expect(resolveHref("notes/page.md", "img/100%.png")).toBe("/api/files/notes/img/100%25.png");
  });
});

describe("renderMarkdown: リンク・画像・Mermaid", () => {
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
});
