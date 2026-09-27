import { expect, test } from "@playwright/test";

const SETTINGS = "/api/pages/notes/2026-01-05-settings.md";

// 保存（エディタ）は段階5なので、ここでは API で settings を書き換えて「保存した」ことにする
test("壊れたスクリプトを保存すると settings ページの先頭にエラーが出る", async ({ page, request }) => {
  const original = (await (await request.get(SETTINGS)).json()) as { content: string; sha: string };
  expect(original.content).toContain("```js script.js");

  // 先に正常な状態を見ておく（控えを作る）
  await page.goto("/p/2026-01-05-settings");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("settings");
  await expect(page.locator(".script-error")).toHaveCount(0);

  // script.js を壊して保存
  // Windows の作業ツリーでは CRLF のことがある
  const broken = original.content.replace(/```js script\.js\r?\n/, (m) => `${m}this is not js;\n`);
  expect(broken).not.toBe(original.content);
  const put = await request.put(SETTINGS, { data: { content: broken, sha: original.sha, message: "test" } });
  expect(put.ok()).toBeTruthy();

  // 読み込み直すと、差分で settings が読み直され、エラーが先頭に出る
  await page.reload();
  const error = page.locator(".script-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("script.js を実行できない: SyntaxError");
  // 先頭（見出しより前）にある
  await expect(page.locator("article > :first-child")).toHaveClass("script-error");
  // 壊れたスクリプトのマクロは使えないので、マクロの見本は展開されない
  await page.goto("/p/2026-01-20-macro-usage");
  await expect(page.locator(".body")).toContainText("{{hello 世界}}");

  // 直して保存すると消える
  const fixed = await request.put(SETTINGS, { data: { content: original.content, sha: null, message: "test" } });
  expect(fixed.ok()).toBeTruthy();
  await page.goto("/p/2026-01-05-settings");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("settings");
  await expect(page.locator(".script-error")).toHaveCount(0);
});
