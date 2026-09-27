import { expect, test } from "@playwright/test";

test("検索語を入力すると結果が差し替わり、/all?q= に残る", async ({ page }) => {
  await page.goto("/all");
  await expect(page.locator("#pages li")).toHaveCount(16);

  const q = page.locator("#q");
  await q.fill("見本の本");
  await expect(page).toHaveURL(/\/all\?q=%E8%A6%8B%E6%9C%AC%E3%81%AE%E6%9C%AC$/);
  // タイトルに含むものが先、本文だけのものはその後（更新順）
  await expect(page.locator("#pages li")).toHaveText(["見本の本C", "見本の本A", "読書リスト"]);
  await expect(page.locator("#status")).toHaveText("3件");

  // 語を足すと絞り込まれる（AND）
  await q.fill("見本の本 感想");
  await expect(page.locator("#pages li")).toHaveText(["見本の本C"]);

  // 空にすると全件に戻り、URL の q も消える
  await q.fill("");
  await expect(page).toHaveURL(/\/all$/);
  await expect(page.locator("#pages li")).toHaveCount(16);

  // URL の q は読み込み直しても残り、検索欄に入る
  await page.goto("/all?q=mermaid");
  await expect(q).toHaveValue("mermaid");
  await expect(page.locator("#pages li")).toHaveText(["Mermaidの見本", "画像の見本", "コードブロックの見本"]);

  // 結果から遷移できる
  await page.locator("#pages li a").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mermaidの見本");
  await expect(q).toHaveValue("");
});

test("ページを見ているときに入力すると /all に移る。IME の変換中は検索しない", async ({ page }) => {
  await page.goto("/p/2026-01-12-book-a");
  const q = page.locator("#q");

  // 変換中の入力（compositionstart のあと）では動かない
  await q.focus();
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#q")!;
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.value = "みほん";
    input.dispatchEvent(new InputEvent("input", { isComposing: true, bubbles: true }));
  });
  await expect(page).toHaveURL(/\/p\/2026-01-12-book-a$/);

  // 確定すると検索する
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#q")!;
    input.value = "見本";
    input.dispatchEvent(new CompositionEvent("compositionend"));
  });
  await expect(page).toHaveURL(/\/all\?q=%E8%A6%8B%E6%9C%AC$/);
  await expect(page.locator("#pages li").first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本");

  // 戻ると元のページ
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本A");
});
