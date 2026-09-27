// ローカルモードの /api/*。KB_ROOT のディレクトリを直接読み書きし、Workerと同じ形で返す。
// Request を受けて Response を返す関数にしておき、Viteの開発サーバーにもテストにもそのまま渡す。
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { ApiError, contentTypeOf, json, pageSegments, splitPath } from "../shared/api-path.ts";

export interface LocalOptions {
  // 知識庫のリポジトリのルートにあたるディレクトリ
  root: string;
  // ページを置くディレクトリ。root からの相対パス
  dir: string;
}

// GitHubのblobのSHAと同じ値。ローカルモードでも同じ方法で競合を見分けられるようにする。
export function blobSha(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

function isNotFound(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

export function createLocalApi({ root, dir }: LocalOptions): (req: Request) => Promise<Response> {
  const dirSegments = dir.split("/").filter((s) => s !== "");

  const pagePath = (rest: string) => pageSegments(rest, dir);

  async function listPages(): Promise<Response> {
    const base = join(root, ...dirSegments);
    const entries = await readdir(base, { recursive: true, withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => join(e.parentPath, e.name));
    // 一度に開くファイルの数を抑える。1万件を同時に開くと EMFILE になる
    const pages: { path: string; sha: string }[] = [];
    for (let i = 0; i < files.length; i += 64) {
      pages.push(
        ...(await Promise.all(
          files.slice(i, i + 64).map(async (file) => ({
            path: relative(root, file).split(sep).join("/"),
            sha: blobSha(await readFile(file)),
          })),
        )),
      );
    }
    pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return json({ pages, dir: dirSegments.join("/") });
  }

  async function getPage(segments: string[]): Promise<Response> {
    const content = await readFile(join(root, ...segments));
    return json({ path: segments.join("/"), sha: blobSha(content), content: content.toString("utf8") });
  }

  async function putPage(segments: string[], req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new ApiError(400, "本文がJSONではない");
    }
    const { content, sha } = (body as { content?: unknown; sha?: unknown } | null) ?? {};
    if (typeof content !== "string") throw new ApiError(400, "content がない");
    if (sha !== undefined && sha !== null && typeof sha !== "string") throw new ApiError(400, "sha が文字列でない");
    const path = segments.join("/");
    const file = join(root, ...segments);

    // 競合の検出（SPEC.md「API」）。sha がいまのファイルと違うとき、null なのにファイルがあるときは書かずに 409 で相手の内容を返す
    let current: Buffer | null = null;
    try {
      current = await readFile(file);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    if (current !== null) {
      const currentSha = blobSha(current);
      if (sha === null || sha === undefined || sha !== currentSha) {
        return json({ error: "競合: ファイルが変わっている", current: { path, sha: currentSha, content: current.toString("utf8") } }, 409);
      }
    } else if (sha !== null && sha !== undefined) {
      return json({ error: "競合: ファイルが消えている", current: null }, 409);
    }

    await mkdir(dirname(file), { recursive: true });
    const bytes = Buffer.from(content, "utf8");
    await writeFile(file, bytes);
    return json({ path, sha: blobSha(bytes) });
  }

  async function getFile(segments: string[]): Promise<Response> {
    const content = await readFile(join(root, ...segments));
    const type = contentTypeOf(segments[segments.length - 1]);
    return new Response(new Uint8Array(content), {
      headers: { "content-type": type, "x-content-type-options": "nosniff" },
    });
  }

  return async (req) => {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === "/api/pages") {
        if (req.method !== "GET") throw new ApiError(405, "GETだけ");
        return await listPages();
      }
      if (pathname.startsWith("/api/pages/")) {
        const segments = pagePath(pathname.slice("/api/pages/".length));
        if (req.method === "GET") return await getPage(segments);
        if (req.method === "PUT") return await putPage(segments, req);
        throw new ApiError(405, "GETとPUTだけ");
      }
      if (pathname.startsWith("/api/files/")) {
        if (req.method !== "GET") throw new ApiError(405, "GETだけ");
        return await getFile(splitPath(pathname.slice("/api/files/".length)));
      }
      throw new ApiError(404, "そのAPIはない");
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.message }, e.status);
      if (isNotFound(e)) return json({ error: "ファイルがない" }, 404);
      throw e;
    }
  };
}
