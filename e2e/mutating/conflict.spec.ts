import { readFile, rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { putFile } from "./helpers";

const PATH = "notes/2026-01-12-book-a.md";
const API = `/api/pages/${PATH}`;

test("裏で変わったページへの保存は拒まれ、両方の内容を見せて選べる", async ({ page, request }) => {
  const original = await readFile(`fixtures/${PATH}`, "utf8");
  const restore = () => putFile(request, PATH, original);
  await restore();

  try {
    await page.goto("/p/2026-01-12-book-a");
    await page.getByRole("button", { name: "編集" }).click();
    const cm = page.locator(".cm-content");
    await expect(cm).toContainText("# 見本の本A");
    await cm.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
    await page.keyboard.type("\n自分が足した行。");

    // 別のツールが同じファイルを変えた
    await putFile(request, PATH, original.replace("# 見本の本A", "# 見本の本A（相手が変えた）"));

    // ページを離れると保存が走り、409 になる。ヘッダーに印が出て、下書きは残る
    await page.locator("#links a", { hasText: "一覧" }).click();
    await expect(page.locator("#save-note")).toHaveText("別の場所で変わっている");
    expect(((await (await request.get(API)).json()) as { content: string }).content).toContain("相手が変えた");

    // ページを開くと、自分の下書きが本文に、相手の内容が先頭に出る
    await page.locator('#pages li a[href="/p/2026-01-12-book-a"]').click();
    const box = page.locator("section.conflict");
    await expect(box).toBeVisible();
    await expect(box).toContainText("別の場所で変わっている");
    await expect(page.locator(".body")).toContainText("自分が足した行。");
    await box.locator("summary").click();
    await expect(box.locator("pre")).toContainText("相手が変えた");

    // 相手の内容にそろえると、下書きが消えて相手の内容が出る
    await box.getByRole("button", { name: "相手の内容にそろえる" }).click();
    await expect(page.locator("section.conflict")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本A（相手が変えた）");
    await expect(page.locator(".body")).not.toContainText("自分が足した行。");
  } finally {
    await restore();
  }
});

test("競合を自分の下書きで上書きすると、相手の sha で保存される", async ({ page, request }) => {
  const original = await readFile(`fixtures/${PATH}`, "utf8");
  const restore = () => putFile(request, PATH, original);
  await restore();

  try {
    await page.goto("/p/2026-01-12-book-a");
    await page.getByRole("button", { name: "編集" }).click();
    const cm = page.locator(".cm-content");
    await cm.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
    await page.keyboard.type("\n上書きする行。");
    await putFile(request, PATH, original.replace("# 見本の本A", "# 相手"));
    await page.locator("#links a", { hasText: "一覧" }).click();
    await expect(page.locator("#save-note")).toHaveText("別の場所で変わっている");

    // 下書きはメモリにあるので、再読み込みせずにページへ移る（索引の title は相手のものに変わっているので href で探す）
    await page.locator('#pages li a[href="/p/2026-01-12-book-a"]').click();
    await page.locator("section.conflict").getByRole("button", { name: "自分の下書きで上書き" }).click();
    await expect(page.locator("section.conflict")).toHaveCount(0);
    await expect.poll(async () => ((await (await request.get(API)).json()) as { content: string }).content).toContain("上書きする行。");
    const saved = ((await (await request.get(API)).json()) as { content: string }).content;
    expect(saved).toContain("# 見本の本A");
    expect(saved).not.toContain("# 相手");
    await expect(page.locator("#save-note")).toBeHidden();
  } finally {
    await restore();
  }
});

test("相手がページを消していたら、その旨が出て、下書きを捨てるとまだないページになる", async ({ page, request }) => {
  const original = await readFile(`fixtures/${PATH}`, "utf8");
  const restore = () => putFile(request, PATH, original);
  await restore();

  try {
    await page.goto("/p/2026-01-12-book-a");
    await page.getByRole("button", { name: "編集" }).click();
    const cm = page.locator(".cm-content");
    await cm.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
    await page.keyboard.type("\n消される前に足した行。");
    // 別のツールがファイルを消した
    await rm(`e2e/.data/${PATH}`);
    await page.locator("#links a", { hasText: "一覧" }).click();
    await expect(page.locator("#save-note")).toHaveText("別の場所で変わっている");

    // 索引には残っているので開ける。消された旨と下書きが出る
    await page.locator('#pages li a[href="/p/2026-01-12-book-a"]').click();
    const box = page.locator("section.conflict");
    await expect(box).toContainText("別の場所で消されている");
    await expect(page.locator(".body")).toContainText("消される前に足した行。");

    // 捨てると、まだないページになる
    await box.getByRole("button", { name: "下書きを捨てる" }).click();
    await expect(page.locator("article > .note")).toHaveText("まだないページ");
  } finally {
    await restore();
  }
});
