// 保存（SPEC.md「編集と保存」）。打鍵ごとには保存せず、入力が止まって一定時間経ったとき、別のページに移るとき、
// タブを閉じるときにまとめて1コミットにする。保存の前に front matter の updated をその日の日付にする。
// 保存できたら Kb.put で控えと索引に反映し、下書きの基準を新しい sha にする。失敗したら下書きを残して次の機会に試す

import { type Draft, dirtyDrafts, getDraft, onDraftChange, rebase } from "./drafts";
import type { Kb } from "./kb";
import { parsePage, splitFrontMatter } from "./page";
import type { Source, WriteOptions } from "./source";

export const SAVE_DELAY = 30000;

// front matter の updated をその日の日付にする。updated がなければ足す。front matter のないページには何もしない
// （DECISIONS.md 2026-09-27「保存時の updated と、front matter のないページ」）
export function withUpdated(content: string, date: string): string {
  const fm = splitFrontMatter(content);
  if (fm.raw === null) return content;
  const lines = fm.raw.split("\n");
  const i = lines.findIndex((line) => /^updated:/.test(line));
  if (i >= 0) {
    if (lines[i].slice("updated:".length).trim().replace(/^["']|["']$/g, "") === date) return content;
    lines[i] = `updated: ${date}`;
  } else {
    lines.push(`updated: ${date}`);
  }
  const head = content.indexOf(fm.raw);
  return `${content.slice(0, head)}${lines.join("\n")}${content.slice(head + fm.raw.length)}`;
}

export interface SaveResult {
  path: string;
  ok: boolean;
  error?: string;
}

export class Saver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  // path ごとの進行中の保存。同じページを同時に二重に送らない
  private readonly inFlight = new Map<string, Promise<SaveResult>>();
  // 直近の失敗。表示に使う
  lastError: string | null = null;

  constructor(
    private readonly kb: Kb,
    private readonly source: Source,
    private readonly today: () => string,
    private readonly delay = SAVE_DELAY,
    private readonly onResult: (result: SaveResult) => void = () => undefined,
  ) {
    onDraftChange(() => this.touched());
  }

  // 入力があった。止まってから delay 後に保存する
  touched(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delay);
  }

  // 変わっている下書きをすべて保存する。ページ移動とタブを閉じるときに呼ぶ
  async flush(options: WriteOptions = {}): Promise<SaveResult[]> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return Promise.all(dirtyDrafts().map(([path, draft]) => this.save(path, draft, options)));
  }

  private save(path: string, draft: Draft, options: WriteOptions): Promise<SaveResult> {
    const running = this.inFlight.get(path);
    // 進行中なら、終わってからもう一度（そのあいだの編集を拾う）
    if (running) return running.then(() => this.saveOnce(path, options));
    const p = this.saveOnce(path, options).finally(() => this.inFlight.delete(path));
    this.inFlight.set(path, p);
    return p;
  }

  private async saveOnce(path: string, options: WriteOptions): Promise<SaveResult> {
    const draft = getDraft(path);
    if (!draft || draft.content === draft.base.content) return { path, ok: true };
    const edited = draft.content;
    const content = withUpdated(edited, this.today());
    const title = parsePage({ path, content }).title;
    try {
      const { sha } = await this.source.write(path, content, draft.base.sha, `web: ${title}`, options);
      const file = { path, sha, content };
      await this.kb.put(file);
      // 送ったあとの編集は次の保存に回す。エディタの中身（updated の行だけ古い）を基準にして、送っていない差分だけが残るようにする
      rebase(path, { path, sha, content: edited });
      this.lastError = null;
      const result = { path, ok: true };
      this.onResult(result);
      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.lastError = error;
      const result = { path, ok: false, error };
      this.onResult(result);
      return result;
    }
  }
}
