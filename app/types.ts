// Breakdown is the full union of new (5-metric) and legacy (3-metric) fields,
// all optional, so historical rows from before the 2026-05-07 migration still
// type-check at read time. normalizeBreakdown() in app/lib/score.ts coerces
// either shape into the 5-metric form for rendering.
export type Breakdown = {
  // 5-metric pitching model (current)
  balance?: number;
  stride?: number;
  arm_path?: number;
  release?: number;
  finish?: number;
  // legacy 3-metric (pre-2026-05-07 rows)
  timing?: number;
  power_transfer?: number;
  bat_control?: number;
};

export type Result = {
  score: number;
  score_label: string;
  breakdown: Breakdown;
  top3: string[];
  impact_line: string;
  uplift_line: string;
  // sport is read by the ShareCard and dashboard label resolver to pick
  // softball ("Circle"/"Snap") vs baseball ("Arm Path"/"Release") UI text.
  // Optional because legacy /api/analyze responses didn't include it; the
  // landing page passes it explicitly when constructing a Result for share.
  sport?: string;
};
