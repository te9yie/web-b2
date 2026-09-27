// GitHub の REST API の薄い包み。Worker が知識庫のリポジトリを読み書きするのに使う。
// 一覧は Trees API（全ファイルの blob の sha を一度に取る）、ページと添付は Contents API、書き込みは Contents API の PUT、
// 初回の取り込みは tarball（DECISIONS.md 2026-09-27「差分は Trees API の一覧で取り、初回は tarball」）

export interface GitHubConfig {
  // owner/repo
  repo: string;
  branch: string;
  token: string;
}

export interface TreeEntry {
  path: string;
  sha: string;
  type: string;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// UTF-8 の文字列と base64 の相互変換。GitHub の content は base64 で、60文字ごとに改行が入る
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class GitHub {
  constructor(
    private readonly config: GitHubConfig,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private url(path: string): string {
    return `https://api.github.com/repos/${this.config.repo}${path}`;
  }

  private async request(path: string, init: RequestInit = {}, accept = "application/vnd.github+json"): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.config.token}`);
    headers.set("accept", accept);
    headers.set("x-github-api-version", "2022-11-28");
    headers.set("user-agent", "web-b2");
    return this.fetchFn(this.url(path), { ...init, headers });
  }

  private async json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) throw new GitHubError(res.status, `GitHub: ${what}が ${res.status}`);
    return (await res.json()) as T;
  }

  // ブランチの先頭のコミットと、そのツリー
  async head(): Promise<{ commit: string; tree: string }> {
    const res = await this.request(`/branches/${encodeURIComponent(this.config.branch)}`);
    const body = await this.json<{ commit: { sha: string; commit: { tree: { sha: string } } } }>(res, "ブランチの取得");
    return { commit: body.commit.sha, tree: body.commit.commit.tree.sha };
  }

  // ツリーの全エントリ（再帰）。GitHub は 10万件・7MB を超えると truncated にする
  async tree(treeSha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const res = await this.request(`/git/trees/${treeSha}?recursive=1`);
    const body = await this.json<{ tree: TreeEntry[]; truncated: boolean }>(res, "ツリーの取得");
    return { entries: body.tree, truncated: body.truncated };
  }

  private contentsPath(path: string): string {
    return `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(this.config.branch)}`;
  }

  // ファイルの中身と sha。1MB を超えると Contents API が中身を返さないので、blob を取る。なければ null
  async read(path: string): Promise<{ sha: string; bytes: Uint8Array } | null> {
    const res = await this.request(this.contentsPath(path));
    if (res.status === 404) return null;
    const body = await this.json<{ sha: string; encoding: string; content: string; type: string }>(res, "ファイルの取得");
    if (body.type !== "file") throw new GitHubError(400, "GitHub: ファイルではない");
    if (body.encoding === "base64") return { sha: body.sha, bytes: decodeBase64(body.content) };
    const blob = await this.request(`/git/blobs/${body.sha}`);
    const b = await this.json<{ content: string }>(blob, "blob の取得");
    return { sha: body.sha, bytes: decodeBase64(b.content) };
  }

  // 添付ファイルをそのまま流す。なければ null
  async raw(path: string): Promise<Response | null> {
    const res = await this.request(this.contentsPath(path), {}, "application/vnd.github.raw+json");
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubError(res.status, `GitHub: 添付の取得が ${res.status}`);
    return res;
  }

  // 書き込み。sha は既存のファイルのもの、新しいファイルは null。sha の不一致は 409、sha なしで既存は 422 で返る
  async write(path: string, bytes: Uint8Array, sha: string | null, message: string): Promise<{ sha: string } | { conflict: true }> {
    const res = await this.request(this.contentsPath(path).split("?")[0], {
      method: "PUT",
      body: JSON.stringify({ message, content: encodeBase64(bytes), branch: this.config.branch, ...(sha ? { sha } : {}) }),
      headers: { "content-type": "application/json" },
    });
    if (res.status === 409 || res.status === 422 || res.status === 404) return { conflict: true };
    const body = await this.json<{ content: { sha: string } }>(res, "書き込み");
    return { sha: body.content.sha };
  }

  // tarball。GitHub は codeload へ転送するので、fetch がそれを追ってくれる
  async tarball(): Promise<Response> {
    const res = await this.request(`/tarball/${encodeURIComponent(this.config.branch)}`, { redirect: "follow" });
    if (!res.ok) throw new GitHubError(res.status, `GitHub: tarball の取得が ${res.status}`);
    return res;
  }
}
