// 知識庫の全体。控え（FileStore）と索引（KbIndex）と取り込み元（Source）をつなぐ。
// 起動時は控えの解析結果のレコードだけを読んで索引を作り、本文は読まない。
// リンク（20万本になる）はレコードから分けて置いてあり、最初の描画の後に読んで逆引きを作る。
// 差分はその後に取って索引に反映する（DECISIONS.md 2026-09-27「起動時は解析結果だけを読む」）。
// バックリンクと 2 hop link は、リンクを読み終えてから引くように、index ではなくここの backlinks/twoHop を使う

import { KbIndex, type TwoHop } from "./kb-index";
import { type Page, type PageMeta, parsePage, splitFrontMatter, toMeta } from "./page";
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
  // name・title での解決と kb.pages に使う。逆引きは backlinks/twoHop を通す
  readonly index: KbIndex<PageMeta>;
  // path → 解析結果。差分の比較はここの sha と行う（ファイルの控えの sha ではなく）。順番はレコードと同じ
  private readonly byPath: Map<string, PageMeta>;
  // links を読み終えたか。読む前の PageMeta の links は空。失敗したら null に戻して次で試し直す
  private links: Promise<void> | null;
  // 検索用の本文。bodies() で読むまでは null
  private bodyMap: Map<string, string> | null = null;
  private bodiesPromise: Promise<ReadonlyMap<string, string>> | null = null;

  private constructor(
    private readonly store: FileStore,
    metas: PageMeta[],
    // 控えの解析結果が使えず、ファイルの中身から作り直したか
    readonly rebuilt: boolean,
    // 読んだレコードの stamp。links のレコードと突き合わせる
    private readonly stamp: string | null,
  ) {
    this.byPath = new Map(metas.map((m) => [m.path, m]));
    this.index = new KbIndex();
    for (const m of metas) this.place(m);
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
      const kb = new Kb(store, stored.pages, false, stored.stamp);
      trace?.("index", performance.now() - t);
      return kb;
    }
    const files = await store.all();
    const metas = files.map((f) => toMeta(parsePage(f)));
    await store.putIndex({ version: PARSER_VERSION, pages: metas });
    return new Kb(store, metas, true, null);
  }

  // links を控えから読んで各ページに入れる。バックリンク・2 hop link・差分の保存の前に済ませる。
  // links のレコードが読んだレコードと別の書き込みのもの（stamp が違う）なら、控えの中身から解析し直す
  loadLinks(): Promise<void> {
    this.links ??= this.readLinks().catch((e) => {
      this.links = null;
      throw e;
    });
    return this.links;
  }

  private async readLinks(): Promise<void> {
    const stored = await this.store.getLinks();
    const metas = [...this.byPath.values()];
    if (stored && stored.stamp === this.stamp && stored.links.length === metas.length) {
      metas.forEach((m, i) => {
        m.links = stored.links[i];
      });
      // 読む前に逆引きを作っていたら空のままなので、作り直させる
      this.index.resetBacklinks();
      return;
    }
    await this.rebuildFromFiles();
  }

  // 控えの中身を基準に全件を解析し直す。控えにないページは消す
  private async rebuildFromFiles(): Promise<void> {
    const files = await this.store.all();
    const paths = new Set(files.map((f) => f.path));
    for (const f of files) this.apply(f);
    for (const p of [...this.byPath.keys()]) if (!paths.has(p)) this.drop(p);
    await this.saveIndex();
  }

  // 逆引きを作る。起動直後の描画のあとに呼んでおくと、最初のバックリンクの表示で待たない
  async prepareBacklinks(): Promise<void> {
    await this.loadLinks();
    this.index.prepareBacklinks();
  }

  async backlinks(ref: string): Promise<PageMeta[]> {
    await this.loadLinks();
    return this.index.backlinks(ref);
  }

  async twoHop(ref: string): Promise<TwoHop<PageMeta>[]> {
    await this.loadLinks();
    return this.index.twoHop(ref);
  }

  private async saveIndex(): Promise<void> {
    await this.store.putIndex({ version: PARSER_VERSION, pages: [...this.byPath.values()] });
  }

  // 索引に置く。name はリポジトリ全体で一意のはずだが、同じ name の別の path があれば path の小さいほうを見せる
  // （読む順番で変わらないように）
  private place(meta: PageMeta): void {
    const current = this.index.get(meta.name);
    if (current && current.path !== meta.path && current.path < meta.path && this.byPath.has(current.path)) return;
    this.index.set(meta);
  }

  private apply(file: StoredFile): void {
    const page = parsePage(file);
    const meta = toMeta(page);
    this.byPath.set(file.path, meta);
    this.place(meta);
    this.bodyMap?.set(file.path, page.body.toLowerCase());
  }

  private drop(path: string): void {
    this.bodyMap?.delete(path);
    const old = this.byPath.get(path);
    if (!old) return;
    this.byPath.delete(path);
    if (this.index.get(old.name)?.path !== path) return;
    this.index.remove(old.name);
    // 同じ name の別の path が残っていれば、そちらを見せる
    let next: PageMeta | null = null;
    for (const m of this.byPath.values()) {
      if (m.name === old.name && (next === null || m.path < next.path)) next = m;
    }
    if (next) this.index.set(next);
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
      // 反映した分を残す。これ自体が失敗しても、伝えるのは元の失敗
      if (fetched.length > 0) await this.saveIndex().catch(() => undefined);
      throw failed;
    }

    await this.store.remove(removed);
    for (const p of removed) this.drop(p);
    if (fetched.length > 0 || removed.length > 0) await this.saveIndex();
    return { fetched, removed };
  }

  // 検索用の、小文字にした全ページの本文（path → 本文）。初めて呼ばれたときに控えから全件読み、以後は差分で更新して持っておく
  // （1万ページで0.9秒。DECISIONS.md 2026-09-27「起動時は解析結果だけを読む」）。失敗したら次で試し直す
  bodies(): Promise<ReadonlyMap<string, string>> {
    this.bodiesPromise ??= (async () => {
      const files = await this.store.all();
      const map = new Map<string, string>();
      for (const f of files) map.set(f.path, splitFrontMatter(f.content).body.toLowerCase());
      this.bodyMap = map;
      return map;
    })().catch((e) => {
      this.bodiesPromise = null;
      throw e;
    });
    return this.bodiesPromise;
  }

  // 本文つきのページ。ref は name でも title でも [[ ]] 付きでもよい。表示のときに、そのページの分だけ控えから読む
  async page(ref: string): Promise<Page | null> {
    const found = this.index.resolve(ref);
    if (!found) return null;
    const file = await this.store.get(found[1].path);
    return file ? parsePage(file) : null;
  }
}
