import { describe, expect, it } from "vitest";
import { blobShaOf } from "../shared/api-path";
import { Kb, PARSER_VERSION } from "./kb";
import { type ArchiveFile, NotFoundError, type Source } from "./source";
import { MemoryStore, type StoredFile } from "./store";

// 取り込み元の見本。読んだ回数を数える
class FakeSource implements Source {
  readonly reads: string[] = [];
  constructor(readonly files: Map<string, StoredFile>) {}

  async list() {
    return [...this.files.values()].map(({ path, sha }) => ({ path, sha }));
  }

  async read(path: string) {
    this.reads.push(path);
    const f = this.files.get(path);
    if (!f) throw new Error(`ない: ${path}`);
    return { ...f };
  }

  async dir() {
    return "notes";
  }

  async write(): Promise<{ sha: string }> {
    throw new Error("このテストでは書かない");
  }
}

const noWrite = async (): Promise<{ sha: string }> => {
  throw new Error("このテストでは書かない");
};

// 控えの読み書きを数える
class CountingStore extends MemoryStore {
  readonly calls: string[] = [];
  override all() {
    this.calls.push("all");
    return super.all();
  }
  override get(path: string) {
    this.calls.push(`get ${path}`);
    return super.get(path);
  }
  override put(files: StoredFile[]) {
    this.calls.push(`put ${files.length}`);
    return super.put(files);
  }
  override getIndex() {
    this.calls.push("getIndex");
    return super.getIndex();
  }
  override getLinks() {
    this.calls.push("getLinks");
    return super.getLinks();
  }
  override putIndex(index: Parameters<MemoryStore["putIndex"]>[0]) {
    this.calls.push(`putIndex ${index.pages.length}`);
    return super.putIndex(index);
  }
}

function file(path: string, content: string, sha = `sha:${content}`): StoredFile {
  return { path, sha, content };
}

function fakeSource(...files: StoredFile[]): FakeSource {
  return new FakeSource(new Map(files.map((f) => [f.path, f])));
}

const names = (kb: Kb) => [...kb.index.pages.keys()].sort();

describe("Kb.open と sync", () => {
  it("初回は全件読んで控えに入れ、索引と解析結果のレコードを作る", async () => {
    const store = new CountingStore();
    const source = fakeSource(file("notes/a.md", "# A\n[[b]]"), file("notes/b.md", "# B"));
    const kb = await Kb.open(store);
    expect(kb.rebuilt).toBe(true);
    expect(kb.index.size).toBe(0);
    const result = await kb.sync(source);
    expect(source.reads.sort()).toEqual(["notes/a.md", "notes/b.md"]);
    expect(result.fetched.sort()).toEqual(["notes/a.md", "notes/b.md"]);
    expect(result.removed).toEqual([]);
    expect(names(kb)).toEqual(["a", "b"]);
    expect(kb.index.get("a")?.title).toBe("A");
    expect(kb.index.backlinks("b").map((p) => p.name)).toEqual(["a"]);
    expect((await store.getIndex())?.pages.map((p) => p.path).sort()).toEqual(["notes/a.md", "notes/b.md"]);
  });

  it("2回目の起動は本文を読まずにレコードから索引を作り、sha が同じなら何も読まない", async () => {
    const store = new CountingStore();
    const source = fakeSource(file("notes/a.md", "# A\n[[b]]"), file("notes/b.md", "# B"));
    await (await Kb.open(store)).sync(source);
    store.calls.length = 0;
    source.reads.length = 0;

    const kb = await Kb.open(store);
    expect(kb.rebuilt).toBe(false);
    // 起動時に読むのはレコードだけ。links は読まない
    expect(store.calls).toEqual(["getIndex"]);
    expect(names(kb)).toEqual(["a", "b"]);
    expect(kb.index.resolve("A")?.[0]).toBe("a");
    expect(kb.index.get("a")?.links).toEqual([]);

    // 逆引きの前に links を読む。2回目は読まない
    await kb.prepareBacklinks();
    await kb.prepareBacklinks();
    expect(store.calls).toEqual(["getIndex", "getLinks"]);
    expect(kb.index.get("a")?.links).toEqual(["b"]);
    expect(kb.index.backlinks("b").map((p) => p.name)).toEqual(["a"]);

    const result = await kb.sync(source);
    expect(source.reads).toEqual([]);
    expect(result).toEqual({ fetched: [], removed: [] });
    // 変わっていなければレコードも書き直さない
    expect(store.calls.filter((c) => c.startsWith("putIndex"))).toEqual([]);
  });

  it("links を読む前に差分を取っても、保存する links は正しい", async () => {
    const store = new CountingStore();
    const source = fakeSource(file("notes/a.md", "# A\n[[b]] [[c]]"), file("notes/b.md", "# B\n[[a]]"));
    await (await Kb.open(store)).sync(source);
    const kb = await Kb.open(store);
    source.files.set("notes/b.md", file("notes/b.md", "# B2\n[[c]]"));
    await kb.sync(source);
    expect(kb.index.get("a")?.links).toEqual(["b", "c"]);
    expect(kb.index.backlinks("c").map((p) => p.name).sort()).toEqual(["a", "b"]);
    const again = await Kb.open(store);
    await again.prepareBacklinks();
    expect(again.index.get("a")?.links).toEqual(["b", "c"]);
    expect(again.index.get("b")?.links).toEqual(["c"]);
    expect(again.index.twoHop("a").map((h) => [h.target.name, h.pages.map((p) => p.name)])).toEqual([["c", ["b"]]]);
  });

  it("レコードを読んだあとで別のタブが書き換えていたら（stamp が違う）、控えの中身から解析し直す", async () => {
    const store = new CountingStore();
    const source = fakeSource(file("notes/a.md", "# A\n[[b]]"), file("notes/b.md", "# B\n[[c]]"));
    await (await Kb.open(store)).sync(source);
    const kb = await Kb.open(store);
    // 別のタブが a を消して d を足した（件数は同じ）。位置で対応づけると b に a の links が付く
    const other = await Kb.open(store);
    source.files.delete("notes/a.md");
    source.files.set("notes/d.md", file("notes/d.md", "# D"));
    await other.sync(source);
    store.calls.length = 0;
    source.reads.length = 0;
    await kb.prepareBacklinks();
    expect(store.calls).toEqual(["getLinks", "all", "putIndex 2"]);
    expect(names(kb)).toEqual(["b", "d"]);
    expect(kb.index.get("b")?.links).toEqual(["c"]);
    expect((await kb.backlinks("c")).map((p) => p.name)).toEqual(["b"]);
    await kb.sync(source);
    expect(source.reads).toEqual([]);
  });

  it("links を読む前に索引の逆引きを作ってしまっても、読んだあとに作り直す", async () => {
    const store = new MemoryStore();
    const source = fakeSource(file("notes/a.md", "# A\n[[b]]"), file("notes/b.md", "# B"));
    await (await Kb.open(store)).sync(source);
    const kb = await Kb.open(store);
    expect(kb.index.backlinks("b")).toEqual([]);
    expect((await kb.backlinks("b")).map((p) => p.name)).toEqual(["a"]);
    expect((await kb.twoHop("a")).length).toBe(0);
  });

  it("links の読み込みに失敗しても、次の呼び出しで試し直す", async () => {
    const store = new CountingStore();
    const source = fakeSource(file("notes/a.md", "# A\n[[b]]"));
    await (await Kb.open(store)).sync(source);
    const kb = await Kb.open(store);
    const getLinks = store.getLinks.bind(store);
    store.getLinks = async () => {
      throw new Error("読めない");
    };
    await expect(kb.prepareBacklinks()).rejects.toThrow("読めない");
    store.getLinks = getLinks;
    await kb.prepareBacklinks();
    expect(kb.index.get("a")?.links).toEqual(["b"]);
  });

  it("本文はページの表示のときにそのページの分だけ読む", async () => {
    const store = new CountingStore();
    const source = fakeSource(file("notes/a.md", "# A\n本文A"), file("notes/b.md", "# B"));
    await (await Kb.open(store)).sync(source);
    const kb = await Kb.open(store);
    store.calls.length = 0;
    const page = await kb.page("[[A|表示]]");
    expect(page?.name).toBe("a");
    expect(page?.body).toBe("# A\n本文A");
    expect(store.calls).toEqual(["get notes/a.md"]);
    expect(await kb.page("ない")).toBeNull();
  });

  it("sha が変わったものと新しいものだけ読んで解析し直し、一覧にないものは索引と控えから消す", async () => {
    const store = new CountingStore();
    const source = fakeSource(file("notes/a.md", "# A"), file("notes/b.md", "# B"), file("notes/c.md", "# C"));
    await (await Kb.open(store)).sync(source);
    const kb = await Kb.open(store);
    const metaA = kb.index.get("a");
    source.reads.length = 0;

    source.files.set("notes/b.md", file("notes/b.md", "# B2\n[[a]]"));
    source.files.set("notes/d.md", file("notes/d.md", "# D"));
    source.files.delete("notes/c.md");
    const result = await kb.sync(source);

    expect(source.reads.sort()).toEqual(["notes/b.md", "notes/d.md"]);
    expect(result.fetched.sort()).toEqual(["notes/b.md", "notes/d.md"]);
    expect(result.removed).toEqual(["notes/c.md"]);
    expect(names(kb)).toEqual(["a", "b", "d"]);
    expect(kb.index.get("b")?.title).toBe("B2");
    expect(kb.index.backlinks("a").map((p) => p.name)).toEqual(["b"]);
    // 変わっていないページの解析結果は同じもののまま
    expect(kb.index.get("a")).toBe(metaA);
    expect((await store.all()).map((f) => f.path).sort()).toEqual(["notes/a.md", "notes/b.md", "notes/d.md"]);
    const stored = await store.getIndex();
    expect(stored?.pages.map((p) => [p.path, p.title]).sort()).toEqual([
      ["notes/a.md", "A"],
      ["notes/b.md", "B2"],
      ["notes/d.md", "D"],
    ]);
  });

  it("解析結果のレコードが古ければ、ファイルの控えが新しくてもそのページを読み直す", async () => {
    const store = new CountingStore();
    const source = fakeSource(file("notes/a.md", "# A"));
    await (await Kb.open(store)).sync(source);
    // 途中で止まった状態を作る。ファイル側だけ新しい sha
    source.files.set("notes/a.md", file("notes/a.md", "# A2"));
    await store.put([file("notes/a.md", "# A2")]);
    const kb = await Kb.open(store);
    expect(kb.index.get("a")?.title).toBe("A");
    source.reads.length = 0;
    await kb.sync(source);
    expect(source.reads).toEqual(["notes/a.md"]);
    expect(kb.index.get("a")?.title).toBe("A2");
  });

  it("解析の版が違えば、取り直さずに控えの中身から全件を解析し直す", async () => {
    const store = new CountingStore();
    const source = fakeSource(file("notes/a.md", "# A"), file("notes/b.md", "# B"));
    await (await Kb.open(store)).sync(source);
    const stored = (await store.getIndex())!;
    await store.putIndex({ version: PARSER_VERSION - 1, pages: stored.pages.map((p) => ({ ...p, title: "古い" })) });
    store.calls.length = 0;
    source.reads.length = 0;

    const kb = await Kb.open(store);
    expect(kb.rebuilt).toBe(true);
    expect(store.calls).toEqual(["getIndex", "all", "putIndex 2"]);
    expect(kb.index.get("a")?.title).toBe("A");
    expect((await store.getIndex())?.version).toBe(PARSER_VERSION);
    await kb.sync(source);
    expect(source.reads).toEqual([]);
  });

  it("同じ path で中身だけ違っても sha が同じなら読み直さない", async () => {
    const store = new MemoryStore();
    const source = fakeSource(file("notes/a.md", "# A", "same"));
    const kb = await Kb.open(store);
    await kb.sync(source);
    source.files.set("notes/a.md", file("notes/a.md", "# A2", "same"));
    source.reads.length = 0;
    await kb.sync(source);
    expect(source.reads).toEqual([]);
    expect(kb.index.get("a")?.title).toBe("A");
  });

  it("読むのは同時に concurrency 件まで。0 以下でも読む", async () => {
    const files = Array.from({ length: 10 }, (_, i) => file(`notes/${i}.md`, `# ${i}`));
    let inFlight = 0;
    let max = 0;
    const source: Source = {
      write: noWrite,
      dir: async () => "notes",
      list: async () => files.map(({ path, sha }) => ({ path, sha })),
      read: async (path) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return files.find((f) => f.path === path)!;
      },
    };
    const kb = await Kb.open(new MemoryStore());
    await kb.sync(source, { concurrency: 3 });
    expect(kb.index.size).toBe(10);
    expect(max).toBeLessThanOrEqual(3);
    const zero = await Kb.open(new MemoryStore());
    await zero.sync(source, { concurrency: 0 });
    expect(zero.index.size).toBe(10);
  });

  it("読むのに失敗したら、読めた分を控えとレコードに書いてから投げる。残りは読まない", async () => {
    const store = new CountingStore();
    const source = fakeSource(file("notes/a.md", "# A"), file("notes/b.md", "# B"), file("notes/c.md", "# C"));
    const read = source.read.bind(source);
    source.read = async (path) => {
      if (path === "notes/b.md") throw new Error("落ちた");
      return read(path);
    };
    const kb = await Kb.open(store);
    await expect(kb.sync(source, { concurrency: 1 })).rejects.toThrow("落ちた");
    // b で落ちたあとの c は読まない（差し替えた read は b を記録しない）
    expect(source.reads).toEqual(["notes/a.md"]);
    expect(names(kb)).toEqual(["a"]);
    expect((await store.getIndex())?.pages.map((p) => p.path)).toEqual(["notes/a.md"]);
    // 次回は残りだけ読む
    source.read = read;
    source.reads.length = 0;
    const again = await Kb.open(store);
    await again.sync(source);
    expect(source.reads.sort()).toEqual(["notes/b.md", "notes/c.md"]);
    expect(names(again)).toEqual(["a", "b", "c"]);
  });

  it("一覧に出たあとで消えたファイルは「消えた」として扱う", async () => {
    const store = new MemoryStore();
    const source = fakeSource(file("notes/a.md", "# A"), file("notes/b.md", "# B"));
    const kb = await Kb.open(store);
    await kb.sync(source);
    source.files.set("notes/b.md", file("notes/b.md", "# B2"));
    const read = source.read.bind(source);
    source.read = async (path) => {
      if (path === "notes/b.md") throw new NotFoundError("ない");
      return read(path);
    };
    const result = await kb.sync(source);
    expect(result).toEqual({ fetched: [], removed: ["notes/b.md"] });
    expect(names(kb)).toEqual(["a"]);
    expect((await store.all()).map((f) => f.path)).toEqual(["notes/a.md"]);
  });

  it("batch 件ごとに控えへ書き、レコードは最後に一度書く", async () => {
    const store = new CountingStore();
    const files = Array.from({ length: 5 }, (_, i) => file(`notes/${i}.md`, `# ${i}`));
    const kb = await Kb.open(store);
    store.calls.length = 0;
    await kb.sync(fakeSource(...files), { concurrency: 1, batch: 2 });
    expect(store.calls).toEqual(["put 2", "put 2", "put 1", "putIndex 5"]);
  });

  it("控えの鍵は取り込み元が返した path ではなく要求した path", async () => {
    const source: Source = {
      write: noWrite,
      dir: async () => "notes",
      list: async () => [{ path: "notes/a.md", sha: "s" }],
      read: async () => ({ path: "./notes/a.md", sha: "s", content: "# A" }),
    };
    const store = new MemoryStore();
    const kb = await Kb.open(store);
    await kb.sync(source);
    expect((await store.all()).map((f) => f.path)).toEqual(["notes/a.md"]);
    expect((await kb.sync(source)).fetched).toEqual([]);
  });

  it("同じ name の別のファイルは path の小さいほうを見せ、それが消えたらもう一方を見せる", async () => {
    const store = new MemoryStore();
    const source = fakeSource(file("notes/x.md", "# 1"), file("notes/sub/x.md", "# 2"));
    const kb = await Kb.open(store);
    await kb.sync(source, { concurrency: 1 });
    expect(kb.index.size).toBe(1);
    expect(kb.index.get("x")?.path).toBe("notes/sub/x.md");
    // 再起動しても同じ
    const again = await Kb.open(store);
    expect(again.index.get("x")?.path).toBe("notes/sub/x.md");
    source.files.delete("notes/sub/x.md");
    await kb.sync(source);
    expect(kb.index.get("x")?.path).toBe("notes/x.md");
    expect(kb.index.get("x")?.title).toBe("1");
  });
});

const utf8 = (s: string) => new TextEncoder().encode(s);

// sha を Git の blob と同じ値にしたファイル（tarball の突き合わせに使う）
async function real(path: string, content: string): Promise<StoredFile> {
  return { path, sha: await blobShaOf(utf8(content)), content };
}

// tarball を持つ取り込み元の見本。一覧とは別に tarball の中身（path → 中身）を持てて、
// archive の呼び出し回数と want に聞かれたパスを記録する
class ArchiveSource extends FakeSource {
  archives = 0;
  readonly asked: string[] = [];
  // tarball の中身。null なら一覧と同じ
  tarball: Map<string, string> | null = null;
  // この件数を返したあとで投げる（回線が切れた場合）
  failAfter: number | null = null;
  // archive が null を返す（tarball を持たない）
  none = false;

  async archive(want: (path: string) => boolean): Promise<AsyncIterable<ArchiveFile> | null> {
    if (this.none) return null;
    this.archives++;
    const entries = [...(this.tarball ?? new Map([...this.files].map(([p, f]) => [p, f.content])))];
    const self = this;
    return (async function* () {
      let n = 0;
      for (const [path, content] of entries) {
        if (self.failAfter !== null && n >= self.failAfter) throw new Error("切れた");
        self.asked.push(path);
        if (!want(path)) continue;
        n++;
        yield { path, bytes: utf8(content) };
      }
    })();
  }
}

async function archiveSource(...entries: [string, string][]): Promise<ArchiveSource> {
  const files = await Promise.all(entries.map(([p, c]) => real(p, c)));
  return new ArchiveSource(new Map(files.map((f) => [f.path, f])));
}

const pages = (n: number): [string, string][] => Array.from({ length: n }, (_, i) => [`notes/p${i}.md`, `# p${i}\n`]);

describe("Kb.sync の tarball の経路", () => {
  it("控えが空なら tarball を1回使い、1件ずつは読まない。全件が控え・索引・レコードに入る", async () => {
    const store = new MemoryStore();
    const source = await archiveSource(["notes/a.md", "# A\n[[b]]"], ["notes/b.md", "﻿# B\n"]);
    const kb = await Kb.open(store);
    const result = await kb.sync(source);
    expect(source.archives).toBe(1);
    expect(source.reads).toEqual([]);
    expect(result.fetched.sort()).toEqual(["notes/a.md", "notes/b.md"]);
    expect(names(kb)).toEqual(["a", "b"]);
    expect(kb.index.backlinks("b").map((p) => p.name)).toEqual(["a"]);
    // 控えの sha は一覧の sha。中身の BOM は外す（Worker の GET /api/pages/<path> と同じ）
    const stored = await store.all();
    expect(stored.map((f) => f.sha).sort()).toEqual([...source.files.values()].map((f) => f.sha).sort());
    expect((await store.get("notes/b.md"))?.content).toBe("# B\n");
    expect(kb.index.get("b")?.title).toBe("B");
    expect((await store.getIndex())?.pages.map((p) => p.path).sort()).toEqual(["notes/a.md", "notes/b.md"]);
  });

  it("2回目は tarball を使わず、変わったものと増えたものだけ読み、消えたものは removed", async () => {
    const store = new MemoryStore();
    const source = await archiveSource(["notes/a.md", "# A"], ["notes/b.md", "# B"], ["notes/c.md", "# C"]);
    await (await Kb.open(store)).sync(source);
    source.files.set("notes/a.md", await real("notes/a.md", "# A2"));
    source.files.set("notes/d.md", await real("notes/d.md", "# D"));
    source.files.delete("notes/c.md");
    source.archives = 0;
    const kb = await Kb.open(store);
    const result = await kb.sync(source);
    expect(source.archives).toBe(0);
    expect(source.reads.sort()).toEqual(["notes/a.md", "notes/d.md"]);
    expect(result.removed).toEqual(["notes/c.md"]);
    expect(names(kb)).toEqual(["a", "b", "d"]);
    expect(kb.index.get("a")?.title).toBe("A2");
  });

  it("tarball の中身の sha が一覧と違うものと、tarball にないものだけ1件ずつ読む。読んで 404 なら消えた扱い", async () => {
    const source = await archiveSource(["notes/a.md", "# A"], ["notes/b.md", "# B"], ["notes/c.md", "# C"], ["notes/gone.md", "# G"]);
    // b は一覧の後で変わった扱い、c と gone は tarball にない。gone は1件ずつ読むと 404
    source.tarball = new Map([
      ["notes/a.md", "# A"],
      ["notes/b.md", "# B 古い"],
    ]);
    const read = source.read.bind(source);
    source.read = async (path) => {
      if (path === "notes/gone.md") {
        source.reads.push(path);
        throw new NotFoundError("ない");
      }
      return read(path);
    };
    const store = new MemoryStore();
    const kb = await Kb.open(store);
    const result = await kb.sync(source);
    expect(source.reads.sort()).toEqual(["notes/b.md", "notes/c.md", "notes/gone.md"]);
    expect(result.removed).toEqual(["notes/gone.md"]);
    expect(names(kb)).toEqual(["a", "b", "c"]);
    // 控えには一覧の sha と合う中身が入る
    expect((await store.get("notes/b.md"))?.content).toBe("# B");
  });

  it("控えがあっても、読むものが archiveThreshold を超えれば tarball を使う。ちょうどなら使わない", async () => {
    const store = new MemoryStore();
    const source = await archiveSource(...pages(8));
    await (await Kb.open(store)).sync(source);
    for (const [p, c] of pages(3)) source.files.set(p, await real(p, `${c}変えた\n`));
    source.archives = 0;
    source.reads.length = 0;
    await (await Kb.open(store)).sync(source, { archiveThreshold: 3 });
    expect(source.archives).toBe(0);
    expect(source.reads).toHaveLength(3);

    for (const [p, c] of pages(4)) source.files.set(p, await real(p, `${c}もう一度\n`));
    source.reads.length = 0;
    const kb = await Kb.open(store);
    const result = await kb.sync(source, { archiveThreshold: 3 });
    expect(source.archives).toBe(1);
    expect(source.reads).toEqual([]);
    expect(result.fetched).toHaveLength(4);
    expect((await store.get("notes/p0.md"))?.content).toBe("# p0\nもう一度\n");
  });

  it("tarball の後で合わないものが archiveThreshold を超えたら、その件数だけ1件ずつ読んでから投げ、起動のたびに進む", async () => {
    const store = new MemoryStore();
    const source = await archiveSource(...pages(7));
    // 5件の中身が変換されている（.gitattributes の export-subst。戻せない）
    source.tarball = new Map(pages(7).map(([p, c], i) => [p, i < 5 ? `${c}$Format:%H$\n` : c]));
    const kb = await Kb.open(store);
    await expect(kb.sync(source, { archiveThreshold: 2 })).rejects.toThrow("合わないファイルが 5 件ある");
    expect(source.reads).toEqual(["notes/p0.md", "notes/p1.md"]);
    expect(names(kb)).toEqual(["p0", "p1", "p5", "p6"]);
    expect((await store.getIndex())?.pages.map((p) => p.path).sort()).toEqual(["notes/p0.md", "notes/p1.md", "notes/p5.md", "notes/p6.md"]);

    // 次の起動: 残り3件で archiveThreshold を超えるので、もう一度 tarball を取り、2件読んで投げる
    source.reads.length = 0;
    const second = await Kb.open(store);
    await expect(second.sync(source, { archiveThreshold: 2 })).rejects.toThrow("合わないファイルが 3 件ある");
    expect(source.archives).toBe(2);
    expect(source.reads).toEqual(["notes/p2.md", "notes/p3.md"]);

    // その次: 残り1件なので tarball を取らずに読んで終わる
    source.reads.length = 0;
    const third = await Kb.open(store);
    const result = await third.sync(source, { archiveThreshold: 2 });
    expect(source.archives).toBe(2);
    expect(source.reads).toEqual(["notes/p4.md"]);
    expect(result.fetched).toEqual(["notes/p4.md"]);
    expect(names(third)).toHaveLength(7);
    expect((await store.get("notes/p0.md"))?.content).toBe("# p0\n");
  });

  it("eol=crlf で CRLF に変わったファイルは、LF に戻した中身が一覧の sha と合えばそれを控えに入れる", async () => {
    const store = new MemoryStore();
    const source = await archiveSource(["notes/a.md", "# A\n\n本文\n"], ["notes/mixed.md", "# M\r\n一行目\n"]);
    source.tarball = new Map([
      ["notes/a.md", "# A\r\n\r\n本文\r\n"],
      // 元から CRLF を含むファイル。LF に戻すと元と違うので1件ずつ読む
      ["notes/mixed.md", "# M\r\n一行目\r\n"],
    ]);
    const kb = await Kb.open(store);
    const result = await kb.sync(source);
    expect(source.reads).toEqual(["notes/mixed.md"]);
    expect(result.fetched.sort()).toEqual(["notes/a.md", "notes/mixed.md"]);
    const a = await store.get("notes/a.md");
    expect(a?.content).toBe("# A\n\n本文\n");
    expect(a?.sha).toBe(source.files.get("notes/a.md")?.sha);
    expect((await store.get("notes/mixed.md"))?.content).toBe("# M\r\n一行目\n");
  });

  it("archive が投げたら（502 など）sync も投げ、1件ずつ読みには回らず、控えは変わらない", async () => {
    const store = new MemoryStore();
    const source = await archiveSource(...pages(3));
    source.archive = async () => {
      throw new Error("APIの応答が異常: 502");
    };
    const kb = await Kb.open(store);
    await expect(kb.sync(source)).rejects.toThrow("502");
    expect(source.reads).toEqual([]);
    expect(await store.all()).toEqual([]);
    expect(kb.index.size).toBe(0);
  });

  it("tarball が途中で切れたら、それまでに届いた分を控えとレコードに書いてから投げ、次は残りだけ読む", async () => {
    const store = new MemoryStore();
    const source = await archiveSource(...pages(5));
    source.failAfter = 2;
    const kb = await Kb.open(store);
    await expect(kb.sync(source)).rejects.toThrow("切れた");
    expect(source.reads).toEqual([]);
    expect(names(kb)).toEqual(["p0", "p1"]);
    expect((await store.getIndex())?.pages.map((p) => p.path)).toEqual(["notes/p0.md", "notes/p1.md"]);

    source.failAfter = null;
    source.archives = 0;
    const again = await Kb.open(store);
    const result = await again.sync(source);
    // 残りは3件で archiveThreshold 以下なので1件ずつ読む
    expect(source.archives).toBe(0);
    expect(source.reads.sort()).toEqual(["notes/p2.md", "notes/p3.md", "notes/p4.md"]);
    expect(result.fetched.sort()).toEqual(["notes/p2.md", "notes/p3.md", "notes/p4.md"]);
    expect(names(again)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
  });

  it("archive が null なら（tarball を持たない取り込み元）1件ずつ全部読む", async () => {
    const source = await archiveSource(["notes/a.md", "# A"], ["notes/b.md", "# B"]);
    source.none = true;
    const kb = await Kb.open(new MemoryStore());
    await kb.sync(source);
    expect(source.reads.sort()).toEqual(["notes/a.md", "notes/b.md"]);
    expect(names(kb)).toEqual(["a", "b"]);
  });

  it("一覧にないファイル（KB_DIR の外、.md 以外）は want が false になり、中身を受け取らない", async () => {
    const source = await archiveSource(["notes/a.md", "# A"]);
    source.tarball = new Map([
      ["README.md", "# readme"],
      ["notes/a.md", "# A"],
      ["notes/img/dot.png", "PNG"],
    ]);
    const store = new MemoryStore();
    const kb = await Kb.open(store);
    const result = await kb.sync(source);
    expect(source.asked).toEqual(["README.md", "notes/a.md", "notes/img/dot.png"]);
    expect(result.fetched).toEqual(["notes/a.md"]);
    expect((await store.all()).map((f) => f.path)).toEqual(["notes/a.md"]);
  });

  it("tarball の経路でも batch 件ごとに控えへ書き、レコードは最後に一度書く", async () => {
    const store = new CountingStore();
    const source = await archiveSource(...pages(5));
    const kb = await Kb.open(store);
    store.calls.length = 0;
    await kb.sync(source, { batch: 2 });
    expect(source.archives).toBe(1);
    expect(store.calls.filter((c) => c !== "getLinks")).toEqual(["put 2", "put 2", "put 1", "putIndex 5"]);
  });
});
