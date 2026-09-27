// Worker の /api/*。ローカルモード（src/server/local.ts）と同じ形で返す（SPEC.md「API」）。GitHub への中継だけを行う

import { ApiError, blobShaOf, contentTypeOf, json, pageSegments, splitPath } from "../shared/api-path.ts";
import { GitHub, GitHubError } from "./github.ts";

export interface GitHubEnv {
  KB_REPO?: string;
  KB_BRANCH?: string;
  KB_DIR?: string;
  GITHUB_TOKEN?: string;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function createGitHubApi(env: GitHubEnv, fetchFn: typeof fetch = (input, init) => fetch(input, init)) {
  const dir = env.KB_DIR || "notes";
  const dirPrefix = dir === "" ? "" : `${dir}/`;

  function client(): GitHub {
    if (!env.KB_REPO || !env.GITHUB_TOKEN) throw new ApiError(500, "KB_REPO か GITHUB_TOKEN が設定されていない");
    return new GitHub({ repo: env.KB_REPO, branch: env.KB_BRANCH || "main", token: env.GITHUB_TOKEN }, fetchFn);
  }

  // 一覧。Trees API で全ファイルの sha を取り、KB_DIR の下の .md だけ返す。head はブランチの先頭のコミット（tarball を同じ版に固定するため）
  async function listPages(gh: GitHub): Promise<Response> {
    const head = await gh.head();
    const { entries, truncated } = await gh.tree(head.tree);
    if (truncated) throw new ApiError(502, "GitHub: ツリーが大きすぎて一覧を取り切れない");
    const pages = entries
      .filter((e) => e.type === "blob" && e.path.startsWith(dirPrefix) && e.path.endsWith(".md"))
      .map((e) => ({ path: e.path, sha: e.sha }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return json({ pages, dir, head: head.commit });
  }

  async function getPage(gh: GitHub, path: string): Promise<Response> {
    const file = await gh.read(path);
    if (!file) throw new ApiError(404, "ファイルがない");
    return json({ path, sha: file.sha, content: decoder.decode(file.bytes) });
  }

  // 書き込み。GitHub が 409/422（sha の不一致、sha なしで既存）を返したら、いまの中身を取って 409 で返す（SPEC.md「API」）
  async function putPage(gh: GitHub, path: string, req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new ApiError(400, "本文がJSONではない");
    }
    const { content, sha, message } = (body as { content?: unknown; sha?: unknown; message?: unknown } | null) ?? {};
    if (typeof content !== "string") throw new ApiError(400, "content がない");
    if (sha !== undefined && sha !== null && typeof sha !== "string") throw new ApiError(400, "sha が文字列でない");
    const bytes = encoder.encode(content);
    const result = await gh.write(path, bytes, typeof sha === "string" ? sha : null, typeof message === "string" && message !== "" ? message : `web: ${path}`);
    if ("conflict" in result) {
      const current = await gh.read(path);
      // 正しい sha なのに 409 になることがある（ref の更新の競り合い）。同じ sha ならもう一度だけ試す
      if (current && typeof sha === "string" && current.sha === sha) {
        const retry = await gh.write(path, bytes, sha, typeof message === "string" ? message : `web: ${path}`);
        if (!("conflict" in retry)) return json({ path, sha: retry.sha });
      }
      return json(
        { error: current ? "競合: ファイルが変わっている" : "競合: ファイルが消えている", current: current ? { path, sha: current.sha, content: decoder.decode(current.bytes) } : null },
        409,
      );
    }
    return json({ path, sha: result.sha });
  }

  async function getFile(gh: GitHub, segments: string[]): Promise<Response> {
    const res = await gh.raw(segments.join("/"));
    if (!res) throw new ApiError(404, "ファイルがない");
    return new Response(res.body, {
      headers: { "content-type": contentTypeOf(segments[segments.length - 1]), "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600" },
    });
  }

  // tarball。初回の取り込みに使う。x-head にブランチの先頭のコミットを付ける
  async function getArchive(gh: GitHub): Promise<Response> {
    const head = await gh.head();
    const res = await gh.tarball();
    return new Response(res.body, { headers: { "content-type": "application/gzip", "x-head": head.commit } });
  }

  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    try {
      const gh = client();
      if (pathname === "/api/pages") {
        if (req.method !== "GET") throw new ApiError(405, "GETだけ");
        return await listPages(gh);
      }
      if (pathname.startsWith("/api/pages/")) {
        const path = pageSegments(pathname.slice("/api/pages/".length), dir).join("/");
        if (req.method === "GET") return await getPage(gh, path);
        if (req.method === "PUT") return await putPage(gh, path, req);
        throw new ApiError(405, "GETとPUTだけ");
      }
      if (pathname.startsWith("/api/files/")) {
        if (req.method !== "GET") throw new ApiError(405, "GETだけ");
        return await getFile(gh, splitPath(pathname.slice("/api/files/".length)));
      }
      if (pathname === "/api/archive") {
        if (req.method !== "GET") throw new ApiError(405, "GETだけ");
        return await getArchive(gh);
      }
      throw new ApiError(404, "そのAPIはない");
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.message }, e.status);
      if (e instanceof GitHubError) return json({ error: e.message }, e.status === 401 || e.status === 403 ? 502 : e.status >= 500 ? 502 : 502);
      throw e;
    }
  };
}

export { blobShaOf };
