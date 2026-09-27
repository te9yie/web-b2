// 編集中の下書き。path ごとに、編集を始めたときのファイル（基準）と今の中身を持つ。
// 表示は下書きを解析して出し、保存と競合の検出は基準の sha を使う。
// 改行は LF にそろえる。CodeMirror が文書を LF で持つので、CRLF のファイルは開いた時点で LF として扱い、保存も LF で書く
// （DECISIONS.md 2026-09-27「CodeMirror 6 を入れる」）。
// 下書きはエディタを開いているあいだは消さない。ページを離れるときに、基準と同じなら消す

import type { StoredFile } from "./store";

export interface Draft {
  // 編集を始めたとき（か最後に保存したとき）のファイル。content は LF にそろえたもの
  base: StoredFile;
  // 今の中身（LF）
  content: string;
}

const drafts = new Map<string, Draft>();
const listeners = new Set<(path: string) => void>();

export function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

export function getDraft(path: string): Draft | undefined {
  return drafts.get(path);
}

// 基準から変わっているか
export function isDirty(draft: Draft): boolean {
  return draft.content !== draft.base.content;
}

// 編集を始める。下書きがあればそれを続け、なければファイルを基準にして作る
export function openDraft(file: StoredFile): Draft {
  const existing = drafts.get(file.path);
  if (existing) return existing;
  const base = { ...file, content: normalizeEol(file.content) };
  const draft = { base, content: base.content };
  drafts.set(file.path, draft);
  return draft;
}

// 中身を更新し、購読者（保存のタイマー）に知らせる
export function updateDraft(path: string, content: string): void {
  const draft = drafts.get(path);
  if (!draft) return;
  draft.content = content;
  for (const l of listeners) l(path);
}

// 保存できたら、その中身を新しい基準にする
export function rebase(path: string, base: StoredFile): void {
  const draft = drafts.get(path);
  if (draft) draft.base = base;
}

// 基準と同じ下書きを消す。path を省くと全部
export function dropClean(path?: string): void {
  for (const [p, d] of drafts) {
    if ((path === undefined || p === path) && !isDirty(d)) drafts.delete(p);
  }
}

export function clearDraft(path: string): void {
  drafts.delete(path);
}

export function dirtyDrafts(): [string, Draft][] {
  return [...drafts].filter(([, d]) => isDirty(d));
}

export function onDraftChange(listener: (path: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
