// Markdownの解析。1ファイルの中身から、SPEC.md「ページのモデル」の各項目を取り出す。
// 行末がLFでもCRLFでも同じ結果になるように、行の区切りは /\r?\n/ で扱う。

export interface Page {
  // リポジトリのルートからのパス（KB_DIR を含む）
  path: string;
  // 拡張子を除いたファイル名。URLと [[リンク]] の解決に使う
  name: string;
  // 最初の `# ` 行。なければ name
  title: string;
  // `# ` 行の中身。一覧でH1のないページを見分けるために title と分けて持つ
  h1: string | null;
  // front matterを除いた本文
  body: string;
  // front matterの created。なければファイル名の先頭の YYYY-MM-DD
  created: string | null;
  // front matterの updated
  updated: string | null;
  // [[x]]・[[x|表示名]] の x、#タグ、front matterの tags。出てきた順で重複なし
  links: string[];
  // GitHubのblobのSHA。競合の検出に使う
  sha: string | null;
}

export interface FrontMatter {
  // front matterの本文（--- の行を含まない）
  raw: string | null;
  // 解析した項目。値は文字列か文字列の配列
  data: Record<string, string | string[]>;
  // front matterを取り除いた残り
  body: string;
}

// YAMLの値の前後の引用符を外す。使うのは日付とタグだけなので、この程度でよい
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

// front matterを切り出す。先頭の `---` の行から次の `---` の行まで。
// 中身は `key: value`、`key: [a, b]`、`key:` の次の行からの `- a` の三つの形だけ読む。
export function splitFrontMatter(content: string): FrontMatter {
  const text = content.startsWith(String.fromCharCode(0xfeff)) ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { raw: null, data: {}, body: text };
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) {
    return { raw: null, data: {}, body: text };
  }
  const fmLines = lines.slice(1, end);
  const data: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of fmLines) {
    if (listKey !== null) {
      const item = /^\s*-\s+(.*)$/.exec(line);
      if (item) {
        (data[listKey] as string[]).push(unquote(item[1]));
        continue;
      }
      listKey = null;
    }
    const kv = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (value === "") {
      data[key] = [];
      listKey = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map(unquote)
        .filter((s) => s !== "");
    } else {
      data[key] = unquote(value);
    }
  }
  // `---` の行の直後の改行まで含めて取り除く。行末はもとの文字列のまま残す
  let offset = 0;
  const eol = /\r?\n/g;
  for (let i = 0; i <= end; i++) {
    const m = eol.exec(text);
    if (!m) {
      offset = text.length;
      break;
    }
    offset = m.index + m[0].length;
  }
  return { raw: fmLines.join("\n"), data, body: text.slice(offset) };
}

// コードの中身を置き換える文字。空白でも `#` でもない文字にして、
// 「行頭または空白の直後」の判定がコードの前後で変わらないようにする
const MASK = String.fromCharCode(0xe000);

function mask(s: string): string {
  return s.replace(/[^\r\n]/g, MASK);
}

// コードブロック（``` と ~~~）とインラインコードを、囲いの行や区切りごと MASK で埋めた文字列を返す。
// 位置と改行は変わらないので、返り値で見つけた位置をもとの文字列に当てられる。
// リンクとタグの抽出、H1の探索、マクロの展開で共通に使う。
export function maskCode(md: string): string {
  const lines = md.split(/(\r?\n)/);
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  // 直前のコードブロックの外にあった行を、インラインコードの判定のためにまとめておく
  let pending: string[] = [];

  const flush = () => {
    if (pending.length > 0) {
      out.push(maskInlineCode(pending.join("")));
      pending = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const piece = lines[i];
    // 奇数番目は行末の改行
    if (i % 2 === 1) {
      (fence ? out : pending).push(piece);
      continue;
    }
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(piece);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
      }
      out.push(mask(piece));
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(piece);
    // バッククォートの囲いは、言語などの後ろの語にバッククォートを含められない
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      flush();
      fence = { char: open[1][0], length: open[1].length };
      out.push(mask(piece));
      continue;
    }
    pending.push(piece);
  }
  flush();
  return out.join("");
}

// インラインコード。同じ数のバッククォートで閉じる。閉じないものは文字のまま。空行はまたがない。
// バッククォートのない部分はまとめて写す（1文字ずつ連結すると1万ページで数秒かかる）
function maskInlineCode(text: string): string {
  const out: string[] = [];
  let copied = 0;
  let i = text.indexOf("`");
  if (i < 0) return text;
  while (i >= 0 && i < text.length) {
    let n = 0;
    while (text[i + n] === "`") n++;
    let j = i + n;
    let closeAt = -1;
    while (j < text.length) {
      const k = text.indexOf("`", j);
      if (k < 0) break;
      let m = 0;
      while (text[k + m] === "`") m++;
      if (m === n) {
        closeAt = k;
        break;
      }
      j = k + m;
    }
    if (closeAt < 0 || /\r?\n[ \t]*\r?\n/.test(text.slice(i + n, closeAt))) {
      // 閉じない。囲いの文字はそのまま残し、その先から探し直す
      i = text.indexOf("`", i + n);
      continue;
    }
    out.push(text.slice(copied, i), mask(text.slice(i, closeAt + n)));
    copied = closeAt + n;
    i = text.indexOf("`", copied);
  }
  out.push(text.slice(copied));
  return out.join("");
}

// [[x]]・[[x|表示名]] の x
const WIKILINK = /\[\[([^\[\]|\r\n]+?)(?:\|[^\[\]\r\n]*)?\]\]/g;
// 行頭または空白の直後の # に続く、空白と # 以外の文字列。行頭の `# ` は見出しなので空白で始まらない
const TAG = new RegExp(`(?<=^|\\s)#([^\\s#${MASK}]+)`, "gmu");

// 本文からリンクとタグを、出てきた順に重複なしで集める。コードの中は見ない。
// masked は maskCode(body) の結果。呼ぶ側が持っていれば渡して、塗りつぶしを繰り返さない
export function extractLinks(body: string, masked: string = maskCode(body)): string[] {
  const found: { index: number; text: string }[] = [];
  for (const m of masked.matchAll(WIKILINK)) {
    const start = m.index + 2;
    // MASK の位置はもとの文字列でも同じなので、表示のためにもとの文字を取り直す
    const text = body.slice(start, start + m[1].length).trim();
    if (text !== "") found.push({ index: m.index, text });
  }
  for (const m of masked.matchAll(TAG)) {
    found.push({ index: m.index, text: m[1] });
  }
  found.sort((a, b) => a.index - b.index);
  return [...new Set(found.map((f) => f.text))];
}

// 本文の最初の `# ` 行の中身。コードブロックの中は見ない
export function extractH1(body: string, masked: string = maskCode(body)): string | null {
  const m = /^(#[ \t]+)(.+?)[ \t]*$/mu.exec(masked);
  if (!m) return null;
  const start = m.index + m[1].length;
  const text = body.slice(start, start + m[2].length).trim();
  return text === "" ? null : text;
}

export function nameOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

function asString(v: string | string[] | undefined): string | null {
  if (typeof v === "string") return v;
  return null;
}

function asList(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}

export function parsePage(file: { path: string; content: string; sha?: string | null }): Page {
  const { data, body } = splitFrontMatter(file.content);
  const name = nameOf(file.path);
  const masked = maskCode(body);
  const h1 = extractH1(body, masked);
  const fromName = /^\d{4}-\d{2}-\d{2}/.exec(name)?.[0] ?? null;
  const tags = asList(data.tags).map((t) => t.replace(/^#/, "")).filter((t) => t !== "");
  return {
    path: file.path,
    name,
    title: h1 ?? name,
    h1,
    body,
    created: asString(data.created) ?? fromName,
    updated: asString(data.updated),
    links: [...new Set([...tags, ...extractLinks(body, masked)])],
    sha: file.sha ?? null,
  };
}
