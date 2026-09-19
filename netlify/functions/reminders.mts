/**
 * The thing that actually runs the reminder sweep.
 *
 * /api/cron/reminders was written, guarded and tested, and nothing ever called it - so
 * every reminder this system has scheduled since it went live would have sat in the table
 * until the call had already happened. The endpoint was never the missing part; this was.
 *
 * It is a caller, not a second implementation. All the logic, the auth and the
 * cannot-double-send guarantees stay in the route, so there is one place to reason about
 * and this file cannot drift away from it.
 *
 * Every ten minutes. The tightest reminder is the one an hour before the call, so ten
 * minutes bounds how late it can be at a tenth of that - close enough that nobody notices,
 * rare enough to be nothing against Netlify's invocation allowance.
 */

export default async () => {
  const base = process.env.APP_BASE_URL;
  const secret = process.env.CRON_SECRET;

  // Say which one is missing. A sweep that silently does nothing is the failure this file
  // exists to end, so it must never be the failure this file introduces.
  if (!base || !secret) {
    console.error("[reminders] cannot run:", !base ? "APP_BASE_URL is not set" : "CRON_SECRET is not set");
    return new Response("misconfigured", { status: 500 });
  }

  const res = await fetch(`${base.replace(/\/+$/, "")}/api/cron/reminders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });

  const body = await res.text();
  if (!res.ok) {
    console.error("[reminders] sweep failed", res.status, body.slice(0, 300));
    return new Response(body, { status: res.status });
  }

  // Logged on every run, including the quiet ones. "considered: 0" in the log is how you
  // tell a working sweep with nothing to do from a sweep that stopped running.
  console.log("[reminders]", body.slice(0, 300));
  return new Response(body, { status: 200 });
};

export const config = {
  schedule: "*/10 * * * *",
};
