// ブラウザでの起動時間。初回（ローカルモードの API から1万ページを読む）と、2回目（IndexedDB の控えから）を測る。
// main.ts が performance.measure で出す "sync"（控えを開いて差分を取るまで）と "index"（解析と索引作り）を読む
import { expect, test } from "@playwright/test";

interface Measures {
  sync: number;
  index: number;
  total: number;
}

async function load(page: import("@playwright/test").Page, reload: boolean): Promise<Measures> {
  const t = Date.now();
  if (reload) await page.reload();
  else await page.goto("/");
  await expect(page.locator("#status")).toHaveText(/^10000ページ/, { timeout: 600000 });
  const total = Date.now() - t;
  const entries = await page.evaluate(() =>
    Object.fromEntries(performance.getEntriesByType("measure").map((m) => [m.name, m.duration])),
  );
  return { sync: entries.sync, index: entries.index, total };
}

test("1万ページの起動時間", async ({ page }) => {
  const first = await load(page, false);
  console.log(`初回: 全体 ${first.total}ms, sync ${first.sync.toFixed(0)}ms, index ${first.index.toFixed(0)}ms`);

  const seconds: Measures[] = [];
  for (let i = 0; i < 3; i++) seconds.push(await load(page, true));
  for (const [i, s] of seconds.entries()) {
    console.log(`2回目(${i + 1}): 全体 ${s.total}ms, sync ${s.sync.toFixed(0)}ms, index ${s.index.toFixed(0)}ms`);
  }

  // sync の内訳。IndexedDB の getAll だけの時間を、アプリと同じ方法で測る
  const getAll = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("web-b2");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const t = performance.now();
    const files = await new Promise<unknown[]>((resolve, reject) => {
      const r = db.transaction("files", "readonly").objectStore("files").getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return { ms: performance.now() - t, count: files.length };
  });
  console.log(`IndexedDB getAll: ${getAll.ms.toFixed(0)}ms（${getAll.count}件）`);

  const list = await page.evaluate(async () => {
    const t = performance.now();
    const res = await fetch("/api/pages");
    await res.json();
    return performance.now() - t;
  });
  console.log(`GET /api/pages（ローカルモード、1万件の sha 計算を含む）: ${list.toFixed(0)}ms`);

  expect(getAll.count).toBe(10000);
});
