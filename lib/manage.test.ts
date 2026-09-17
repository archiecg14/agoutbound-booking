import test from "node:test";
import assert from "node:assert/strict";
import {
  MANAGE_GRACE_HOURS,
  canManage,
  manageRefusalMessage,
  manageUrl,
  mintManageToken,
  readManageToken,
} from "./manage.ts";
import { makeInvite, signPayload } from "./oauth.ts";

process.env.LINKS_API_KEY = "test-signing-secret";

const END = "2026-09-20T09:30:00.000Z";
const START = "2026-09-20T09:00:00.000Z";

test("a manage token round-trips and carries its booking", () => {
  const claims = readManageToken(mintManageToken("bk-1", END));
  assert.equal(claims?.k, "manage");
  assert.equal(claims?.bookingId, "bk-1");
});

test("another signed payload is NOT accepted as a manage token", () => {
  // Without the purpose check, any token this app signs — a connect invite, an OAuth
  // state — would let the holder cancel somebody's booking.
  assert.equal(readManageToken(makeInvite("cl-1")), null, "an invite must not manage");
  assert.equal(
    readManageToken(signPayload({ k: "state", clientId: "cl-1", nonce: "n" })),
    null,
    "an oauth state must not manage",
  );
  assert.equal(readManageToken(signPayload({ bookingId: "bk-1" })), null, "no purpose, no access");
});

test("a forged or absent token is refused", () => {
  const good = mintManageToken("bk-1", END);
  const body = good.slice(0, good.lastIndexOf("."));
  assert.equal(readManageToken(`${body}.notasignature`), null);
  assert.equal(readManageToken(null), null);
  assert.equal(readManageToken("rubbish"), null);
});

test("the token outlives the call by the grace period, not less", () => {
  // Someone needing to cancel ten minutes late must still be able to; a link that dies at
  // the start time is useless exactly when it matters most.
  const claims = readManageToken(mintManageToken("bk-1", END));
  const expected = Date.parse(END) + MANAGE_GRACE_HOURS * 3_600_000;
  assert.equal(claims?.exp, expected);
  assert.ok(claims!.exp > Date.parse(END));
});

test("canManage allows a live booking and blocks a cancelled one", () => {
  const before = "2026-09-19T12:00:00.000Z";
  assert.deepEqual(canManage({ status: "confirmed", startUtc: START }, before), { ok: true });
  assert.deepEqual(canManage({ status: "cancelled", startUtc: START }, before), {
    ok: false,
    reason: "already_cancelled",
  });
  assert.deepEqual(canManage(null, before), { ok: false, reason: "not_found" });
});

test("cancelling is still allowed shortly after the call has started", () => {
  // That is how an honest no-show gets recorded rather than sitting as a phantom booking.
  const justAfter = "2026-09-20T09:15:00.000Z";
  assert.deepEqual(canManage({ status: "confirmed", startUtc: START }, justAfter), { ok: true });
});

test("a long-past booking can no longer be changed", () => {
  const wayAfter = "2026-09-25T09:00:00.000Z";
  assert.deepEqual(canManage({ status: "confirmed", startUtc: START }, wayAfter), {
    ok: false,
    reason: "too_late",
  });
});

test("refusals map to sensible statuses", () => {
  assert.equal(manageRefusalMessage("already_cancelled").status, 409);
  assert.equal(manageRefusalMessage("slot_not_offered").status, 409);
  assert.equal(manageRefusalMessage("not_found").status, 404);
});

test("manage urls survive a trailing slash", () => {
  assert.equal(manageUrl("https://book.test/", "abc"), "https://book.test/m/abc");
  assert.equal(manageUrl("https://book.test", "abc"), "https://book.test/m/abc");
});
