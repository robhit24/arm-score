// Score helpers for the 5-metric pitching model
// (Balance / Stride / Arm Path / Release / Finish).
//
// Weighting decided 2026-05-07 with Rob:
//   Balance 15% | Stride 20% | Arm Path 25% | Release 25% | Finish 15%
// Arm Path + Release carry the most because they're the strongest predictors
// of both velocity and injury risk; Balance and Finish are the lightest
// because they're partly downstream effects of the middle phases.
//
// IMPORTANT: storage uses these canonical names regardless of sport. The UI
// surface remaps to softball-specific labels at render time via
// PITCHING_LABELS — see pickPitchingLabels(). Keeping a single canonical
// shape in DynamoDB means leaderboards, history, and charts work without
// per-sport branching.

import type { Breakdown } from "../types";

export const METRIC_WEIGHTS = {
  balance: 0.15,
  stride: 0.20,
  arm_path: 0.25,
  release: 0.25,
  finish: 0.15,
} as const;

export type MetricKey = keyof typeof METRIC_WEIGHTS;

// Sport-aware display labels. Underlying scoring is the same — only the
// UI text changes — so a softball pitcher sees "Circle/Snap" language and
// a baseball pitcher sees "Arm Path/Release". Add new sports here only.
export const PITCHING_LABELS: Record<"baseball" | "softball", Record<MetricKey, string>> = {
  baseball: {
    balance: "Balance",
    stride: "Stride",
    arm_path: "Arm Path",
    release: "Release",
    finish: "Finish",
  },
  softball: {
    balance: "Balance",
    stride: "Stride",
    arm_path: "Circle",
    release: "Snap",
    finish: "Finish",
  },
};

export function pickPitchingLabels(sport: string | undefined | null): Record<MetricKey, string> {
  return /softball/i.test(sport || "") ? PITCHING_LABELS.softball : PITCHING_LABELS.baseball;
}

// Chronological metric order — frame story flows: setup → stride → arm action
// → release → follow-through. Used by score cards, OG images, breakdown rows.
export const METRIC_ORDER: ReadonlyArray<MetricKey> = [
  "balance",
  "stride",
  "arm_path",
  "release",
  "finish",
];

export type NormalizedBreakdown = {
  balance: number;
  stride: number;
  arm_path: number;
  release: number;
  finish: number;
};

// Coalesce legacy 3-metric breakdowns ({timing, power_transfer, bat_control})
// into the 5-metric shape so old SwingAnalyses rows still render. Without
// this the dashboard would show NaN for any analysis run pre-migration.
//
// Legacy → new mapping (rough but believable):
//   timing         → arm_path  (arm action quality was scored as "timing")
//   power_transfer → stride    (mechanics/lower-half was "power_transfer")
//   bat_control    → release   (command/repeatability was "bat_control")
//   balance, finish are back-filled as averages — see below.
export function normalizeBreakdown(b: Partial<Breakdown> | undefined | null): NormalizedBreakdown {
  const arm_path = b?.arm_path ?? b?.timing ?? 0;
  const stride = b?.stride ?? b?.power_transfer ?? 0;
  const release = b?.release ?? b?.bat_control ?? 0;
  const isLegacy = b?.balance == null && b?.finish == null && (b?.timing != null || b?.power_transfer != null);
  const balance = b?.balance ?? (isLegacy ? Math.round((stride + arm_path) / 2) : 0);
  const finish = b?.finish ?? (isLegacy ? Math.round((arm_path + release) / 2) : 0);
  return { balance, stride, arm_path, release, finish };
}

export function computeOverall(b: NormalizedBreakdown): number {
  return Math.round(
    b.balance * METRIC_WEIGHTS.balance +
    b.stride * METRIC_WEIGHTS.stride +
    b.arm_path * METRIC_WEIGHTS.arm_path +
    b.release * METRIC_WEIGHTS.release +
    b.finish * METRIC_WEIGHTS.finish
  );
}

// Returns the lowest-scoring metric — used by plan generation to allocate
// the largest share of drills to the player's weakest phase.
export function weakestMetric(b: NormalizedBreakdown): MetricKey {
  let weakest: MetricKey = "balance";
  let min = b.balance;
  (Object.keys(METRIC_WEIGHTS) as MetricKey[]).forEach((k) => {
    if (b[k] < min) {
      min = b[k];
      weakest = k;
    }
  });
  return weakest;
}
