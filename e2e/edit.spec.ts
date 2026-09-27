import { expect, test } from "@playwright/test";

test("編集で本文を書き換えると表示に反映される（保存はまだしない）", async ({ page }) => {
  await page.goto("/p/2026-01-12-book-a");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本A");

  // 「編集」でその場がエディタになり、ファイルの中身（front matter を含む）が入っている
  await page.getByRole("button", { name: "編集" }).click();
  const cm = page.locator(".cm-content");
  await expect(cm).toBeVisible();
  await expect(cm).toContainText("created: 2026-01-12");
  await expect(cm).toContainText("# 見本の本A");
  await expect(page.locator(".body")).toHaveCount(0);

  // 全部を書き換える
  await cm.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("# 書き換えた\n\n本文を書き換えた。[[2026-01-15-book-c]] へのリンク。");

  // 「表示」で描き直すと、新しい見出しと本文とリンクが出る
  await page.getByRole("button", { name: "表示" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("書き換えた");
  await expect(page.locator(".body")).toContainText("本文を書き換えた");
  await expect(page.locator(".body a.wikilink")).toHaveAttribute("href", "/p/2026-01-15-book-c");
  await expect(page).toHaveTitle("書き換えた - web-b2");

  // 別のページへ移って戻っても、同じセッションのあいだは下書きが見える
  await page.locator(".body a.wikilink").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本C");
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("書き換えた");

  // もう一度編集すると下書きが入っている
  await page.getByRole("button", { name: "編集" }).click();
  await expect(page.locator(".cm-content")).toContainText("# 書き換えた");

  // 読み込み直すと（まだ保存していないので）元に戻る
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本A");
});
