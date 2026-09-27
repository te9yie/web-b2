import { expect, test } from "@playwright/test";

// IndexedDB の控えが効いていることを、ブラウザが出すリクエストの数で確かめる。
// テストごとにブラウザの文脈は新しいので、最初の goto は必ず初回になる
test("2回目の読み込みではページを取り直さない", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.startsWith("/api/pages/")) reads.push(pathname);
  });

  await page.goto("/all");
  await expect(page.locator("#pages li")).toHaveCount(16);
  await expect(page.locator("#status")).toHaveText("16ページ（16件を読み直し）");
  expect(reads).toHaveLength(16);

  reads.length = 0;
  await page.reload();
  await expect(page.locator("#pages li")).toHaveCount(16);
  await expect(page.locator("#status")).toHaveText("16ページ（0件を読み直し）");
  expect(reads).toEqual([]);
});
