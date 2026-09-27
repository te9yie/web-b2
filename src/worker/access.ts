// Cloudflare Access が付ける Cf-Access-Jwt-Assertion のJWTを検証する。
// 静的ファイルを持つWorkerには ctx.access が渡らないので、自分で確かめる（DECISIONS.md）。

export interface AccessConfig {
  // https://<チーム名>.cloudflareaccess.com。JWTの iss と比べる
  teamDomain: string;
  // AccessのアプリのAUDタグ
  aud: string;
}

export interface Jwks {
  keys: (JsonWebKey & { kid?: string })[];
}

export interface VerifierDeps {
  fetchCerts(url: string): Promise<Jwks>;
  // ミリ秒
  now(): number;
}

// 通らなかった理由。401の原因を調べるため、一時的に本文にも出している
export type AccessFailure =
  | { reason: "bad-format" | "alg" | "no-key" | "certs-fetch-failed" | "signature" | "exp" | "nbf" }
  | { reason: "aud"; tokenAud: unknown; expectedLength: number }
  | { reason: "iss"; tokenIss: unknown; expectedLength: number };

export type AccessResult = { ok: true } | ({ ok: false } & AccessFailure);

export type AccessVerifier = (token: string, config: AccessConfig) => Promise<AccessResult>;

// 鍵は取り直さずに使い回す。知らない kid が来たら取り直すが、間隔は空ける
const cacheMs = 60 * 60 * 1000;
const refetchMs = 60 * 1000;

// 末尾の / を落とし、https:// がなければ付ける
export function normalizeTeamDomain(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return /^https:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("base64urlではない");
  const binary = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(s: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(s)));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("JSONのオブジェクトではない");
  return value as Record<string, unknown>;
}

export function createAccessVerifier(deps: VerifierDeps): AccessVerifier {
  const cache = new Map<string, { jwks: Jwks; fetchedAt: number }>();

  async function findKey(certsUrl: string, kid: string): Promise<JsonWebKey | undefined> {
    const now = deps.now();
    let entry = cache.get(certsUrl);
    const find = () => entry?.jwks.keys.find((k) => k.kid === kid);
    if (!entry || now - entry.fetchedAt > cacheMs || (!find() && now - entry.fetchedAt > refetchMs)) {
      entry = { jwks: await deps.fetchCerts(certsUrl), fetchedAt: now };
      cache.set(certsUrl, entry);
    }
    return find();
  }

  return async (token, config): Promise<AccessResult> => {
    const fail = (failure: AccessFailure): AccessResult => ({ ok: false, ...failure });
    const teamDomain = normalizeTeamDomain(config.teamDomain);
    const parts = token.split(".");
    if (parts.length !== 3) return fail({ reason: "bad-format" });
    const [headerPart, payloadPart, signaturePart] = parts;
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    let signature: Uint8Array<ArrayBuffer>;
    try {
      header = decodeJson(headerPart);
      payload = decodeJson(payloadPart);
      signature = base64UrlDecode(signaturePart);
    } catch {
      return fail({ reason: "bad-format" });
    }
    if (header.alg !== "RS256") return fail({ reason: "alg" });
    if (typeof header.kid !== "string") return fail({ reason: "no-key" });

    let jwk: JsonWebKey | undefined;
    try {
      jwk = await findKey(`${teamDomain}/cdn-cgi/access/certs`, header.kid);
    } catch (e) {
      console.error("Accessの鍵を取れない", e);
      return fail({ reason: "certs-fetch-failed" });
    }
    if (!jwk) return fail({ reason: "no-key" });
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "verify",
      ]);
    } catch {
      return fail({ reason: "no-key" });
    }
    const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed))) {
      return fail({ reason: "signature" });
    }

    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(config.aud)) {
      return fail({ reason: "aud", tokenAud: payload.aud, expectedLength: config.aud.length });
    }
    if (payload.iss !== teamDomain) {
      return fail({ reason: "iss", tokenIss: payload.iss, expectedLength: teamDomain.length });
    }
    const nowSec = deps.now() / 1000;
    if (typeof payload.exp !== "number" || payload.exp <= nowSec) return fail({ reason: "exp" });
    if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > nowSec)) {
      return fail({ reason: "nbf" });
    }
    return { ok: true };
  };
}

export const defaultVerifier = createAccessVerifier({
  async fetchCerts(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`鍵を取れない: ${res.status}`);
    return (await res.json()) as Jwks;
  },
  now: () => Date.now(),
});
