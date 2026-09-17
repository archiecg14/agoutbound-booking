/**
 * POST /api/ops/login — exchange the operator password for a session cookie.
 *
 * Both failure modes return the same message. "No password is configured" is useful to the
 * operator and equally useful to anyone probing the endpoint, so it goes to the server log
 * instead of the response.
 */

import { cookies } from "next/headers";
import { OPS_COOKIE, SESSION_HOURS, login } from "@/lib/operator-auth";

export async function POST(request: Request) {
  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Incorrect password." }, { status: 401 });
  }

  const result = login(body.password);
  if (!result.ok) {
    if (result.reason === "unconfigured") {
      console.error("[ops] OPS_PASSWORD is unset or shorter than 12 characters — refusing all logins");
    }
    return Response.json({ error: "Incorrect password." }, { status: 401 });
  }

  const jar = await cookies();
  jar.set(OPS_COOKIE, result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict", // an operator session should never ride along on a cross-site request
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });

  return Response.json({ ok: true });
}

export async function DELETE() {
  const jar = await cookies();
  jar.delete({ name: OPS_COOKIE, path: "/" });
  return Response.json({ ok: true });
}
