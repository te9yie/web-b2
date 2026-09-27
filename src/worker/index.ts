// Workerの入口。静的ファイル（SPA）は wrangler.jsonc の assets がWorkerを通さずに返し、
// /api/* だけがここに来る（run_worker_first）。
import { defaultVerifier, type AccessVerifier } from "./access.ts";

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// テストでは鍵の取得と時刻を差し替えた verify を渡す
export function createHandler(verify: AccessVerifier) {
  async function authenticated(req: Request, env: Env): Promise<boolean> {
    const token = req.headers.get("cf-access-jwt-assertion");
    if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
    try {
      return await verify(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
    } catch (e) {
      // 鍵を取れないときも確かめようがないので通さない
      console.error("Accessの検証に失敗", e);
      return false;
    }
  }

  return async (req: Request, env: Env): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (!(await authenticated(req, env))) return json({ error: "Accessを通っていない" }, 401);
    // GitHubへの中継は段階6で作る
    return json({ error: "まだない" }, 501);
  };
}

export default { fetch: createHandler(defaultVerifier) };
