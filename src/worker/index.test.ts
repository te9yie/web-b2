import { beforeAll, describe, expect, it } from "vitest";
import { createAccessVerifier } from "./access";
import { createHandler, type Env } from "./index";
import { aud, createKey, jwks, now, sign, teamDomain, type TestKey } from "./jwt-test-helper";

let key: TestKey;
let handle: ReturnType<typeof createHandler>;

beforeAll(async () => {
  key = await createKey("k1");
  handle = createHandler(createAccessVerifier({ fetchCerts: async () => jwks(key), now: () => now }));
});

// 静的ファイルの代わりに、呼ばれたパスを返す
const env: Env = {
  ASSETS: { fetch: async (req) => new Response(`assets:${new URL(req.url).pathname}`) },
  ACCESS_TEAM_DOMAIN: teamDomain,
  ACCESS_AUD: aud,
};

function call(path: string, init?: RequestInit, e: Env = env): Promise<Response> {
  return handle(new Request(`http://localhost${path}`, init), e);
}

async function signedIn(): Promise<RequestInit> {
  return { headers: { "cf-access-jwt-assertion": await sign(key) } };
}

describe("振り分け", () => {
  it("/api/* 以外は静的ファイルに渡す", async () => {
    const res = await call("/p/foo");
    expect(await res.text()).toBe("assets:/p/foo");
  });

  it("/apiary のように /api/ で始まらないパスも静的ファイルに渡す", async () => {
    const res = await call("/apiary");
    expect(await res.text()).toBe("assets:/apiary");
  });
});

describe("Access", () => {
  it("ヘッダーがなければ /api/pages は401で、理由は no-token", async () => {
    const res = await call("/api/pages");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Accessを通っていない", reason: "no-token" });
  });

  it("検証を通らないトークンは401", async () => {
    const token = await sign(key, { aud: ["other"] });
    const res = await call("/api/pages", { headers: { "cf-access-jwt-assertion": token } });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: "Accessを通っていない",
      reason: "aud",
      tokenAud: ["other"],
      expectedLength: aud.length,
    });
    // トークン本体と署名は返さない
    for (const part of token.split(".")) expect(text).not.toContain(part);
  });

  it("検証を通れば401にしない", async () => {
    const res = await call("/api/pages", await signedIn());
    expect(res.status).not.toBe(401);
  });

  it("ACCESS_TEAM_DOMAIN か ACCESS_AUD が未設定なら401で、理由は secret-missing", async () => {
    const init = await signedIn();
    for (const e of [{ ...env, ACCESS_TEAM_DOMAIN: undefined }, { ...env, ACCESS_AUD: "" }]) {
      const res = await call("/api/pages", init, e);
      expect(res.status).toBe(401);
      expect(await res.json()).toHaveProperty("reason", "secret-missing");
    }
  });

  it("鍵を取れなければ401", async () => {
    const failing = createHandler(
      createAccessVerifier({
        fetchCerts: async () => {
          throw new Error("network");
        },
        now: () => now,
      }),
    );
    const res = await failing(new Request("http://localhost/api/pages", await signedIn()), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toHaveProperty("reason", "certs-fetch-failed");
  });

  it("/api/whoami はもうない", async () => {
    expect((await call("/api/whoami")).status).toBe(401);
    expect((await call("/api/whoami", await signedIn())).status).not.toBe(200);
  });
});
