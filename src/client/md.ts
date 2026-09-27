// Markdown の切り出し。settings ページの読み取りと、スクリプトから使う kb.section / kb.codeBlock（SPEC.md「マクロ」）の本体。
// 見出しと囲いはコードブロックの外だけを見る

import { WIKILINK, maskCode } from "./page";

interface Heading {
  level: number;
  text: string;
  // 見出しの行の始まりと、次の行の始まり
  start: number;
  next: number;
}

function headings(md: string): Heading[] {
  const masked = maskCode(md);
  const out: Heading[] = [];
  // 末尾の閉じの #（空白の後ろだけ。`## C#` の # は文字）は含めない。page.ts の extractH1 と同じ規則
  for (const m of masked.matchAll(/^(#{1,6})([ \t]+)(.*?)(?:[ \t]+#+)?[ \t]*$/gmu)) {
    // 位置は塗りつぶした文字列で探し、文字はもとの文字列から取る
    const textStart = m.index + m[1].length + m[2].length;
    const text = md.slice(textStart, textStart + m[3].length).trim();
    const eol = md.indexOf("\n", m.index);
    out.push({ level: m[1].length, text, start: m.index, next: eol < 0 ? md.length : eol + 1 });
  }
  return out;
}

// その見出しの次の行から、同じかより浅い見出しの手前まで。見出しの行は含めない。見出しがなければ null。
// 同じ見出しが複数あれば最初のもの
export function section(md: string, heading: string): string | null {
  const hs = headings(md);
  const i = hs.findIndex((h) => h.text === heading.trim());
  if (i < 0) return null;
  const h = hs[i];
  const end = hs.slice(i + 1).find((x) => x.level <= h.level);
  return md.slice(h.next, end ? end.start : md.length);
}

// コードの外の最初の [[x]]・[[x|表示名]] の x。なければ null
export function firstLink(md: string): string | null {
  const masked = maskCode(md);
  const m = new RegExp(WIKILINK.source).exec(masked);
  if (!m) return null;
  const text = md.slice(m.index + 2, m.index + 2 + m[1].length).trim();
  return text === "" ? null : text;
}

// 名前付きコードブロック（```js script.js のように、言語の後ろの語が名前）の中身。同名が複数あれば改行で連結。なければ null。
// 行ごとに読むので、改行は LF にそろう（section は元の文字列のまま切り出すので CRLF が残る）
export function codeBlock(md: string, name: string): string | null {
  const lines = md.split(/\r?\n/);
  const found: string[] = [];
  let fence: { char: string; length: number; body: string[]; named: boolean } | null = null;
  for (const line of lines) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        if (fence.named) found.push(fence.body.join("\n"));
        fence = null;
      } else {
        fence.body.push(line);
      }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open || (open[1][0] === "`" && open[2].includes("`"))) continue;
    const words = open[2].trim().split(/\s+/);
    fence = { char: open[1][0], length: open[1].length, body: [], named: words[1] === name };
  }
  // 閉じないブロックは末尾まで
  if (fence?.named) found.push(fence.body.join("\n"));
  return found.length === 0 ? null : found.join("\n");
}

// 箇条書きの各項目の中身（`- ` や `1. ` を除いた文字列）。入れ子は平らにする
export function listItems(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}
