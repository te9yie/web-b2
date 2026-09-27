// テスト用に、Accessと同じ形（RS256）のJWTと鍵を作る
import type { Jwks } from "./access.ts";

export const teamDomain = "https://example.cloudflareaccess.com";
export const aud = "test-aud";
export const now = Date.UTC(2026, 8, 27, 12, 0, 0);

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

export async function createKey(kid: string): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid } };
}

export function jwks(...keys: TestKey[]): Jwks {
  return { keys: keys.map((k) => k.jwk) };
}

// 既定では、now の時点で有効なトークンになる。claims で上書きする
export async function sign(
  key: TestKey,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): Promise<string> {
  const nowSec = Math.floor(now / 1000);
  const head = encodeJson({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const body = encodeJson({ aud: [aud], iss: teamDomain, iat: nowSec, nbf: nowSec, exp: nowSec + 3600, ...claims });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${base64Url(new Uint8Array(signature))}`;
}
