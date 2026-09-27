import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const PATH = "notes/2026-01-12-book-a.md";
const API = `/api/pages/${PATH}`;

function todayHere(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("編集して別のページへ移ると保存され、ファイルが変わり updated がその日になる", async ({ page, request }) => {
  const original = await readFile(`fixtures/${PATH}`, "utf8");
  const restore = () => request.put(API, { data: { content: original, sha: null, message: "test" } });
  await restore();

  try {
    await page.goto("/p/2026-01-12-book-a");
    await page.getByRole("button", { name: "編集" }).click();
    const cm = page.locator(".cm-content");
    await expect(cm).toContainText("# 見本の本A");
    // 末尾に1行足す
    await cm.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
    await page.keyboard.type("\n保存の見本で足した行。");

    // 別のページへ移る（ヘッダーの「一覧」）と保存される
    await page.locator("#links a", { hasText: "一覧" }).click();
    await expect(page).toHaveURL(/\/all$/);
    await expect.poll(async () => (await (await request.get(API)).json()).content as string).toContain("保存の見本で足した行。");
    const saved = (await (await request.get(API)).json()) as { content: string };
    expect(saved.content).toContain(`updated: ${todayHere()}`);
    expect(saved.content).toContain("created: 2026-01-12");
    expect(saved.content).not.toContain("\r\n");

    // 開き直すと保存した内容が出る（下書きではなく控えから。読み込み直しなので下書きはない）
    await page.goto("/p/2026-01-12-book-a");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本A");
    await expect(page.locator(".body")).toContainText("保存の見本で足した行。");
    await expect(page.locator(".dates")).toContainText(`更新 ${todayHere()}`);
    // 一覧の並びにも反映されている（更新順の先頭）
    await page.goto("/all");
    await expect(page.locator("#pages li").first()).toHaveText("見本の本A");
  } finally {
    await restore();
  }
});

test("タブを閉じる（pagehide）ときにも保存される", async ({ page, request }) => {
  const original = await readFile(`fixtures/${PATH}`, "utf8");
  const restore = () => request.put(API, { data: { content: original, sha: null, message: "test" } });
  await restore();

  try {
    await page.goto("/p/2026-01-12-book-a");
    await page.getByRole("button", { name: "編集" }).click();
    const cm = page.locator(".cm-content");
    await cm.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
    await page.keyboard.type("\n閉じる前に足した行。");
    // 閉じる。keepalive の fetch は閉じたあとも送られる
    await page.close();
    await expect.poll(async () => (await (await request.get(API)).json()).content as string, { timeout: 10000 }).toContain("閉じる前に足した行。");
  } finally {
    await restore();
  }
});
