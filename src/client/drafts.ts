// 編集中の下書き。path ごとに、編集を始めたときのファイル（基準）と今の中身を持つ。
// 表示は下書きを解析して出し、保存と競合の検出は基準の sha を使う。
// 改行は LF にそろえる。CodeMirror が文書を LF で持つので、CRLF のファイルは開いた時点で LF として扱い、保存も LF で書く
// （DECISIONS.md 2026-09-27「CodeMirror 6 を入れる」）。
// 下書きはエディタを開いているあいだは消さない。ページを離れるときに、基準と同じなら消す。
// 新しいページ（まだないページから書き始めたもの）は sha が null で、開いた name からも引けるようにする

export interface DraftBase {
  path: string;
  // 編集を始めたとき（か最後に保存したとき）の sha。新しいページは null
  sha: string | null;
  // そのときの中身（LF）
  content: string;
}

export interface Draft {
  base: DraftBase;
  // 今の中身（LF）
  content: string;
}

const drafts = new Map<string, Draft>();
// まだないページの name → 新しいページの path
const newPages = new Map<string, string>();
const listeners = new Set<(path: string) => void>();

export function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

export function getDraft(path: string): Draft | undefined {
  return drafts.get(path);
}

// まだないページの name で開いた新しいページの下書き
export function draftForNewPage(name: string): Draft | undefined {
  const path = newPages.get(name);
  return path === undefined ? undefined : drafts.get(path);
}

// 基準から変わっているか
export function isDirty(draft: Draft): boolean {
  return draft.content !== draft.base.content;
}

// 編集を始める。下書きがあればそれを続け、なければファイルを基準にして作る
export function openDraft(file: DraftBase): Draft {
  const existing = drafts.get(file.path);
  if (existing) return existing;
  const base = { ...file, content: normalizeEol(file.content) };
  const draft = { base, content: base.content };
  drafts.set(file.path, draft);
  return draft;
}

// まだないページ name から新しいページを書き始める。基準は空（sha null、content 空）で、初期の中身が下書きになる
export function openNewDraft(name: string, path: string, initial: string): Draft {
  const existing = draftForNewPage(name);
  if (existing) return existing;
  const draft = { base: { path, sha: null, content: "" }, content: initial };
  drafts.set(path, draft);
  newPages.set(name, path);
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
export function rebase(path: string, base: DraftBase): void {
  const draft = drafts.get(path);
  if (draft) draft.base = base;
}

// 基準と同じ下書きを消す。path を省くと全部
export function dropClean(path?: string): void {
  for (const [p, d] of drafts) {
    if ((path === undefined || p === path) && !isDirty(d)) clearDraft(p);
  }
}

export function clearDraft(path: string): void {
  drafts.delete(path);
  for (const [name, p] of newPages) if (p === path) newPages.delete(name);
}

export function dirtyDrafts(): [string, Draft][] {
  return [...drafts].filter(([, d]) => isDirty(d));
}

export function onDraftChange(listener: (path: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
