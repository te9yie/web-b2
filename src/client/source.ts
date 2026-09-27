// 取り込み元。ページの一覧（path と sha）と1ページの取得ができればよい。
// ApiSource は /api/pages を使い、一覧に head があれば（Worker）初回の取り込みに /api/archive の tarball も使う。
// ローカルモードの一覧には head がないので、tarball は取らずに1件ずつ読む

import type { StoredFile } from "./store";
import { TarError, readTar } from "./tar";

export interface WriteOptions {
  // タブを閉じるときの保存。ページが消えても送り終える
  keepalive?: boolean;
}

export interface ArchiveFile {
  // リポジトリのルートからのパス
  path: string;
  bytes: Uint8Array;
}

export interface Source {
  list(): Promise<{ path: string; sha: string }[]>;
  // ページを置くディレクトリ（KB_DIR）。新しいページのパスを組み立てるのに使う
  dir(): Promise<string>;
  // 一覧に出たあとで消えたファイルは NotFoundError を投げる。取り込みはそれを「消えた」として扱う
  read(path: string): Promise<StoredFile>;
  // 書き込み。sha は編集を始めたときの値で、新しいページは null。message はコミットメッセージ。新しい sha を返す
  write(path: string, content: string, sha: string | null, message: string, options?: WriteOptions): Promise<{ sha: string }>;
  // 全ファイルをまとめて取る（tarball）。want が true のファイルだけ中身を返す。持たない取り込み元（ローカルモード）は null
  archive?(want: (path: string) => boolean): Promise<AsyncIterable<ArchiveFile> | null>;
}

export class NotFoundError extends Error {}

// 書き込みの競合（409）。current は相手（いまのファイル）の内容。相手が消していれば null、本文から読めなければ undefined
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly current: StoredFile | null | undefined,
  ) {
    super(message);
  }
}

// パスの区切りごとにURLエンコードする。SPEC.md「API」の <path> の渡し方
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asFile(v: unknown): StoredFile | null {
  if (!isRecord(v) || typeof v.path !== "string" || typeof v.sha !== "string" || typeof v.content !== "string") return null;
  return { path: v.path, sha: v.sha, content: v.content };
}

// 異常な応答を投げる形にする。本文の error を文に含める
async function failure(res: Response): Promise<Error> {
  let message = `${res.status}`;
  let body: unknown = null;
  try {
    body = await res.json();
    if (isRecord(body) && typeof body.error === "string") message = `${res.status} ${body.error}`;
  } catch {
    // 本文がJSONでなければ状態コードだけ
  }
  if (res.status === 404) return new NotFoundError(`APIの応答が異常: ${message}`);
  if (res.status === 409) {
    // current: null は「相手が消した」。欠けているか形が違うなら「読めない」（undefined）で、控えには触らせない
    const current = isRecord(body) && "current" in body ? (body.current === null ? null : (asFile(body.current) ?? undefined)) : undefined;
    return new ConflictError(message, current);
  }
  return new Error(`APIの応答が異常: ${message}`);
}

async function readJson(res: Response): Promise<unknown> {
  if (!res.ok) throw await failure(res);
  return res.json();
}

// tarball のエントリから先頭のディレクトリ（GitHub の tarball は owner-repo-<短いSHA>/ の下に全部入っている）を外す。
// 先頭のディレクトリ自身は null
function stripTop(path: string): string | null {
  const slash = path.indexOf("/");
  return slash < 0 || slash === path.length - 1 ? null : path.slice(slash + 1);
}

export class ApiSource implements Source {
  // 一覧で受け取った dir。新しいページの作成で使う
  private knownDir: string | null = null;
  // 一覧で受け取った head。あれば /api/archive がある（Worker）。ローカルモードは null
  private knownHead: string | null = null;

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
    this.knownHead = isRecord(body) && typeof body.head === "string" ? body.head : null;
    return pages.map((p: unknown) => {
      if (!isRecord(p) || typeof p.path !== "string" || typeof p.sha !== "string") {
        throw new Error("APIの応答が異常: 一覧の項目に path と sha がない");
      }
      return { path: p.path, sha: p.sha };
    });
  }

  // tarball を流しながら展開する。一覧に head がなければ（ローカルモード）何も取らずに null。
  // sync は archive の前に必ず list を呼ぶので、その順序に頼る。
  // tarball と一覧のコミットが同じかは見ない。受け取った側が sha を計算して一覧と突き合わせる（DECISIONS.md 2026-09-28）
  async archive(want: (path: string) => boolean): Promise<AsyncIterable<ArchiveFile> | null> {
    if (this.knownHead === null) return null;
    if (typeof DecompressionStream === "undefined") throw new Error("このブラウザは gzip を展開できない（DecompressionStream がない）");
    const res = await this.fetchFn("/api/archive");
    if (!res.ok) throw await failure(res);
    if (!res.body) throw new Error("APIの応答が異常: tarball の本文がない");
    const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
    const entries = readTar(stream, (p) => {
      const path = stripTop(p);
      return path !== null && want(path);
    });
    return (async function* () {
      try {
        for await (const e of entries) yield { path: stripTop(e.path)!, bytes: e.bytes };
      } catch (e) {
        if (e instanceof TarError) throw e;
        // DecompressionStream の TypeError は文が「TypeError」だけのことがあり、どこで失敗したか分からないので包む
        const detail = e instanceof Error ? `${e.name}${e.message ? `: ${e.message}` : ""}` : String(e);
        throw new Error(`tarball の読み込みが途中で失敗した: ${detail}`, { cause: e });
      }
    })();
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
