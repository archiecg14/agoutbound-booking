import test from "node:test";
import assert from "node:assert/strict";
import { isOperator, login } from "./operator-auth.ts";
import { makeInvite, signPayload } from "./oauth.ts";
import { mintManageToken } from "./manage.ts";

process.env.LINKS_API_KEY = "test-signing-secret";

const GOOD = "a-sufficiently-long-operator-password";

function withPassword<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.OPS_PASSWORD;
  if (value === undefined) delete process.env.OPS_PASSWORD;
  else process.env.OPS_PASSWORD = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.OPS_PASSWORD;
    else process.env.OPS_PASSWORD = saved;
  }
}

test("the right password yields a session", () => {
  withPassword(GOOD, () => {
    const r = login(GOOD);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(isOperator(r.token), true);
  });
});

test("an unset password fails CLOSED, never open", () => {
  // The tempting alternative — allow access when unset "just in dev" — is how an admin
  // surface showing real client data ends up open on a real deploy.
  withPassword(undefined, () => {
    assert.deepEqual(login(""), { ok: false, reason: "unconfigured" });
    assert.deepEqual(login(GOOD), { ok: false, reason: "unconfigured" });
  });
});

test("a short password is treated as unconfigured", () => {
  withPassword("short", () => {
    assert.deepEqual(login("short"), { ok: false, reason: "unconfigured" });
  });
});

test("a wrong password is refused, whatever its shape", () => {
  withPassword(GOOD, () => {
    for (const bad of ["", "wrong", GOOD + "x", GOOD.slice(0, -1), null, 42, undefined, {}]) {
      const r = login(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      if (!r.ok) assert.equal(r.reason, "wrong");
    }
  });
});

test("a cookie cannot simply be invented", () => {
  for (const bad of ["true", "1", "ops", "", null, undefined, "not.a.token"]) {
    assert.equal(isOperator(bad as string | null), false, String(bad));
  }
});

test("another signed token of ours is NOT an operator session", () => {
  // Purpose checks are the thing standing between a booking link and admin access.
  assert.equal(isOperator(makeInvite("cl-1")), false, "a connect invite must not sign in");
  assert.equal(isOperator(mintManageToken("bk-1", "2026-09-20T09:30:00Z")), false, "a manage token must not sign in");
  assert.equal(isOperator(signPayload({ k: "state", nonce: "n" })), false, "an oauth state must not sign in");
});

test("an expired session is not an operator", () => {
  assert.equal(isOperator(signPayload({ k: "ops", exp: Date.now() - 1000 })), false);
  assert.equal(isOperator(signPayload({ k: "ops", exp: Date.now() + 60_000 })), true);
});
