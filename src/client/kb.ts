// 知識庫の全体。控え（FileStore）と索引（KbIndex）と取り込み元（Source）をつなぐ。
// 起動時は控えの解析結果のレコードだけを読んで索引を作り、本文は読まない。
// リンク（20万本になる）はレコードから分けて置いてあり、最初の描画の後に読んで逆引きを作る。
// 差分はその後に取って索引に反映する（DECISIONS.md 2026-09-27「起動時は解析結果だけを読む」）。
// バックリンクと 2 hop link は、リンクを読み終えてから引くように、index ではなくここの backlinks/twoHop を使う

import { blobShaOf } from "../shared/api-path";
import { KbIndex, type TwoHop } from "./kb-index";
import { type Page, type PageMeta, parsePage, splitFrontMatter, toMeta } from "./page";
import { SETTINGS_NAME, type Settings, parseSettings } from "./settings";
import { type ArchiveFile, NotFoundError, type Source } from "./source";
import type { FileStore, StoredFile } from "./store";

// 解析の直し方を変えて、控えの解析結果を作り直したいときに上げる
export const PARSER_VERSION = 1;

// 読み直すファイルがこれより多ければ、控えがあっても tarball で取る。
// tarball の後で一覧と合わないファイルがこれより多ければ、このうち先頭のこの件数だけを1件ずつ読んでから投げる
// （GitHub の API の上限を使い切らないため。起動のたびにこの件数ずつ進む）。
// GitHub の上限（1時間5,000回）の6%として置いた値で、計測で決めたものではない（DECISIONS.md 2026-09-28）
export const ARCHIVE_THRESHOLD = 300;

// Worker の GET /api/pages/<path> と同じ既定の設定（BOM を外す）にして、どちらの経路で読んでも控えの中身をそろえる
const decoder = new TextDecoder();

type Take = (file: StoredFile) => Promise<void>;

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
  // 索引にページを入れたり消したりするたびに増える。sync が途中で失敗しても、反映した分があったかをこれで見る
  private revisionCount = 0;
  private bodiesPromise: Promise<ReadonlyMap<string, string>> | null = null;
  // bodies() で読んでいるあいだに変わった本文。null は消えたページ
  private pendingBodies: Map<string, string | null> | null = null;

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

  get revision(): number {
    return this.revisionCount;
  }

  private apply(file: StoredFile): void {
    this.revisionCount++;
    const page = parsePage(file);
    const meta = toMeta(page);
    this.byPath.set(file.path, meta);
    this.place(meta);
    this.noteBody(file.path, page.body.toLowerCase());
  }

  private drop(path: string): void {
    this.revisionCount++;
    this.noteBody(path, null);
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
  // 控えが空か、読むものが archiveThreshold 件を超えれば、取り込み元の tarball（あれば）で取る。tarball の各ファイルは
  // sha を計算して一覧の sha と合うものだけ使い、合わないものと tarball にないものは1件ずつ読む（DECISIONS.md 2026-09-28）。
  // 1件ずつ読むものが archiveThreshold 件を超えたら、先頭の archiveThreshold 件だけ読んでから投げる。
  // 1件ずつ読むのは同時に concurrency 件まで。読めた分は batch 件ごとに控えへ書く。
  // 一覧に出たあとで消えたファイル（NotFoundError）は「消えた」として扱う。
  // 途中で失敗しても、反映した分は解析結果のレコードに書いてから投げるので、次回はそこから続けられる
  async sync(source: Source, { concurrency = 8, batch = 200, archiveThreshold = ARCHIVE_THRESHOLD } = {}): Promise<SyncResult> {
    const [listed] = await Promise.all([source.list(), this.loadLinks()]);
    const listedPaths = new Set(listed.map((p) => p.path));
    // path → 一覧の sha。読み終えたものから消す
    const wanted = new Map(listed.filter((p) => this.byPath.get(p.path)?.sha !== p.sha).map((p) => [p.path, p.sha]));
    const removed = [...this.byPath.keys()].filter((p) => !listedPaths.has(p));
    const fetched: string[] = [];

    let pending: StoredFile[] = [];
    const flush = async () => {
      const files = pending;
      pending = [];
      await this.store.put(files);
      for (const f of files) this.apply(f);
    };
    const take: Take = async (file) => {
      pending.push(file);
      fetched.push(file.path);
      wanted.delete(file.path);
      if (pending.length >= batch) await flush();
    };

    try {
      const bulk = wanted.size > 0 && (this.byPath.size === 0 || wanted.size > archiveThreshold);
      const archive = bulk && source.archive ? await source.archive((p) => wanted.has(p)) : null;
      if (archive) {
        await takeArchive(archive, wanted, take, batch);
        const rest = wanted.size;
        if (rest > archiveThreshold) {
          await readEach(source, [...wanted.keys()].slice(0, archiveThreshold), take, removed, concurrency);
          throw new Error(
            `tarball の中身が一覧と合わないファイルが ${rest} 件ある。1件ずつ読むのは起動ごとに ${archiveThreshold} 件までにしていて、残りは次の起動で読む`,
          );
        }
      }
      // 残り（tarball がない取り込み元では全部）を1件ずつ読む
      await readEach(source, [...wanted.keys()], take, removed, concurrency);
      await flush();
    } catch (e) {
      // 反映した分を残す。これ自体が失敗しても、伝えるのは元の失敗
      await flush().catch(() => undefined);
      if (fetched.length > 0) await this.saveIndex().catch(() => undefined);
      throw e;
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
      // 読んでいるあいだの apply/drop は pendingBodies に控え、読み終えてから上書きする（控えの実装の順序に頼らない）
      this.pendingBodies = new Map();
      try {
        const files = await this.store.all();
        const map = new Map<string, string>();
        for (const f of files) map.set(f.path, splitFrontMatter(f.content).body.toLowerCase());
        for (const [path, body] of this.pendingBodies) {
          if (body === null) map.delete(path);
          else map.set(path, body);
        }
        this.bodyMap = map;
        return map;
      } finally {
        this.pendingBodies = null;
      }
    })().catch((e) => {
      this.bodiesPromise = null;
      throw e;
    });
    return this.bodiesPromise;
  }

  private noteBody(path: string, body: string | null): void {
    if (this.pendingBodies) this.pendingBodies.set(path, body);
    if (!this.bodyMap) return;
    if (body === null) this.bodyMap.delete(path);
    else this.bodyMap.set(path, body);
  }

  // settings ページ（SPEC.md「settings ページ」）。name か H1 が settings のページを読む。なければ既定の値
  async settings(): Promise<Settings> {
    return parseSettings(await this.page(SETTINGS_NAME));
  }

  // ファイルの中身そのもの（front matter を含む）。編集に使う
  content(path: string): Promise<StoredFile | undefined> {
    return this.store.get(path);
  }

  // ローカルで書いた1ページを、控え・索引・解析結果に反映する（保存のあとに、サーバーが返した sha で呼ぶ）
  async put(file: StoredFile): Promise<void> {
    await this.loadLinks();
    await this.store.put([file]);
    this.apply(file);
    await this.saveIndex();
  }

  // 相手が消したページを控えと索引から外す
  async remove(path: string): Promise<void> {
    await this.loadLinks();
    await this.store.remove([path]);
    this.drop(path);
    await this.saveIndex();
  }

  // 本文つきのページ。ref は name でも title でも [[ ]] 付きでもよい。表示のときに、そのページの分だけ控えから読む
  async page(ref: string): Promise<Page | null> {
    const found = this.index.resolve(ref);
    if (!found) return null;
    const file = await this.store.get(found[1].path);
    return file ? parsePage(file) : null;
  }
}

// tarball から来たファイルを batch 件ずつためて sha を計算し、一覧の sha（wanted）と同じものだけ take する。
// sha は変換の前のバイト列で計算するので、BOM のあるファイルも一覧と合う。
// 合わないファイルに CR があれば、CRLF を LF に戻したバイト列でも計算し、合えば戻したほうを使う
// （.gitattributes の eol=crlf は git archive で当たる。DECISIONS.md 2026-09-28）。
// ストリームが途中で投げたときも、ためていた分（最後まで読み切ったファイル）は確かめて take してから投げ直す
async function takeArchive(files: AsyncIterable<ArchiveFile>, wanted: Map<string, string>, take: Take, batch: number): Promise<void> {
  let buffered: ArchiveFile[] = [];
  const check = async () => {
    const got = buffered;
    buffered = [];
    const matched = await Promise.all(got.map((f) => matchSha(f.bytes, wanted.get(f.path))));
    for (let i = 0; i < got.length; i++) {
      const bytes = matched[i];
      if (bytes) await take({ path: got[i].path, sha: wanted.get(got[i].path)!, content: decoder.decode(bytes) });
    }
  };
  try {
    for await (const f of files) {
      buffered.push(f);
      if (buffered.length >= batch) await check();
    }
  } catch (e) {
    await check().catch(() => undefined);
    throw e;
  }
  await check();
}

// 一覧の sha と合うバイト列。そのままで合わなければ CRLF を LF に戻したもので試す。どちらも合わなければ null
async function matchSha(bytes: Uint8Array, sha: string | undefined): Promise<Uint8Array | null> {
  if (sha === undefined) return null;
  if ((await blobShaOf(bytes)) === sha) return bytes;
  if (!bytes.includes(0x0d)) return null;
  const lf = crlfToLf(bytes);
  return (await blobShaOf(lf)) === sha ? lf : null;
}

function crlfToLf(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
    out[n++] = bytes[i];
  }
  return out.subarray(0, n);
}

// paths を同時に concurrency 件まで1件ずつ読む。NotFoundError は removed に入れる。
// ほかの失敗は、それ以降を読まずに、読みかけの分を待ってから最初の失敗を投げる
async function readEach(source: Source, paths: string[], take: Take, removed: string[], concurrency: number): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (next < paths.length && failed === null) {
      const path = paths[next++];
      try {
        const file = await source.read(path);
        await take({ path, sha: file.sha, content: file.content });
      } catch (e) {
        if (e instanceof NotFoundError) {
          removed.push(path);
          continue;
        }
        failed ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, paths.length)) }, worker));
  if (failed !== null) throw failed;
}
