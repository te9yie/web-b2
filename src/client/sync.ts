// リポジトリの .md を控え（FileStore）に取り込み、変わったものだけ読み直す。
// 取り込み元（Source）は、ページの一覧（path と sha）と1ページの取得ができればよい。
// いまは /api/pages を使う ApiSource だけで、tarball と compare を使う取り込み元は段階6で足す。

import { KbIndex } from "./kb-index";
import { parsePage } from "./page";
import type { FileStore, StoredFile } from "./store";

export interface Source {
  list(): Promise<{ path: string; sha: string }[]>;
  // 一覧に出たあとで消えたファイルは NotFoundError を投げる。sync はそれを「消えた」として扱う
  read(path: string): Promise<StoredFile>;
}

export class NotFoundError extends Error {}

export interface SyncResult {
  // 取り込み後の全ファイル。path 順
  files: StoredFile[];
  // 今回読み直した path
  fetched: string[];
  // 今回控えから消した path
  removed: string[];
}

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
  constructor(private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init)) {}

  async list(): Promise<{ path: string; sha: string }[]> {
    const body = await readJson(await this.fetchFn("/api/pages"));
    const pages = isRecord(body) ? body.pages : undefined;
    if (!Array.isArray(pages)) throw new Error("APIの応答が異常: pages がない");
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
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// 一覧の sha と控えの sha を比べ、違うものと新しいものだけ読み、一覧にないものを控えから消す。
// 読むのは同時に concurrency 件まで。一覧に出たあとで消えたファイル（NotFoundError）は「消えた」として扱う。
// 読めた分は batch 件ごとに控えへ書くので、途中で失敗しても次回はそこから続けられる。
// 控えは sha 単位で正しいので、一部だけ書いても差分の計算は変わらない
export async function sync(store: FileStore, source: Source, { concurrency = 8, batch = 200 } = {}): Promise<SyncResult> {
  const [listed, cached] = await Promise.all([source.list(), store.all()]);
  const cachedByPath = new Map(cached.map((f) => [f.path, f]));
  const listedPaths = new Set(listed.map((p) => p.path));

  const toFetch = listed.filter((p) => cachedByPath.get(p.path)?.sha !== p.sha).map((p) => p.path);
  const removed = cached.filter((f) => !listedPaths.has(f.path)).map((f) => f.path);
  const fetched: string[] = [];

  let pending: StoredFile[] = [];
  const flush = async () => {
    const files = pending;
    pending = [];
    await store.put(files);
    for (const f of files) cachedByPath.set(f.path, f);
  };

  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (next < toFetch.length && failed === null) {
      const path = toFetch[next++];
      try {
        const file = await source.read(path);
        pending.push({ path, sha: file.sha, content: file.content });
        fetched.push(path);
        if (pending.length >= batch) await flush();
      } catch (e) {
        if (e instanceof NotFoundError) {
          removed.push(path);
          continue;
        }
        failed ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, toFetch.length)) }, worker));
  await flush();
  if (failed !== null) throw failed;

  await store.remove(removed);
  for (const p of removed) cachedByPath.delete(p);
  return { files: [...cachedByPath.values()].sort(byPath), fetched, removed };
}

export function buildIndex(files: StoredFile[]): KbIndex {
  return new KbIndex(files.map((f) => parsePage(f)));
}
