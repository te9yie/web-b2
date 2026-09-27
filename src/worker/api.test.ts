import { describe, expect, it } from "vitest";
import { blobShaOf } from "../shared/api-path";
import { createGitHubApi } from "./api";
import { decodeBase64, encodeBase64 } from "./github";

const REPO = "owner/kb";
const env = { KB_REPO: REPO, KB_BRANCH: "main", KB_DIR: "notes", GITHUB_TOKEN: "t0ken" };
const base = `https://api.github.com/repos/${REPO}`;

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) => encodeBase64(utf8(s));

// GitHub の代わり。ファイルの中身を持ち、呼ばれた URL と本文を記録する
class FakeGitHub {
  readonly calls: { method: string; url: string; body?: unknown; headers: Headers }[] = [];
  head = "c0mm1t";
  truncated = false;
  // PUT を強制的に 409 にする回数（ref の競り合いの模擬）
  spuriousConflicts = 0;
  constructor(readonly files: Map<string, string>) {}

  private async sha(content: string): Promise<string> {
    return blobShaOf(utf8(content));
  }

  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, url, body, headers });
    const u = new URL(url);
    const path = u.pathname.slice(`/repos/${REPO}`.length);

    if (path === "/branches/main") return Response.json({ commit: { sha: this.head, commit: { tree: { sha: "tr33" } } } });
    if (path === "/git/trees/tr33") {
      const tree = await Promise.all([...this.files].map(async ([p, c]) => ({ path: p, type: "blob", sha: await this.sha(c) })));
      tree.push({ path: "notes", type: "tree", sha: "d1r" });
      return Response.json({ sha: "tr33", tree, truncated: this.truncated });
    }
    if (path === "/tarball/main") return new Response("TARBALL", { status: 200 });
    if (path.startsWith("/contents/")) {
      const file = decodeURIComponent(path.slice("/contents/".length));
      if (method === "GET") {
        const content = this.files.get(file);
        if (content === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
        if (headers.get("accept") === "application/vnd.github.raw+json") return new Response(content, { headers: { "content-type": "text/plain" } });
        // 大きいファイルは content を返さない
        if (content.length > 1000) return Response.json({ sha: await this.sha(content), type: "file", encoding: "none", content: "" });
        return Response.json({ sha: await this.sha(content), type: "file", encoding: "base64", content: `${b64(content).slice(0, 60)}\n${b64(content).slice(60)}` });
      }
      if (method === "PUT") {
        if (this.spuriousConflicts > 0) {
          this.spuriousConflicts--;
          return Response.json({ message: "conflict" }, { status: 409 });
        }
        const current = this.files.get(file);
        const currentSha = current === undefined ? null : await this.sha(current);
        if (current !== undefined && body.sha === undefined) return Response.json({ message: "sha wasn't supplied" }, { status: 422 });
        if (current !== undefined && body.sha !== currentSha) return Response.json({ message: "does not match" }, { status: 409 });
        if (current === undefined && body.sha !== undefined) return Response.json({ message: "Not Found" }, { status: 404 });
        const next = new TextDecoder().decode(decodeBase64(body.content));
        this.files.set(file, next);
        return Response.json({ content: { sha: await this.sha(next) }, commit: { sha: "n3w" } }, { status: current === undefined ? 201 : 200 });
      }
    }
    if (path.startsWith("/git/blobs/")) {
      for (const c of this.files.values()) if ((await this.sha(c)) === path.slice("/git/blobs/".length)) return Response.json({ content: b64(c), encoding: "base64" });
    }
    return Response.json({ message: "unexpected" }, { status: 500 });
  };
}

function setup() {
  const gh = new FakeGitHub(
    new Map([
      ["notes/2026-01-25.md", "---\ncreated: 2026-01-25\n---\n\n# 2026-01-25\n\n日付ページ\n"],
      ["notes/sub/deep.md", "# 深い\n"],
      ["notes/img/dot.png", "PNG"],
      ["README.md", "# readme\n"],
      ["notes/big.md", `# 大きい\n${"あ".repeat(2000)}\n`],
    ]),
  );
  const api = createGitHubApi(env, gh.fetch);
  const call = (path: string, init?: RequestInit) => api(new Request(`http://localhost${path}`, init));
  return { gh, api, call };
}

describe("GET /api/pages", () => {
  it("Trees API で KB_DIR の下の .md だけをパス順に返し、dir と head を添える", async () => {
    const { gh, call } = setup();
    const res = await call("/api/pages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pages: { path: string; sha: string }[]; dir: string; head: string };
    expect(body.pages.map((p) => p.path)).toEqual(["notes/2026-01-25.md", "notes/big.md", "notes/sub/deep.md"]);
    expect(body.pages[0].sha).toBe(await blobShaOf(utf8(gh.files.get("notes/2026-01-25.md")!)));
    expect(body.dir).toBe("notes");
    expect(body.head).toBe("c0mm1t");
    // 認証と版のヘッダーを付ける
    const first = gh.calls[0];
    expect(first.headers.get("authorization")).toBe("Bearer t0ken");
    expect(first.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(gh.calls.map((c) => new URL(c.url).pathname)).toEqual([`/repos/${REPO}/branches/main`, `/repos/${REPO}/git/trees/tr33`]);
  });

  it("ツリーが切れていたら 502", async () => {
    const { gh, call } = setup();
    gh.truncated = true;
    const res = await call("/api/pages");
    expect(res.status).toBe(502);
  });

  it("KB_REPO か GITHUB_TOKEN がなければ 500", async () => {
    const api = createGitHubApi({ KB_REPO: REPO }, async () => new Response(""));
    const res = await api(new Request("http://localhost/api/pages"));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("GITHUB_TOKEN");
  });
});

describe("GET /api/pages/<path>", () => {
  it("Contents API の base64 を戻して中身と sha を返す。日本語の名前と大きいファイルも", async () => {
    const { gh, call } = setup();
    const res = await call("/api/pages/notes/2026-01-25.md");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; sha: string; content: string };
    expect(body.content).toBe(gh.files.get("notes/2026-01-25.md"));
    expect(body.sha).toBe(await blobShaOf(utf8(body.content)));
    // 大きいファイルは blob を取る
    const big = (await (await call("/api/pages/notes/big.md")).json()) as { content: string };
    expect(big.content).toBe(gh.files.get("notes/big.md"));
    expect(gh.calls.some((c) => c.url.includes("/git/blobs/"))).toBe(true);
  });

  it("ないファイルは 404。KB_DIR の外や .md 以外、ドットで始まる区切りは 400", async () => {
    const { call } = setup();
    expect((await call("/api/pages/notes/nothing.md")).status).toBe(404);
    expect((await call("/api/pages/README.md")).status).toBe(400);
    expect((await call("/api/pages/notes/img/dot.png")).status).toBe(400);
    expect((await call("/api/pages/notes/.git/config.md")).status).toBe(400);
    expect((await call("/api/files/.github/workflows/x.yml")).status).toBe(400);
  });
});

describe("PUT /api/pages/<path>", () => {
  const put = (call: ReturnType<typeof setup>["call"], path: string, body: unknown) =>
    call(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("いまの sha を添えて書き換えると、新しい sha を返し、コミットメッセージとブランチを渡す", async () => {
    const { gh, call } = setup();
    const before = (await (await call("/api/pages/notes/2026-01-25.md")).json()) as { sha: string };
    const res = await put(call, "/api/pages/notes/2026-01-25.md", { content: "# 2026-01-25\n\n書き換えた\n", sha: before.sha, message: "web: 2026-01-25" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "notes/2026-01-25.md", sha: await blobShaOf(utf8("# 2026-01-25\n\n書き換えた\n")) });
    expect(gh.files.get("notes/2026-01-25.md")).toBe("# 2026-01-25\n\n書き換えた\n");
    const putCall = gh.calls.find((c) => c.method === "PUT")!;
    expect(putCall.body).toMatchObject({ message: "web: 2026-01-25", branch: "main", sha: before.sha });
    expect(new URL(putCall.url).search).toBe("");
  });

  it("sha が null なら新しいファイルを作る（201）。日本語の名前はエンコードする", async () => {
    const { gh, call } = setup();
    const res = await put(call, `/api/pages/notes/${encodeURIComponent("新しい.md")}`, { content: "# 新しい\n", sha: null, message: "web: 新しい" });
    expect(res.status).toBe(200);
    expect(gh.files.get("notes/新しい.md")).toBe("# 新しい\n");
    expect(gh.calls.find((c) => c.method === "PUT")!.url).toContain(`/contents/notes/${encodeURIComponent("新しい.md")}`);
  });

  it("sha が違えば GitHub の 409 を、いまの中身つきの 409 に写す", async () => {
    const { gh, call } = setup();
    const res = await put(call, "/api/pages/notes/2026-01-25.md", { content: "自分\n", sha: "0000000000000000000000000000000000000000", message: "m" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; current: { path: string; sha: string; content: string } };
    expect(body.current.content).toBe(gh.files.get("notes/2026-01-25.md"));
    expect(body.current.path).toBe("notes/2026-01-25.md");
    expect(gh.files.get("notes/2026-01-25.md")).not.toBe("自分\n");
  });

  it("sha なしで既存（GitHub は 422）も 409。消えたファイルに sha を添えた（GitHub は 404）は current: null", async () => {
    const { call } = setup();
    const exists = await put(call, "/api/pages/notes/2026-01-25.md", { content: "x", sha: null, message: "m" });
    expect(exists.status).toBe(409);
    expect(((await exists.json()) as { current: unknown }).current).not.toBeNull();
    const gone = await put(call, "/api/pages/notes/gone.md", { content: "x", sha: "0000000000000000000000000000000000000000", message: "m" });
    expect(gone.status).toBe(409);
    expect(((await gone.json()) as { current: unknown }).current).toBeNull();
  });

  it("正しい sha なのに 409 が返ったら（ref の競り合い）一度だけ試し直す", async () => {
    const { gh, call } = setup();
    gh.spuriousConflicts = 1;
    const before = (await (await call("/api/pages/notes/2026-01-25.md")).json()) as { sha: string };
    const res = await put(call, "/api/pages/notes/2026-01-25.md", { content: "二度目\n", sha: before.sha, message: "m" });
    expect(res.status).toBe(200);
    expect(gh.files.get("notes/2026-01-25.md")).toBe("二度目\n");
    expect(gh.calls.filter((c) => c.method === "PUT").length).toBe(2);
  });

  it("本文が JSON でない、content がない、KB_DIR の外は 400", async () => {
    const { call } = setup();
    expect((await call("/api/pages/notes/a.md", { method: "PUT", body: "x" })).status).toBe(400);
    expect((await put(call, "/api/pages/notes/a.md", { sha: null })).status).toBe(400);
    expect((await put(call, "/api/pages/README.md", { content: "x", sha: null })).status).toBe(400);
  });
});

describe("GET /api/files/<path> と /api/archive", () => {
  it("添付ファイルを raw で流し、拡張子で content-type を決める", async () => {
    const { gh, call } = setup();
    const res = await call("/api/files/notes/img/dot.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("PNG");
    expect(gh.calls[0].headers.get("accept")).toBe("application/vnd.github.raw+json");
    expect((await call("/api/files/notes/img/none.png")).status).toBe(404);
  });

  it("tarball を流し、x-head に先頭のコミットを付ける", async () => {
    const { call } = setup();
    const res = await call("/api/archive");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("x-head")).toBe("c0mm1t");
    expect(await res.text()).toBe("TARBALL");
  });

  it("GitHub が落ちていれば 502。知らない API は 404。PUT 以外の書き込みは 405", async () => {
    const api = createGitHubApi(env, async () => Response.json({ message: "bad" }, { status: 500 }));
    expect((await api(new Request("http://localhost/api/pages"))).status).toBe(502);
    const { call } = setup();
    expect((await call("/api/nothing")).status).toBe(404);
    expect((await call("/api/pages", { method: "POST" })).status).toBe(405);
  });
});

describe("base64", () => {
  it("UTF-8 の往復", () => {
    const s = "日本語と emoji 🎉 と改行\n";
    expect(new TextDecoder().decode(decodeBase64(encodeBase64(utf8(s))))).toBe(s);
    // GitHub の content は途中に改行が入る
    expect(new TextDecoder().decode(decodeBase64("YW\nJj\n"))).toBe("abc");
  });
});
