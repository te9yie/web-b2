// /api/* のパスの扱い。Worker とローカルモードで同じ規則にする（SPEC.md「API」）。
// <path> はリポジトリのルートからのパスで、区切りごとに URL エンコードされている

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// URL のパスの残りをリポジトリ内の相対パスの区切りに分ける。ルートの外に出るものと、
// ドットで始まる区切り（.git、.github など）は拒否する
export function splitPath(rest: string): string[] {
  const segments = rest.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      throw new ApiError(400, "パスを解釈できない");
    }
  });
  for (const s of segments) {
    // %2F や %5C を戻すと区切りになるので、戻したあとで調べる
    if (s === "" || s === "." || s === ".." || /[/\\\0]/.test(s)) throw new ApiError(400, "不正なパス");
    if (s.startsWith(".")) throw new ApiError(400, "ドットで始まる名前は扱わない");
  }
  return segments;
}

// ページとして読み書きしてよいのは KB_DIR の下の .md だけ
export function pageSegments(rest: string, dir: string): string[] {
  const dirSegments = dir.split("/").filter((s) => s !== "");
  const segments = splitPath(rest);
  const inDir = dirSegments.every((s, i) => segments[i] === s) && segments.length > dirSegments.length;
  if (!inDir || !segments[segments.length - 1].endsWith(".md")) {
    throw new ApiError(400, `${dir} の下の .md ではない`);
  }
  return segments;
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

// 添付ファイルの content-type。拡張子で決める。分からなければ octet-stream
export function contentTypeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot).toLowerCase();
  return contentTypes[ext] ?? "application/octet-stream";
}

// Git の blob の SHA-1 と同じ値（`blob <バイト数>\0` と中身）。WebCrypto で計算する
export async function blobShaOf(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header, 0);
  all.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
