// vertex.test.mjs — offline tests for the Vertex summary provider.
// No network: a real RSA keypair signs the JWT; an injected fetch fakes Google.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildSignedJwt, createVertex, loadVertexConfig } from "./vertex.mjs";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIV = privateKey.export({ type: "pkcs8", format: "pem" });
const PUB = publicKey.export({ type: "spki", format: "pem" });

const fakeCreds = {
  client_email: "observer@proj.iam.gserviceaccount.com",
  private_key: PRIV,
  token_uri: "https://oauth2.googleapis.com/token",
  project_id: "proj-123",
};

function decode(seg) {
  return JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

test("buildSignedJwt: well-formed claims and verifiable RS256 signature", () => {
  const jwt = buildSignedJwt(fakeCreds, 1_000_000);
  const [h, p, sig] = jwt.split(".");
  assert.deepEqual(decode(h), { alg: "RS256", typ: "JWT" });
  const claims = decode(p);
  assert.equal(claims.iss, fakeCreds.client_email);
  assert.equal(claims.aud, fakeCreds.token_uri);
  assert.equal(claims.scope, "https://www.googleapis.com/auth/cloud-platform");
  assert.equal(claims.iat, 1_000_000);
  assert.equal(claims.exp, 1_003_600);
  const ok = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${h}.${p}`),
    PUB,
    Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
  );
  assert.equal(ok, true, "signature verifies with the public key");
});

test("createVertex: token exchange + generateContent parse (injected fetch)", async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes("oauth2.googleapis.com/token")) {
      assert.match(opts.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
      assert.match(opts.body, /assertion=/);
      return { ok: true, json: async () => ({ access_token: "ya29.fake", expires_in: 3600 }) };
    }
    // generateContent
    assert.match(url, /aiplatform\.googleapis\.com\/v1\/projects\/proj-123\/locations\/global\/publishers\/google\/models\/gemini-3\.1-flash-lite:generateContent$/);
    assert.equal(opts.headers.authorization, "Bearer ya29.fake");
    const body = JSON.parse(opts.body);
    assert.equal(body.system_instruction.parts[0].text, "SYS");
    assert.equal(body.contents[0].parts[0].text, "USER");
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "a summary" }] } }] }) };
  };
  const cfg = { creds: fakeCreds, project: "proj-123", location: "global", model: "gemini-3.1-flash-lite" };
  const v = createVertex(cfg, { fetch: fakeFetch, now: () => 5_000_000 });
  const out = await v.summarize("SYS", "USER");
  assert.equal(out, "a summary");
  assert.equal(calls.length, 2, "one token call + one generate call");

  // Second call reuses the cached token (no second token exchange).
  await v.summarize("SYS", "USER");
  const tokenCalls = calls.filter((c) => c.url.includes("oauth2.googleapis.com/token"));
  assert.equal(tokenCalls.length, 1, "access token cached across calls");
});

test("createVertex: regional location builds prefixed host", async () => {
  let genUrl;
  const fakeFetch = async (url) => {
    if (url.includes("oauth2")) return { ok: true, json: async () => ({ access_token: "t", expires_in: 3600 }) };
    genUrl = url;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "x" }] } }] }) };
  };
  const v = createVertex({ creds: fakeCreds, project: "p", location: "us-central1", model: "m" }, { fetch: fakeFetch, now: () => 1 });
  await v.summarize("s", "u");
  assert.match(genUrl, /^https:\/\/us-central1-aiplatform\.googleapis\.com\/v1\/projects\/p\/locations\/us-central1\//);
});

test("loadVertexConfig: returns null when no credentials path", () => {
  assert.equal(loadVertexConfig({}), null);
  assert.equal(loadVertexConfig({ GOOGLE_APPLICATION_CREDENTIALS: "" }), null);
});

test("createVertex: surfaces token-exchange failure", async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const v = createVertex({ creds: fakeCreds, project: "p", location: "global", model: "m" }, { fetch: fakeFetch, now: () => 1 });
  await assert.rejects(v.summarize("s", "u"), /token exchange 401/);
});
