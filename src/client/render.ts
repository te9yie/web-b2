// ページの本文を HTML にする。marked の字句解析のあと、文章のトークンの中だけで [[リンク]] と #タグ を /p/ へのリンクに
// 置き換える。コード、HTML、リンクの表示名、画像の代替文の中には手を入れない。
// 通常のリンクと画像の相対パスはページの位置から解決する。Mermaid のブロックは <pre class="mermaid"> にして、
// 表示側（view.ts）が mermaid を読み込んで描く。
// 本文は自分のノートなので、HTML の消毒（sanitize）はしない（DECISIONS.md 2026-09-27「marked と mermaid を入れる」）。

import { Marked, type Token, type Tokens } from "marked";
import { TAG, WIKILINK, maskCode, nameOf } from "./page";

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
  const out = href.startsWith("/") ? [] : [...base];
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
// 相対パスの .md はページへ転送し、それ以外の相対パスは添付ファイルとして Worker 経由で取る。
// `?` と `#` から後ろはそのまま付け直す。パスの %XX は戻してから区切るので、%2F は区切りになる
export function resolveHref(pagePath: string, href: string): string {
  if (href === "" || hasScheme(href) || href.startsWith("#") || href.startsWith("?") || href.startsWith("//")) return href;
  const cut = href.search(/[?#]/);
  const [path, rest] = cut < 0 ? [href, ""] : [href.slice(0, cut), href.slice(cut)];
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // %XX の形になっていない % はそのままの文字として扱う
  }
  const resolved = resolveRelative(pagePath, decoded);
  if (resolved === null) return href;
  if (resolved.endsWith(".md")) return pageUrl(nameOf(resolved)) + rest;
  return fileUrl(resolved) + rest;
}

function anchor(target: string, label: string, kind: "wikilink" | "tag", ctx: RenderContext): Tokens.HTML {
  const cls = ctx.exists(target) ? kind : `${kind} missing`;
  const text = `<a href="${pageUrl(target)}" class="${cls}">${escapeHtml(label)}</a>`;
  return { type: "html", raw: text, text, pre: false, block: false };
}

// 文章のトークン一つを、文字とリンクのトークンの列にする。
// prevOk は、このトークンの先頭が「行頭または空白の直後」とみなせるか（前のトークンが空白で終わるか、前がない）
function splitText(token: Tokens.Text, prevOk: boolean, ctx: RenderContext): Token[] {
  const text = token.text;
  const found: { start: number; end: number; token: Tokens.HTML }[] = [];
  for (const m of text.matchAll(WIKILINK)) {
    const inner = m[0].slice(2, -2);
    const bar = inner.indexOf("|");
    const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    const label = (bar < 0 ? target : inner.slice(bar + 1).trim()) || target;
    if (target !== "") found.push({ start: m.index, end: m.index + m[0].length, token: anchor(target, label, "wikilink", ctx) });
  }
  for (const m of text.matchAll(TAG)) {
    if (m.index === 0 && !prevOk) continue;
    found.push({ start: m.index, end: m.index + m[0].length, token: anchor(m[1], `#${m[1]}`, "tag", ctx) });
  }
  if (found.length === 0) return [token];
  found.sort((a, b) => a.start - b.start);
  const out: Token[] = [];
  let pos = 0;
  for (const f of found) {
    if (f.start < pos) continue;
    if (f.start > pos) out.push({ type: "text", raw: text.slice(pos, f.start), text: text.slice(pos, f.start), escaped: token.escaped });
    out.push(f.token);
    pos = f.end;
  }
  if (pos < text.length) out.push({ type: "text", raw: text.slice(pos), text: text.slice(pos), escaped: token.escaped });
  return out;
}

// 子を持つトークンの、文章の子だけを置き換える。リンクと画像の中は見ない（<a> の入れ子や代替文の破壊を避ける）。
// 表のセルは walkTokens がセル自体を渡さないので、表のトークンから辿る
function linkifyChildren(parent: Token, ctx: RenderContext): void {
  if (parent.type === "link" || parent.type === "image") return;
  if (parent.type === "table") {
    const table = parent as Tokens.Table;
    for (const cell of [...table.header, ...table.rows.flat()]) linkifyHolder(cell, ctx);
    return;
  }
  linkifyHolder(parent as { tokens?: Token[] }, ctx);
}

function linkifyHolder(parent: { tokens?: Token[] }, ctx: RenderContext): void {
  const children = parent.tokens;
  if (!children) return;
  const out: Token[] = [];
  let prevOk = true;
  for (const child of children) {
    if (child.type === "text" && !(child as Tokens.Text).tokens) {
      out.push(...splitText(child as Tokens.Text, prevOk, ctx));
    } else {
      out.push(child);
    }
    prevOk = child.type === "br" || child.type === "space" || /\s$/.test(child.raw);
  }
  parent.tokens = out;
}

function createMarked(ctx: RenderContext): Marked {
  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens: (token) => linkifyChildren(token, ctx),
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

// 表の行の中の [[x|表示名]] の | を \| にする。GFM の表は | でセルを区切るので、そのままだとセルが割れる。
// marked は表のセルの \| を | に戻してから中身を読むので、置き換えた行でも [[x|表示名]] として見える。
// 表の行かどうかは「[[ ]] の外にも | がある行」で見分ける（コードの中は見ない）。表でない行が該当しても、\| が文字の | として出るだけ
export function escapePipesInTableRows(body: string): string {
  const masked = maskCode(body);
  let out = "";
  let pos = 0;
  const lines = /[^\r\n]*(?:\r?\n|$)/g;
  for (const line of masked.matchAll(lines)) {
    if (line[0] === "") break;
    const start = line.index;
    const text = line[0];
    if (!text.includes("|")) continue;
    const matches = [...text.matchAll(WIKILINK)].filter((m) => m[0].includes("|"));
    if (matches.length === 0) continue;
    const outside = text.replace(WIKILINK, (m) => " ".repeat(m.length));
    if (!outside.includes("|")) continue;
    for (const m of matches) {
      const from = start + m.index;
      const to = from + m[0].length;
      out += body.slice(pos, from) + body.slice(from, to).replace(/\|/g, "\\|");
      pos = to;
    }
  }
  return out + body.slice(pos);
}

// 本文を HTML にする。front matter は除いてから渡す。
// 表示名に HTML のタグや強調の記号を含む [[x|<i>y</i>]] は、marked が先に分けてしまうのでリンクにならない（索引には入る）
export function renderMarkdown(body: string, ctx: RenderContext): string {
  return createMarked(ctx).parse(escapePipesInTableRows(body), { async: false }) as string;
}
