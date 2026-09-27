import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";

function todayHere(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function listPaths(request: import("@playwright/test").APIRequestContext): Promise<string[]> {
  const body = (await (await request.get("/api/pages")).json()) as { pages: { path: string }[]; dir: string };
  return body.pages.map((p) => p.path);
}

test("まだないページに書き込むと、時刻のファイル名で KB_DIR の直下にファイルができる", async ({ page, request }) => {
  const before = await listPaths(request);
  let created: string | null = null;
  try {
    await page.goto("/p/新しい見本のページ");
    await expect(page.locator("article > .note")).toHaveText("まだないページ");

    // 「編集」で、front matter と # 名前 が入ったエディタが開く
    await page.getByRole("button", { name: "編集" }).click();
    const cm = page.locator(".cm-content");
    await expect(cm).toContainText(`created: ${todayHere()}`);
    await expect(cm).toContainText("# 新しい見本のページ");
    await cm.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
    await page.keyboard.type("最初の本文。[[2026-01-25]] へのリンク。");

    // 「表示」で描くと、まだないページではなく本文つきのページになる（保存はまだ）
    await page.getByRole("button", { name: "表示" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("新しい見本のページ");
    await expect(page.locator(".body")).toContainText("最初の本文。");
    expect(await listPaths(request)).toEqual(before);

    // 別のページへ移ると保存され、KB_DIR（notes）の直下に YYYY-MM-DD-HHMMSS.md ができる
    await page.locator(".body a.wikilink").click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("2026-01-25");
    await expect.poll(async () => (await listPaths(request)).length).toBe(before.length + 1);
    const added = (await listPaths(request)).filter((p) => !before.includes(p));
    expect(added).toHaveLength(1);
    created = added[0];
    expect(created).toMatch(new RegExp(`^notes/${todayHere()}-\\d{6}\\.md$`));
    const file = (await (await request.get(`/api/pages/${created}`)).json()) as { content: string };
    expect(file.content).toContain("# 新しい見本のページ");
    expect(file.content).toContain("最初の本文。");
    expect(file.content).toContain(`updated: ${todayHere()}`);

    // 開き直すと title で解決されて開ける。バックリンクにも出る
    await page.goto("/p/新しい見本のページ");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("新しい見本のページ");
    await expect(page.locator(".body")).toContainText("最初の本文。");
    await page.goto("/p/2026-01-25");
    await expect(page.locator("section.backlinks li", { hasText: "新しい見本のページ" })).toHaveCount(1);
  } finally {
    // 途中で落ちても、増えたファイルはすべて消す
    const extra = created ? [created] : (await listPaths(request)).filter((p) => !before.includes(p));
    for (const p of extra) await rm(`e2e/.data/${p}`, { force: true });
  }
});

test("日付ページに書き込むと、日付のファイル名になる", async ({ page, request }) => {
  const today = todayHere();
  const path = `notes/${today}.md`;
  try {
    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`/p/${today}$`));
    await page.getByRole("button", { name: "編集" }).click();
    const cm = page.locator(".cm-content");
    await expect(cm).toContainText(`# ${today}`);
    await cm.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
    await page.keyboard.type("今日の記録。");
    await page.locator("#links a", { hasText: "一覧" }).click();
    await expect.poll(async () => (await request.get(`/api/pages/${path}`)).status()).toBe(200);
    const file = (await (await request.get(`/api/pages/${path}`)).json()) as { content: string };
    expect(file.content).toContain("今日の記録。");
    // name で解決されるので、{{date}} がページの日付になる日付ページとして開ける
    await page.goto(`/p/${today}`);
    await expect(page.locator(".body")).toContainText("今日の記録。");
    await expect(page.locator(".dates")).toContainText(`作成 ${today}`);
  } finally {
    await rm(`e2e/.data/${path}`, { force: true });
  }
});
