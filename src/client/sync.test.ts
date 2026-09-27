import { describe, expect, it } from "vitest";
import { createLocalApi } from "../server/local";
import { MemoryStore, type StoredFile } from "./store";
import { ApiSource, type Source, buildIndex, encodePath, sync } from "./sync";

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
}

function file(path: string, content: string, sha = `sha:${content}`): StoredFile {
  return { path, sha, content };
}

function fakeSource(...files: StoredFile[]): FakeSource {
  return new FakeSource(new Map(files.map((f) => [f.path, f])));
}

describe("sync", () => {
  it("初回は全件読み、控えに入れる", async () => {
    const store = new MemoryStore();
    const source = fakeSource(file("notes/a.md", "# A"), file("notes/b.md", "# B"));
    const result = await sync(store, source);
    expect(source.reads.sort()).toEqual(["notes/a.md", "notes/b.md"]);
    expect(result.fetched.sort()).toEqual(["notes/a.md", "notes/b.md"]);
    expect(result.removed).toEqual([]);
    expect(result.files.map((f) => f.path)).toEqual(["notes/a.md", "notes/b.md"]);
    expect((await store.all()).length).toBe(2);
  });

  it("2回目は sha が同じなら何も読まない", async () => {
    const store = new MemoryStore();
    const source = fakeSource(file("notes/a.md", "# A"), file("notes/b.md", "# B"));
    await sync(store, source);
    source.reads.length = 0;
    const result = await sync(store, source);
    expect(source.reads).toEqual([]);
    expect(result.fetched).toEqual([]);
    expect(result.files.map((f) => f.content)).toEqual(["# A", "# B"]);
  });

  it("sha が変わったものと新しいものだけ読み、一覧にないものは控えから消す", async () => {
    const store = new MemoryStore();
    const source = fakeSource(file("notes/a.md", "# A"), file("notes/b.md", "# B"), file("notes/c.md", "# C"));
    await sync(store, source);
    source.reads.length = 0;

    source.files.set("notes/b.md", file("notes/b.md", "# B2"));
    source.files.set("notes/d.md", file("notes/d.md", "# D"));
    source.files.delete("notes/c.md");
    const result = await sync(store, source);

    expect(source.reads.sort()).toEqual(["notes/b.md", "notes/d.md"]);
    expect(result.removed).toEqual(["notes/c.md"]);
    expect(result.files.map((f) => [f.path, f.content])).toEqual([
      ["notes/a.md", "# A"],
      ["notes/b.md", "# B2"],
      ["notes/d.md", "# D"],
    ]);
    expect((await store.all()).map((f) => f.path).sort()).toEqual(["notes/a.md", "notes/b.md", "notes/d.md"]);
  });

  it("同じ path で中身だけ違っても sha が同じなら読み直さない", async () => {
    const store = new MemoryStore();
    const source = fakeSource(file("notes/a.md", "# A", "same"));
    await sync(store, source);
    source.files.set("notes/a.md", file("notes/a.md", "# A2", "same"));
    source.reads.length = 0;
    const result = await sync(store, source);
    expect(source.reads).toEqual([]);
    expect(result.files[0].content).toBe("# A");
  });

  it("読むのは同時に concurrency 件まで", async () => {
    const files = Array.from({ length: 10 }, (_, i) => file(`notes/${i}.md`, `# ${i}`));
    let inFlight = 0;
    let max = 0;
    const source: Source = {
      list: async () => files.map(({ path, sha }) => ({ path, sha })),
      read: async (path) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return files.find((f) => f.path === path)!;
      },
    };
    const result = await sync(new MemoryStore(), source, { concurrency: 3 });
    expect(result.files.length).toBe(10);
    expect(max).toBeLessThanOrEqual(3);
  });

  it("読むのに失敗したら控えを変えない", async () => {
    const store = new MemoryStore();
    const source = fakeSource(file("notes/a.md", "# A"));
    await sync(store, source);
    source.files.set("notes/a.md", file("notes/a.md", "# A2"));
    source.files.set("notes/b.md", { path: "notes/b.md", sha: "x", content: "" });
    source.read = async () => {
      throw new Error("落ちた");
    };
    await expect(sync(store, source)).rejects.toThrow("落ちた");
    expect((await store.all()).map((f) => [f.path, f.content])).toEqual([["notes/a.md", "# A"]]);
  });
});

describe("ApiSource: ローカルモードのAPIを取り込み元にする", () => {
  // fixtures/ は読むだけなので写さずに使う
  const api = createLocalApi({ root: "fixtures", dir: "notes" });
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return api(new Request(new URL(url, "http://localhost"), init));
  };

  it("初回は一覧と全ページを取り、2回目は一覧だけ", async () => {
    const store = new MemoryStore();
    const source = new ApiSource(fetchFn);
    const first = await sync(store, source);
    expect(first.files.length).toBe(16);
    expect(calls.filter((u) => u === "/api/pages").length).toBe(1);
    expect(calls.filter((u) => u.startsWith("/api/pages/")).length).toBe(16);

    calls.length = 0;
    const second = await sync(store, source);
    expect(second.fetched).toEqual([]);
    expect(calls).toEqual(["/api/pages"]);

    const index = buildIndex(second.files);
    expect(index.size).toBe(16);
    expect(index.resolve("見本の本A")?.[0]).toBe("2026-01-12-book-a");
  });

  it("APIがエラーを返したら error の文を含めて投げる", async () => {
    const source = new ApiSource(async () => Response.json({ error: "まだない" }, { status: 501 }));
    await expect(source.list()).rejects.toThrow("501 まだない");
  });
});

describe("encodePath", () => {
  it("区切りごとにエンコードし、/ は残す", () => {
    expect(encodePath("notes/a b/日本語 #1.md")).toBe("notes/a%20b/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%231.md");
  });
});

describe("MemoryStore", () => {
  it("put は同じ path を上書きし、meta は文字列を保つ", async () => {
    const store = new MemoryStore();
    await store.put([file("a", "1"), file("a", "2")]);
    expect((await store.all()).map((f) => f.content)).toEqual(["2"]);
    expect(await store.getMeta("head")).toBeNull();
    await store.setMeta("head", "abc");
    expect(await store.getMeta("head")).toBe("abc");
    await store.remove(["a", "b"]);
    expect(await store.all()).toEqual([]);
  });
});
