import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { expect, test } from "@playwright/test";
import { type TarInput, makeTarGz } from "../src/client/tar-test-helper";

// tarball の経路（DecompressionStream とストリームの読み方）をブラウザで通す。
// ローカルモードには /api/archive も一覧の head もないので、一覧に head を足し、/api/archive に fixtures/ から作った tar.gz を返す
async function fixtureEntries(root: string): Promise<TarInput[]> {
  const out: TarInput[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push({ path: relative(root, full).split("\\").join("/"), content: new Uint8Array(await readFile(full)) });
    }
  };
  await walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

test("初回は tarball で全件を取り、2回目は tarball もページも取り直さない", async ({ page }) => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  const tgz = makeTarGz(await fixtureEntries("fixtures"), { top: "owner-kb-0123456", comment: head });
  let archives = 0;
  const reads: string[] = [];
  page.on("request", (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.startsWith("/api/pages/")) reads.push(pathname);
  });
  await page.route(
    (url) => url.pathname === "/api/pages",
    async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), head } });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/archive",
    async (route) => {
      archives++;
      await route.fulfill({ status: 200, contentType: "application/gzip", headers: { "x-head": head }, body: Buffer.from(tgz) });
    },
  );

  await page.goto("/all");
  await expect(page.locator("#pages li")).toHaveCount(16);
  await expect(page.locator("#status")).toHaveText("16ページ（16件を読み直し）");
  expect(archives).toBe(1);
  expect(reads).toEqual([]);

  archives = 0;
  await page.reload();
  await expect(page.locator("#pages li")).toHaveCount(16);
  await expect(page.locator("#status")).toHaveText("16ページ（0件を読み直し）");
  expect(archives).toBe(0);
  expect(reads).toEqual([]);

  // tarball から入れた中身で表示できる。差分の一覧を受け取るまで待つ（テストの終わりに route の処理が残らないように）
  const listed = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/pages");
  await page.goto("/p/見本の本A");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("見本の本A");
  await listed;
  expect(archives).toBe(0);
});
