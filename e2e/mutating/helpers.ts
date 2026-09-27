import type { APIRequestContext } from "@playwright/test";

// いまの sha を取ってから書く。競合の検出が入っても、既存のファイルへの書き戻しが 409 にならないように
export async function putFile(request: APIRequestContext, path: string, content: string): Promise<void> {
  const api = `/api/pages/${path}`;
  const current = await request.get(api);
  const sha = current.ok() ? ((await current.json()) as { sha: string }).sha : null;
  const res = await request.put(api, { data: { content, sha, message: "test" } });
  if (!res.ok()) throw new Error(`PUT ${path} が ${res.status()}`);
}
