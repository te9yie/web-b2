// settings ページの読み取り（SPEC.md「settings ページ」）。H1 が settings のページの見出しごとに設定を読む。
// ページや見出しがなければ既定の値

import { codeBlock, firstLink, listItems, section } from "./md";

export interface HeaderLink {
  label: string;
  // URL か、[[ページ]] の名前。page が true なら名前
  target: string;
  page: boolean;
}

export interface Settings {
  // settings ページの name。なければ null（すべて既定の値）
  name: string | null;
  // 「トップ」の節の生の文字列。段階4でマクロを展開してから最初の [[リンク]] を取るために持つ
  topSection: string | null;
  // 「トップ」の最初の [[リンク]] の名前（展開前）。なければ null（今日の日付ページ）
  top: string | null;
  // 「ヘッダー」の箇条書き。なければ既定（今日・一覧）
  header: HeaderLink[];
  // ```css style.css の中身
  css: string | null;
  // ```js script.js の中身
  script: string | null;
}

export const DEFAULT_HEADER: HeaderLink[] = [
  { label: "今日", target: "/", page: false },
  { label: "一覧", target: "/all", page: false },
];

export const SETTINGS_NAME = "settings";

export const DEFAULT_SETTINGS: Settings = { name: null, topSection: null, top: null, header: DEFAULT_HEADER, css: null, script: null };

function parseHeaderItem(item: string): HeaderLink | null {
  const wiki = /^\[\[([^\[\]|\r\n]+?)(?:\|([^\[\]\r\n]*))?\]\]$/.exec(item.trim());
  if (wiki) {
    const target = wiki[1].trim();
    return target === "" ? null : { label: (wiki[2] ?? "").trim() || target, target, page: true };
  }
  // [表示名](URL) と [表示名](<URL>)。URL に空白や ) を含むものは読まない
  const md = /^\[([^\]]*)\]\((?:<([^<>]*)>|([^)\s]+))(?:\s+["'][^"']*["'])?\)$/.exec(item.trim());
  if (md) {
    const url = md[2] ?? md[3];
    return { label: md[1].trim() || url, target: url, page: false };
  }
  return null;
}

export function parseSettings(page: { name: string; body: string } | null): Settings {
  if (page === null) return DEFAULT_SETTINGS;
  const body = page.body;
  const topSection = section(body, "トップ");
  const headerSection = section(body, "ヘッダー");
  const header = headerSection === null ? DEFAULT_HEADER : listItems(headerSection).map(parseHeaderItem).filter((x): x is HeaderLink => x !== null);
  return {
    name: page.name,
    topSection,
    top: topSection === null ? null : firstLink(topSection),
    header: header.length === 0 ? DEFAULT_HEADER : header,
    css: codeBlock(body, "style.css"),
    script: codeBlock(body, "script.js"),
  };
}
