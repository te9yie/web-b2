// 編集中の下書き。path ごとに、編集を始めたときのファイル（基準）と今の中身を持つ。
// 表示は下書きを解析して出し、保存と競合の検出は基準の sha を使う（段階5の続きのタスク）。
// 改行は LF にそろえる。CodeMirror が文書を LF で持つので、CRLF のファイルは開いた時点で LF として扱い、保存も LF で書く
// （DECISIONS.md 2026-09-27「CodeMirror 6 を入れる」）

import type { StoredFile } from "./store";

export interface Draft {
  // 編集を始めたときのファイル。content は LF にそろえたもの
  base: StoredFile;
  // 今の中身（LF）
  content: string;
}

const drafts = new Map<string, Draft>();

export function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

export function getDraft(path: string): Draft | undefined {
  return drafts.get(path);
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

// 中身を更新する。基準と同じに戻ったら下書きを消す
export function updateDraft(path: string, content: string): void {
  const draft = drafts.get(path);
  if (!draft) return;
  if (content === draft.base.content) drafts.delete(path);
  else draft.content = content;
}

export function clearDraft(path: string): void {
  drafts.delete(path);
}

export function draftPaths(): string[] {
  return [...drafts.keys()];
}
