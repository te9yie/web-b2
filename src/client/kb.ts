// 知識庫の全体。控え（FileStore）と索引（KbIndex）と取り込み元（Source）をつなぐ。
// 起動時は控えの解析結果のレコードだけを読んで索引を作り、本文は読まない。
// リンク（20万本になる）はレコードから分けて置いてあり、最初の描画の後に読んで逆引きを作る。
// 差分はその後に取って索引に反映する（DECISIONS.md 2026-09-27「起動時は解析結果だけを読む」）。

import { KbIndex } from "./kb-index";
import { type Page, type PageMeta, parsePage, toMeta } from "./page";
import { NotFoundError, type Source } from "./source";
import type { FileStore, StoredFile } from "./store";

// 解析の直し方を変えて、控えの解析結果を作り直したいときに上げる
export const PARSER_VERSION = 1;

export interface SyncResult {
  // 今回読み直した path
  fetched: string[];
  // 今回控えから消した path
  removed: string[];
}

export type OpenStep = "record" | "index";

export class Kb {
  readonly index: KbIndex<PageMeta>;
  // path → 解析結果。差分の比較はここの sha と行う（ファイルの控えの sha ではなく）。順番はレコードと同じ
  private readonly byPath: Map<string, PageMeta>;
  // links を読み終えたか。読む前の PageMeta の links は空
  private links: Promise<void> | null;

  private constructor(
    private readonly store: FileStore,
    metas: PageMeta[],
    // 控えの解析結果が使えず、ファイルの中身から作り直したか
    readonly rebuilt: boolean,
  ) {
    this.byPath = new Map(metas.map((m) => [m.path, m]));
    this.index = new KbIndex(metas);
    this.links = rebuilt ? Promise.resolve() : null;
  }

  // 控えのレコードから索引を作る。レコードがないか解析の版が違えば、控えの中身から全件を解析し直す（取り直しはしない）。
  // trace は計測用で、段階ごとの時間（ms）を受け取る
  static async open(store: FileStore, trace?: (step: OpenStep, ms: number) => void): Promise<Kb> {
    let t = performance.now();
    const stored = await store.getIndex();
    trace?.("record", performance.now() - t);
    if (stored && stored.version === PARSER_VERSION) {
      t = performance.now();
      const kb = new Kb(store, stored.pages, false);
      trace?.("index", performance.now() - t);
      return kb;
    }
    return Kb.rebuild(store);
  }

  private static async rebuild(store: FileStore): Promise<Kb> {
    const files = await store.all();
    const metas = files.map((f) => toMeta(parsePage(f)));
    await store.putIndex({ version: PARSER_VERSION, pages: metas });
    return new Kb(store, metas, true);
  }

  // links を控えから読んで各ページに入れる。バックリンク・2 hop link・差分の保存の前に済ませる。
  // links のレコードが pages と合わなければ、控えの中身から解析し直す
  loadLinks(): Promise<void> {
    this.links ??= (async () => {
      const links = await this.store.getLinks();
      const metas = [...this.byPath.values()];
      if (links && links.length === metas.length) {
        metas.forEach((m, i) => {
          m.links = links[i];
        });
        return;
      }
      const files = await this.store.all();
      const byPath = new Map(files.map((f) => [f.path, f]));
      for (const m of metas) {
        const file = byPath.get(m.path);
        if (file) this.apply(file);
        else this.drop(m.path);
      }
      await this.saveIndex();
    })();
    return this.links;
  }

  // 逆引きを作る。起動直後の描画のあとに呼んでおくと、最初のバックリンクの表示で待たない
  async prepareBacklinks(): Promise<void> {
    await this.loadLinks();
    this.index.prepareBacklinks();
  }

  private async saveIndex(): Promise<void> {
    await this.store.putIndex({ version: PARSER_VERSION, pages: [...this.byPath.values()] });
  }

  private apply(file: StoredFile): void {
    const meta = toMeta(parsePage(file));
    this.byPath.set(file.path, meta);
    this.index.set(meta);
  }

  private drop(path: string): void {
    const old = this.byPath.get(path);
    if (!old) return;
    this.byPath.delete(path);
    // 同じ name の別のファイルが後から来て索引を差し替えていることがあるので、自分のものだけ消す
    if (this.index.get(old.name)?.path === path) this.index.remove(old.name);
  }

  // 一覧の sha と解析結果の sha を比べ、違うものと新しいものだけ読んで解析し、索引に反映する。一覧にないものは消す。
  // 読むのは同時に concurrency 件まで。読めた分は batch 件ごとに控えへ書く。
  // 一覧に出たあとで消えたファイル（NotFoundError）は「消えた」として扱う。
  // 途中で失敗しても、反映した分は解析結果のレコードに書いてから投げるので、次回はそこから続けられる
  async sync(source: Source, { concurrency = 8, batch = 200 } = {}): Promise<SyncResult> {
    const [listed] = await Promise.all([source.list(), this.loadLinks()]);
    const listedPaths = new Set(listed.map((p) => p.path));
    const toFetch = listed.filter((p) => this.byPath.get(p.path)?.sha !== p.sha).map((p) => p.path);
    const removed = [...this.byPath.keys()].filter((p) => !listedPaths.has(p));
    const fetched: string[] = [];

    let pending: StoredFile[] = [];
    const flush = async () => {
      const files = pending;
      pending = [];
      await this.store.put(files);
      for (const f of files) this.apply(f);
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
    if (failed !== null) {
      if (fetched.length > 0) await this.saveIndex();
      throw failed;
    }

    await this.store.remove(removed);
    for (const p of removed) this.drop(p);
    if (fetched.length > 0 || removed.length > 0) await this.saveIndex();
    return { fetched, removed };
  }

  // 本文つきのページ。ref は name でも title でも [[ ]] 付きでもよい。表示のときに、そのページの分だけ控えから読む
  async page(ref: string): Promise<Page | null> {
    const found = this.index.resolve(ref);
    if (!found) return null;
    const file = await this.store.get(found[1].path);
    return file ? parsePage(file) : null;
  }
}
