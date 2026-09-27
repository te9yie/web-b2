// 保存（SPEC.md「編集と保存」）。打鍵ごとには保存せず、入力が止まって一定時間経ったとき、別のページに移るとき、
// タブを閉じるときにまとめて1コミットにする。保存の前に front matter の updated をその日の日付にする。
// 保存できたら Kb.put で控えと索引に反映し、下書きの基準を新しい sha にする。失敗したら下書きを残して次の機会に試す

import { type Draft, dirtyDrafts, getDraft, markConflict, onDraftChange, rebase } from "./drafts";
import type { Kb } from "./kb";
import { parsePage, splitFrontMatter } from "./page";
import { ConflictError, type Source, type WriteOptions } from "./source";
import type { StoredFile } from "./store";

export const SAVE_DELAY = 30000;

// front matter の updated をその日の日付にする。updated がなければ足す。front matter のないページには何もしない
// （DECISIONS.md 2026-09-27「保存時の updated と、front matter のないページ」）。
// 行ごとに扱い、改行はもとのまま。updated が複数あれば最初のもの
export function withUpdated(content: string, date: string): string {
  if (splitFrontMatter(content).raw === null) return content;
  // [行, 改行, 行, 改行, ...] の並び
  const parts = content.split(/(\r?\n)/);
  const eol = parts[1] ?? "\n";
  // parts[0] が先頭の ---。閉じの --- を探す（BOM は splitFrontMatter が許すので、ここでも外す）
  let close = -1;
  for (let i = 2; i < parts.length; i += 2) {
    if (parts[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) return content;
  for (let i = 2; i < close; i += 2) {
    if (!/^updated:/.test(parts[i])) continue;
    const current = parts[i].slice("updated:".length).trim().replace(/^["']|["']$/g, "");
    if (current === date) return content;
    parts[i] = `updated: ${date}`;
    return parts.join("");
  }
  parts.splice(close, 0, `updated: ${date}`, eol);
  return parts.join("");
}

export interface SaveResult {
  path: string;
  ok: boolean;
  error?: string;
  // 競合（409）。相手の内容。消えていれば null
  conflict?: StoredFile | null;
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

  // 同じ path の保存は一つずつ連ねる。進行中なら終わってからもう一度（そのあいだの編集を拾う）
  private save(path: string, _draft: Draft, options: WriteOptions): Promise<SaveResult> {
    const running = this.inFlight.get(path) ?? Promise.resolve();
    const p: Promise<SaveResult> = running.then(() => this.saveOnce(path, options)).finally(() => {
      if (this.inFlight.get(path) === p) this.inFlight.delete(path);
    });
    this.inFlight.set(path, p);
    return p;
  }

  private async saveOnce(path: string, options: WriteOptions): Promise<SaveResult> {
    const draft = getDraft(path);
    if (!draft || draft.content === draft.base.content) return { path, ok: true };
    const edited = draft.content;
    const content = withUpdated(edited, this.today());
    const title = parsePage({ path, content }).title;
    // keepalive の fetch は本文が 64KiB を超えると送れない。大きいページは普通の fetch で送る（閉じるときは届かないことがある）
    const keepalive = (options.keepalive ?? false) && content.length < 60000;
    try {
      const { sha } = await this.source.write(path, content, draft.base.sha, `web: ${title}`, { keepalive });
      // 書けた時点で基準を新しい sha にする（このあとの控えの更新が失敗しても、次の保存が古い sha で送られないように）。
      // エディタの中身（updated の行だけ古い）を基準にして、送っていない差分だけが残るようにする
      rebase(path, { path, sha, content: edited });
      try {
        await this.kb.put({ path, sha, content });
      } catch (e) {
        console.warn(`保存はできたが控えに反映できない: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.lastError = null;
      const result = { path, ok: true };
      this.onResult(result);
      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (e instanceof ConflictError) {
        // 下書きに相手の内容を付けて自動の再送から外し、控えと索引は相手の内容にする（消えていれば控えからも消す）
        markConflict(path, e.current ?? { path, sha: null, content: "" });
        try {
          if (e.current) await this.kb.put(e.current);
          else await this.kb.remove(path);
        } catch (err) {
          console.warn(`相手の内容を控えに反映できない: ${err instanceof Error ? err.message : String(err)}`);
        }
        const result = { path, ok: false, error, conflict: e.current };
        this.onResult(result);
        return result;
      }
      this.lastError = error;
      const result = { path, ok: false, error };
      this.onResult(result);
      return result;
    }
  }
}
