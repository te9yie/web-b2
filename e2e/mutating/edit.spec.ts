import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const PATH = "notes/2026-01-12-book-a.md";
const API = `/api/pages/${PATH}`;

// ページを離れると保存されるので、書き換えるテストとして動かし、終わったら fixtures の内容に戻す
test("編集で本文を書き換えると表示に反映される", async ({ page, request }) => {
  const original = await readFile(`fixtures/${PATH}`, "utf8");
  const restore = () => request.put(API, { data: { content: original, sha: null, message: "test" } });
  await restore();

  try {
    await page.goto("/p/2026-01-12-book-a");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本A");

    // 「編集」でその場がエディタになり、ファイルの中身（front matter を含む）が入っている
    await page.getByRole("button", { name: "編集" }).click();
    const cm = page.locator(".cm-content");
    await expect(cm).toBeVisible();
    await expect(cm).toContainText("created: 2026-01-12");
    await expect(cm).toContainText("# 見本の本A");
    await expect(page.locator(".body")).toHaveCount(0);

    // 全部を書き換える。`[[` を打つと `]]` が補われ、続けて打つ `]` は読み飛ばされる（closeBrackets）ので、結果は書いたとおりになる
    await cm.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await page.keyboard.type("# 書き換えた\n\n本文を書き換えた。[[2026-01-15-book-c]] へのリンク。");

    // 「表示」で描き直すと、新しい見出しと本文とリンクが出る（保存はまだ。30秒のタイマーの前）
    await page.getByRole("button", { name: "表示" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("書き換えた");
    await expect(page.locator(".body")).toContainText("本文を書き換えた");
    await expect(page.locator(".body a.wikilink")).toHaveAttribute("href", "/p/2026-01-15-book-c");
    await expect(page).toHaveTitle("書き換えた - web-b2");
    expect(((await (await request.get(API)).json()) as { content: string }).content).toContain("# 見本の本A");

    // 別のページへ移ると保存され、戻ると保存した内容が出る。索引も新しい title になる
    await page.locator(".body a.wikilink").click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本C");
    await expect.poll(async () => ((await (await request.get(API)).json()) as { content: string }).content).toContain("# 書き換えた");
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("書き換えた");
    await expect(page.locator("section.backlinks li", { hasText: "書き換えた" })).toHaveCount(0);

    // もう一度編集すると、保存した内容（updated が今日）が入っている
    await page.getByRole("button", { name: "編集" }).click();
    await expect(page.locator(".cm-content")).toContainText("# 書き換えた");
  } finally {
    await restore();
  }
});
