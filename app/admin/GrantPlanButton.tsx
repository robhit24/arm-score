"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import s from "./page.module.css";

// Client island for the admin's grant-plan modal. Lives on each Users row
// so customer service grants are one click away. Hits POST
// /api/admin/grant-plan which is admin-gated server-side — see
// app/api/admin/grant-plan/route.ts.
export function GrantPlanButton({ email }: { email: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [planDays, setPlanDays] = useState<0 | 1 | 7 | 14 | 30 | 45>(7);
  const [pro, setPro] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setPlanDays(7);
    setPro(false);
    setNote("");
    setResult(null);
    setSubmitting(false);
  }

  async function submit() {
    if (planDays === 0 && !pro) {
      setResult("Pick a plan length or toggle Pro.");
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/grant-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, plan_days: planDays, pro, note }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const parts: string[] = [];
      if (data.pro) parts.push("Pro granted");
      if (data.plan_days > 0) parts.push(`${data.plan_days}-day plan granted`);
      if (data.plan_email_skipped) parts.push("(no swing on file — email skipped)");
      else if (data.plan_job_id) parts.push("plan email sent");
      setResult(parts.join(" · ") || "Done.");
      // Refresh the server component so the Users table reflects the new
      // status pill (Pro / N-day) immediately.
      startTransition(() => router.refresh());
    } catch (err: any) {
      setResult(`Error: ${err?.message || "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className={s.grantBtn}
        onClick={() => {
          reset();
          setOpen(true);
        }}
        title="Grant plan or Pro"
      >
        + Grant
      </button>
    );
  }

  return (
    <div
      className={s.grantOverlay}
      role="dialog"
      aria-label="Grant plan"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className={s.grantModal}>
        <div className={s.grantHead}>
          <div className={s.grantTitle}>Grant plan</div>
          <button
            type="button"
            className={s.grantClose}
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className={s.grantBody}>
          <div className={s.grantRow}>
            <span className={s.grantLabel}>User</span>
            <span className={s.grantValue}>{email}</span>
          </div>

          <div className={s.grantRow}>
            <span className={s.grantLabel}>Plan length</span>
            <div className={s.grantOptions}>
              {([0, 1, 7, 14, 30, 45] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`${s.grantOpt} ${planDays === d ? s.grantOptActive : ""}`}
                  onClick={() => setPlanDays(d)}
                >
                  {d === 0 ? "None" : `${d}d`}
                </button>
              ))}
            </div>
          </div>

          <div className={s.grantRow}>
            <span className={s.grantLabel}>Pro sub</span>
            <label className={s.grantToggle}>
              <input
                type="checkbox"
                checked={pro}
                onChange={(e) => setPro(e.target.checked)}
              />
              <span>Mark as subscribed (comp Pro)</span>
            </label>
          </div>

          <div className={s.grantRow}>
            <span className={s.grantLabel}>Note</span>
            <input
              type="text"
              className={s.grantInput}
              placeholder="why (refund, comp, recovery…)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
            />
          </div>

          {result && (
            <div
              className={
                result.startsWith("Error") ? s.grantErr : s.grantOk
              }
            >
              {result}
            </div>
          )}
        </div>
        <div className={s.grantFoot}>
          <button
            type="button"
            className={s.grantCancel}
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className={s.grantSubmit}
            onClick={submit}
            disabled={submitting || pending}
          >
            {submitting ? "Granting…" : "Grant"}
          </button>
        </div>
      </div>
    </div>
  );
}
