import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { KbIndex, byUpdatedDesc, refName } from "./kb-index";
import { type Page, type PageMeta, parsePage } from "./page";

async function loadFixtures(): Promise<Page[]> {
  const dir = join("fixtures", "notes");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  return Promise.all(
    files.map(async (file) => parsePage({ path: `notes/${file}`, content: await readFile(join(dir, file), "utf8") })),
  );
}

// テスト用の小さなページ。本文の解析は page.test.ts で確かめているので、ここでは項目を直接作る
function page(name: string, o: { h1?: string; links?: string[]; updated?: string | null } = {}): Page {
  return {
    path: `notes/${name}.md`,
    name,
    title: o.h1 ?? name,
    h1: o.h1 ?? null,
    body: "",
    created: null,
    updated: o.updated ?? null,
    links: o.links ?? [],
    sha: null,
  };
}

const names = (pages: PageMeta[]) => pages.map((p) => p.name);

describe("KbIndex: fixtures/notes", () => {
  let index: KbIndex;
  beforeAll(async () => {
    index = new KbIndex(await loadFixtures());
  });

  it("pages は name → ページ", () => {
    expect(index.size).toBe(16);
    expect(index.pages.get("2026-01-12-book-a")?.title).toBe("見本の本A");
  });

  it("name で解決する", () => {
    const found = index.resolve("2026-01-12-book-a");
    expect(found?.[0]).toBe("2026-01-12-book-a");
    expect(found?.[1].title).toBe("見本の本A");
  });

  it("title で解決する。[[ ]] と表示名が付いていてもよい", () => {
    expect(index.resolve("見本の本A")?.[0]).toBe("2026-01-12-book-a");
    expect(index.resolve("[[見本の本A]]")?.[0]).toBe("2026-01-12-book-a");
    expect(index.resolve("[[ 見本の本A | 表示名 ]]")?.[0]).toBe("2026-01-12-book-a");
  });

  it("同じ title が複数あれば updated が新しいもの", () => {
    expect(index.resolve("同じタイトル")?.[0]).toBe("2026-01-22-duplicate-title-new");
  });

  it("どちらにもなければ null。target はまだないページとして名前を返す", () => {
    expect(index.resolve("架空 太郎")).toBeNull();
    expect(index.resolve("[[]]")).toBeNull();
    expect(index.target("[[架空 太郎|著者]]")).toEqual({ name: "架空 太郎", page: null });
  });

  it("H1 のないページは name でだけ引ける", () => {
    expect(index.resolve("2026-01-18-no-title")?.[0]).toBe("2026-01-18-no-title");
  });

  it("まだないページのバックリンク。updated の新しい順、同じなら name の降順", () => {
    expect(names(index.backlinks("架空 太郎"))).toEqual([
      "2026-01-24-two-hop",
      "2026-01-15-book-c",
      "2026-01-10-reading-list",
      "2026-01-12-book-a",
    ]);
    expect(names(index.backlinks("まだないページ"))).toEqual(["2026-01-19-no-frontmatter"]);
  });

  it("タグも同じリンクなので、タグ名のバックリンクが引ける", () => {
    expect(names(index.backlinks("books"))).toEqual([
      "2026-01-24-two-hop",
      "2026-01-15-book-c",
      "2026-01-10-reading-list",
      "2026-01-12-book-a",
    ]);
    expect(names(index.backlinks("要約待ち"))).toEqual(["2026-01-26-capture", "2026-01-15-book-c"]);
  });

  it("あるページのバックリンクは name と title のどちらで書かれたものも含む", () => {
    // book-c は [[見本の本A]]（title）、reading-list と two-hop は name で書いている
    const expected = ["2026-01-24-two-hop", "2026-01-15-book-c", "2026-01-10-reading-list"];
    expect(names(index.backlinks("2026-01-12-book-a"))).toEqual(expected);
    expect(names(index.backlinks("見本の本A"))).toEqual(expected);
  });

  it("title で引いたバックリンクは、その title に解決されるページのもの", () => {
    // 「同じタイトル」は新しいほうに解決されるので、新しいほうへのバックリンクが出る
    expect(names(index.backlinks("同じタイトル"))).toEqual(["2026-01-25", "2026-01-21-duplicate-title-old"]);
    expect(names(index.backlinks("2026-01-21-duplicate-title-old"))).toEqual(["2026-01-22-duplicate-title-new"]);
  });

  it("2 hop link はリンク先ごとに、同じリンク先を持つ他のページをまとめる", () => {
    const hops = index.twoHop("2026-01-24-two-hop");
    expect(hops.map((h) => [h.target.name, h.target.page?.name ?? null, names(h.pages)])).toEqual([
      ["books", null, ["2026-01-15-book-c", "2026-01-10-reading-list", "2026-01-12-book-a"]],
      ["架空 太郎", null, ["2026-01-15-book-c", "2026-01-10-reading-list", "2026-01-12-book-a"]],
      ["2026-01-12-book-a", "2026-01-12-book-a", ["2026-01-15-book-c", "2026-01-10-reading-list"]],
      ["2026-01-15-book-c", "2026-01-15-book-c", ["2026-01-10-reading-list", "2026-01-12-book-a"]],
    ]);
  });

  it("他のページが一つもないリンク先は 2 hop link に出さない。まだないページの 2 hop link はない", () => {
    // no-frontmatter の [[まだないページ]] を持つのはこのページだけ
    expect(index.twoHop("2026-01-19-no-frontmatter")).toEqual([]);
    expect(index.twoHop("架空 太郎")).toEqual([]);
  });
});

describe("KbIndex: 解決の順番と更新", () => {
  it("name が title より先", () => {
    const index = new KbIndex([page("X", { h1: "エックス" }), page("2026-01-01-a", { h1: "X", updated: "2026-01-02" })]);
    expect(index.resolve("X")?.[0]).toBe("X");
    expect(index.resolve("エックス")?.[0]).toBe("X");
  });

  it("同じ title で updated がないものは古い扱い。updated も同じなら name の降順", () => {
    const index = new KbIndex([
      page("a", { h1: "T", updated: null }),
      page("b", { h1: "T", updated: "2026-01-01" }),
      page("c", { h1: "T", updated: "2026-01-01" }),
    ]);
    expect(index.resolve("T")?.[0]).toBe("c");
    index.remove("c");
    expect(index.resolve("T")?.[0]).toBe("b");
    index.remove("b");
    expect(index.resolve("T")?.[0]).toBe("a");
  });

  it("name と title の両方で同じページを指すリンクは、2 hop link で一つのグループになる", () => {
    const index = new KbIndex([
      page("a", { h1: "A" }),
      page("p", { links: ["a", "A"] }),
      page("q", { links: ["A"] }),
      page("r", { links: ["a"] }),
    ]);
    const hops = index.twoHop("p");
    expect(hops.length).toBe(1);
    expect(hops[0].target.name).toBe("a");
    expect(names(hops[0].pages).sort()).toEqual(["q", "r"]);
  });

  it("自分自身へのリンクはバックリンクにも 2 hop link にも出さない", () => {
    const index = new KbIndex([page("a", { h1: "A", links: ["a", "A"] })]);
    expect(index.backlinks("a")).toEqual([]);
    expect(index.twoHop("a")).toEqual([]);
  });

  it("set で差し替えると古い links と title が消える", () => {
    const index = new KbIndex([page("a", { h1: "旧", links: ["x"] }), page("b", { links: ["x"] })]);
    expect(names(index.backlinks("x")).sort()).toEqual(["a", "b"]);
    index.set(page("a", { h1: "新", links: ["y"] }));
    expect(index.resolve("旧")).toBeNull();
    expect(index.resolve("新")?.[0]).toBe("a");
    expect(names(index.backlinks("x"))).toEqual(["b"]);
    expect(names(index.backlinks("y"))).toEqual(["a"]);
  });

  it("remove で索引から消える", () => {
    const index = new KbIndex([page("a", { h1: "A", links: ["x"] })]);
    index.remove("a");
    index.remove("a");
    expect(index.size).toBe(0);
    expect(index.resolve("a")).toBeNull();
    expect(index.resolve("A")).toBeNull();
    expect(index.backlinks("x")).toEqual([]);
  });

  it("逆引きは最初に要るときに作り、その前後の set/remove を反映する", () => {
    const index = new KbIndex([page("a", { links: ["x"] })]);
    index.set(page("b", { links: ["x"] }));
    expect(names(index.backlinks("x")).sort()).toEqual(["a", "b"]);
    index.set(page("c", { links: ["x"] }));
    index.remove("a");
    expect(names(index.backlinks("x")).sort()).toEqual(["b", "c"]);
    index.prepareBacklinks();
    expect(names(index.backlinks("x")).sort()).toEqual(["b", "c"]);
  });

  it("本文のない PageMeta でも入れられる", () => {
    const { body: _body, ...meta } = page("a", { h1: "A" });
    const index = new KbIndex([meta]);
    expect(index.resolve("A")?.[0]).toBe("a");
  });

  it("pages は読むだけの Map として渡せる", () => {
    const index = new KbIndex([page("a")]);
    expect([...index.pages.keys()]).toEqual(["a"]);
  });
});

describe("refName", () => {
  it("[[ ]] と表示名を外して前後の空白を落とす", () => {
    expect(refName("a")).toBe("a");
    expect(refName(" [[ a | b ]] ")).toBe("a");
    expect(refName("[[a|]]")).toBe("a");
    expect(refName("[[]]")).toBe("");
    // [[ ]] で囲まれていなければ | は名前の一部
    expect(refName("a|b")).toBe("a|b");
  });
});

describe("byUpdatedDesc", () => {
  it("updated の新しい順、同じなら name の降順、updated なしは最後", () => {
    const pages = [
      page("a", { updated: null }),
      page("b", { updated: "2026-01-01" }),
      page("c", { updated: "2026-01-02" }),
      page("d", { updated: "2026-01-01" }),
    ];
    expect(names(pages.sort(byUpdatedDesc))).toEqual(["c", "d", "b", "a"]);
  });
});
