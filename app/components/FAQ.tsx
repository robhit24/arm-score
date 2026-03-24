"use client";

import { useState } from "react";
import s from "./FAQ.module.css";

export function FAQ({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);

  return (
    <button
      type="button"
      className={s.card}
      data-open={open}
      onClick={() => setOpen((o) => !o)}
    >
      <div className={s.header}>
        <div className={s.question}>{q}</div>
        <div className={s.chevron} data-open={open}>
          ›
        </div>
      </div>
      {open && <div className={s.answer}>{a}</div>}
    </button>
  );
}
