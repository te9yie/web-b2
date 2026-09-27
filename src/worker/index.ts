// Workerの入口。静的ファイル（SPA）は wrangler.jsonc の assets がWorkerを通さずに返し、
// /api/* だけがここに来る（run_worker_first）。
import { defaultVerifier, type AccessVerifier } from "./access.ts";
import { type GitHubEnv, createGitHubApi } from "./api.ts";

export interface Env extends GitHubEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// テストでは鍵の取得と時刻を差し替えた verify と、GitHub の代わりの fetch を渡す
export function createHandler(verify: AccessVerifier, githubFetch: typeof fetch = (input, init) => fetch(input, init)) {
  async function authenticated(req: Request, env: Env): Promise<boolean> {
    const token = req.headers.get("cf-access-jwt-assertion");
    if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
    return (await verify(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD })).ok;
  }

  return async (req: Request, env: Env): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (!(await authenticated(req, env))) return json({ error: "Accessを通っていない" }, 401);
    return createGitHubApi(env, githubFetch)(req);
  };
}

export default { fetch: createHandler(defaultVerifier) };
