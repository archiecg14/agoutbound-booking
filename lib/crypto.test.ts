import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CryptoNotConfigured, decryptSecret, encryptSecret, isEncrypted } from "./crypto.ts";
import {
  consentUrl,
  makeInvite,
  signPayload,
  subjectFromIdToken,
  verifyPayload,
} from "./oauth.ts";

// Both modules read env lazily inside their functions, so setting it here is enough — no
// import ordering games required.
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.SIGNING_KEY = "test-signing-secret";

const TOKEN = "1//0gExampleRefreshTokenValue_abcdef";

// ── encryption ──────────────────────────────────────────────────────────────

test("a secret round-trips", () => {
  assert.equal(decryptSecret(encryptSecret(TOKEN)), TOKEN);
});

test("the same plaintext encrypts differently every time", () => {
  // A fixed IV would let anyone with the database tell which clients share a token, and
  // worse, is catastrophic for GCM specifically.
  assert.notEqual(encryptSecret(TOKEN), encryptSecret(TOKEN));
});

test("tampering is detected rather than decrypting to rubbish", () => {
  const enc = encryptSecret(TOKEN);
  const [v, iv, data, tag] = enc.split(".");

  const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
  assert.throws(() => decryptSecret([v, iv, flip(data), tag].join(".")), /unable|bad|decrypt/i);
  assert.throws(() => decryptSecret([v, iv, data, flip(tag)].join(".")), /unable|bad|decrypt/i);
  assert.throws(() => decryptSecret([v, flip(iv), data, tag].join(".")), /unable|bad|decrypt/i);
});

test("a foreign or malformed format is refused", () => {
  for (const bad of ["", "plaintext-token", "v2.a.b.c", "v1.only.three"]) {
    assert.throws(() => decryptSecret(bad));
  }
});

test("isEncrypted distinguishes stored formats", () => {
  assert.equal(isEncrypted(encryptSecret(TOKEN)), true);
  assert.equal(isEncrypted(TOKEN), false, "a legacy plaintext row must be recognisable");
});

test("a missing or wrong-sized key fails loudly instead of using a default", () => {
  const saved = process.env.TOKEN_ENCRYPTION_KEY;
  try {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.throws(() => encryptSecret(TOKEN), CryptoNotConfigured);

    process.env.TOKEN_ENCRYPTION_KEY = Buffer.from("too short").toString("base64");
    assert.throws(() => encryptSecret(TOKEN), CryptoNotConfigured);
  } finally {
    process.env.TOKEN_ENCRYPTION_KEY = saved;
  }
});

// ── signed payloads ─────────────────────────────────────────────────────────

test("a signed payload round-trips", () => {
  const t = signPayload({ k: "invite", clientId: "cl-1" });
  assert.deepEqual(verifyPayload(t), { k: "invite", clientId: "cl-1" });
});

test("an altered payload or signature is rejected", () => {
  const t = signPayload({ k: "invite", clientId: "cl-1" });
  const [body, sig] = [t.slice(0, t.lastIndexOf(".")), t.slice(t.lastIndexOf(".") + 1)];

  const forged = Buffer.from(JSON.stringify({ k: "invite", clientId: "cl-EVIL" })).toString("base64url");
  assert.equal(verifyPayload(`${forged}.${sig}`), null, "cannot swap in another client");
  assert.equal(verifyPayload(`${body}.${"A".repeat(sig.length)}`), null);
  assert.equal(verifyPayload(null), null);
  assert.equal(verifyPayload("nonsense"), null);
});

test("expiry is enforced by the verifier, not by each caller", () => {
  assert.equal(verifyPayload(signPayload({ k: "state", exp: Date.now() - 1000 })), null);
  assert.ok(verifyPayload(signPayload({ k: "state", exp: Date.now() + 60_000 })));
});

test("an invite carries its purpose and an expiry", () => {
  const inv = verifyPayload<{ k: string; clientId: string; exp: number }>(makeInvite("cl-1"));
  assert.equal(inv?.k, "invite");
  assert.equal(inv?.clientId, "cl-1");
  assert.ok(inv!.exp > Date.now());
});

test("signing does NOT fall back to LINKS_API_KEY", () => {
  // The separation is the whole point: LINKS_API_KEY is handed to the lead-build tooling,
  // SIGNING_KEY never leaves the server. A fallback would silently re-merge them and let a
  // holder of the minting key forge manage tokens and operator sessions.
  const saved = { sign: process.env.SIGNING_KEY, links: process.env.LINKS_API_KEY };
  try {
    delete process.env.SIGNING_KEY;
    process.env.LINKS_API_KEY = "the-minting-bearer-token";
    assert.throws(() => signPayload({ k: "invite" }), /SIGNING_KEY is not set/);
  } finally {
    process.env.SIGNING_KEY = saved.sign;
    if (saved.links === undefined) delete process.env.LINKS_API_KEY;
    else process.env.LINKS_API_KEY = saved.links;
  }
});

// ── consent url ─────────────────────────────────────────────────────────────

test("the consent url asks for offline access and forces a refresh token", () => {
  const u = new URL(
    consentUrl({ clientId: "g-1", redirectUri: "https://x.test/cb", state: "s" }),
  );
  assert.equal(u.searchParams.get("access_type"), "offline");
  // Without this, a reconnect returns no refresh token and the connection dies in an hour.
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("response_type"), "code");

  const scopes = (u.searchParams.get("scope") ?? "").split(" ");
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.freebusy"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.events"));
  // We never need event contents, so we never ask for a scope that grants them.
  assert.ok(!scopes.some((s) => s.endsWith("/auth/calendar")), "must not request full calendar");
  assert.ok(!scopes.some((s) => s.includes("calendar.readonly")), "must not request readonly-all");
  // Identity scopes: needed to learn who connected without an extra API call, and both are
  // non-sensitive. A live run proved the alternative (reading calendar metadata) 403s.
  assert.ok(scopes.includes("email"), "email claim is how the address is learned");
  assert.ok(scopes.includes("openid"));
});

test("the account id is read from the id_token, and junk yields null", () => {
  const claims = Buffer.from(JSON.stringify({ sub: "11223344" })).toString("base64url");
  assert.equal(subjectFromIdToken(`header.${claims}.sig`), "11223344");
  for (const bad of [undefined, "", "a.b", "a.!!!.c"]) {
    assert.equal(subjectFromIdToken(bad), null, String(bad));
  }
});
