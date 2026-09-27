// 取り込み元。ページの一覧（path と sha）と1ページの取得ができればよい。
// いまは /api/pages を使う ApiSource だけで、tarball と compare を使う取り込み元は段階6で足す。

import type { StoredFile } from "./store";

export interface WriteOptions {
  // タブを閉じるときの保存。ページが消えても送り終える
  keepalive?: boolean;
}

export interface Source {
  list(): Promise<{ path: string; sha: string }[]>;
  // ページを置くディレクトリ（KB_DIR）。新しいページのパスを組み立てるのに使う
  dir(): Promise<string>;
  // 一覧に出たあとで消えたファイルは NotFoundError を投げる。取り込みはそれを「消えた」として扱う
  read(path: string): Promise<StoredFile>;
  // 書き込み。sha は編集を始めたときの値で、新しいページは null。message はコミットメッセージ。新しい sha を返す
  write(path: string, content: string, sha: string | null, message: string, options?: WriteOptions): Promise<{ sha: string }>;
}

export class NotFoundError extends Error {}

// パスの区切りごとにURLエンコードする。SPEC.md「API」の <path> の渡し方
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function readJson(res: Response): Promise<unknown> {
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = `${res.status} ${body.error}`;
    } catch {
      // 本文がJSONでなければ状態コードだけ
    }
    if (res.status === 404) throw new NotFoundError(`APIの応答が異常: ${message}`);
    throw new Error(`APIの応答が異常: ${message}`);
  }
  return res.json();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export class ApiSource implements Source {
  // 一覧で受け取った dir。新しいページの作成で使う
  private knownDir: string | null = null;

  constructor(private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init)) {}

  async dir(): Promise<string> {
    if (this.knownDir === null) await this.list();
    return this.knownDir ?? "";
  }

  async list(): Promise<{ path: string; sha: string }[]> {
    const body = await readJson(await this.fetchFn("/api/pages"));
    const pages = isRecord(body) ? body.pages : undefined;
    if (!Array.isArray(pages)) throw new Error("APIの応答が異常: pages がない");
    if (isRecord(body) && typeof body.dir === "string") this.knownDir = body.dir;
    return pages.map((p: unknown) => {
      if (!isRecord(p) || typeof p.path !== "string" || typeof p.sha !== "string") {
        throw new Error("APIの応答が異常: 一覧の項目に path と sha がない");
      }
      return { path: p.path, sha: p.sha };
    });
  }

  // 要求した path 以外の項目は控えに入れない
  async read(path: string): Promise<StoredFile> {
    const body = await readJson(await this.fetchFn(`/api/pages/${encodePath(path)}`));
    if (!isRecord(body) || typeof body.sha !== "string" || typeof body.content !== "string") {
      throw new Error(`APIの応答が異常: ${path} の sha か content がない`);
    }
    return { path, sha: body.sha, content: body.content };
  }

  async write(path: string, content: string, sha: string | null, message: string, options: WriteOptions = {}): Promise<{ sha: string }> {
    const res = await this.fetchFn(`/api/pages/${encodePath(path)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, sha, message }),
      keepalive: options.keepalive ?? false,
    });
    const body = await readJson(res);
    if (!isRecord(body) || typeof body.sha !== "string") throw new Error(`APIの応答が異常: ${path} の書き込みで sha が返らない`);
    return { sha: body.sha };
  }
}
