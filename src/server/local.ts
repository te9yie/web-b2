// ローカルモードの /api/*。KB_ROOT のディレクトリを直接読み書きし、Workerと同じ形で返す。
// Request を受けて Response を返す関数にしておき、Viteの開発サーバーにもテストにもそのまま渡す。
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";

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

const contentTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// URLのパスの残りをリポジトリ内の相対パスの区切りに分ける。ルートの外に出るものは拒否する。
function splitPath(rest: string): string[] {
  const segments = rest.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      throw new HttpError(400, "パスを解釈できない");
    }
  });
  for (const s of segments) {
    // %2F や %5C を戻すと区切りになるので、戻したあとで調べる
    if (s === "" || s === "." || s === ".." || /[/\\\0]/.test(s)) {
      throw new HttpError(400, "不正なパス");
    }
  }
  return segments;
}

function isNotFound(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

export function createLocalApi({ root, dir }: LocalOptions): (req: Request) => Promise<Response> {
  const dirSegments = dir.split("/").filter((s) => s !== "");

  // ページとして読み書きしてよいのは KB_DIR の下の .md だけ
  function pagePath(rest: string): string[] {
    const segments = splitPath(rest);
    const inDir = dirSegments.every((s, i) => segments[i] === s) && segments.length > dirSegments.length;
    if (!inDir || !segments[segments.length - 1].endsWith(".md")) {
      throw new HttpError(400, `${dir} の下の .md ではない`);
    }
    return segments;
  }

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
      throw new HttpError(400, "本文がJSONではない");
    }
    const content = (body as { content?: unknown } | null)?.content;
    if (typeof content !== "string") throw new HttpError(400, "content がない");
    const file = join(root, ...segments);
    await mkdir(dirname(file), { recursive: true });
    const bytes = Buffer.from(content, "utf8");
    await writeFile(file, bytes);
    return json({ path: segments.join("/"), sha: blobSha(bytes) });
  }

  async function getFile(segments: string[]): Promise<Response> {
    const content = await readFile(join(root, ...segments));
    const type = contentTypes[extname(segments[segments.length - 1]).toLowerCase()] ?? "application/octet-stream";
    return new Response(new Uint8Array(content), {
      headers: { "content-type": type, "x-content-type-options": "nosniff" },
    });
  }

  return async (req) => {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === "/api/pages") {
        if (req.method !== "GET") throw new HttpError(405, "GETだけ");
        return await listPages();
      }
      if (pathname.startsWith("/api/pages/")) {
        const segments = pagePath(pathname.slice("/api/pages/".length));
        if (req.method === "GET") return await getPage(segments);
        if (req.method === "PUT") return await putPage(segments, req);
        throw new HttpError(405, "GETとPUTだけ");
      }
      if (pathname.startsWith("/api/files/")) {
        if (req.method !== "GET") throw new HttpError(405, "GETだけ");
        return await getFile(splitPath(pathname.slice("/api/files/".length)));
      }
      throw new HttpError(404, "そのAPIはない");
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (isNotFound(e)) return json({ error: "ファイルがない" }, 404);
      throw e;
    }
  };
}
