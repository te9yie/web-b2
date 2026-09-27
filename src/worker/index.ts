// Workerの入口。静的ファイル（SPA）は wrangler.jsonc の assets がWorkerを通さずに返し、
// /api/* だけがここに来る（run_worker_first）。
import { defaultVerifier, type AccessResult, type AccessVerifier } from "./access.ts";

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
  async function authenticate(req: Request, env: Env): Promise<AccessResult | { ok: false; reason: string }> {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { ok: false, reason: "secret-missing" };
    const token = req.headers.get("cf-access-jwt-assertion");
    if (!token) return { ok: false, reason: "no-token" };
    return verify(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
  }

  return async (req: Request, env: Env): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    const auth = await authenticate(req, env);
    if (!auth.ok) {
      // 401の原因を調べるため、一時的に理由も返す。原因が分かったら error だけに戻す
      const { ok: _, ...detail } = auth;
      return json({ error: "Accessを通っていない", ...detail }, 401);
    }
    // GitHubへの中継は段階6で作る
    return json({ error: "まだない" }, 501);
  };
}

export default { fetch: createHandler(defaultVerifier) };
