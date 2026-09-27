import { describe, expect, it } from "vitest";
import { handle, type Context, type Env } from "./index";

// 静的ファイルの代わりに、呼ばれたパスを返す
const env: Env = {
  ASSETS: { fetch: async (req) => new Response(`assets:${new URL(req.url).pathname}`) },
};
const signedIn: Context = { access: { aud: "test" } };

function call(path: string, ctx: Context, init?: RequestInit): Promise<Response> {
  return handle(new Request(`http://localhost${path}`, init), env, ctx);
}

describe("振り分け", () => {
  it("/api/* 以外は静的ファイルに渡す", async () => {
    const res = await call("/p/foo", {});
    expect(await res.text()).toBe("assets:/p/foo");
  });

  it("/apiary のように /api/ で始まらないパスも静的ファイルに渡す", async () => {
    const res = await call("/apiary", {});
    expect(await res.text()).toBe("assets:/apiary");
  });
});

describe("Access", () => {
  it("ctx.access がなければ /api/pages は401", async () => {
    const res = await call("/api/pages", {});
    expect(res.status).toBe(401);
    expect(await res.json()).toHaveProperty("error");
  });

  it("ctx.access があれば401にしない", async () => {
    const res = await call("/api/pages", signedIn);
    expect(res.status).not.toBe(401);
  });
});

describe("GET /api/whoami", () => {
  it("何もなければすべて false", async () => {
    const res = await call("/api/whoami", {});
    expect(await res.json()).toEqual({ access: false, jwtHeader: false, cookie: false });
  });

  it("有無だけを返し、値は返さない", async () => {
    const res = await call("/api/whoami", signedIn, {
      headers: { "cf-access-jwt-assertion": "secret-jwt", cookie: "a=1; CF_Authorization=secret-cookie" },
    });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ access: true, jwtHeader: true, cookie: true });
    expect(text).not.toContain("secret");
  });
});
