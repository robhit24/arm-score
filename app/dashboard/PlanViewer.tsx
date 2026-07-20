"use client";

import { useState } from "react";
import s from "./plan-viewer.module.css";

// Defensive: model output occasionally returns a string where an array is
// expected (e.g. `cues: "stay loose"` instead of `cues: ["stay loose"]`).
// Plain `(x || []).map(...)` throws TypeError when x is a non-empty string,
// which surfaces as "Application error: a client-side exception" in prod.
function arr<T>(x: unknown): T[] {
  if (Array.isArray(x)) return x as T[];
  if (typeof x === "string" && x.trim()) return [x as unknown as T];
  return [];
}
function str(x: unknown): string {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  return JSON.stringify(x);
}

// Reps is supposed to be a string per the Lambda schema, but the model
// occasionally returns an object like {sets: 3, reps_per_set: 8, tempo: "..."}.
// JSON.stringify'd those leaked into the UI as raw JSON which forced the card
// wider than the viewport on mobile. Format known shapes; fall back to the
// values joined so we never render "{...}".
function formatReps(x: unknown): string {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (typeof x === "number") return String(x);
  if (Array.isArray(x)) return x.map(formatReps).filter(Boolean).join(" · ");
  if (typeof x === "object") {
    const obj = x as Record<string, unknown>;
    const sets = obj.sets ?? obj.SETS;
    const reps = obj.reps ?? obj.REPS ?? obj.reps_per_set ?? obj.REPS_PER_SET;
    const tempo = obj.tempo ?? obj.TEMPO;
    const main =
      sets != null && reps != null ? `${sets} × ${reps}` :
      reps != null ? `${reps} reps` :
      sets != null ? `${sets} sets` : "";
    const parts = [main, tempo ? String(tempo) : ""].filter(Boolean);
    if (parts.length) return parts.join(" · ");
    return Object.values(obj).filter((v) => v != null && typeof v !== "object").map(String).join(" · ");
  }
  return "";
}

// reps comes back from the Lambda as an object {sets, reps_per_set, tempo}
// (see aws/generate-and-send/handler.js daily_plan schema). Older plans or
// edge-case model output may have it as a plain string — formatReps handles
// both. Keep typed as `unknown` so TS doesn't lie about the runtime shape.
type Drill = {
  name: string;
  purpose: string;
  how_to: string;
  reps: unknown;
  cues: string[];
  common_mistakes: string[];
};

type WarmupItem = { name: string; description: string; reps: string; distance_ft?: string };
// As of 2026-05-08 the Lambda emits warmup as a 3-phase object. Older plans
// stored before that bump are still flat arrays — coerced to the new shape
// at render time below so historical PlanJobs rows don't crash this viewer.
type WarmupShape = {
  mobility?: WarmupItem[];
  activation?: WarmupItem[];
  throwing_prep?: WarmupItem[];
};

type DayPlan = {
  day: number;
  week: number;
  session_time_min: number;
  focus: string;
  warmup: WarmupShape | WarmupItem[];
  drills: Drill[];
  parent_help: string[];
  success_metric: string;
};

function asWarmupShape(w: unknown): WarmupShape {
  if (!w) return {};
  if (Array.isArray(w)) {
    // Legacy flat array — bucket by name keyword. Mirror Lambda
    // coerceLegacyWarmup so server-side and client-side render the same way.
    const out: Required<WarmupShape> = { mobility: [], activation: [], throwing_prep: [] };
    for (const raw of w) {
      const item = raw as WarmupItem;
      const name = String(item?.name || "").toLowerCase();
      if (/throw|toss|wrist (snap|flick)|k-drill|crow hop|long toss|one-knee/.test(name)) {
        out.throwing_prep.push(item);
      } else if (/band|activation|scap|y-t-w|ytw|external rotation|pull-apart/.test(name)) {
        out.activation.push(item);
      } else {
        out.mobility.push(item);
      }
    }
    return out;
  }
  return w as WarmupShape;
}

type Plan = {
  title: string;
  overview: string;
  weekly_structure: string;
  weekly_blocks: { week: number; theme: string; goals: string[]; focus_points: string[] }[];
  daily_plan: DayPlan[];
  equipment_notes: string[];
  safety_notes: string[];
};

export function PlanViewer({
  plan,
  planDays,
  sentAt,
}: {
  plan: Plan;
  planDays: number;
  sentAt: string;
}) {
  const [activeWeek, setActiveWeek] = useState(1);
  const [expandedDay, setExpandedDay] = useState<number | null>(null);

  const weeks = arr<Plan["weekly_blocks"][number]>(plan.weekly_blocks);
  const days = arr<DayPlan>(plan.daily_plan).filter((d) => d.week === activeWeek);

  return (
    <div className={s.wrap}>
      <div className={s.header}>
        <div className={s.title}>{plan.title || `${planDays}-Day Plan`}</div>
        <div className={s.date}>
          Generated {new Date(sentAt).toLocaleDateString()}
        </div>
      </div>

      <div className={s.overview}>{plan.overview}</div>

      {/* Week tabs */}
      <div className={s.weekTabs}>
        {weeks.map((w) => (
          <button
            key={w.week}
            type="button"
            className={s.weekTab}
            data-active={activeWeek === w.week}
            onClick={() => { setActiveWeek(w.week); setExpandedDay(null); }}
          >
            <div className={s.weekTabNum}>Wk {w.week}</div>
            <div className={s.weekTabTheme}>{w.theme}</div>
          </button>
        ))}
      </div>

      {/* Week goals */}
      {weeks.find((w) => w.week === activeWeek) && (
        <div className={s.weekInfo}>
          <div className={s.weekGoals}>
            <div className={s.label}>Goals</div>
            {arr<string>(weeks.find((w) => w.week === activeWeek)?.goals).map((g, i) => (
              <div key={i} className={s.goalItem}>• {str(g)}</div>
            ))}
          </div>
        </div>
      )}

      {/* Days */}
      <div className={s.daysList}>
        {days.map((d) => (
          <div key={d.day} className={s.dayCard}>
            <button
              type="button"
              className={s.dayHeader}
              onClick={() => setExpandedDay(expandedDay === d.day ? null : d.day)}
            >
              <div className={s.dayBadge}>Day {d.day}</div>
              <div className={s.dayFocus}>{str(d.focus)}</div>
              <div className={s.dayTime}>{d.session_time_min}m</div>
              <div className={s.dayChevron} data-open={expandedDay === d.day}>›</div>
            </button>

            {expandedDay === d.day && (
              <div className={s.dayBody}>
                {/* Warmup — 3 phases (mobility → activation → throwing prep).
                    The phase labels are deliberately visible so an athlete or
                    parent can't visually skip from "stretch" straight to a
                    bullpen — the throwing-prep ramp has to be performed every
                    day, in order. */}
                <div className={s.section}>
                  <div className={s.sectionTitle}>Warm-up</div>
                  {(() => {
                    const wu = asWarmupShape(d.warmup);
                    const phases: { label: string; items: WarmupItem[] }[] = [
                      { label: "Mobility", items: arr<WarmupItem>(wu.mobility) },
                      { label: "Activation", items: arr<WarmupItem>(wu.activation) },
                      { label: "Throwing Prep", items: arr<WarmupItem>(wu.throwing_prep) },
                    ];
                    return phases.filter((p) => p.items.length > 0).map((p) => (
                      <div key={p.label} className={s.warmupPhase}>
                        <div className={s.phaseLabel}>{p.label}</div>
                        {p.items.map((w, i) => (
                          <div key={i} className={s.miniCard}>
                            <div className={s.miniName}>{str(w?.name)}</div>
                            <div className={s.miniDesc}>{str(w?.description)}</div>
                            <div className={s.miniReps}>
                              {[formatReps(w?.reps), w?.distance_ft].filter(Boolean).join(" · ")}
                            </div>
                          </div>
                        ))}
                      </div>
                    ));
                  })()}
                </div>

                {/* Drills */}
                <div className={s.section}>
                  <div className={s.sectionTitle}>Drills</div>
                  {arr<Drill>(d.drills).map((dr, i) => (
                    <div key={i} className={s.drillCard}>
                      <div className={s.drillTop}>
                        <div className={s.drillName}>{str(dr?.name)}</div>
                        <div className={s.drillReps}>{formatReps(dr?.reps)}</div>
                      </div>
                      <div className={s.drillPurpose}>{str(dr?.purpose)}</div>
                      <div className={s.drillHow}>{str(dr?.how_to)}</div>
                      <div className={s.drillGrid}>
                        <div>
                          <div className={s.label}>Cues</div>
                          {arr<string>(dr?.cues).map((c, j) => (
                            <div key={j} className={s.cueItem}>• {str(c)}</div>
                          ))}
                        </div>
                        <div>
                          <div className={s.label}>Watch for</div>
                          {arr<string>(dr?.common_mistakes).map((m, j) => (
                            <div key={j} className={s.cueItem}>• {str(m)}</div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Parent help */}
                <div className={s.section}>
                  <div className={s.sectionTitle}>Parent / Coach Notes</div>
                  {arr<string>(d.parent_help).map((p, i) => (
                    <div key={i} className={s.parentItem}>{str(p)}</div>
                  ))}
                </div>

                {/* Success metric */}
                <div className={s.metric}>{str(d.success_metric)}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
