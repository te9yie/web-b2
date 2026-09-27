// 書き換えるテスト（e2e/mutating/）のために、fixtures/ を e2e/.data に写す。テストのたびに作り直す。
// Playwright は webServer を globalSetup より先に起動するが、ローカルモードのサーバーは起動時にディレクトリを見ず、
// リクエストのたびに読むので順序は問題にならない（src/server/local.ts）
import { cp, rm } from "node:fs/promises";

export const MUTABLE_ROOT = "e2e/.data";

export default async function globalSetup(): Promise<void> {
  await rm(MUTABLE_ROOT, { recursive: true, force: true });
  await cp("fixtures", MUTABLE_ROOT, { recursive: true });
}
