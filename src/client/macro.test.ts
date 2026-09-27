import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createLocalApi } from "../server/local";
import { Kb } from "./kb";
import { type MacroFn, expand } from "./macro";
import { Scripting } from "./scripting";
import { ApiSource } from "./source";
import { MemoryStore } from "./store";

const ctx = { name: "p", stack: ["p"] };
const macros = (m: Record<string, MacroFn>) => new Map(Object.entries(m));

describe("expand", () => {
  it("登録された名前を戻り値に置き換え、未登録はそのまま。引数は前後の空白を落とす", async () => {
    const md = "a {{hi 世界}} b {{ hi  x y }} c {{none 1}} d {{hi}}";
    const out = await expand(md, ctx, macros({ hi: (arg) => `<${arg}>` }));
    expect(out).toBe("a <世界> b <x y> c {{none 1}} d <>");
  });

  it("コードブロックとインラインコードの中は展開しない", async () => {
    const md = "{{x}} `{{x}}`\n```\n{{x}}\n```\n{{x}}";
    expect(await expand(md, ctx, macros({ x: () => "X" }))).toBe("X `{{x}}`\n```\n{{x}}\n```\nX");
  });

  it("Promise を返す関数と、ctx を受け取る関数", async () => {
    const fn: MacroFn = async (arg, c) => `${c.name}:${c.stack.join(",")}:${arg}`;
    expect(await expand("{{f a}}", { name: "n", stack: ["n", "m"] }, macros({ f: fn }))).toBe("n:n,m:a");
  });

  it("例外を投げたら名前と理由を出し、残りは展開する", async () => {
    const out = await expand("{{bad}} {{ok}}", ctx, macros({ bad: () => { throw new Error("落ちた"); }, ok: () => "OK" }));
    expect(out).toBe("（{{bad}}: 落ちた） OK");
  });

  it("引数に改行や { } は含められない。戻り値は文字列にする", async () => {
    expect(await expand("{{x a\nb}}", ctx, macros({ x: () => "X" }))).toBe("{{x a\nb}}");
    expect(await expand("{{x {y}}}", ctx, macros({ x: () => "X" }))).toBe("{{x {y}}}");
    expect(await expand("{{n}}", ctx, macros({ n: () => 42 as unknown as string }))).toBe("42");
  });
});

describe("Scripting: 見本の settings の script.js", () => {
  async function setup() {
    const api = createLocalApi({ root: "fixtures", dir: "notes" });
    const kb = await Kb.open(new MemoryStore());
    await kb.sync(new ApiSource(async (input, init) => api(new Request(new URL(String(input), "http://localhost"), init))));
    const settings = await kb.settings();
    const scripting = new Scripting(kb);
    scripting.load(settings.script);
    return { kb, scripting };
  }

  it("date・hello・embed・touched が登録され、マクロの見本のページが展開される", async () => {
    const { kb, scripting } = await setup();
    expect(scripting.error).toBeNull();
    expect([...scripting.macros.keys()].sort()).toEqual(["date", "embed", "hello", "touched"]);

    const page = (await kb.page("2026-01-20-macro-usage"))!;
    // Windows の作業ツリーでは見本が CRLF なので、比べる前にそろえる
    const out = (await scripting.expand(page.body, { name: page.name, stack: [page.name] })).replace(/\r\n/g, "\n");
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(out).toContain(`今日は ${ymd}。こんにちは、世界。未登録の {{unknown 1 2}} はそのまま残る。`);
    // embed: 読書リストの「読んだ」の節
    expect(out).toContain("- [[2026-01-15-book-c]]（[[架空 太郎]]）#読了");
    expect(out).not.toContain("{{embed");
    // touched: 今日に作成・更新したページはない
    expect(out).toContain("## その日のページ\n\n（なし）");
  });

  it("日付ページでは date がページ名になり、touched がその日のページを挙げる", async () => {
    const { scripting } = await setup();
    const out = await scripting.expand("{{date}} / {{touched}}", { name: "2026-01-18", stack: ["2026-01-18"] });
    expect(out).toBe("2026-01-18 / - [[2026-01-10-reading-list|読書リスト]]\n- [[2026-01-15-book-c|見本の本C]]\n- [[2026-01-18-no-title]]");
  });

  it("embed の循環と、ないページ・ない見出し", async () => {
    const { scripting } = await setup();
    const c = { name: "2026-01-10-reading-list", stack: ["2026-01-10-reading-list"] };
    expect(await scripting.expand("{{embed 2026-01-10-reading-list#読んだ}}", c)).toBe("（embed: 「2026-01-10-reading-list」が自分自身を取り込んでいる）");
    expect(await scripting.expand("{{embed ないページ}}", c)).toBe("（embed: ページ「ないページ」がない）");
    expect(await scripting.expand("{{embed 見本の本A#ない}}", c)).toBe("（embed: 「2026-01-12-book-a」に見出し「ない」がない）");
  });

  it("構文エラーと実行時エラーは error に残り、登録は空になる", async () => {
    const { scripting } = await setup();
    scripting.load("kb.macro('a', () => 'A');\nthis is not js");
    expect(scripting.error).toMatch(/^SyntaxError: /);
    expect(scripting.macros.size).toBe(0);
    scripting.load("kb.macro('a', () => 'A');\nnull.x;");
    expect(scripting.error).toMatch(/^TypeError: /);
    // 例外の前に登録した分は残る（settings の先頭に理由が出る）
    expect(scripting.macros.size).toBe(1);
    scripting.load(null);
    expect(scripting.error).toBeNull();
    expect(scripting.macros.size).toBe(0);
  });

  it("kb API: wikilink・today・section・codeBlock", async () => {
    const { kb, scripting } = await setup();
    const api = scripting.api();
    const page = kb.index.get("2026-01-12-book-a")!;
    expect(api.wikilink("2026-01-12-book-a", page)).toBe("[[2026-01-12-book-a|見本の本A]]");
    expect(api.wikilink("2026-01-25", kb.index.get("2026-01-25")!)).toBe("[[2026-01-25]]");
    expect(api.wikilink("x", null)).toBe("[[x]]");
    expect(api.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(api.section("## a\nb\n## c\n", "a")).toBe("b\n");
    expect(api.codeBlock("```js x\n1\n```\n", "x")).toBe("1");
    expect(api.pages.size).toBe(16);
    expect(api.resolve("[[見本の本A]]")?.[0]).toBe("2026-01-12-book-a");
    expect((await api.page("見本の本A"))?.body).toContain("著者は");
  });

  it("見本の README の説明どおり、settings の script.js を素直に読める", async () => {
    const md = await readFile("fixtures/notes/2026-01-05-settings.md", "utf8");
    expect(md).toContain("```js script.js");
  });
});
