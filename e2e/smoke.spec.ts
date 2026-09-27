import { expect, test } from "@playwright/test";

test("トップが開く", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("web-b2");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("web-b2");
});
