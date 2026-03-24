"use client";

import { useState } from "react";
import s from "./plan-viewer.module.css";

type Drill = {
  name: string;
  purpose: string;
  how_to: string;
  reps: string;
  cues: string[];
  common_mistakes: string[];
};

type DayPlan = {
  day: number;
  week: number;
  session_time_min: number;
  focus: string;
  warmup: { name: string; description: string; reps: string }[];
  drills: Drill[];
  parent_help: string[];
  success_metric: string;
};

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

  const weeks = plan.weekly_blocks || [];
  const days = (plan.daily_plan || []).filter((d) => d.week === activeWeek);

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
            {(weeks.find((w) => w.week === activeWeek)?.goals || []).map((g, i) => (
              <div key={i} className={s.goalItem}>• {g}</div>
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
              <div className={s.dayFocus}>{d.focus}</div>
              <div className={s.dayTime}>{d.session_time_min}m</div>
              <div className={s.dayChevron} data-open={expandedDay === d.day}>›</div>
            </button>

            {expandedDay === d.day && (
              <div className={s.dayBody}>
                {/* Warmup */}
                <div className={s.section}>
                  <div className={s.sectionTitle}>Warm-up</div>
                  {(d.warmup || []).map((w, i) => (
                    <div key={i} className={s.miniCard}>
                      <div className={s.miniName}>{w.name}</div>
                      <div className={s.miniDesc}>{w.description}</div>
                      <div className={s.miniReps}>{w.reps}</div>
                    </div>
                  ))}
                </div>

                {/* Drills */}
                <div className={s.section}>
                  <div className={s.sectionTitle}>Drills</div>
                  {(d.drills || []).map((dr, i) => (
                    <div key={i} className={s.drillCard}>
                      <div className={s.drillTop}>
                        <div className={s.drillName}>{dr.name}</div>
                        <div className={s.drillReps}>{dr.reps}</div>
                      </div>
                      <div className={s.drillPurpose}>{dr.purpose}</div>
                      <div className={s.drillHow}>{dr.how_to}</div>
                      <div className={s.drillGrid}>
                        <div>
                          <div className={s.label}>Cues</div>
                          {(dr.cues || []).map((c, j) => (
                            <div key={j} className={s.cueItem}>• {c}</div>
                          ))}
                        </div>
                        <div>
                          <div className={s.label}>Watch for</div>
                          {(dr.common_mistakes || []).map((m, j) => (
                            <div key={j} className={s.cueItem}>• {m}</div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Parent help */}
                <div className={s.section}>
                  <div className={s.sectionTitle}>Parent / Coach Notes</div>
                  {(d.parent_help || []).map((p, i) => (
                    <div key={i} className={s.parentItem}>{p}</div>
                  ))}
                </div>

                {/* Success metric */}
                <div className={s.metric}>{d.success_metric}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
