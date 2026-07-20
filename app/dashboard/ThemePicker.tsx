"use client";

import { useState } from "react";
import s from "./theme-picker.module.css";

export type ThemeName = "champagne" | "green" | "blue" | "pink" | "purple" | "mono";

const THEMES: { name: ThemeName; color: string; label: string }[] = [
  { name: "champagne", color: "#c4a470", label: "Champagne" },
  { name: "green",     color: "#10b981", label: "Emerald"   },
  { name: "blue",      color: "#3b82f6", label: "Sapphire"  },
  { name: "pink",      color: "#f472b6", label: "Rose"      },
  { name: "purple",    color: "#a78bfa", label: "Violet"    },
  { name: "mono",      color: "#a8a8a8", label: "Mono"      },
];

export function ThemePicker({
  current,
  onChange,
}: {
  current: ThemeName;
  onChange: (t: ThemeName) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = THEMES.find((t) => t.name === current) ?? THEMES[0];

  return (
    <div className={s.wrap} data-open={open}>
      {open && (
        <div className={s.swatches}>
          {THEMES.map((t) => (
            <button
              key={t.name}
              type="button"
              className={s.swatch}
              data-active={t.name === current}
              style={{ background: t.color }}
              aria-label={t.label}
              title={t.label}
              onClick={() => {
                onChange(t.name);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
      <button
        type="button"
        className={s.toggle}
        style={{ background: active.color }}
        aria-label={open ? "Close theme picker" : "Open theme picker"}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "×" : "🎨"}
      </button>
    </div>
  );
}
