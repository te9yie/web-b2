import { expect, test } from "@playwright/test";

// 取り込みの確認画面（/new と /append）。ここでは「保存」を押さない（fixtures/ を書き換えない）。
// 保存するテストは e2e/mutating/capture.spec.ts

function todayHere(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const q = encodeURIComponent;

test("細工した本文は確認画面で動かず、textarea の文字として出る", async ({ page }) => {
  const payload = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`;
  await page.goto(`/new?title=x&body=${q(payload)}`);
  await expect(page.locator("textarea.capture-body")).toHaveValue(payload);
  await expect(page.locator(".capture-warnings")).toContainText("本文に HTML が含まれている");
  await expect(page.locator("button.save")).toBeEnabled();
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(page.locator("article.capture img, article.capture script")).toHaveCount(0);
});

test("差分の同期が終わるまで「保存」を押せない", async ({ page }) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/pages", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(`/new?title=${q("まだないページ")}&body=x`);
  await expect(page.locator(".capture-status")).toHaveText("差分を確認中。終わると保存できる");
  await expect(page.locator("button.save")).toBeDisabled();
  // 待っているあいだも本文は直せる。同期の後に描き直されて消えない
  await page.locator("textarea.capture-body").fill("直した本文");
  release();
  await expect(page.locator("button.save")).toBeEnabled();
  await expect(page.locator(".capture-target")).toHaveText("新しいページ「まだないページ」を作る");
  await expect(page.locator("textarea.capture-body")).toHaveValue("直した本文");
});

test("差分を取れないと「保存」を出さずに理由を出す", async ({ page }) => {
  await page.route("**/api/pages", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"落ちた"}' }));
  await page.goto("/append?page=x&body=y");
  await expect(page.locator(".capture-status")).toContainText("差分を取れないので保存できない");
  await expect(page.locator("button.save")).toHaveCount(0);
});

test("同じ内容がすでに末尾にあるときと、settings ページに書くときに注意を出す", async ({ page }) => {
  await page.goto(`/append?page=${q("取り込みの見本")}&body=${q("https://example.com/article")}`);
  await expect(page.locator(".capture-target")).toHaveText("「取り込みの見本」の末尾に足す");
  await expect(page.locator(".capture-tail")).toContainText("https://example.com/article");
  await expect(page.locator(".capture-warnings")).toContainText("同じ内容がすでに末尾にある");
  await expect(page.locator("button.save")).toBeEnabled();

  await page.goto("/append?page=settings&body=x");
  await expect(page.locator("button.save")).toBeEnabled();
  await expect(page.locator(".capture-warnings")).toContainText("settings ページに書く");
});

test("行き先か本文がなければ「保存」を出さずに理由を出す", async ({ page }) => {
  await page.goto("/new");
  await expect(page.locator(".capture-target")).toHaveText("title も body もない");
  await expect(page.locator("button.save")).toHaveCount(0);

  await page.goto(`/append?page=${q("見本の本A")}`);
  await expect(page.locator(".capture-target")).toHaveText("body がない（見本の本A）");
  await expect(page.locator("button.save")).toHaveCount(0);

  await page.goto(`/new?title=${q("見本の本A")}`);
  await expect(page.locator(".capture-target")).toHaveText("同じ名前のページがある（見本の本A）");
  await expect(page.locator("button.save")).toHaveCount(0);
});

test("別のサイトの枠の中では保存できない", async ({ page, baseURL }) => {
  await page.setContent(`<iframe src="${baseURL}/new?body=x" width="800" height="600"></iframe>`);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator(".capture-status")).toHaveText("枠の中では保存できない");
  await expect(frame.locator("button.save")).toHaveCount(0);
});

test("「やめる」で何も書かずに今日のページへ移り、戻っても確認画面に戻らない", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "PUT") writes.push(req.url());
  });
  await page.goto(`/new?title=${q("やめる見本")}&body=x`);
  await expect(page.locator("button.save")).toBeEnabled();
  await page.getByRole("button", { name: "やめる" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${todayHere()}$`));
  await page.goBack();
  await expect(page).not.toHaveURL(/\/new/);
  expect(writes).toEqual([]);
});
