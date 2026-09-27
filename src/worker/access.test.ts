import { beforeAll, describe, expect, it } from "vitest";
import { createAccessVerifier, normalizeTeamDomain, type Jwks } from "./access";
import { aud, createKey, jwks, now, sign, teamDomain, type TestKey } from "./jwt-test-helper";

let key: TestKey;
let other: TestKey;

beforeAll(async () => {
  key = await createKey("k1");
  other = await createKey("k2");
});

// 鍵の取得を数え、時刻を進められるようにした verifier
function setup(certs: () => Jwks) {
  const state = { now, fetched: [] as string[] };
  const verify = createAccessVerifier({
    fetchCerts: async (url) => {
      state.fetched.push(url);
      return certs();
    },
    now: () => state.now,
  });
  return { state, verify };
}

const config = { teamDomain, aud };

describe("createAccessVerifier", () => {
  it("正しいトークンを通し、チームドメインの certs から鍵を取る", async () => {
    const { state, verify } = setup(() => jwks(key));
    expect(await verify(await sign(key), config)).toBe(true);
    expect(state.fetched).toEqual([`${teamDomain}/cdn-cgi/access/certs`]);
  });

  it("aud が文字列でも通す", async () => {
    const { verify } = setup(() => jwks(key));
    expect(await verify(await sign(key, { aud }), config)).toBe(true);
  });

  it("別の鍵で署名したものは通さない", async () => {
    const { verify } = setup(() => jwks(key));
    const forged = await sign({ ...other, kid: "k1" });
    expect(await verify(forged, config)).toBe(false);
  });

  it("本文を書き換えたものは通さない", async () => {
    const { verify } = setup(() => jwks(key));
    const [h, , s] = (await sign(key)).split(".");
    const [, b] = (await sign(key, { email: "someone" })).split(".");
    expect(await verify(`${h}.${b}.${s}`, config)).toBe(false);
  });

  it("aud が違えば通さない", async () => {
    const { verify } = setup(() => jwks(key));
    expect(await verify(await sign(key, { aud: ["other"] }), config)).toBe(false);
  });

  it("iss が違えば通さない", async () => {
    const { verify } = setup(() => jwks(key));
    expect(await verify(await sign(key, { iss: "https://evil.cloudflareaccess.com" }), config)).toBe(false);
  });

  it("期限切れ・exp なし・nbf より前は通さない", async () => {
    const { verify } = setup(() => jwks(key));
    const nowSec = Math.floor(now / 1000);
    expect(await verify(await sign(key, { exp: nowSec }), config)).toBe(false);
    expect(await verify(await sign(key, { exp: undefined }), config)).toBe(false);
    expect(await verify(await sign(key, { nbf: nowSec + 60 }), config)).toBe(false);
  });

  it("RS256 以外や kid のないものは通さない", async () => {
    const { verify } = setup(() => jwks(key));
    expect(await verify(await sign(key, {}, { alg: "none" }), config)).toBe(false);
    expect(await verify(await sign(key, {}, { alg: "HS256" }), config)).toBe(false);
    expect(await verify(await sign(key, {}, { kid: undefined }), config)).toBe(false);
  });

  it("JWTの形でないものは通さない", async () => {
    const { verify } = setup(() => jwks(key));
    for (const token of ["", "a.b", "a.b.c", "!!.!!.!!", `${(await sign(key)).slice(0, -2)}*`]) {
      expect(await verify(token, config)).toBe(false);
    }
  });

  it("鍵は使い回し、知らない kid が来たら取り直す", async () => {
    let keys = jwks(key);
    const { state, verify } = setup(() => keys);
    await verify(await sign(key), config);
    await verify(await sign(key), config);
    expect(state.fetched).toHaveLength(1);

    // 鍵が入れ替わった。取り直しの間隔を空けてから来れば通す
    keys = jwks(key, other);
    state.now += 2 * 60 * 1000;
    expect(await verify(await sign(other), config)).toBe(true);
    expect(state.fetched).toHaveLength(2);
  });

  it("知らない kid が続いても、すぐには取り直さない", async () => {
    const { state, verify } = setup(() => jwks(key));
    await verify(await sign(key), config);
    expect(await verify(await sign(other), config)).toBe(false);
    expect(await verify(await sign(other), config)).toBe(false);
    expect(state.fetched).toHaveLength(1);
  });
});

describe("normalizeTeamDomain", () => {
  it("https:// を補い、末尾の / を落とす", () => {
    expect(normalizeTeamDomain("example.cloudflareaccess.com")).toBe(teamDomain);
    expect(normalizeTeamDomain("https://example.cloudflareaccess.com/")).toBe(teamDomain);
    expect(normalizeTeamDomain(` ${teamDomain} `)).toBe(teamDomain);
  });
});
