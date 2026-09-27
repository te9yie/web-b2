// マクロの展開（SPEC.md「マクロ」）。本文の {{名前 引数}} を、登録された関数の戻り値（Markdown）に置き換える。
// コードブロックとインラインコードの中は展開しない。登録されていない名前は書いたまま残す。
// 関数は文字列か、その Promise を返す。例外を投げたら、その場所に名前と理由を出して残りは展開する

import { maskCode } from "./page";

export interface MacroContext {
  // 表示中のページ名
  name: string;
  // 展開中のページ名の配列。埋め込みの循環を見つけるのに使う
  stack: string[];
}

export type MacroFn = (arg: string, ctx: MacroContext) => string | Promise<string> | null | undefined;

// {{名前 引数}}。名前は空白と { } 以外、引数は } と改行以外の文字列（前後の空白は落とす）。名前と引数の区切りは半角か全角の空白
const SP = "[ \\t\\u3000]";
export const MACRO = new RegExp(`\\{\\{${SP}*([^\\s{}]+)(?:${SP}+([^{}\\r\\n]*?))?${SP}*\\}\\}`, "g");

// kb.expand を自分で呼ぶマクロが stack を伸ばさずに再帰したときに止める深さ
export const MAX_DEPTH = 20;

export async function expand(md: string, ctx: MacroContext, macros: ReadonlyMap<string, MacroFn>, depth = 0): Promise<string> {
  const masked = maskCode(md);
  let out = "";
  let pos = 0;
  for (const m of masked.matchAll(MACRO)) {
    const name = m[1];
    const fn = macros.get(name);
    if (!fn) continue;
    const raw = md.slice(m.index, m.index + m[0].length);
    const arg = raw
      .slice(2, -2)
      .trim()
      .slice(name.length)
      .replace(/^[ \t　]+/, "")
      .trim();
    let replaced: string;
    if (depth >= MAX_DEPTH) {
      replaced = `（{{${name}}}: 展開が深すぎる）`;
    } else {
      try {
        // ctx はマクロごとに写しを渡す。マクロが stack を書き換えても他に影響しない
        const value = await fn(arg, { name: ctx.name, stack: [...ctx.stack] });
        replaced = value === null || value === undefined ? "" : String(value);
      } catch (e) {
        replaced = `（{{${name}}}: ${e instanceof Error ? e.message : String(e)}）`;
      }
    }
    out += md.slice(pos, m.index) + replaced;
    pos = m.index + raw.length;
  }
  return out + md.slice(pos);
}
