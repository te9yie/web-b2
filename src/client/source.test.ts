import { describe, expect, it } from "vitest";
import { createLocalApi } from "../server/local";
import { blobShaOf } from "../shared/api-path";
import { createGitHubApi } from "../worker/api";
import { FakeGitHub, REPO } from "../worker/github-test-helper";
import { Kb } from "./kb";
import { ApiSource, type ArchiveFile, ConflictError, NotFoundError, encodePath } from "./source";
import { MemoryStore, type StoredFile } from "./store";
import { makeTarGz } from "./tar-test-helper";

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
    // dir は一覧で受け取ったものを返し、一覧を取り直さない
    expect(await source.dir()).toBe("notes");
    expect(calls.filter((u) => u === "/api/pages").length).toBe(1);

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

  it("409 は ConflictError で、相手の内容を持つ。消えていれば null", async () => {
    const current = { path: "notes/a.md", sha: "s", content: "相手" };
    const conflict = new ApiSource(async () => Response.json({ error: "競合", current }, { status: 409 }));
    const e = await conflict.write("notes/a.md", "自分", "old", "web: a").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as ConflictError).current).toEqual(current);
    expect((e as ConflictError).message).toContain("競合");
    const gone = new ApiSource(async () => Response.json({ error: "競合", current: null }, { status: 409 }));
    const g = await gone.write("notes/a.md", "自分", "old", "web: a").catch((err: unknown) => err);
    expect((g as ConflictError).current).toBeNull();
    // current が欠けている・形が違う 409 は「読めない」（undefined）
    const bare = new ApiSource(async () => new Response("conflict", { status: 409 }));
    const b = await bare.write("notes/a.md", "自分", "old", "web: a").catch((err: unknown) => err);
    expect(b).toBeInstanceOf(ConflictError);
    expect((b as ConflictError).current).toBeUndefined();
    const broken = new ApiSource(async () => Response.json({ error: "競合", current: { path: "a" } }, { status: 409 }));
    const br = await broken.write("notes/a.md", "自分", "old", "web: a").catch((err: unknown) => err);
    expect((br as ConflictError).current).toBeUndefined();
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

const urlOf = (input: RequestInfo | URL) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

async function collect(files: AsyncIterable<ArchiveFile>): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for await (const f of files) out.push([f.path, new TextDecoder().decode(f.bytes)]);
  return out;
}

describe("ApiSource.archive", () => {
  it("ローカルモードの一覧には head がないので null を返し、/api/archive を取りに行かない", async () => {
    const api = createLocalApi({ root: "fixtures", dir: "notes" });
    const calls: string[] = [];
    const source = new ApiSource(async (input, init) => {
      calls.push(urlOf(input));
      return api(new Request(new URL(urlOf(input), "http://localhost"), init));
    });
    await source.list();
    expect(await source.archive(() => true)).toBeNull();
    expect(calls).toEqual(["/api/pages"]);
  });

  it("一覧に head があれば /api/archive を取って展開し、先頭のディレクトリを外したパスで返す", async () => {
    const tgz = makeTarGz(
      [
        { path: "README.md", content: "# readme\n" },
        { path: "notes/a.md", content: "# A\n" },
        { path: "notes/img/dot.png", content: "PNG" },
      ],
      { top: "owner-kb-c0mm1t0" },
    );
    const asked: string[] = [];
    const source = new ApiSource(async (input) => {
      const url = urlOf(input);
      if (url === "/api/pages") return Response.json({ pages: [], dir: "notes", head: "c0mm1t" });
      if (url === "/api/archive") return new Response(tgz, { headers: { "content-type": "application/gzip" } });
      return Response.json({ error: "ない" }, { status: 404 });
    });
    await source.list();
    const files = await source.archive((p) => {
      asked.push(p);
      return p.startsWith("notes/") && p.endsWith(".md");
    });
    expect(await collect(files!)).toEqual([["notes/a.md", "# A\n"]]);
    // 先頭のディレクトリ自身は want に聞かない
    expect(asked).toEqual(["README.md", "notes/a.md", "notes/img/dot.png"]);
  });

  it("/api/archive がエラーなら error の文を含めて投げ、gzip でない本文は読むときに投げる", async () => {
    let archive: Response = Response.json({ error: "GitHub: tarball の取得が 500" }, { status: 502 });
    const source = new ApiSource(async (input) => (urlOf(input) === "/api/pages" ? Response.json({ pages: [], dir: "notes", head: "h" }) : archive));
    await source.list();
    await expect(source.archive(() => true)).rejects.toThrow("502 GitHub: tarball の取得が 500");
    archive = new Response("TARBALL");
    const files = await source.archive(() => true);
    await expect(collect(files!)).rejects.toThrow();
  });
});

// 完了条件の確かめ。ブラウザの取り込み（Kb と ApiSource）を、Worker の /api/*（createGitHubApi）と GitHub の代わりにつなぐ
describe("Worker 経由の取り込み", () => {
  const longName = `notes/${"とても長い日本語のファイル名".repeat(3)}.md`;

  function setup() {
    const gh = new FakeGitHub(
      new Map([
        ["README.md", "# readme\n"],
        ["notes/img/dot.png", "PNG"],
        ["notes/2026-01-25.md", "---\ncreated: 2026-01-25\n---\n\n# 2026-01-25\n\n[[深い]] を見る\n"],
        ["notes/sub/deep.md", "# 深い\n"],
        ["notes/big.md", `# 大きい\n${"あ".repeat(2000)}\n`],
        [longName, "# 長い名前\n"],
      ]),
    );
    const api = createGitHubApi({ KB_REPO: REPO, KB_BRANCH: "main", KB_DIR: "notes", GITHUB_TOKEN: "t" }, gh.fetch);
    const calls: string[] = [];
    const source = new ApiSource(async (input, init) => {
      calls.push(urlOf(input));
      return api(new Request(new URL(urlOf(input), "http://localhost"), init));
    });
    const reads = () => calls.filter((u) => u.startsWith("/api/pages/"));
    return { gh, calls, source, reads };
  }

  it("初回は tarball で全件を取り、2回目は変わったものだけ /api/pages/<path> で読む", async () => {
    const { gh, calls, source, reads } = setup();
    const store = new MemoryStore();
    const first = await (await Kb.open(store)).sync(source);
    expect(first.fetched).toHaveLength(4);
    expect(calls).toEqual(["/api/pages", "/api/archive"]);
    // GitHub の Contents API は一度も呼ばない
    expect(gh.calls.filter((c) => c.url.includes("/contents/"))).toEqual([]);
    // 控えの sha は一覧（Trees API）の sha と同じ
    const listed = await source.list();
    const stored = new Map((await store.all()).map((f) => [f.path, f.sha]));
    expect(stored).toEqual(new Map(listed.map((p) => [p.path, p.sha])));

    const kb = await Kb.open(store);
    expect(kb.index.resolve("深い")?.[0]).toBe("deep");
    expect(kb.index.get("big")?.title).toBe("大きい");
    expect(kb.index.resolve("長い名前")?.[1].path).toBe(longName);
    expect((await kb.page("2026-01-25"))?.body).toContain("[[深い]] を見る");

    // 2回目: 1件書き換え、1件足し、1件消す
    gh.files.set("notes/sub/deep.md", "# 深い\n\n書き換えた\n");
    gh.files.set("notes/new.md", "# 新しい\n");
    gh.files.delete("notes/big.md");
    calls.length = 0;
    const second = await kb.sync(source);
    expect(calls.filter((u) => u === "/api/archive")).toEqual([]);
    expect(reads().sort()).toEqual(["/api/pages/notes/new.md", "/api/pages/notes/sub/deep.md"]);
    expect(second.removed).toEqual(["notes/big.md"]);
    expect((await kb.page("深い"))?.body).toContain("書き換えた");
    expect(kb.index.get("new")?.title).toBe("新しい");
    expect(kb.index.get("big")).toBeUndefined();
  });

  it("一覧と tarball の間に1件変わったら、そのファイルだけ /api/pages/<path> で読み、新しい中身と sha を控える", async () => {
    const { gh, source, reads } = setup();
    gh.beforeTarball = () => {
      gh.files.set("notes/sub/deep.md", "# 深い\n\n後で変わった\n");
    };
    const store = new MemoryStore();
    const kb = await Kb.open(store);
    await kb.sync(source);
    expect(reads()).toEqual(["/api/pages/notes/sub/deep.md"]);
    const stored = await store.get("notes/sub/deep.md");
    expect(stored?.content).toBe("# 深い\n\n後で変わった\n");
    expect(stored?.sha).toBe(await blobShaOf(new TextEncoder().encode("# 深い\n\n後で変わった\n")));
    expect(kb.index.size).toBe(4);
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
