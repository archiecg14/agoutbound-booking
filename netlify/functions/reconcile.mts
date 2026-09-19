/**
 * Runs the calendar half of reconcile on a schedule. A caller, not a second implementation
 * - the same reasoning as the reminders sweep beside it.
 *
 * Hourly. A booking that failed to reach the calendar needs finding before the meeting, and
 * bookings here are few enough that an hourly pass costs almost nothing.
 */

export default async () => {
  const base = process.env.APP_BASE_URL;
  const secret = process.env.CRON_SECRET;

  if (!base || !secret) {
    console.error("[reconcile] cannot run:", !base ? "APP_BASE_URL is not set" : "CRON_SECRET is not set");
    return new Response("misconfigured", { status: 500 });
  }

  const res = await fetch(`${base.replace(/\/+$/, "")}/api/cron/reconcile`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });

  const body = await res.text();
  if (!res.ok) {
    console.error("[reconcile] sweep failed", res.status, body.slice(0, 300));
    return new Response(body, { status: res.status });
  }
  console.log("[reconcile]", body.slice(0, 300));
  return new Response(body, { status: 200 });
};

export const config = { schedule: "17 * * * *" };
