/**
 * Working out who is calling, for rate limiting only.
 *
 * Rewritten after a review found the original both spoofable and broken:
 *
 *   - It read the LEFT-most x-forwarded-for entry. Proxies append the real address to
 *     whatever the client sent, so the left-most value is attacker-controlled: send
 *     `X-Forwarded-For: 1.2.3.4`, rotate it per request, and the per-IP limit is defeated.
 *     The right-most entry is the one the nearest proxy wrote, and is the only one not
 *     supplied by the caller.
 *   - Its IPv6 handling dropped the empty groups produced by `::` compression, so
 *     2001:db8::1 became "2001:db8:1::/64" — a different network. Unrelated visitors
 *     collided in one bucket and one visitor could move between buckets at will.
 *
 * A missing address now FAILS CLOSED into a single shared bucket rather than skipping the
 * limit. Traffic we cannot attribute is exactly the traffic most worth limiting.
 */

/** Everything we cannot attribute shares this bucket, and so shares one hourly allowance. */
export const UNKNOWN_BUCKET = "unknown";

/** Expand an IPv6 address to its 8 groups, restoring whatever `::` compressed away. */
function expandIpv6(ip: string): string[] | null {
  const plain = ip.replace(/^\[|\]$/g, "").split("%")[0];
  if (!/^[0-9a-fA-F:.]+$/.test(plain)) return null;

  const halves = plain.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];

  // An IPv4-mapped tail (::ffff:127.0.0.1) occupies two groups, not one.
  const last = tail[tail.length - 1] ?? head[head.length - 1];
  let extra = 0;
  if (last && last.includes(".")) {
    const o = last.split(".");
    if (o.length !== 4 || o.some((x) => x === "" || Number(x) > 255 || !/^\d+$/.test(x))) return null;
    extra = 1;
  }

  const present = head.length + tail.length + extra;
  if (halves.length === 1) {
    if (present !== 8) return null;
    return head;
  }
  if (present > 8) return null;

  const gap = new Array(8 - present).fill("0");
  return [...head, ...gap, ...tail];
}

/**
 * Reduce an address to a rate-limiting bucket.
 *
 * Truncated on purpose: a full address is personal data with no extra value here, and the
 * host portion adds nothing to limiting while adding everything to what a leak exposes.
 */
export function ipBucket(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim().replace(/^\[|\]$/g, "").split("%")[0];
  if (!trimmed) return null;

  if (trimmed.includes(":")) {
    // An IPv4-mapped address (::ffff:203.0.113.5) is really an IPv4 client. Bucketing it by
    // the mapping prefix would put EVERY such client in one bucket, so unwrap it first.
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
    if (mapped) return ipBucket(mapped[1]);

    const groups = expandIpv6(trimmed);
    if (!groups) return null;
    // Normalised: lowercase, no leading zeros. Without this the same address written two
    // ways ("2001:0db8:0000:..." and "2001:db8::1") lands in two different buckets, which
    // is exactly the evasion this function exists to prevent. Caught by its own test.
    const norm = groups.map((g) => (parseInt(g, 16) || 0).toString(16));
    return norm.slice(0, 4).join(":") + "::/64";
  }

  const octets = trimmed.split(".");
  if (octets.length !== 4) return null;
  if (octets.some((o) => o === "" || !/^\d+$/.test(o) || Number(o) > 255)) return null;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/**
 * The caller's bucket, from headers, preferring ones a client cannot forge.
 *
 * Order matters. Platform headers (x-vercel-forwarded-for, x-real-ip) are written by the
 * edge and overwrite anything the client sent. Only if neither exists do we fall back to
 * the right-most x-forwarded-for entry — the hop nearest us.
 */
export function bucketFromHeaders(headers: Headers): string {
  const direct = headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip");
  const fromDirect = ipBucket(direct);
  if (fromDirect) return fromDirect;

  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
    // Right-most, not left-most: the nearest proxy wrote it, the client could not.
    for (let i = hops.length - 1; i >= 0; i--) {
      const b = ipBucket(hops[i]);
      if (b) return b;
    }
  }

  return UNKNOWN_BUCKET;
}
