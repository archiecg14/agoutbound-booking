import type { NextConfig } from "next";

/**
 * Who is allowed to put this app in an iframe.
 *
 * Nothing set a frame policy before, which meant any site could embed the booking page and
 * overlay it - a stranger's page could sit invisibly on top of a real calendar and collect
 * what people typed, or take the click that books. The booking page is MEANT to be embedded,
 * but only by the sites that own it.
 *
 * EMBED_ORIGINS is comma separated so a new client site needs a variable, not a deploy of
 * changed code. frame-ancestors is the modern control; X-Frame-Options cannot express a
 * list, so it is deliberately not set - sending a DENY alongside would break the embed in
 * the older browsers that only read it, which is worse than relying on the CSP.
 */
const embedOrigins = (process.env.EMBED_ORIGINS ?? "https://agoutbound.co.uk,https://www.agoutbound.co.uk")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors 'self' ${embedOrigins.join(" ")}`,
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
