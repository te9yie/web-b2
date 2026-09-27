// 検索（SPEC.md「検索」）。空白区切りの語をすべて含むページ（AND、大文字小文字を区別しない）を、
// タイトルに全語を含むもの → 更新順で並べ、300件で切る。本文は小文字にしたものを呼ぶ側が渡す

import { byUpdatedDesc } from "./kb-index";
import type { PageMeta } from "./page";

export const LIMIT = 300;

export function searchWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
}

export interface SearchResult {
  pages: PageMeta[];
  // 切る前の件数
  total: number;
}

// bodyOf は path から小文字にした本文を返す。まだ読めていなければ空文字でよい（title だけで探す）
export function search(pages: Iterable<PageMeta>, query: string, bodyOf: (path: string) => string): SearchResult {
  const words = searchWords(query);
  const hits: { page: PageMeta; inTitle: boolean }[] = [];
  for (const page of pages) {
    if (words.length === 0) {
      hits.push({ page, inTitle: false });
      continue;
    }
    const title = page.title.toLowerCase();
    let inTitle = true;
    let ok = true;
    for (const w of words) {
      // タイトル（H1 か name）にあれば本文を見ない。H1 は本文の中にあり、name はページそのものを指す
      if (title.includes(w)) continue;
      inTitle = false;
      if (!bodyOf(page.path).includes(w)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push({ page, inTitle });
  }
  hits.sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || byUpdatedDesc(a.page, b.page));
  return { pages: hits.slice(0, LIMIT).map((h) => h.page), total: hits.length };
}
