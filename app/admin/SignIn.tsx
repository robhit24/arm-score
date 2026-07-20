"use client";

import { useState } from "react";
import s from "./page.module.css";

// Client form for the magic-link sign-in. Keeps the parent (page.tsx) a
// pure server component that can do the auth gate + DynamoDB scans without
// any client JS for the admin himself.
export function SignIn({ notAllowed }: { notAllowed: boolean }) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (sending || !email.includes("@")) return;
    setErr(null);
    setSending(true);
    try {
      const res = await fetch("/api/auth/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, redirect: "/admin" }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSent(true);
    } catch (e: any) {
      setErr(e?.message || "Failed to send link");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={s.signin}>
      <h1>Admin sign-in</h1>
      <p>Magic link only. Email must be on the admin allowlist.</p>
      {notAllowed && (
        <div className={s.signinErr}>
          Signed in but not authorized. Sign in with an admin email.
        </div>
      )}
      <form className={s.signinForm} onSubmit={submit}>
        <input
          className={s.signinInput}
          type="email"
          placeholder="admin email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          autoFocus
        />
        <button className={s.signinBtn} type="submit" disabled={sending || !email.includes("@")}>
          {sending ? "Sending…" : sent ? "Sent — check your inbox" : "Send magic link"}
        </button>
      </form>
      {sent && <div className={s.signinOk}>Link sent. Click it from your email to land on /admin.</div>}
      {err && <div className={s.signinErr}>{err}</div>}
      <div className={s.signinNote}>Link expires in 15 minutes.</div>
    </div>
  );
}
