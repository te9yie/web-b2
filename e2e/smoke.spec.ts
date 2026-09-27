import { expect, test } from "@playwright/test";

test("一覧が開く", async ({ page }) => {
  await page.goto("/all");
  await expect(page).toHaveTitle("web-b2");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("web-b2");
});
