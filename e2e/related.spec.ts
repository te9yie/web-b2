import { expect, test } from "@playwright/test";

test("ページの末尾にバックリンクと 2 hop link が出る", async ({ page }) => {
  await page.goto("/p/2026-01-12-book-a");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本A");

  // このページへのリンク。name で書いた読書リストと 2 hop link の見本、title（見本の本A）で書いた見本の本C。updated の新しい順
  const back = page.locator("section.backlinks");
  await expect(back.locator("h2")).toHaveText("このページへのリンク");
  await expect(back.locator("li")).toHaveText(["2 hop linkの見本", "見本の本C", "読書リスト"]);

  // 2 hop link。リンク先ごとに、同じリンク先を持つ他のページ。順番は本文の links の順（tags → 本文）
  const hop = page.locator("section.two-hop");
  await expect(hop.locator("h2")).toHaveText("2 hop link");
  await expect(hop.locator(".hop h3")).toHaveText(["books", "架空 太郎", "読書リスト", "見本の本C"]);
  await expect(hop.locator(".hop").nth(1).locator("li")).toHaveText(["2 hop linkの見本", "見本の本C", "読書リスト"]);
  // まだないページ（タグと著者名）への見出しは missing、あるページは普通のリンク
  await expect(hop.locator(".hop h3 a").nth(0)).toHaveClass("wikilink missing");
  await expect(hop.locator(".hop h3 a").nth(2)).toHaveClass("wikilink");

  // バックリンクから遷移できる
  await back.getByRole("link", { name: "見本の本C" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本C");
});

test("まだないページにもバックリンクが出る。バックリンクのないページは「なし」", async ({ page }) => {
  await page.goto("/p/架空 太郎");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("架空 太郎");
  await expect(page.locator("section.backlinks li")).toHaveText(["2 hop linkの見本", "見本の本C", "読書リスト", "見本の本A"]);
  await expect(page.locator("section.two-hop")).toHaveCount(0);

  await page.goto("/p/2026-01-26-143210");
  await expect(page.locator("section.backlinks .note")).toHaveText("なし");
});
