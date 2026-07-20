"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import s from "./page.module.css";

// Client island for the admin's delete-swing button. The parent admin page
// stays a pure server component; this is the only client JS shipped per
// row. Hits DELETE /api/swings?id= which gates on isAdminEmail() — see
// app/api/swings/route.ts.
export function DeleteSwingButton({
  swingId,
  email,
}: {
  swingId: string;
  email: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  async function handleDelete() {
    if (!window.confirm(`Delete this swing from ${email || "(no email)"}?`))
      return;
    try {
      const res = await fetch(`/api/swings?id=${encodeURIComponent(swingId)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await res.text());
      setDone(true);
      // Refresh the server component so the row count + tables reflect the
      // delete. router.refresh() re-runs the page's DynamoDB scans.
      startTransition(() => router.refresh());
    } catch (err: any) {
      alert(`Delete failed: ${err?.message || "unknown error"}`);
    }
  }

  if (done) {
    return <span className={s.deletedTag}>deleted</span>;
  }

  return (
    <button
      type="button"
      className={s.deleteBtn}
      onClick={handleDelete}
      disabled={pending}
      aria-label="Delete swing"
      title="Delete swing"
    >
      ×
    </button>
  );
}
