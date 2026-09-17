"use client";

import { useState } from "react";
import "../ops.css";
import "../../b/booking.css";

export default function OpsLogin() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ops/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // Replace rather than push: the password should not be one Back press away.
        window.location.replace("/ops");
        return;
      }
      setError("Incorrect password.");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="ops-login">
      <h1 style={{ fontFamily: "var(--display)", fontSize: "var(--t-title)" }}>Operator</h1>
      <p className="ops__sub">AG Outbound booking</p>
      <form onSubmit={submit}>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          aria-label="Operator password"
        />
        {error ? <div className="notice">{error}</div> : null}
        <button className="btn" type="submit" disabled={busy || !password}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
