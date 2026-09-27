import { expect, test } from "@playwright/test";

function todayHere(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("settings の script.js のマクロが表示で展開される", async ({ page }) => {
  await page.goto("/p/2026-01-20-macro-usage");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("マクロの見本");
  const body = page.locator(".body");

  // {{date}}・{{hello 世界}}・未登録の {{unknown 1 2}}
  await expect(body.locator("p:not(.dates)").first()).toHaveText(`今日は ${todayHere()}。こんにちは、世界。未登録の {{unknown 1 2}} はそのまま残る。`);

  // {{embed 2026-01-10-reading-list#読んだ}}: 読書リストの「読んだ」の節がリンクつきで入る
  const embedded = body.locator("li", { hasText: "架空 太郎" });
  await expect(embedded).toHaveCount(1);
  await expect(embedded.getByRole("link", { name: "2026-01-15-book-c" })).toHaveAttribute("href", "/p/2026-01-15-book-c");
  await expect(body).not.toContainText("{{embed");

  // {{touched}}: 今日に作成・更新したページはない
  await expect(body).toContainText("（なし）");
});

test("トップの [[{{date}}]] が展開されて / が今日の日付ページになる", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`/p/${todayHere()}$`));
});
