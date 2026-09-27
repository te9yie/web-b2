// テスト用の GitHub の代わり。ファイルの中身を持ち、呼ばれた URL と本文を記録する。
// tarball は持っているファイルから本物の tar.gz を作って返す
import { makeTarGz } from "../client/tar-test-helper.ts";
import { blobShaOf } from "../shared/api-path.ts";
import { decodeBase64, encodeBase64 } from "./github.ts";

export const REPO = "owner/kb";

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) => encodeBase64(utf8(s));

export class FakeGitHub {
  readonly calls: { method: string; url: string; body?: unknown; headers: Headers }[] = [];
  head = "c0mm1t";
  truncated = false;
  // PUT を強制的に 409 にする回数（ref の競り合いの模擬）
  spuriousConflicts = 0;
  // tarball を作る直前に呼ぶ（一覧と tarball の間にファイルが変わる場合の模擬）
  beforeTarball: (() => void) | null = null;
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
    if (path === "/tarball/main") {
      this.beforeTarball?.();
      const entries = [...this.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, content]) => ({ path: p, content }));
      const top = `${REPO.replace("/", "-")}-${this.head.slice(0, 7)}`;
      return new Response(makeTarGz(entries, { top, comment: this.head }), { status: 200, headers: { "content-type": "application/x-gzip" } });
    }
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
