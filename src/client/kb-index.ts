// 索引。全ページを name で持ち、title からの引き当てと、リンク先からリンク元への逆引きを保つ。
// SPEC.md「リンクの解決」の解決順・バックリンク・2 hop link をここで計算する。
// ページの追加・差し替え・削除ができるので、変わったファイルだけ読み直す場面でも作り直さなくてよい。

import type { Page } from "./page";

// リンクの解決先。page が null なら「まだないページ」で、name はリンクに書かれた文字
export interface Target {
  name: string;
  page: Page | null;
}

// 2 hop link の1グループ。target を同じくリンクしている他のページ
export interface TwoHop {
  target: Target;
  pages: Page[];
}

// 一覧やバックリンクの並び。updated が新しい順、同じなら name の降順（ファイル名は日付で始まるので新しいものが先）
export function byUpdatedDesc(a: Page, b: Page): number {
  const au = a.updated ?? "";
  const bu = b.updated ?? "";
  if (au !== bu) return au < bu ? 1 : -1;
  if (a.name === b.name) return 0;
  return a.name < b.name ? 1 : -1;
}

// `[[x]]`・`[[x|表示名]]` の形でも x だけの形でも受け取り、x を返す
export function refName(ref: string): string {
  let s = ref.trim();
  if (s.startsWith("[[") && s.endsWith("]]")) {
    s = s.slice(2, -2);
    const bar = s.indexOf("|");
    if (bar >= 0) s = s.slice(0, bar);
  }
  return s.trim();
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function removeFrom(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

export class KbIndex {
  // name → ページ。kb.pages としてスクリプトにもそのまま渡す
  private readonly byName = new Map<string, Page>();
  // H1 → その H1 を持つページの name。H1 のないページは title が name と同じなので入れない
  private readonly byTitle = new Map<string, Set<string>>();
  // links に書かれた文字 → それを含むページの name。解決はせず、書かれたままの文字で引く
  private readonly sources = new Map<string, Set<string>>();

  constructor(pages: Iterable<Page> = []) {
    for (const page of pages) this.set(page);
  }

  get pages(): ReadonlyMap<string, Page> {
    return this.byName;
  }

  get size(): number {
    return this.byName.size;
  }

  get(name: string): Page | undefined {
    return this.byName.get(name);
  }

  // ページを追加する。同じ name のページがあれば差し替える（name はリポジトリ全体で一意なので、後から来たものを採る）
  set(page: Page): void {
    this.remove(page.name);
    this.byName.set(page.name, page);
    if (page.h1 !== null) addTo(this.byTitle, page.title, page.name);
    for (const link of page.links) addTo(this.sources, link, page.name);
  }

  remove(name: string): void {
    const old = this.byName.get(name);
    if (!old) return;
    this.byName.delete(name);
    if (old.h1 !== null) removeFrom(this.byTitle, old.title, name);
    for (const link of old.links) removeFrom(this.sources, link, name);
  }

  // SPEC.md「リンクの解決」の順で引く。name → title（複数あれば updated が新しいもの）→ null
  resolve(ref: string): [string, Page] | null {
    const x = refName(ref);
    if (x === "") return null;
    const byName = this.byName.get(x);
    if (byName) return [x, byName];
    const names = this.byTitle.get(x);
    if (!names) return null;
    let best: Page | null = null;
    for (const name of names) {
      const page = this.byName.get(name)!;
      if (best === null || byUpdatedDesc(page, best) < 0) best = page;
    }
    return best === null ? null : [best.name, best];
  }

  // 解決先。まだないページなら page を null にして、書かれた文字を name にする
  target(ref: string): Target {
    const found = this.resolve(ref);
    if (found) return { name: found[0], page: found[1] };
    return { name: refName(ref), page: null };
  }

  // そのページの name か title を links に含むページ。自分自身は含めない。
  // ref は name でも title でもまだないページの名前でもよい
  backlinks(ref: string): Page[] {
    const { name, page } = this.target(ref);
    const names = new Set(this.sources.get(name) ?? []);
    if (page && page.title !== name) {
      for (const n of this.sources.get(page.title) ?? []) names.add(n);
    }
    names.delete(name);
    return [...names].map((n) => this.byName.get(n)!).sort(byUpdatedDesc);
  }

  // そのページと同じリンク先を持つ他のページを、リンク先ごとにまとめる。
  // リンク先は解決してからまとめるので、name で書いたリンクと title で書いたリンクは同じグループになる。
  // 他のページが一つもないリンク先は出さない。順番はページの links の順
  twoHop(ref: string): TwoHop[] {
    const self = this.target(ref);
    if (!self.page) return [];
    const groups = new Map<string, TwoHop>();
    for (const link of self.page.links) {
      const target = this.target(link);
      if (groups.has(target.name)) continue;
      const pages = this.backlinks(target.name).filter((p) => p.name !== self.name);
      if (pages.length === 0) continue;
      groups.set(target.name, { target, pages });
    }
    return [...groups.values()];
  }
}
