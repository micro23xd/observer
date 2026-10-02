// vertex.mjs — Vertex AI summary provider (zero runtime deps).
//
// Isolates the one LLM touchpoint behind a single seam. Auth is a service-account
// JWT exchanged for a short-lived OAuth2 access token, signed with node:crypto:
//
//   sa.json ─► sign RS256 JWT ─► POST oauth2/token ─► access_token (cached, refreshed)
//                                                          │ Bearer
//   POST {host}/v1/projects/{proj}/locations/{loc}/publishers/google/models/{model}:generateContent
//
// fetch + clock are injectable (deps) so the whole flow is testable offline.

import crypto from "node:crypto";
import fs from "node:fs";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_MODEL = "gemini-3.1-flash-lite";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Read + validate the service-account config. Returns null (never throws) when the
// credentials path is unset/unreadable/unparseable so summaries degrade gracefully.
export function loadVertexConfig(env = process.env) {
  const path = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) return null;
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`vertex: cannot read credentials at ${path}: ${e.message} — summaries disabled`);
    return null;
  }
  if (!creds.client_email || !creds.private_key) {
    console.error("vertex: credentials missing client_email/private_key — summaries disabled");
    return null;
  }
  return {
    creds,
    project: env.VERTEX_PROJECT || creds.project_id,
    location: env.VERTEX_LOCATION || "global",
    model: env.OBSERVER_MODEL || DEFAULT_MODEL,
  };
}

// Build a signed RS256 JWT asserting the service account. Exported for unit testing.
export function buildSignedJwt(creds, nowSec) {
  const header = { alg: "RS256", typ: "JWT" };
  const tokenUri = creds.token_uri || "https://oauth2.googleapis.com/token";
  const claims = {
    iss: creds.client_email,
    scope: SCOPE,
    aud: tokenUri,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), creds.private_key);
  return `${signingInput}.${b64url(signature)}`;
}

function vertexHost(location) {
  return location === "global"
    ? "https://aiplatform.googleapis.com"
    : `https://${location}-aiplatform.googleapis.com`;
}

// Factory: returns { summarize(system, user) }. Token is cached in the closure and
// refreshed 300s before expiry to survive a multi-day daemon.
export function createVertex(config, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const now = deps.now || (() => Date.now());
  const tokenUri = config.creds.token_uri || "https://oauth2.googleapis.com/token";
  let token = null;
  let tokenExpMs = 0;

  async function accessToken() {
    if (token && now() < tokenExpMs - 300_000) return token;
    const jwt = buildSignedJwt(config.creds, Math.floor(now() / 1000));
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    });
    const res = await fetchImpl(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`vertex token exchange ${res.status}`);
    const data = await res.json();
    if (!data.access_token) throw new Error("vertex token exchange: no access_token");
    token = data.access_token;
    tokenExpMs = now() + (data.expires_in || 3600) * 1000;
    return token;
  }

  async function summarize(system, user) {
    const at = await accessToken();
    const { project, location, model } = config;
    const url = `${vertexHost(location)}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${at}` },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 400 },
      }),
    });
    if (!res.ok) throw new Error(`vertex generateContent ${res.status}`);
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text).filter(Boolean).join("").trim();
  }

  return { summarize, accessToken };
}
