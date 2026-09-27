// リポジトリの .md を控え（FileStore）に取り込み、変わったものだけ読み直す。
// 取り込み元（Source）は、ページの一覧（path と sha）と1ページの取得ができればよい。
// いまは /api/pages を使う ApiSource だけで、tarball と compare を使う取り込み元は段階6で足す。

import { KbIndex } from "./kb-index";
import { parsePage } from "./page";
import type { FileStore, StoredFile } from "./store";

export interface Source {
  list(): Promise<{ path: string; sha: string }[]>;
  read(path: string): Promise<StoredFile>;
}

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

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = `${res.status} ${body.error}`;
    } catch {
      // 本文がJSONでなければ状態コードだけ
    }
    throw new Error(`APIの応答が異常: ${message}`);
  }
  return (await res.json()) as T;
}

export class ApiSource implements Source {
  constructor(private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init)) {}

  async list(): Promise<{ path: string; sha: string }[]> {
    const body = await readJson<{ pages: { path: string; sha: string }[] }>(await this.fetchFn("/api/pages"));
    return body.pages;
  }

  async read(path: string): Promise<StoredFile> {
    return readJson<StoredFile>(await this.fetchFn(`/api/pages/${encodePath(path)}`));
  }
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// 一覧の sha と控えの sha を比べ、違うものと新しいものだけ読み、一覧にないものを控えから消す。
// 読むのは同時に concurrency 件まで。読み終えるまで控えは書き換えないので、途中で失敗しても次回に同じ差分をやり直せる
export async function sync(store: FileStore, source: Source, { concurrency = 8 } = {}): Promise<SyncResult> {
  const [listed, cached] = await Promise.all([source.list(), store.all()]);
  const cachedByPath = new Map(cached.map((f) => [f.path, f]));
  const listedPaths = new Set(listed.map((p) => p.path));

  const toFetch = listed.filter((p) => cachedByPath.get(p.path)?.sha !== p.sha).map((p) => p.path);
  const removed = cached.filter((f) => !listedPaths.has(f.path)).map((f) => f.path);

  const fetchedFiles: StoredFile[] = [];
  let next = 0;
  const worker = async () => {
    while (next < toFetch.length) {
      const path = toFetch[next++];
      fetchedFiles.push(await source.read(path));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, toFetch.length) }, worker));

  await store.remove(removed);
  await store.put(fetchedFiles);

  for (const p of removed) cachedByPath.delete(p);
  for (const f of fetchedFiles) cachedByPath.set(f.path, f);
  return { files: [...cachedByPath.values()].sort(byPath), fetched: toFetch, removed };
}

export function buildIndex(files: StoredFile[]): KbIndex {
  return new KbIndex(files.map((f) => parsePage(f)));
}
