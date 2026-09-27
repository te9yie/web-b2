import { expect, test } from "@playwright/test";

// ブラウザと同じ機械で動くので、ブラウザのタイムゾーンでの今日と一致する
function todayHere(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("/ は今日の日付ページになり、ヘッダーのリンクが settings の内容になる", async ({ page }) => {
  await page.goto("/");
  // 見本の settings の「トップ」は [[{{date}}]] で、マクロの展開は段階4なので、今日の日付ページになる
  const today = todayHere();
  await expect(page).toHaveURL(new RegExp(`/p/${today}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(today);

  // ヘッダー: [今日](/)、[一覧](/all)、[[2026-01-10-reading-list|読書]]
  const nav = page.locator("#links a");
  await expect(nav).toHaveText(["今日", "一覧", "読書"]);
  await expect(nav.nth(0)).toHaveAttribute("href", "/");
  await expect(nav.nth(1)).toHaveAttribute("href", "/all");
  await expect(nav.nth(2)).toHaveAttribute("href", "/p/2026-01-10-reading-list");

  // style.css（article { line-height: 1.7; }）がページ全体に当たる
  await nav.nth(2).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("読書リスト");
  await expect(page.locator("article")).toHaveCSS("line-height", "27.2px");

  // 「一覧」で /all、「今日」で日付ページに戻る
  await nav.nth(1).click();
  await expect(page).toHaveURL(/\/all$/);
  await nav.nth(0).click();
  await expect(page).toHaveURL(new RegExp(`/p/${today}$`));
});
