import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobSha, createLocalApi } from "./local";

// fixtures/ を書き換えないよう、テストごとに一時ディレクトリへ写してから使う
let root: string;
let api: (req: Request) => Promise<Response>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "web-b2-"));
  await cp("fixtures", root, { recursive: true });
  api = createLocalApi({ root, dir: "notes" });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function call(path: string, init?: RequestInit): Promise<Response> {
  return api(new Request(`http://localhost${path}`, init));
}

function put(path: string, body: unknown): Promise<Response> {
  return call(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("blobSha", () => {
  it("git hash-object と同じ値になる", () => {
    const content = Buffer.from("# 見本\n\n本文\n", "utf8");
    const expected = execFileSync("git", ["hash-object", "--stdin"], { input: content }).toString().trim();
    expect(blobSha(content)).toBe(expected);
  });
});

describe("GET /api/pages", () => {
  it("KB_DIR の下の .md をパス順に列挙し、添付ファイルは含めない", async () => {
    const res = await call("/api/pages");
    expect(res.status).toBe(200);
    const { pages } = (await res.json()) as { pages: { path: string; sha: string }[] };
    const paths = pages.map((p) => p.path);
    expect(paths).toHaveLength(16);
    // 新しいページの置き場（KB_DIR）も返す
    expect(((await (await call("/api/pages")).json()) as { dir: string }).dir).toBe("notes");
    expect(paths[0]).toBe("notes/2026-01-05-settings.md");
    expect(paths).toContain("notes/2026-01-26-143210.md");
    expect(paths).not.toContain("notes/img/dot.png");
    expect([...paths].sort()).toEqual(paths);
    for (const p of pages) expect(p.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("ドットで始まる区切りを含むパスは 400（Worker と同じ）", async () => {
    expect((await call("/api/pages/notes/.git/config.md")).status).toBe(400);
    expect((await call("/api/files/.github/workflows/x.yml")).status).toBe(400);
    expect((await put("/api/pages/notes/.hidden.md", { content: "x", sha: null })).status).toBe(400);
  });

  it("サブディレクトリの .md も列挙する", async () => {
    await put("/api/pages/notes/sub/deep.md", { content: "# 深い\n" });
    const { pages } = (await (await call("/api/pages")).json()) as { pages: { path: string }[] };
    expect(pages.map((p) => p.path)).toContain("notes/sub/deep.md");
  });
});

describe("GET /api/pages/<path>", () => {
  it("中身とSHAを返す", async () => {
    const res = await call("/api/pages/notes/2026-01-25.md");
    expect(res.status).toBe(200);
    const page = (await res.json()) as { path: string; sha: string; content: string };
    const raw = await readFile(join(root, "notes/2026-01-25.md"));
    expect(page).toEqual({ path: "notes/2026-01-25.md", sha: blobSha(raw), content: raw.toString("utf8") });
  });

  it("ないページは404", async () => {
    expect((await call("/api/pages/notes/nothing.md")).status).toBe(404);
  });

  it("KB_DIR の外や .md 以外は400", async () => {
    expect((await call("/api/pages/README.md")).status).toBe(400);
    expect((await call("/api/pages/notes/img/dot.png")).status).toBe(400);
    expect((await call("/api/pages/notes/%2E%2E/README.md")).status).toBe(400);
  });
});

describe("PUT /api/pages/<path>", () => {
  it("既存のページを、いまの sha を添えて書き換え、新しいSHAを返す", async () => {
    const { sha } = (await (await call("/api/pages/notes/2026-01-25.md")).json()) as { sha: string };
    const content = "---\ncreated: 2026-01-25\nupdated: 2026-01-26\n---\n\n# 2026-01-25\n\n書き換えた\n";
    const res = await put("/api/pages/notes/2026-01-25.md", { content, sha });
    expect(res.status).toBe(200);
    const saved = await readFile(join(root, "notes/2026-01-25.md"));
    expect(saved.toString("utf8")).toBe(content);
    expect(await res.json()).toEqual({ path: "notes/2026-01-25.md", sha: blobSha(saved) });
  });

  it("裏で変わったファイルへの保存は 409 で拒み、相手の内容を返し、ファイルは変えない", async () => {
    const path = "notes/2026-01-25.md";
    const { sha: mine } = (await (await call(`/api/pages/${path}`)).json()) as { sha: string };
    // 別のツールが同じファイルを変えた
    const theirs = "---\ncreated: 2026-01-25\nupdated: 2026-01-27\n---\n\n# 2026-01-25\n\n相手が書いた\n";
    await writeFile(join(root, path), theirs, "utf8");
    const res = await put(`/api/pages/${path}`, { content: "自分が書いた\n", sha: mine });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; current: { path: string; sha: string; content: string } };
    expect(body.error).toContain("競合");
    // 両方の内容: 相手の内容は本文で返り、自分の内容は送った側が持っている。ファイルは相手のまま
    expect(body.current).toEqual({ path, sha: blobSha(Buffer.from(theirs, "utf8")), content: theirs });
    expect((await readFile(join(root, path))).toString("utf8")).toBe(theirs);
    // 相手の sha を添えれば書ける
    const retry = await put(`/api/pages/${path}`, { content: "自分が書いた\n", sha: body.current.sha });
    expect(retry.status).toBe(200);
  });

  it("sha が null（新しいページ）なのにファイルがあれば 409。ファイルがないのに sha があれば 409", async () => {
    const res = await put("/api/pages/notes/2026-01-25.md", { content: "x", sha: null });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { current: { path: string } }).current.path).toBe("notes/2026-01-25.md");
    const gone = await put("/api/pages/notes/nothing.md", { content: "x", sha: "0000000000000000000000000000000000000000" });
    expect(gone.status).toBe(409);
    expect(((await gone.json()) as { current: null }).current).toBeNull();
    const fresh = await put("/api/pages/notes/nothing.md", { content: "x", sha: null });
    expect(fresh.status).toBe(200);
  });

  it("日本語のファイル名で新しいページを作り、取得できる", async () => {
    const path = `/api/pages/notes/${encodeURIComponent("新しいページ.md")}`;
    expect((await put(path, { content: "# 新しいページ\n" })).status).toBe(200);
    const page = (await (await call(path)).json()) as { path: string; content: string };
    expect(page.path).toBe("notes/新しいページ.md");
    expect(page.content).toBe("# 新しいページ\n");
  });

  it("content がなければ書き込まず400", async () => {
    expect((await put("/api/pages/notes/2026-01-25.md", {})).status).toBe(400);
    expect((await call("/api/pages/notes/2026-01-25.md", { method: "PUT", body: "not json" })).status).toBe(400);
  });

  it("KB_DIR の外には書き込まない", async () => {
    expect((await put("/api/pages/outside.md", { content: "x" })).status).toBe(400);
    expect((await put("/api/pages/notes/..%2Foutside.md", { content: "x" })).status).toBe(400);
  });
});

describe("GET /api/files/<path>", () => {
  it("添付ファイルをそのまま返す", async () => {
    const res = await call("/api/files/notes/img/dot.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const expected = await readFile(join(root, "notes/img/dot.png"));
    expect(Buffer.from(await res.arrayBuffer()).equals(expected)).toBe(true);
  });

  it("ないファイルは404、ルートの外は400", async () => {
    expect((await call("/api/files/notes/img/none.png")).status).toBe(404);
    expect((await call("/api/files/notes%2F..%2F..%2Fpackage.json")).status).toBe(400);
  });
});

describe("そのほか", () => {
  it("知らないAPIは404、許していないメソッドは405", async () => {
    expect((await call("/api/nothing")).status).toBe(404);
    expect((await call("/api/pages", { method: "POST" })).status).toBe(405);
    expect((await call("/api/pages/notes/2026-01-25.md", { method: "DELETE" })).status).toBe(405);
  });
});
