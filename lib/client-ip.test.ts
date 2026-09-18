import test from "node:test";
import assert from "node:assert/strict";
import { UNKNOWN_BUCKET, bucketFromHeaders, ipBucket } from "./client-ip.ts";

const headers = (h: Record<string, string>) => new Headers(h);

// ── the IPv6 bug this module was written to fix ─────────────────────────────

test("IPv6 :: compression is restored, not discarded", () => {
  // The original dropped the empty groups, turning 2001:db8::1 into "2001:db8:1::/64" —
  // a genuinely different network. Two unrelated visitors then shared one bucket.
  assert.equal(ipBucket("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipBucket("2001:db8:1::5"), "2001:db8:1:0::/64");
  assert.notEqual(ipBucket("2001:db8::1"), ipBucket("2001:db8:1::5"), "distinct /64s must not collide");
});

test("the same address always yields the same bucket, however it is written", () => {
  // Otherwise a caller varies the compressed form and hops between buckets at will,
  // defeating the hourly limit entirely.
  const forms = ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1", "2001:db8:0:0:0:0:0:1"];
  const buckets = new Set(forms.map((f) => ipBucket(f)));
  assert.equal(buckets.size, 1, `expected one bucket, got ${[...buckets].join(", ")}`);
});

test("loopback and IPv4-mapped addresses resolve sensibly", () => {
  assert.equal(ipBucket("::1"), "0:0:0:0::/64");
  assert.equal(ipBucket("::ffff:127.0.0.1"), "127.0.0.0/24", "IPv4-mapped is an IPv4 client");
  assert.equal(ipBucket("::ffff:203.0.113.5"), "203.0.113.0/24");
  assert.notEqual(ipBucket("::ffff:203.0.113.5"), ipBucket("::ffff:198.51.100.5"), "must not share one bucket");
});

test("IPv4 is truncated to a /24", () => {
  assert.equal(ipBucket("203.0.113.42"), "203.0.113.0/24");
});

test("junk yields null rather than a bogus bucket", () => {
  for (const bad of [null, undefined, "", "   ", "garbage", "1.2.3", "999.1.1.1", "2001:db8::1::2"]) {
    assert.equal(ipBucket(bad as string), null, String(bad));
  }
});

// ── the spoofing bug ────────────────────────────────────────────────────────

test("a client-supplied x-forwarded-for entry is NOT trusted", () => {
  // Proxies append the real address, so the LEFT-most entry is whatever the caller sent.
  // Taking it let anyone rotate a fake value and get unlimited buckets.
  const b = bucketFromHeaders(headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }));
  assert.equal(b, "203.0.113.0/24", "must use the right-most hop, not the caller's value");
  assert.notEqual(b, "1.2.3.0/24");
});

test("a platform header wins over anything in x-forwarded-for", () => {
  const b = bucketFromHeaders(
    headers({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "198.51.100.7" }),
  );
  assert.equal(b, "198.51.100.0/24");
});

test("no usable address FAILS CLOSED into a shared bucket", () => {
  // The original returned null here and the caller skipped the limit entirely — it failed
  // open. Unattributable traffic is exactly the traffic most worth limiting.
  assert.equal(bucketFromHeaders(headers({})), UNKNOWN_BUCKET);
  assert.equal(bucketFromHeaders(headers({ "x-forwarded-for": "not-an-ip" })), UNKNOWN_BUCKET);
  assert.notEqual(bucketFromHeaders(headers({})), null);
});

test("a single-hop x-forwarded-for still works", () => {
  assert.equal(bucketFromHeaders(headers({ "x-forwarded-for": "203.0.113.9" })), "203.0.113.0/24");
});
