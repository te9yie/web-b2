// Node.js での計測。合成データ1万ページの解析と索引作り、リンクの解決、素朴な検索の時間を出す。
// 結果は console に出し、docs/perf.md に書き写す
import { describe, expect, it } from "vitest";
import { KbIndex } from "../src/client/kb-index";
import { type Page, parsePage } from "../src/client/page";
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

// 段階3の検索の目安。空白区切りの語をすべて含む（大文字小文字を区別しない）ページを、title に全語を含むもの→ updated 順で並べ、300件で切る
function naiveSearch(pages: Page[], query: string): Page[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  const hits: { page: Page; inTitle: boolean }[] = [];
  for (const page of pages) {
    const title = page.title.toLowerCase();
    const body = page.body.toLowerCase();
    if (!words.every((w) => title.includes(w) || body.includes(w))) continue;
    hits.push({ page, inTitle: words.every((w) => title.includes(w)) });
  }
  hits.sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || (b.page.updated ?? "").localeCompare(a.page.updated ?? ""));
  return hits.slice(0, 300).map((h) => h.page);
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
    let index = new KbIndex();
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

    const all = [...index.pages.values()];
    const queries = [pages[123].title.slice(0, 2), `${pages[456].title.slice(0, 2)} ${pages[789].title.slice(0, 2)}`, "zzz"];
    for (const q of queries) {
      let hits = 0;
      bench(`素朴な検索「${q}」`, 5, () => {
        hits = naiveSearch(all, q).length;
      });
      console.log(`  → ${hits}件`);
    }

    // 小文字にした本文を持っておけば、検索のたびに toLowerCase しなくてよい。その分の目安
    const lowered = all.map((p) => ({ ...p, title: p.title.toLowerCase(), body: p.body.toLowerCase() }));
    for (const q of queries) {
      bench(`小文字化済みの本文での検索「${q}」`, 5, () => naiveSearch(lowered, q));
    }

    const mem = process.memoryUsage();
    console.log(`ヒープ: ${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB（中身 ${(bytes / 1024 / 1024).toFixed(0)}MB を含む）`);

    expect(index.size).toBe(10000);
  });
});
