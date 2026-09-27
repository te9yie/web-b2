// ブラウザ側に置くファイルの控え。リポジトリの .md を path・sha・中身のまま持ち、次回の起動で差分だけ取り直すために使う。
// 本体は IndexedDB（IdbStore）。テストでは同じ形の MemoryStore を使う。
// 解析した結果ではなく中身そのものを置くのは、編集のときに front matter を含む元の文字列が要るのと、
// 解析の直し方が変わっても取り直さずに済むようにするため。

import type { PageMeta } from "./page";

export interface StoredFile {
  // リポジトリのルートからのパス
  path: string;
  // Gitのblobの SHA。これが同じなら中身も同じとみなして取り直さない
  sha: string;
  content: string;
}

// 全ページの解析結果。起動時はこれだけを読んで索引を作る（DECISIONS.md 2026-09-27「起動時は解析結果だけを読む」）。
// version は解析の版で、違えばファイルの中身から全件を解析し直す。
// links は量が多い（1万ページで20万本）ので別に置き、getIndex が返す pages の links は空。getLinks で pages と同じ順に読む
export interface StoredIndex {
  version: number;
  pages: PageMeta[];
}

export interface FileStore {
  all(): Promise<StoredFile[]>;
  get(path: string): Promise<StoredFile | undefined>;
  put(files: StoredFile[]): Promise<void>;
  remove(paths: string[]): Promise<void>;
  getIndex(): Promise<StoredIndex | null>;
  getLinks(): Promise<string[][] | null>;
  // pages と links の両方を書く
  putIndex(index: StoredIndex): Promise<void>;
  // 最後に見たコミットなど、ファイル以外の小さな値
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

// 控えの JSON を読む。形が違えば null にして、呼ぶ側に作り直させる
function parseJson(json: unknown): unknown {
  if (typeof json !== "string") return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function parseIndex(json: unknown): StoredIndex | null {
  const v = parseJson(json) as Partial<StoredIndex> | null;
  if (typeof v !== "object" || v === null) return null;
  return typeof v.version === "number" && Array.isArray(v.pages) ? { version: v.version, pages: v.pages } : null;
}

function parseLinks(json: unknown): string[][] | null {
  const v = parseJson(json);
  return Array.isArray(v) ? (v as string[][]) : null;
}

// 保存する形。links を抜いた pages と、同じ順の links
function serializeIndex(index: StoredIndex): { pages: string; links: string } {
  const pages = index.pages.map(({ links: _links, ...rest }) => ({ ...rest, links: [] }));
  return { pages: JSON.stringify({ version: index.version, pages }), links: JSON.stringify(index.pages.map((p) => p.links)) };
}

export class MemoryStore implements FileStore {
  private readonly files = new Map<string, StoredFile>();
  private readonly meta = new Map<string, string>();
  private index: { pages: string; links: string } | null = null;

  async all(): Promise<StoredFile[]> {
    return [...this.files.values()];
  }

  async get(path: string): Promise<StoredFile | undefined> {
    const f = this.files.get(path);
    return f && { ...f };
  }

  async getIndex(): Promise<StoredIndex | null> {
    return parseIndex(this.index?.pages);
  }

  async getLinks(): Promise<string[][] | null> {
    return parseLinks(this.index?.links);
  }

  async putIndex(index: StoredIndex): Promise<void> {
    this.index = serializeIndex(index);
  }

  async put(files: StoredFile[]): Promise<void> {
    for (const f of files) this.files.set(f.path, { ...f });
  }

  async remove(paths: string[]): Promise<void> {
    for (const p of paths) this.files.delete(p);
  }

  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
  }
}

const FILES = "files";
const META = "meta";
// META の中で解析結果のレコードを置く鍵。links は別の鍵
const INDEX_KEY = "index";
const LINKS_KEY = "index:links";
// object store の構成を変えるときに上げる
const VERSION = 1;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export class IdbStore implements FileStore {
  private constructor(private readonly db: IDBDatabase) {}

  // データベースを開く。なければ files（path が鍵）と meta の二つの object store を作る
  static async open(name = "web-b2", factory: IDBFactory = indexedDB): Promise<IdbStore> {
    const r = factory.open(name, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: "path" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    // 古い版を開いたままの別のタブがあると、版を上げた open は blocked のまま成功も失敗もしない。待ち続けずに失敗にする
    const blocked = new Promise<never>((_, reject) => {
      r.onblocked = () => reject(new Error("別のタブが古い版のデータベースを開いている"));
    });
    const db = await Promise.race([request(r), blocked]);
    // 別のタブが版を上げようとしたら、こちらは閉じて邪魔をしない。以後この IdbStore は使えないので、次の起動で開き直す
    db.onversionchange = () => db.close();
    return new IdbStore(db);
  }

  all(): Promise<StoredFile[]> {
    return request(this.db.transaction(FILES, "readonly").objectStore(FILES).getAll() as IDBRequest<StoredFile[]>);
  }

  get(path: string): Promise<StoredFile | undefined> {
    return request(this.db.transaction(FILES, "readonly").objectStore(FILES).get(path) as IDBRequest<StoredFile | undefined>);
  }

  // レコードは JSON の文字列で置く（docs/perf.md）
  async getIndex(): Promise<StoredIndex | null> {
    return parseIndex(await request(this.db.transaction(META, "readonly").objectStore(META).get(INDEX_KEY)));
  }

  async getLinks(): Promise<string[][] | null> {
    return parseLinks(await request(this.db.transaction(META, "readonly").objectStore(META).get(LINKS_KEY)));
  }

  // 二つを同じトランザクションで書き、片方だけ新しくならないようにする
  async putIndex(index: StoredIndex): Promise<void> {
    const { pages, links } = serializeIndex(index);
    const tx = this.db.transaction(META, "readwrite");
    tx.objectStore(META).put(pages, INDEX_KEY);
    tx.objectStore(META).put(links, LINKS_KEY);
    await complete(tx);
  }

  async put(files: StoredFile[]): Promise<void> {
    if (files.length === 0) return;
    const tx = this.db.transaction(FILES, "readwrite");
    const store = tx.objectStore(FILES);
    for (const f of files) store.put(f);
    await complete(tx);
  }

  async remove(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const tx = this.db.transaction(FILES, "readwrite");
    const store = tx.objectStore(FILES);
    for (const p of paths) store.delete(p);
    await complete(tx);
  }

  async getMeta(key: string): Promise<string | null> {
    const v = await request(this.db.transaction(META, "readonly").objectStore(META).get(key));
    return typeof v === "string" ? v : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    const tx = this.db.transaction(META, "readwrite");
    tx.objectStore(META).put(value, key);
    await complete(tx);
  }

  close(): void {
    this.db.close();
  }
}
