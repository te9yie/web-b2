// ブラウザ側に置くファイルの控え。リポジトリの .md を path・sha・中身のまま持ち、次回の起動で差分だけ取り直すために使う。
// 本体は IndexedDB（IdbStore）。テストでは同じ形の MemoryStore を使う。
// 解析した結果ではなく中身そのものを置くのは、編集のときに front matter を含む元の文字列が要るのと、
// 解析の直し方が変わっても取り直さずに済むようにするため。

export interface StoredFile {
  // リポジトリのルートからのパス
  path: string;
  // Gitのblobの SHA。これが同じなら中身も同じとみなして取り直さない
  sha: string;
  content: string;
}

export interface FileStore {
  all(): Promise<StoredFile[]>;
  put(files: StoredFile[]): Promise<void>;
  remove(paths: string[]): Promise<void>;
  // 最後に見たコミットなど、ファイル以外の小さな値
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

export class MemoryStore implements FileStore {
  private readonly files = new Map<string, StoredFile>();
  private readonly meta = new Map<string, string>();

  async all(): Promise<StoredFile[]> {
    return [...this.files.values()];
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
    const r = factory.open(name, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: "path" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    return new IdbStore(await request(r));
  }

  all(): Promise<StoredFile[]> {
    return request(this.db.transaction(FILES, "readonly").objectStore(FILES).getAll() as IDBRequest<StoredFile[]>);
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
