import { expect, test } from "@playwright/test";

test("見本ページが表示され、リンクをクリックして遷移できる", async ({ page }) => {
  await page.goto("/p/2026-01-12-book-a");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本A");
  await expect(page).toHaveTitle("見本の本A - web-b2");
  await expect(page.locator(".dates")).toHaveText("作成 2026-01-12 / 更新 2026-01-12");

  // まだないページへのリンクは見た目が変わる
  const author = page.locator("a.wikilink.missing", { hasText: "架空 太郎" }).first();
  await expect(author).toHaveAttribute("href", "/p/%E6%9E%B6%E7%A9%BA%20%E5%A4%AA%E9%83%8E");

  // [[2026-01-10-reading-list|読書リスト]] をクリックすると、ページの再読み込みなしで遷移する
  // （再読み込みが起きると window に付けた印が消える）
  await page.evaluate(() => {
    (window as unknown as { __alive: number }).__alive = 1;
  });
  await page.locator(".body").getByRole("link", { name: "読書リスト" }).click();
  await expect(page).toHaveURL(/\/p\/2026-01-10-reading-list$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("読書リスト");
  expect(await page.evaluate(() => (window as unknown as { __alive?: number }).__alive)).toBe(1);

  // 読書リストの「）#読了」は空白の直後ではないのでタグにならない
  await expect(page.locator("a.tag")).toHaveCount(0);
  await expect(page.locator(".body")).toContainText("）#読了");

  // 見本の本C の「 #読了」はタグ。まだないページを開くと見出しだけ出る
  await page.locator(".body").getByRole("link", { name: "2026-01-15-book-c" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本C");
  await page.locator("a.tag", { hasText: "#読了" }).click();
  await expect(page).toHaveURL(/\/p\/%E8%AA%AD%E4%BA%86$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("読了");
  await expect(page.locator(".note")).toHaveText("まだないページ");

  // 戻る
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本C");
});

test("title でも開け、H1 のないページは name が見出しになる", async ({ page }) => {
  await page.goto("/p/見本の本A");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本A");
  await page.goto("/p/2026-01-18-no-title");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("2026-01-18-no-title");
});

test("画像は Worker 経由で出て、.md へのリンクはページへ転送する", async ({ page }) => {
  await page.goto("/p/2026-01-23-image");
  const img = page.locator("img[alt=点]");
  await expect(img).toHaveAttribute("src", "/api/files/notes/img/dot.png");
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  const link = page.locator(".body").getByRole("link", { name: "2026-01-16" });
  await expect(link).toHaveAttribute("href", "/p/2026-01-16-mermaid-sample");
  await link.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mermaidの見本");
  // Mermaid は図になる
  await expect(page.locator("pre.mermaid svg")).toBeVisible();
});
