// Node.js での計測。合成データ1万ページの解析と索引作り、リンクの解決、素朴な検索の時間を出す。
// 結果は console に出し、docs/perf.md に書き写す
import { describe, expect, it } from "vitest";
import { KbIndex } from "../src/client/kb-index";
import { type Page, parsePage } from "../src/client/page";
import { search } from "../src/client/search";
import { synthesize, totalBytes } from "./synth";

function ms(n: number): string {
  return `${n.toFixed(1)}ms`;
}

// 何回か回して中央値を採る。最初の1回はJITが温まっていないので別に出す
function bench(label: string, runs: number, fn: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`${label}: 初回 ${ms(times[0])}, 中央値 ${ms(median)}, 最小 ${ms(sorted[0])}（${runs}回）`);
  return median;
}

describe("1万ページの合成データ", () => {
  it("解析・索引・解決・検索の時間", () => {
    const t0 = performance.now();
    const files = synthesize({ count: 10000, bytesPerPage: 5600, seed: 1 });
    const bytes = totalBytes(files);
    console.log(`合成: ${files.length}ページ, ${(bytes / 1024 / 1024).toFixed(1)}MB, 生成 ${ms(performance.now() - t0)}`);

    let pages: Page[] = [];
    bench("parsePage 全件", 5, () => {
      pages = files.map((f) => parsePage({ path: f.path, content: f.content, sha: "x" }));
    });
    let index = new KbIndex<Page>();
    bench("KbIndex 構築", 5, () => {
      index = new KbIndex(pages);
    });
    bench("parsePage + KbIndex（2回目以降の起動で控えから索引を作る分）", 5, () => {
      index = new KbIndex(files.map((f) => parsePage({ path: f.path, content: f.content, sha: "x" })));
    });

    const linkCount = pages.reduce((n, p) => n + p.links.length, 0);
    const missing = new Set<string>();
    for (const p of pages) for (const l of p.links) if (!index.resolve(l)) missing.add(l);
    console.log(`リンク: 合計 ${linkCount}, 1ページ平均 ${(linkCount / pages.length).toFixed(1)}, まだないページ ${missing.size}種`);

    const sample = pages.filter((_, i) => i % 97 === 0);
    const perCall = (label: string, fn: (p: Page) => unknown) => {
      const t = performance.now();
      let n = 0;
      for (let r = 0; r < 20; r++) for (const p of sample) (fn(p), n++);
      console.log(`${label}: 1回あたり ${((performance.now() - t) / n * 1000).toFixed(1)}µs（${n}回）`);
    };
    perCall("resolve（name）", (p) => index.resolve(p.name));
    perCall("resolve（title）", (p) => index.resolve(p.title));
    perCall("backlinks", (p) => index.backlinks(p.name));
    perCall("twoHop", (p) => index.twoHop(p.name));

    // ページ表示で要る分をまとめて。まだないページに向くリンクの多い「人名」のバックリンクも見る
    const heavy = [...missing].map((m) => [m, index.backlinks(m).length] as const).sort((a, b) => b[1] - a[1])[0];
    console.log(`バックリンクが最も多いまだないページ: ${heavy[1]}件`);
    bench(`backlinks（最多の ${heavy[1]}件）`, 20, () => index.backlinks(heavy[0]));

    // 検索はアプリと同じ search() で測る。本文は Kb.bodies() と同じく小文字にしたものを path で引く
    const all = [...index.pages.values()];
    const lowered = new Map(all.map((p) => [p.path, p.body.toLowerCase()]));
    const bodyOf = (path: string) => lowered.get(path) ?? "";
    const queries = [pages[123].title.slice(0, 2), `${pages[456].title.slice(0, 2)} ${pages[789].title.slice(0, 2)}`, "zzz"];
    for (const q of queries) {
      let hits = 0;
      bench(`検索「${q}」`, 5, () => {
        hits = search(all, q, bodyOf).total;
      });
      console.log(`  → ${hits}件`);
    }

    const mem = process.memoryUsage();
    console.log(`ヒープ: ${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB（中身 ${(bytes / 1024 / 1024).toFixed(0)}MB を含む）`);

    expect(index.size).toBe(10000);
  });
});
