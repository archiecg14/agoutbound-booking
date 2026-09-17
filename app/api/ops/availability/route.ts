/**
 * POST /api/ops/availability — replace a connection's weekly availability.
 *
 * Replace, not merge: partial edits to a recurring schedule are how people end up with a
 * Tuesday rule they deleted six weeks ago still quietly offering slots. The caller sends the
 * whole week and gets exactly that.
 */

import { cookies } from "next/headers";
import { serviceClient } from "@/lib/supabase";
import { OPS_COOKIE, isOperator } from "@/lib/operator-auth";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function validZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const jar = await cookies();
  if (!isOperator(jar.get(OPS_COOKIE)?.value)) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }

  let b: { connectionId?: string; rules?: unknown };
  try {
    b = (await request.json()) as typeof b;
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const connectionId = typeof b.connectionId === "string" ? b.connectionId : null;
  if (!connectionId) return Response.json({ error: "connection_required" }, { status: 400 });
  if (!Array.isArray(b.rules)) return Response.json({ error: "rules_required" }, { status: 400 });

  const rows = [];
  for (const raw of b.rules) {
    const r = raw as Record<string, unknown>;
    const weekday = Number(r.weekday);
    const start = typeof r.startLocal === "string" ? r.startLocal : "";
    const end = typeof r.endLocal === "string" ? r.endLocal : "";

    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return Response.json({ error: "invalid_weekday" }, { status: 400 });
    }
    if (!TIME.test(start) || !TIME.test(end) || end <= start) {
      return Response.json({ error: "invalid_times" }, { status: 400 });
    }
    // An unknown zone would be accepted by Postgres as a plain string and then silently
    // produce no slots at all, which is very hard to diagnose from the outside.
    if (!validZone(r.timezone)) return Response.json({ error: "invalid_timezone" }, { status: 400 });

    rows.push({ connection_id: connectionId, weekday, start_local: start, end_local: end, timezone: r.timezone });
  }

  const db = serviceClient();
  const { error: delErr } = await db.from("availability_rules").delete().eq("connection_id", connectionId);
  if (delErr) {
    console.error("[ops] clearing availability failed", delErr);
    return Response.json({ error: "write_failed" }, { status: 500 });
  }

  if (rows.length) {
    const { error } = await db.from("availability_rules").insert(rows);
    if (error) {
      // The old rules are already gone. Say so plainly rather than returning a generic
      // failure that leaves the operator believing nothing changed.
      console.error("[ops] inserting availability failed AFTER clearing", error);
      return Response.json(
        { error: "write_failed_after_clear", detail: "Previous rules were removed. Re-send the week." },
        { status: 500 },
      );
    }
  }

  return Response.json({ ok: true, rules: rows.length });
}
