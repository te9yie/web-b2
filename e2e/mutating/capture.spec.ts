import { readFile, rm } from "node:fs/promises";
import { type APIRequestContext, type Page, expect, test } from "@playwright/test";
import { putFile } from "./helpers";

// /new と /append から「保存」でページを作る・追記する。作ったファイルは消し、書き換えたファイルは fixtures/ の中身に戻す

const BOOK = "notes/2026-01-12-book-a.md";
const q = encodeURIComponent;

function todayHere(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function listPaths(request: APIRequestContext): Promise<string[]> {
  const body = (await (await request.get("/api/pages")).json()) as { pages: { path: string }[] };
  return body.pages.map((p) => p.path);
}

async function contentOf(request: APIRequestContext, path: string): Promise<string> {
  return ((await (await request.get(`/api/pages/${path}`)).json()) as { content: string }).content;
}

// 行き先が決まって「保存」を押せるまで待ってから押す
async function save(page: Page): Promise<void> {
  const button = page.locator("button.save");
  await expect(button).toBeEnabled();
  await button.click();
}

// 保存で増えたファイルを見つけ、テストの後に消す
async function withNewFiles(request: APIRequestContext, fn: (added: () => Promise<string[]>) => Promise<void>): Promise<void> {
  const before = await listPaths(request);
  const added = async () => (await listPaths(request)).filter((p) => !before.includes(p));
  try {
    await fn(added);
  } finally {
    for (const p of await added()) await rm(`e2e/.data/${p}`, { force: true });
  }
}

// 見本の本A を書き換えるテスト。前後で fixtures/ の中身に戻す
async function withBook(request: APIRequestContext, fn: (original: string) => Promise<void>): Promise<void> {
  const original = await readFile(`fixtures/${BOOK}`, "utf8");
  await putFile(request, BOOK, original);
  try {
    await fn(original.replace(/\r\n/g, "\n"));
  } finally {
    await putFile(request, BOOK, original);
  }
}

test("/new?title=&body= で、保存を押すと title を見出しにした新しいページができる", async ({ page, request }) => {
  await withNewFiles(request, async (added) => {
    const body = "一行目\n二行目 https://example.com/a?x=1&y=2";
    await page.goto(`/new?title=${q("取り込みの試し")}&body=${q(body)}`);
    await expect(page.locator(".capture-target")).toHaveText("新しいページ「取り込みの試し」を作る");
    await expect(page.locator("button.save")).toBeEnabled();
    // 開いただけでは書かない
    expect(await added()).toEqual([]);

    await save(page);
    await expect(page).toHaveURL(new RegExp(`/p/${q("取り込みの試し")}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("取り込みの試し");
    await expect(page.locator(".body")).toContainText("二行目 https://example.com/a?x=1&y=2");

    const files = await added();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^notes/${todayHere()}-\\d{6}\\.md$`));
    const today = todayHere();
    expect(await contentOf(request, files[0])).toBe(`---\ncreated: ${today}\nupdated: ${today}\n---\n\n# 取り込みの試し\n\n${body}\n`);

    // 確認画面は履歴に残らない
    await page.goBack();
    await expect(page).not.toHaveURL(/\/new/);
  });
});

test("/new?body= だけなら、見出しのない時刻のファイル名のページになる", async ({ page, request }) => {
  await withNewFiles(request, async (added) => {
    await page.goto(`/new?body=${q("タイトルなしの取り込み")}`);
    await expect(page.locator(".capture-target")).toHaveText("タイトルのない新しいページを作る");
    await save(page);
    await expect(page).toHaveURL(new RegExp(`/p/${todayHere()}-\\d{6}$`));
    await expect(page.locator(".body")).toContainText("タイトルなしの取り込み");
    const files = await added();
    expect(files).toHaveLength(1);
    expect(page.url()).toContain(`/p/${files[0].slice("notes/".length, -".md".length)}`);
    const content = await contentOf(request, files[0]);
    expect(content).toContain("タイトルなしの取り込み");
    expect(content).not.toMatch(/^# /m);
  });
});

test("/new の title が既存のページなら、新しく作らずに末尾へ追記する", async ({ page, request }) => {
  await withBook(request, async (original) => {
    const before = await listPaths(request);
    await page.goto(`/new?title=${q("見本の本A")}&body=${q("二度目の取り込み")}`);
    await expect(page.locator(".capture-target")).toContainText("同じ名前のページがあるので、その末尾に足す");
    await expect(page.locator("article.capture h1")).toHaveText("追記");
    await save(page);
    await expect(page).toHaveURL(/\/p\/2026-01-12-book-a$/);
    await expect(page.locator(".body")).toContainText("二度目の取り込み");
    expect(await listPaths(request)).toEqual(before);
    const content = await contentOf(request, BOOK);
    expect(content).toBe(`${original.replace("updated: 2026-01-12", `updated: ${todayHere()}`)}\n二度目の取り込み\n`);
  });
});

test("/append?page=&body= で、既存のページの末尾に空行を挟んで追記する", async ({ page, request }) => {
  await withBook(request, async (original) => {
    await page.goto(`/append?page=${q("見本の本A")}&body=${q("追記の見本")}`);
    await expect(page.locator(".capture-target")).toHaveText("「見本の本A」の末尾に足す");
    await expect(page.locator(".capture-tail")).toContainText("と同じ著者。");
    await save(page);
    await expect(page).toHaveURL(/\/p\/2026-01-12-book-a$/);
    await expect(page.locator(".body")).toContainText("追記の見本");
    const content = await contentOf(request, BOOK);
    expect(content.endsWith("と同じ著者。\n\n追記の見本\n")).toBe(true);
    expect(content).toContain("created: 2026-01-12");
    expect(content).toContain(`updated: ${todayHere()}`);
    expect(content.startsWith(original.replace("updated: 2026-01-12", `updated: ${todayHere()}`))).toBe(true);
  });
});

test("/append の page がまだないページなら、その名前を見出しにして作る", async ({ page, request }) => {
  await withNewFiles(request, async (added) => {
    await page.goto(`/append?page=${q("まだない取り込み先")}&body=${q("最初の追記")}`);
    await expect(page.locator(".capture-target")).toHaveText("新しいページ「まだない取り込み先」を作る");
    await save(page);
    await expect(page).toHaveURL(new RegExp(`/p/${q("まだない取り込み先")}$`));
    const files = await added();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^notes/${todayHere()}-\\d{6}\\.md$`));
    expect(await contentOf(request, files[0])).toMatch(/\n# まだない取り込み先\n\n最初の追記\n$/);
    // 開き直すと title で解決される
    await page.goto(`/p/${q("まだない取り込み先")}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("まだない取り込み先");
    await expect(page.locator(".body")).toContainText("最初の追記");
  });
});

test("確認画面で直した本文が保存される", async ({ page, request }) => {
  await withBook(request, async () => {
    await page.goto(`/append?page=${q("見本の本A")}&body=${q("元の本文")}`);
    await expect(page.locator("button.save")).toBeEnabled();
    await page.locator("textarea.capture-body").fill("書き換えた本文");
    await save(page);
    await expect(page).toHaveURL(/\/p\/2026-01-12-book-a$/);
    const content = await contentOf(request, BOOK);
    expect(content.endsWith("\n\n書き換えた本文\n")).toBe(true);
    expect(content).not.toContain("元の本文");
  });
});

test("確認画面を開いた後に別の場所で変わっていたら、ページに移って競合を出す", async ({ page, request }) => {
  await withBook(request, async (original) => {
    await page.goto(`/append?page=${q("見本の本A")}&body=${q("競合の見本")}`);
    await expect(page.locator("button.save")).toBeEnabled();
    await putFile(request, BOOK, `${original}別の場所で足した行。\n`);
    await save(page);
    await expect(page).toHaveURL(/\/p\/2026-01-12-book-a$/);
    await expect(page.locator("section.conflict")).toContainText("このページは別の場所で変わっている");
    // 上書きしていない
    const content = await contentOf(request, BOOK);
    expect(content).toContain("別の場所で足した行。");
    expect(content).not.toContain("競合の見本");
  });
});
