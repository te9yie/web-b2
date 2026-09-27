// ブラウザでの起動時間。初回（ローカルモードの API から1万ページを読む）と、2回目（IndexedDB の控えから）を測る。
// main.ts が performance.measure で出す "open"（控えを開いて解析結果から索引を作るまで）、
// "reverse"（逆引きの構築）、"sync"（差分の取得と反映）を読む。SPEC.md の100msの目標は open で見る。
// 数字は機械の負荷で揺れる（同じ機械で中央値61msと88msの日がある）ので assert はせず、docs/perf.md に写して判断する
import { expect, test } from "@playwright/test";

interface Measures {
  open: number;
  openStore: number;
  openRecord: number;
  openIndex: number;
  reverse: number;
  sync: number;
  total: number;
}

async function load(page: import("@playwright/test").Page, reload: boolean): Promise<Measures> {
  const t = Date.now();
  if (reload) await page.reload();
  else await page.goto("/all");
  await expect(page.locator("#status")).toHaveText(/^10000ページ（\d+件を読み直し）$/, { timeout: 600000 });
  const total = Date.now() - t;
  const entries = await page.evaluate(() =>
    Object.fromEntries(performance.getEntriesByType("measure").map((m) => [m.name, m.duration])),
  );
  return {
    open: entries.open,
    openStore: entries["open:store"],
    openRecord: entries["open:record"] ?? 0,
    openIndex: entries["open:index"] ?? 0,
    reverse: entries.reverse,
    sync: entries.sync,
    total,
  };
}

const ms = (n: number) => `${n.toFixed(0)}ms`;

function fmt(m: Measures): string {
  const open = `open ${ms(m.open)}（IndexedDB を開く ${ms(m.openStore)}, レコードを読む ${ms(m.openRecord)}, 索引を作る ${ms(m.openIndex)}）`;
  return `全体 ${m.total}ms, ${open}, reverse ${ms(m.reverse)}, sync ${ms(m.sync)}`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

test("1万ページの起動時間", async ({ page }) => {
  const first = await load(page, false);
  console.log(`初回: ${fmt(first)}`);

  const seconds: Measures[] = [];
  for (let i = 0; i < 5; i++) seconds.push(await load(page, true));
  for (const [i, s] of seconds.entries()) console.log(`2回目(${i + 1}): ${fmt(s)}`);
  const med = (k: keyof Measures) => ms(median(seconds.map((s) => s[k])));
  console.log(
    `2回目の中央値: open ${med("open")}（レコードを読む ${med("openRecord")}, 索引を作る ${med("openIndex")}）, reverse ${med("reverse")}, sync ${med("sync")}`,
  );

  // 解析結果のレコードと、ファイルの控えの getAll の時間を、アプリと同じ方法で測る
  const idb = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("web-b2");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const time = async <T,>(fn: () => IDBRequest<T>): Promise<[number, T]> => {
      const t = performance.now();
      const v = await new Promise<T>((resolve, reject) => {
        const r = fn();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      return [performance.now() - t, v];
    };
    const [indexMs, json] = await time(() => db.transaction("meta", "readonly").objectStore("meta").get("index"));
    const t = performance.now();
    const index = JSON.parse(json as string) as { pages: unknown[] };
    const parseMs = performance.now() - t;
    const [allMs, files] = await time(() => db.transaction("files", "readonly").objectStore("files").getAll());
    const [oneMs] = await time(() => db.transaction("files", "readonly").objectStore("files").get((files as { path: string }[])[5000].path));
    db.close();
    return { indexMs, parseMs, bytes: (json as string).length, indexPages: index.pages.length, allMs, count: (files as unknown[]).length, oneMs };
  });
  console.log(
    `IndexedDB: 解析結果のレコード get ${ms(idb.indexMs)}（${(idb.bytes / 1024 / 1024).toFixed(1)}M文字）, JSON.parse ${ms(idb.parseMs)}（${idb.indexPages}ページ）, files getAll ${ms(idb.allMs)}（${idb.count}件）, files get 1件 ${idb.oneMs.toFixed(1)}ms`,
  );

  const list = await page.evaluate(async () => {
    const t = performance.now();
    const res = await fetch("/api/pages");
    await res.json();
    return performance.now() - t;
  });
  console.log(`GET /api/pages（ローカルモード、1万件の sha 計算を含む）: ${list.toFixed(0)}ms`);

  expect(idb.count).toBe(10000);
  expect(idb.indexPages).toBe(10000);
});
