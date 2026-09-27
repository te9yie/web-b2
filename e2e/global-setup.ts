// 書き換えるテスト（e2e/mutating/）のために、fixtures/ を e2e/.data に写す。テストのたびに作り直す
import { cp, rm } from "node:fs/promises";

export const MUTABLE_ROOT = "e2e/.data";

export default async function globalSetup(): Promise<void> {
  await rm(MUTABLE_ROOT, { recursive: true, force: true });
  await cp("fixtures", MUTABLE_ROOT, { recursive: true });
}
