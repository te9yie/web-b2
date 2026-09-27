// settings の script.js の実行と、スクリプトから使う kb API（SPEC.md「マクロ」）。
// スクリプトは new Function で動かし、kb.macro / kb.command で登録されたものを持つ。
// settings を読み直すたびに load し直すので、登録は毎回作り直す

import { today } from "./date";
import type { Kb } from "./kb";
import { type MacroContext, type MacroFn, expand } from "./macro";
import { codeBlock, section } from "./md";
import type { Page, PageMeta } from "./page";

export type CommandFn = (editor: unknown) => unknown;

export interface KbApi {
  macro(name: string, fn: MacroFn): void;
  command(name: string, fn: CommandFn): void;
  readonly pages: ReadonlyMap<string, PageMeta>;
  resolve(ref: string): [string, PageMeta] | null;
  page(ref: string): Promise<Page | null>;
  section(md: string, heading: string): string | null;
  codeBlock(md: string, name: string): string | null;
  expand(md: string, ctx: MacroContext): Promise<string>;
  wikilink(name: string, page: PageMeta | null): string;
  today(): string;
}

export class Scripting {
  readonly macros = new Map<string, MacroFn>();
  readonly commands = new Map<string, CommandFn>();
  // 直近の load での構文エラーか実行時エラー。settings ページの先頭に出す
  error: string | null = null;
  // スクリプトを読んだ settings ページの name。エラーを出す場所を見分ける
  settingsName: string | null = null;

  constructor(private readonly kb: Kb) {}

  api(): KbApi {
    const kb = this.kb;
    return {
      macro: (name, fn) => {
        this.macros.set(name, fn);
      },
      command: (name, fn) => {
        this.commands.set(name, fn);
      },
      get pages() {
        return kb.index.pages;
      },
      resolve: (ref) => kb.index.resolve(ref),
      page: (ref) => kb.page(ref),
      section,
      codeBlock,
      expand: (md, ctx) => this.expand(md, ctx),
      wikilink: (name, page) => (page && page.title !== name ? `[[${name}|${page.title}]]` : `[[${name}]]`),
      today: () => today(),
    };
  }

  // スクリプトを実行して登録をやり直す。script が null なら登録なし。エラーは error に残して投げない
  load(script: string | null, settingsName: string | null = null): void {
    this.macros.clear();
    this.commands.clear();
    this.error = null;
    this.settingsName = settingsName;
    if (script === null || script.trim() === "") return;
    try {
      // 構文エラーはここで出る
      const fn = new Function("kb", script) as (api: KbApi) => unknown;
      fn(this.api());
    } catch (e) {
      this.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
  }

  // kb.expand から再帰的に呼ばれたときの深さを、呼び出しの連なりで数える（stack を伸ばさない再帰を止めるため）
  private depth = 0;

  async expand(md: string, ctx: MacroContext): Promise<string> {
    this.depth++;
    try {
      return await expand(md, ctx, this.macros, this.depth - 1);
    } finally {
      this.depth--;
    }
  }
}
