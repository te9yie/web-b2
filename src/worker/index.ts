// Workerの入口。静的ファイル（SPA）は wrangler.jsonc の assets がWorkerを通さずに返し、
// /api/* だけがここに来る（run_worker_first）。

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

// Workerの ctx のうち使うところだけ。Accessを通ったリクエストには access が付く。
export interface Context {
  access?: unknown;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function hasCookie(req: Request, name: string): boolean {
  const cookie = req.headers.get("cookie") ?? "";
  return cookie.split(";").some((c) => c.trim().startsWith(`${name}=`));
}

// 静的ファイルを持つWorkerには ctx.access が渡らないとドキュメントにあるため、本番で何が届くかを確かめる。
// 値は返さず有無だけを返す。確かめ終わったら消す。
function whoami(req: Request, ctx: Context): Response {
  return json({
    access: ctx.access !== undefined,
    jwtHeader: req.headers.has("cf-access-jwt-assertion"),
    cookie: hasCookie(req, "CF_Authorization"),
  });
}

export async function handle(req: Request, env: Env, ctx: Context): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
  if (pathname === "/api/whoami") return whoami(req, ctx);
  if (ctx.access === undefined) return json({ error: "Accessを通っていない" }, 401);
  // GitHubへの中継は段階6で作る
  return json({ error: "まだない" }, 501);
}

export default { fetch: handle };
