// settings ページの読み取り（SPEC.md「settings ページ」）。H1 が settings のページの見出しごとに設定を読む。
// ページや見出しがなければ既定の値

import { codeBlock, listItems, section } from "./md";
import { WIKILINK } from "./page";

export interface HeaderLink {
  label: string;
  // URL か、[[ページ]] の名前。page が true なら名前
  target: string;
  page: boolean;
}

export interface Settings {
  // 「トップ」の最初の [[リンク]] の名前。なければ null（今日の日付ページ）。マクロは呼ぶ側が先に展開する
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

function parseHeaderItem(item: string): HeaderLink | null {
  const wiki = /^\[\[([^\[\]|\r\n]+?)(?:\|([^\[\]\r\n]*))?\]\]$/.exec(item.trim());
  if (wiki) {
    const target = wiki[1].trim();
    return target === "" ? null : { label: (wiki[2] ?? "").trim() || target, target, page: true };
  }
  const md = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(item.trim());
  if (md) return { label: md[1].trim() || md[2], target: md[2], page: false };
  return null;
}

export function parseSettings(body: string | null): Settings {
  if (body === null) return { top: null, header: DEFAULT_HEADER, css: null, script: null };
  const topSection = section(body, "トップ");
  const topMatch = topSection === null ? null : [...topSection.matchAll(WIKILINK)][0];
  const top = topMatch ? topMatch[1].trim() || null : null;
  const headerSection = section(body, "ヘッダー");
  const header = headerSection === null ? DEFAULT_HEADER : listItems(headerSection).map(parseHeaderItem).filter((x): x is HeaderLink => x !== null);
  return {
    top,
    header: headerSection !== null && header.length === 0 ? DEFAULT_HEADER : header,
    css: codeBlock(body, "style.css"),
    script: codeBlock(body, "script.js"),
  };
}
