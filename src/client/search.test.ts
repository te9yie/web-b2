import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type Page, parsePage } from "./page";
import { LIMIT, search, searchWords } from "./search";

let pages: Page[];
const bodies = new Map<string, string>();
const bodyOf = (path: string) => bodies.get(path) ?? "";
const names = (r: { pages: { name: string }[] }) => r.pages.map((p) => p.name);

beforeAll(async () => {
  const dir = join("fixtures", "notes");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  pages = await Promise.all(files.map(async (f) => parsePage({ path: `notes/${f}`, content: await readFile(join(dir, f), "utf8") })));
  for (const p of pages) bodies.set(p.path, p.body.toLowerCase());
});

describe("search", () => {
  it("語が空なら全ページを更新順で返す", () => {
    const r = search(pages, "  ", bodyOf);
    expect(r.total).toBe(16);
    // updated が同じなら name の降順
    expect(names(r).slice(0, 4)).toEqual(["2026-01-26-capture", "2026-01-26-143210", "2026-01-25", "2026-01-22-duplicate-title-new"]);
  });

  it("全部の語を含むページだけ（AND）。タイトルに全語を含むものが先、あとは更新順", () => {
    const r = search(pages, "見本 著者", bodyOf);
    // タイトルに「見本」と「著者」の両方を含むページはない。本文に両方あるのは本C・読書リスト（『見本の本B』と「著者」）・本A
    expect(names(r)).toEqual(["2026-01-15-book-c", "2026-01-10-reading-list", "2026-01-12-book-a"]);
    const t = search(pages, "見本の本", bodyOf);
    // タイトルに含む本C（01-18）・本A（01-12）が先、本文だけの読書リスト（01-18）はその後
    expect(names(t)).toEqual(["2026-01-15-book-c", "2026-01-12-book-a", "2026-01-10-reading-list"]);
  });

  it("大文字小文字を区別しない。本文がまだ読めていなくてもタイトルで見つかる", () => {
    // タイトルに含む Mermaid の見本が先。本文（リンク先の名前）に含む画像とコードブロックの見本は更新順
    expect(names(search(pages, "MERMAID", bodyOf))).toEqual(["2026-01-16-mermaid-sample", "2026-01-23-image", "2026-01-17-code-samples"]);
    expect(names(search(pages, "mermaid", () => ""))).toEqual(["2026-01-16-mermaid-sample"]);
    expect(names(search(pages, "架空", () => ""))).toEqual([]);
  });

  it("見つからなければ空", () => {
    expect(search(pages, "zzz", bodyOf)).toEqual({ pages: [], total: 0 });
  });

  it("300件で切り、total には全件数が入る", () => {
    const many = Array.from({ length: LIMIT + 5 }, (_, i) => ({ ...pages[0], name: `p${i}`, path: `notes/p${i}.md` }));
    const r = search(many, "", bodyOf);
    expect(r.pages.length).toBe(LIMIT);
    expect(r.total).toBe(LIMIT + 5);
  });

  it("searchWords は空白で区切って小文字にする", () => {
    expect(searchWords(" A　b  c ")).toEqual(["a", "b", "c"]);
  });
});
