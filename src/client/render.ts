// ページの本文を HTML にする。marked で変換する前に、コードの外の [[リンク]] と #タグ を /p/ へのリンクに置き換え、
// 通常のリンクと画像の相対パスをページの位置から解決する。Mermaid のブロックは <pre class="mermaid"> にして、
// 表示側（view.ts）が mermaid を読み込んで描く。
// 本文は自分のノートなので、HTML の消毒（sanitize）はしない（DECISIONS.md 2026-09-27「marked と mermaid を入れる」）。

import { Marked, type Tokens } from "marked";
import { maskCode, nameOf } from "./page";

export interface RenderContext {
  // 表示するページのパス。相対パスの解決に使う
  pagePath: string;
  // [[x]] の x が既にあるページを指すか。まだないページのリンクは見た目を変える
  exists: (ref: string) => boolean;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ページへの URL。name は区切りを含めて1つの segment としてエンコードする
export function pageUrl(name: string): string {
  return `/p/${encodeURIComponent(name)}`;
}

// 添付ファイルへの URL
export function fileUrl(path: string): string {
  return `/api/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function hasScheme(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

// ページからの相対パスを、リポジトリのルートからのパスにする。`..` は畳む。ルートの外に出たら null
export function resolveRelative(pagePath: string, href: string): string | null {
  const base = pagePath.split("/").slice(0, -1);
  const parts = href.startsWith("/") ? [] : base;
  const out = [...parts];
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

// 通常のリンクの href を表示用に直す。外部 URL とページ内リンクはそのまま。
// 相対パスの .md はページへ転送し、それ以外の相対パスは添付ファイルとして Worker 経由で取る
export function resolveHref(pagePath: string, href: string): string {
  if (href === "" || hasScheme(href) || href.startsWith("#") || href.startsWith("//")) return href;
  const hashAt = href.indexOf("#");
  const [path, hash] = hashAt < 0 ? [href, ""] : [href.slice(0, hashAt), href.slice(hashAt)];
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return href;
  }
  const resolved = resolveRelative(pagePath, decoded);
  if (resolved === null) return href;
  if (resolved.endsWith(".md")) return pageUrl(nameOf(resolved)) + hash;
  return fileUrl(resolved) + hash;
}

const WIKILINK = /\[\[([^\[\]|\r\n]+?)(?:\|([^\[\]\r\n]*))?\]\]/g;
const MASK = String.fromCharCode(0xe000);
const TAG = new RegExp(`(?<=^|\\s)#([^\\s#${MASK}]+)`, "gmu");

// コードの外の [[x]]・[[x|表示名]]・#タグ を <a> に置き換える。位置はコードを塗りつぶした文字列で探し、文字はもとの本文から取る
export function linkify(body: string, ctx: RenderContext): string {
  const masked = maskCode(body);
  const edits: { start: number; end: number; html: string }[] = [];
  for (const m of masked.matchAll(WIKILINK)) {
    const raw = body.slice(m.index, m.index + m[0].length);
    const inner = raw.slice(2, -2);
    const bar = inner.indexOf("|");
    const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    const label = (bar < 0 ? target : inner.slice(bar + 1).trim()) || target;
    if (target === "") continue;
    const cls = ctx.exists(target) ? "wikilink" : "wikilink missing";
    edits.push({ start: m.index, end: m.index + raw.length, html: `<a href="${pageUrl(target)}" class="${cls}">${escapeHtml(label)}</a>` });
  }
  for (const m of masked.matchAll(TAG)) {
    const tag = m[1];
    const cls = ctx.exists(tag) ? "tag" : "tag missing";
    edits.push({ start: m.index, end: m.index + m[0].length, html: `<a href="${pageUrl(tag)}" class="${cls}">#${escapeHtml(tag)}</a>` });
  }
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const e of edits) {
    if (e.start < pos) continue;
    out += body.slice(pos, e.start) + e.html;
    pos = e.end;
  }
  return out + body.slice(pos);
}

function createMarked(ctx: RenderContext): Marked {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      link(token: Tokens.Link) {
        const text = this.parser.parseInline(token.tokens);
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        return `<a href="${escapeHtml(resolveHref(ctx.pagePath, token.href))}"${title}>${text}</a>`;
      },
      image(token: Tokens.Image) {
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        return `<img src="${escapeHtml(resolveHref(ctx.pagePath, token.href))}" alt="${escapeHtml(token.text)}"${title}>`;
      },
      code(token: Tokens.Code) {
        if ((token.lang ?? "").split(/\s+/)[0] !== "mermaid") return false;
        return `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`;
      },
    },
  });
  return marked;
}

// 本文を HTML にする。front matter は除いてから渡す
export function renderMarkdown(body: string, ctx: RenderContext): string {
  return createMarked(ctx).parse(linkify(body, ctx), { async: false }) as string;
}
