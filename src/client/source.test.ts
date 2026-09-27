import { describe, expect, it } from "vitest";
import { createLocalApi } from "../server/local";
import { Kb } from "./kb";
import { ApiSource, NotFoundError, encodePath } from "./source";
import { MemoryStore, type StoredFile } from "./store";

function file(path: string, content: string, sha = `sha:${content}`): StoredFile {
  return { path, sha, content };
}

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
    const kb = await Kb.open(store);
    const first = await kb.sync(source);
    expect(first.fetched.length).toBe(16);
    expect(calls.filter((u) => u === "/api/pages").length).toBe(1);
    expect(calls.filter((u) => u.startsWith("/api/pages/")).length).toBe(16);

    calls.length = 0;
    const again = await Kb.open(store);
    const second = await again.sync(source);
    expect(second.fetched).toEqual([]);
    expect(calls).toEqual(["/api/pages"]);
    expect(again.index.size).toBe(16);
    expect(again.index.resolve("見本の本A")?.[0]).toBe("2026-01-12-book-a");
    expect((await again.page("見本の本A"))?.body).toContain("著者は [[架空 太郎]]");
  });

  it("APIがエラーを返したら error の文を含めて投げる。404 は NotFoundError", async () => {
    const source = new ApiSource(async () => Response.json({ error: "まだない" }, { status: 501 }));
    await expect(source.list()).rejects.toThrow("501 まだない");
    const gone = new ApiSource(async () => Response.json({ error: "ない" }, { status: 404 }));
    await expect(gone.read("notes/a.md")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("応答の形が違えば投げ、余分な項目は控えに入れない", async () => {
    const broken = new ApiSource(async () => Response.json({ pages: [{ path: "a" }] }));
    await expect(broken.list()).rejects.toThrow("path と sha がない");
    const noContent = new ApiSource(async () => Response.json({ path: "a", sha: "s" }));
    await expect(noContent.read("a")).rejects.toThrow("sha か content がない");
    const extra = new ApiSource(async () => Response.json({ path: "b", sha: "s", content: "x", size: 1 }));
    expect(await extra.read("a")).toEqual({ path: "a", sha: "s", content: "x" });
  });
});

describe("encodePath", () => {
  it("区切りごとにエンコードし、/ は残す", () => {
    expect(encodePath("notes/a b/日本語 #1.md")).toBe("notes/a%20b/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%231.md");
  });
});

describe("MemoryStore", () => {
  it("put は同じ path を上書きし、get は1件、meta は文字列を保つ", async () => {
    const store = new MemoryStore();
    await store.put([file("a", "1"), file("a", "2")]);
    expect((await store.all()).map((f) => f.content)).toEqual(["2"]);
    expect((await store.get("a"))?.content).toBe("2");
    expect(await store.get("b")).toBeUndefined();
    expect(await store.getMeta("head")).toBeNull();
    await store.setMeta("head", "abc");
    expect(await store.getMeta("head")).toBe("abc");
    await store.remove(["a", "b"]);
    expect(await store.all()).toEqual([]);
  });

  it("解析結果のレコードは links を分けて置き、写しを返す", async () => {
    const store = new MemoryStore();
    expect(await store.getIndex()).toBeNull();
    expect(await store.getLinks()).toBeNull();
    const meta = { path: "a.md", name: "a", title: "A", h1: "A", created: null, updated: null, links: ["x", "y"], sha: "s" };
    const index = { version: 1, pages: [meta] };
    await store.putIndex(index);
    const got = (await store.getIndex())!;
    expect(got.version).toBe(1);
    expect(got.pages).toEqual([{ ...meta, links: [] }]);
    expect(got.pages[0]).not.toBe(meta);
    const links = (await store.getLinks())!;
    expect(links.links).toEqual([["x", "y"]]);
    // 両方に同じ stamp が入り、書き直すと変わる
    expect(links.stamp).toBe(got.stamp);
    await store.putIndex(index);
    expect((await store.getIndex())?.stamp).not.toBe(got.stamp);
  });
});
