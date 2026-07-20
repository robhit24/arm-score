"use strict";

const { SESClient, SendRawEmailCommand } = require("@aws-sdk/client-ses");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const crypto = require("crypto");

// Anthropic SDK — used for plan generation (claude-sonnet-4-6 with tool-use
// schema enforcement). Swapped from OpenAI gpt-4o on 2026-05-09 to mirror the
// batiq Lambda. Tool-use is meaningfully more reliable than asking for STRICT
// JSON in a system prompt, especially for the per-week structured warmup
// (mobility/activation/throwing_prep with distance ramp). Same dual-import
// shim used elsewhere for ESM-first packages.
const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");

// Bumping this string is the signal that "how plans are generated has changed."
// We stamp it onto every PlanJobs row alongside prompt_hash so we can A/B
// across versions and debug specific complaints. Bump whenever the prompt
// shape, drill library, or scoring schema changes — not for typo fixes.
const PROMPT_VERSION = "v3-2026-05-09-rotating-throwing-prep";
const PLAN_MODEL = "claude-sonnet-4-6";

const ses = new SESClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SWING_TABLE = process.env.SWING_TABLE;
const JOBS_TABLE = process.env.JOBS_TABLE;
const SES_FROM = process.env.SES_FROM;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const BRAND_NAME = process.env.BRAND_NAME || "ArmIQ";
const BRAND_PRIMARY = process.env.BRAND_PRIMARY || "#e10600";
const BRAND_DARK = process.env.BRAND_DARK || "#111111";
const REUPLOAD_URL = process.env.REUPLOAD_URL || "https://armiq.ai";

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function makeBoundary() {
  return `----=_Part_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function buildRawEmail({ to, subject, text, attachments = [] }) {
  const b = makeBoundary();

  const parts = [
    `From: ${SES_FROM}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${b}"`,
    ``,

    `--${b}`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    text,
    ``,
  ];

  for (const att of attachments) {
    parts.push(
      `--${b}`,
      `Content-Type: ${att.contentType}; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      att.base64,
      ``
    );
  }

  parts.push(`--${b}--`, ``);

  return Buffer.from(parts.join("\n"), "utf8");
}

async function htmlToPdfBuffer(html) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({ format: "Letter", printBackground: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

function chunkWeeks(planDays) {
  // 14 => 2w (7/7), 30 => 4w (7/7/7/9), 45 => 6w (7/7/7/7/7/10)
  if (planDays <= 14) return [7, 7];
  if (planDays <= 30) return [7, 7, 7, planDays - 21];
  return [7, 7, 7, 7, 7, planDays - 35];
}

function expectedWeekCount(planDays) {
  return chunkWeeks(planDays).length;
}

// Per-day warmup shape check. We hard-require the 3-phase structure because
// the user's #1 safety constraint is that pitching days ALWAYS open with a
// FULL arm warm-up — mobility → activation → throwing-prep with a distance
// ramp. A flat-array warmup (the pre-2026-05 schema) is treated as invalid
// here so the repair pass can re-generate it; normalizePlan keeps the legacy
// shape readable in the meantime so we never ship a worse plan than before.
function validateWarmupShape(w) {
  if (!w || typeof w !== "object" || Array.isArray(w)) return "warmup must be a {mobility,activation,throwing_prep} object";
  const m = Array.isArray(w.mobility) ? w.mobility : [];
  const a = Array.isArray(w.activation) ? w.activation : [];
  const t = Array.isArray(w.throwing_prep) ? w.throwing_prep : [];
  if (m.length < 2) return "mobility needs ≥2 exercises";
  if (a.length < 2) return "activation needs ≥2 exercises";
  if (t.length < 3) return "throwing_prep needs ≥3 exercises with distance ramp";
  return null;
}

function validatePlan(plan, planDays) {
  const errors = [];

  if (!plan || typeof plan !== "object") errors.push("plan not object");

  const daily = plan?.daily_plan;
  if (!Array.isArray(daily)) errors.push("daily_plan missing/invalid");
  else {
    const days = daily.map((d) => Number(d?.day)).filter((n) => Number.isFinite(n));
    const unique = new Set(days);
    if (unique.size !== planDays) errors.push(`daily_plan unique days != ${planDays} (got ${unique.size})`);
    for (let i = 1; i <= planDays; i++) {
      if (!unique.has(i)) errors.push(`missing day ${i}`);
    }

    // Warmup shape check on every day. One bad warmup invalidates the plan
    // (and triggers the repair attempt) — we never ship a pitching plan
    // missing throwing-prep ramp.
    for (const d of daily) {
      const wErr = validateWarmupShape(d?.warmup);
      if (wErr) errors.push(`day ${d?.day}: ${wErr}`);
    }
  }

  const weeks = plan?.weekly_blocks;
  const wc = expectedWeekCount(planDays);
  if (!Array.isArray(weeks) || weeks.length < wc) errors.push(`weekly_blocks missing/too short (need >= ${wc})`);

  // minimal required keys
  if (typeof plan?.title !== "string" || !plan.title.trim()) errors.push("title missing");
  if (typeof plan?.overview !== "string" || plan.overview.trim().length < 20) errors.push("overview too short/missing");
  if (typeof plan?.weekly_structure !== "string" || plan.weekly_structure.trim().length < 20)
    errors.push("weekly_structure too short/missing");

  return { ok: errors.length === 0, errors };
}

// Defensive coercion for warmup. Pre-2026-05 plans returned a flat array of
// 4 warmup items; the new schema is {mobility, activation, throwing_prep}. We
// keep historical plans renderable by best-effort splitting the flat array
// into the three buckets based on name keywords. Anything we can't classify
// goes into mobility (the safest fallback — it doesn't claim throwing-prep
// readiness it didn't earn).
function coerceLegacyWarmup(w) {
  if (!w) return { mobility: [], activation: [], throwing_prep: [] };
  if (!Array.isArray(w)) {
    return {
      mobility: Array.isArray(w.mobility) ? w.mobility : [],
      activation: Array.isArray(w.activation) ? w.activation : [],
      throwing_prep: Array.isArray(w.throwing_prep) ? w.throwing_prep : [],
    };
  }
  const out = { mobility: [], activation: [], throwing_prep: [] };
  for (const item of w) {
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

function normalizePlan(plan, planDays) {
  // Ensure arrays exist and daily is sorted
  plan.weekly_blocks = Array.isArray(plan.weekly_blocks) ? plan.weekly_blocks : [];
  plan.daily_plan = Array.isArray(plan.daily_plan) ? plan.daily_plan : [];

  plan.daily_plan = plan.daily_plan
    .slice()
    .sort((a, b) => (Number(a?.day) || 0) - (Number(b?.day) || 0));

  // Coerce any flat-array warmups to the structured shape.
  for (const d of plan.daily_plan) {
    if (d && (Array.isArray(d.warmup) || !d.warmup || typeof d.warmup !== "object")) {
      d.warmup = coerceLegacyWarmup(d.warmup);
    }
  }

  // Ensure week numbers exist
  const weeks = chunkWeeks(planDays);
  let day = 1;
  for (let w = 1; w <= weeks.length; w++) {
    const len = weeks[w - 1];
    for (let i = 0; i < len; i++) {
      const item = plan.daily_plan.find((x) => Number(x?.day) === day);
      if (item && !item.week) item.week = w;
      day++;
    }
  }

  return plan;
}

function promptForPlan({ planDays, analysis, sport, ageGroup }) {
  const weekCount = expectedWeekCount(planDays);

  const banned = [
    "video", "record", "self-assess", "self assess", "submit", "send a video",
    "coach feedback", "feedback", "upload again", "film yourself"
  ];

  // Identify weakest area to weight the drill selection.
  // Pitching uses the 5-metric model {balance, stride, arm_path, release, finish}.
  // Read with legacy fallbacks (timing/power_transfer/bat_control) so historical
  // rows from the pre-2026-04 hitting schema still produce useful weighting
  // instead of silently collapsing to the 70 default — this was the bug that
  // made every plan look identical regardless of athlete weakness. Mirror the
  // mapping in app/lib/score.ts and app/api/analyze/route.ts.
  const bd = analysis.breakdown || {};
  const areas = [
    { name: "balance",  label: "Balance",  score: bd.balance ?? 70 },
    { name: "stride",   label: "Stride",   score: bd.stride ?? bd.power_transfer ?? 70 },
    { name: "arm_path", label: "Arm Path", score: bd.arm_path ?? bd.timing ?? 70 },
    { name: "release",  label: "Release",  score: bd.release ?? bd.bat_control ?? 70 },
    { name: "finish",   label: "Finish",   score: bd.finish ?? 70 },
  ].sort((a, b) => a.score - b.score);
  const weakest = areas[0].label;
  const secondWeakest = areas[1].label;

  const safeAge = ageGroup || "12U";

  return `
You are an elite youth ${sport} pitching development coach designing a ${planDays}-day program.

ATHLETE AGE GROUP: ${safeAge}
Adapt everything to this age:
- 8U-10U: Keep sessions 15-20 min. Fun, game-like throwing drills. Simple cues (1-2 words). NO weighted balls or resistance bands. Focus on balance, direction, and basic arm path. Parent involvement critical.
- 11U-13U: Sessions 20-25 min. Introduce proper pitching mechanics concepts. Light towel drills and flatground work. Start building repeatable delivery patterns. Can use light resistance bands for hips only.
- 14U-16U: Sessions 25-35 min. Full mechanical drills. Weighted ball programs appropriate. Mound work with intent. Can handle complex multi-step cues. Developing velocity and command.
- 17U-18U: Sessions 30-40 min. Near-adult programming. Advanced sequencing, bullpen sessions, game-speed transfer. Weighted ball and long-toss integration.
- College/Adult: Full intensity. Advanced periodization. Pitch design, tunneling, game-situation specificity. Peak performance focus.

PITCH ANALYSIS:
Score: ${analysis.score} | Label: ${analysis.score_label}
Balance: ${bd.balance ?? "?"} | Stride: ${bd.stride ?? bd.power_transfer ?? "?"} | Arm Path: ${bd.arm_path ?? bd.timing ?? "?"} | Release: ${bd.release ?? bd.bat_control ?? "?"} | Finish: ${bd.finish ?? "?"}
Weakest area: ${weakest} (${areas[0].score}), then ${secondWeakest} (${areas[1].score})
Top 3 issues:
1) ${analysis.top3?.[0]}
2) ${analysis.top3?.[1]}
3) ${analysis.top3?.[2]}
Impact: ${analysis.impact_line}
Uplift: ${analysis.uplift_line}

DRILL LIBRARY — you MUST use drills from this list (mix and vary across days). You may add 3-5 original drills not on this list, but the majority must come from here:

ARM PATH DRILLS: Arm circle wall drill, Elbow spiral drill, Scarecrow throws, High-cocked position holds, Forearm spiral drill, Prone Y-T-W raises, Thumb-to-thigh path drill, Standing arm action drill, Figure-8 arm path drill, Behind-the-back catch drill

MECHANICS DRILLS: Hip-to-shoulder separation drill, Stride length markers, Rocker drill (momentum work), Knee-to-knee drive drill, Flatground with focus cues, Towel drill for extension, Hershiser drill (cross-body), Drop-step power drill, Pivot-and-throw drill, Walk-through delivery drill

COMMAND DRILLS: Target toss (4 quadrants), Glove-side finish drill, Balance point holds (3-sec), Eyes-on-target tracking drill, Flat-ground spot work, Bullpen with zones, Change-up touch drill, 2-seam/4-seam location sets, Release point repetition drill, Controlled long toss (accuracy focus)

FULL PITCHING WARM-UP LIBRARY — every day must include a COMPLETE warm-up progression (5-6 exercises), not just 1-2 stretches. Build from mobility → activation → throwing prep:

BASEBALL WARM-UP PROGRESSION:
Phase 1 (Mobility): Arm circles, trunk rotations, hip circles, lateral lunges, leg swings, cat-cow spine, shoulder cross-body stretches
Phase 2 (Activation): Band pull-aparts, scapular wall slides, external rotation with band, prone Y-T-W raises, wrist pronation/supination
Phase 3 (Throwing Prep): Wrist flicks (10-15 at 10ft), one-knee throws (10 at 30ft), standing throws (10 at 45ft), crow hop throws (10 at 60ft), long toss build-up (60→90→120ft)

SOFTBALL WARM-UP PROGRESSION:
Phase 1 (Mobility): Arm circles (windmill motion), trunk rotations, hip circles, lateral lunges, wrist rolls, shoulder mobility circles
Phase 2 (Activation): Band pull-aparts, scapular wall slides, wrist snaps (stationary, 20 reps), K-drill (kneeling windmill motion, 15 reps), figure-8 arm path drill
Phase 3 (Throwing Prep): Wrist snaps at 10ft (15 reps), K-drill progression to standing (15 reps), half-circle throws at 20ft (10 reps), full windmill at 30ft (10 reps), build to full distance (10 at game speed)

SOFTBALL-SPECIFIC DRILLS (use these for softball athletes):
K-drill (kneeling windmill), Wrist snap drill, Half-circle drill, Wall spin drill, Bucket drill (release point), Walk-through windmill, Power line drill, Stride-and-throw, Glove snap drill, Backhand spin drill

Use the CORRECT warm-up progression for ${sport}. Softball athletes MUST use the softball warm-up including wrist snaps and K-drill. Baseball athletes use the baseball progression.

ARM CARE LIBRARY (post-session):
Jaeger band routine (full J-band series), Sleeper stretches (30 sec each side), Prone Y-T-W raises (10 reps each), Reverse throws (15 light reps), Wrist weight pronation/supination (2x15), Cross-body shoulder stretch (30 sec each), Forearm roller (2x30 sec), Ice (15 min if thrown hard), Foam roll thoracic spine

VARIETY RULES (CRITICAL):
- NEVER repeat the same drill name on consecutive days
- Within each week, use at least 6 DIFFERENT drill names across the 7 days
- Vary warmup exercises — rotate through at least 4 different warmups per week
- Change rep counts and set structures week to week (e.g., 3x10 -> 4x8 -> 3x12)
- Each week must introduce at least 2 drills NOT used the previous week
- Weight drill selection toward ${weakest} (40% of drills), ${secondWeakest} (35%), strongest area (25%)
- ALWAYS include at least 1 arm care exercise per day

PROGRESSION ARC (week by week):
Week 1: Isolation + feel — slow reps, exaggerated positions, building awareness of the ${weakest} issue
Week 2: Sequencing — connect ${weakest} fix into the full delivery chain, tempo work
${weekCount >= 4 ? `Week 3: Intent + velocity — add long toss distance, increase intensity, weighted ball work (age appropriate)
Week 4: Integration — mound work, bullpen sessions, game-speed reps with focus cues` : ""}
${weekCount >= 6 ? `Week 5: Pressure reps — pitch count challenges, simulated innings, fatigue management
Week 6: Peak + maintain — full bullpen sessions, confidence building, pre-game routines` : ""}

PITCH COUNT & REST GUIDELINES BY AGE — INCLUDE ALL OF THIS FOR ${safeAge} IN safety_notes (this is critical for parent education):

BASEBALL:
- 8U: Max 50 pitches/game, 2 appearances/week. NO breaking balls. 1 day rest after 1-20 pitches, 2 days after 21-35, 3 days after 36-50.
- 9U-10U: Max 75 pitches/game, 2 appearances/week. NO breaking balls. 1 day rest after 1-20, 2 days after 21-35, 3 days after 36-50, 4 days after 51-65.
- 11U-12U: Max 85 pitches/game. Fastball and changeup ONLY. 1 day rest after 1-20, 2 days after 21-35, 3 days after 36-50, 4 days after 51-65.
- 13U-14U: Max 95 pitches/game. Can introduce curveball with proper mechanics. 1 day rest after 1-20, 2 days after 21-35, 3 days after 36-50, 4 days after 51-65.
- 15U-16U: Max 95 pitches/game. Full arsenal allowed. 1 day rest after 1-30, 2 days after 31-45, 3 days after 46-60, 4 days after 61+.
- 17U-18U: Max 105 pitches/game. Monitor workload and innings carefully. Same rest rules as 15U-16U.
- College/Adult: Follow team guidelines. Track pitch counts, innings per week, and overall workload.

SOFTBALL:
- No official pitch count limits but fatigue MUST be monitored
- Watch for: drop in velocity, loss of control, change in arm slot, complaints of tiredness
- Recommend: max 2 games/day with at least 30 min rest between, no more than 4 appearances/week during heavy tournament play
- Rest: 1 day off after 60+ pitches, at minimum

WARNING SIGNS OF ARM FATIGUE (include in safety_notes for ALL ages):
- Decreased velocity or "arm feels heavy"
- Loss of command / can't locate fastball
- Change in arm slot or release point
- Elbow or shoulder pain DURING or AFTER throwing (STOP IMMEDIATELY)
- Taking longer to warm up than usual
- Avoiding throwing or making excuses not to pitch

PARENT NOTE: If a coach is asking your athlete to pitch through pain or ignoring pitch counts, it is YOUR responsibility to protect your child's arm. No game is worth a torn UCL or shoulder injury. These guidelines are based on USA Baseball, Pitch Smart, and MLB recommendations.

ARM CARE EMPHASIS (especially for baseball):
- Each day includes exactly 2 arm care exercises post-session
- Across the week, cover band work, stretching, and recovery
- Include "ice 15 minutes after any session with 30+ throws at full effort"
- Weekly: include 1 rest day with ONLY arm care and no throwing

ABSOLUTE RULES:
- Do NOT mention: ${banned.join(", ")}
- No video analysis, no self assessment, no coach feedback references
- This must read like an elite pitching development plan
- Every day must feel DIFFERENT from the day before
- Arm safety is the #1 priority — this plan should make parents feel confident their kid's arm is protected

BE CONCISE. Descriptions are ONE short sentence. how_to is 1-2 sentences. No marketing prose. The plan must fit in the response budget — verbose padding causes truncation.

OUTPUT: Return STRICT JSON ONLY with exactly these keys:
{
  "title": "string",
  "overview": "string (3-6 confident sentences referencing the athlete's specific weaknesses)",
  "weekly_structure": "string (describe what changes each week and WHY)",
  "weekly_blocks": [
    { "week": 1, "theme": "string", "goals": ["...","...","..."], "focus_points": ["...","...","..."] }
  ],
  "daily_plan": [
    {
      "day": 1,
      "week": 1,
      "session_time_min": 25,
      "focus": "string (specific to that day, not generic)",
      "warmup": {
        "mobility": [
          { "name":"string", "description":"1 short sentence with the body position", "reps":"string" }
        ],
        "activation": [
          { "name":"string", "description":"1 short sentence with the body position", "reps":"string" }
        ],
        "throwing_prep": [
          { "name":"string", "description":"1 short sentence", "reps":"string", "distance_ft":"string (e.g. '10 ft', '45 ft', '60 ft')" }
        ]
      },
      "drills": [
        {
          "name": "string (from the drill library or clearly original)",
          "purpose": "string (1 short sentence — tie to athlete's weakness)",
          "how_to": "string (1-2 sentences, step-by-step)",
          "reps": "string (specific — e.g. '3 sets x 8 reps' not just 'repeat')",
          "cues": ["...","...","..."],
          "common_mistakes": ["...","..."]
        }
      ],
      "arm_care": [
        { "name":"string", "description":"1 short sentence", "reps":"string" }
      ],
      "parent_help": [
        "string (one specific observation or action for the day)"
      ],
      "success_metric": "string (observable outcome — e.g. 'release point consistent for 3+ consecutive reps')"
    }
  ],
  "equipment_notes": ["...","..."],
  "safety_notes": ["Write the ACTUAL pitch count limits and rest day rules for ${safeAge} from the guidelines above — real numbers, not placeholders", "Write ACTUAL rest day requirements (e.g. '2 days rest after 36-50 pitches')", "List the ACTUAL warning signs of arm fatigue", "Write a parent protection note about coaches who over-pitch"],
  "arm_care_overview": "string (3-4 sentences explaining the importance of arm care for this age group and what the daily arm care routine targets)"
}

CONSTRAINTS:
- weekly_blocks: exactly ${weekCount} weeks (1..${weekCount})
- daily_plan: EVERY day 1..${planDays}, no gaps
- Each day MUST include: a structured warmup object + exactly 3 drills + exactly 2 arm care exercises
- WARMUP IS NON-NEGOTIABLE — every pitching day must open with a complete arm warm-up. The "warmup" object must contain:
  * mobility: at least 2 exercises (full-body and shoulder mobility — NOT just static stretches)
  * activation: at least 2 exercises (band pull-aparts, scapular activation, rotator cuff prep)
  * throwing_prep: at least 3 exercises with a clear distance ramp from short to long (start ≤15ft, build to playing distance)
- THROWING-PREP ROTATION (CRITICAL): the throwing_prep list must vary day-to-day. Within any 7-day window, use at least 5 DIFFERENT throwing-prep drill names across the week. Repeating the exact same 3 drills (e.g. "Wrist Flicks → Short Toss → Long Toss") every day is FORBIDDEN — that is the failure mode we are explicitly preventing. The distance ramp shape (short → mid → long) is preserved every day, but the specific drills filling those slots rotate.
- BASEBALL throwing-prep pool to rotate from: wrist flicks, one-knee throws, two-knee throws, towel snaps, crow-hop throws, rocker throws, drop-step throws, walking throws, long-toss pulldowns, fungo-distance throws, glove-side flips, scarecrow throws. Every day must include at least one of {wrist flicks, towel snaps} as the opener AND end with a long-toss build-up (e.g. 30→45→60→90ft).
- SOFTBALL throwing-prep pool to rotate from: wrist snaps (stationary), K-drill kneeling, K-drill standing, half-circle throws, full-windmill at short distance, walk-through windmill, power-line throws, stride-and-throw, glove snaps, bucket-drill release. Every day must include at least one of {wrist snaps, K-drill} as the opener AND ramp to game distance.
- A pitcher who skips the throwing-prep ramp risks injury. NEVER abbreviate warmup, NEVER write "see Day 1" or similar shortcuts, NEVER collapse phases. Each day lists every warmup exercise in full.
- Vary the SPECIFIC exercises across days for ALL three phases (mobility, activation, throwing_prep), not just one.
- Do NOT use "arm circles" or "butt kicks" alone. Use REAL pitcher warmup exercises from the library above.
- Cues: each cue ≤ 7 words, action-verb. Three cues per drill: one body cue (where to feel it), one timing cue (when), one finish cue (what success looks like).
- Reps: be specific — e.g. "3 sets x 8 reps @ moderate tempo", not "repeat" or "do a few".
- Banned voice: never use "unlock", "supercharge", "leverage", "elevate", "transform", "seamlessly", "synergy", "next-level", "game-changing". Write like a coach, not a brochure.
- Arm care section is POST-session recovery: band exercises, stretches, icing guidelines
- safety_notes must include pitch count guidelines specific to ${safeAge}
- Keep JSON valid. No markdown. No extra keys.
`;
}

function promptRepair({ planDays, sport, analysis, previousRaw, errors }) {
  const weekCount = expectedWeekCount(planDays);
  return `
You previously returned invalid JSON or an incomplete plan. Fix it.

Requirements:
- Return STRICT JSON ONLY with the exact required keys.
- weekly_blocks must have exactly ${weekCount} weeks (1..${weekCount}).
- daily_plan must contain EVERY day 1..${planDays} with no gaps.

Common errors to fix:
${errors.map((e) => "- " + e).join("\n")}

Use this analysis context:
Score: ${analysis.score}
Top3: ${JSON.stringify(analysis.top3 || [])}
Sport: ${sport}

Here is your previous output (for reference, do not include it in final answer):
${previousRaw}

Now return the corrected JSON only.
`;
}

// Skeleton prompt: title, overview, weekly_blocks (themes/goals), equipment,
// safety, arm_care_overview. Output is small (~2-3K tokens) so this call
// always completes well under any token cap and gives downstream per-week
// calls a coherent "weekly_structure" string + per-week themes to anchor on.
function promptForSkeleton({ planDays, analysis, sport, ageGroup }) {
  const bd = analysis.breakdown || {};
  const safeAge = ageGroup || "12U";
  const weekCount = expectedWeekCount(planDays);

  return `You are an elite ${sport} pitching coach. Design the SKELETON of a ${planDays}-day program for a ${safeAge} ${sport} pitcher.

DO NOT generate daily content yet. Only produce the high-level structure.

ATHLETE CONTEXT:
Score: ${analysis.score} | Label: ${analysis.score_label}
Balance: ${bd.balance ?? "?"} | Stride: ${bd.stride ?? bd.power_transfer ?? "?"} | Arm Path: ${bd.arm_path ?? bd.timing ?? "?"} | Release: ${bd.release ?? bd.bat_control ?? "?"} | Finish: ${bd.finish ?? "?"}
Top 3: ${(analysis.top3 || []).join(" | ")}
Impact: ${analysis.impact_line || ""}
Uplift: ${analysis.uplift_line || ""}

OUTPUT (via tool call):
- title: confident plan title naming the athlete's age + sport
- overview: 3-5 sentences referencing specific weaknesses
- weekly_structure: 2-3 sentences describing what changes each week and WHY
- weekly_blocks: exactly ${weekCount} weeks (1..${weekCount}). Each week: theme, 3 goals, 3 focus_points
- equipment_notes: 4-6 items (real gear for ${safeAge})
- safety_notes: 4-5 items including pitch counts for ${safeAge} and arm-fatigue warning signs
- arm_care_overview: 2-3 sentences on importance of post-session arm care

BE CONCISE. No marketing language. Real coach voice.

PITCH COUNT REFERENCE for safety_notes (${safeAge}):
- 8U-10U: 50 max/day, 1 day rest after 21+, 2 days after 36+
- 11U-12U: 75 max/day, 1 day after 21+, 2 days after 36+, 3 days after 51+
- 13U-14U: 95 max/day, 1 day after 21+, 2 days after 36+, 3 days after 51+, 4 days after 66+
- 15U-16U: 95 max/day, same rest schema
- 17U-18U: 105 max/day, same rest schema

Banned voice: never "unlock / supercharge / leverage / elevate / transform / seamlessly / synergy / next-level / game-changing".`;
}

function promptForWeek({ weekNum, weekTheme, daysInWeek, startDay, sport, ageGroup, analysis, overviewContext }) {
  const bd = analysis.breakdown || {};
  const safeAge = ageGroup || "12U";

  return `You are an elite ${sport} pitching coach. Generate ONLY Week ${weekNum} (Days ${startDay}-${startDay + daysInWeek - 1}) of a pitching program.

BE CONCISE. Each description is ONE short sentence. how_to is 1-2 sentences. No marketing prose. The week must fit cleanly in the response budget.

Athlete: ${safeAge} ${sport} pitcher
Score: ${analysis.score} | Balance: ${bd.balance ?? "?"} | Stride: ${bd.stride ?? bd.power_transfer ?? "?"} | Arm Path: ${bd.arm_path ?? bd.timing ?? "?"} | Release: ${bd.release ?? bd.bat_control ?? "?"} | Finish: ${bd.finish ?? "?"}
Week theme: ${weekTheme}
${overviewContext}

Return STRICT JSON with exactly this structure:
{
  "days": [
    {
      "day": ${startDay},
      "week": ${weekNum},
      "session_time_min": 25,
      "focus": "string",
      "warmup": {
        "mobility": [
          { "name":"string", "description":"1 short sentence", "reps":"string" },
          { "name":"string", "description":"1 short sentence", "reps":"string" }
        ],
        "activation": [
          { "name":"string", "description":"1 short sentence", "reps":"string" },
          { "name":"string", "description":"1 short sentence", "reps":"string" }
        ],
        "throwing_prep": [
          { "name":"string", "description":"1 short sentence", "reps":"string", "distance_ft":"string (e.g. '10 ft')" },
          { "name":"string", "description":"1 short sentence", "reps":"string", "distance_ft":"string (e.g. '45 ft')" },
          { "name":"string", "description":"1 short sentence", "reps":"string", "distance_ft":"string (e.g. '60 ft')" }
        ]
      },
      "drills": [
        { "name":"string", "purpose":"string (1 sentence)", "how_to":"1-2 sentences", "reps":"string", "cues":["...","...","..."], "common_mistakes":["...","..."] },
        { "name":"string", "purpose":"string (1 sentence)", "how_to":"1-2 sentences", "reps":"string", "cues":["...","...","..."], "common_mistakes":["...","..."] },
        { "name":"string", "purpose":"string (1 sentence)", "how_to":"1-2 sentences", "reps":"string", "cues":["...","...","..."], "common_mistakes":["...","..."] }
      ],
      "arm_care": [
        { "name":"string", "description":"string", "reps":"string" },
        { "name":"string", "description":"string", "reps":"string" }
      ],
      "parent_help": ["string", "string"],
      "success_metric": "string"
    }
  ]
}

RULES:
- Generate exactly ${daysInWeek} days (Day ${startDay} through Day ${startDay + daysInWeek - 1})
- EVERY day's "warmup" MUST be the structured object with mobility ≥2, activation ≥2, throwing_prep ≥3 (distance ramp). Never skip phases. Never abbreviate. Never write "same as Day N".
- THROWING-PREP ROTATION IS MANDATORY across this week. Across the ${daysInWeek} days you generate, use at least ${Math.min(daysInWeek + 1, 6)} DIFFERENT throwing-prep drill names. Do NOT use the exact same 3 drills (e.g. wrist flicks → short toss → long toss) for every day — that is the bug we are fixing. The distance-ramp SHAPE stays the same (short → mid → long), but the specific drills rotate.
${sport === "softball"
  ? `- Softball throwing-prep pool: wrist snaps, K-drill kneeling, K-drill standing, half-circle throws, full-windmill at short distance, walk-through windmill, power-line throws, stride-and-throw, glove snaps, bucket-drill release.
- Every day must include at least one of {wrist snaps, K-drill (kneeling or standing)} as the opener, and ramp to game distance.`
  : `- Baseball throwing-prep pool: wrist flicks, one-knee throws, two-knee throws, towel snaps, crow-hop throws, rocker throws, drop-step throws, walking throws, long-toss pulldowns, fungo-distance throws, glove-side flips, scarecrow throws.
- Every day must include at least one of {wrist flicks, towel snaps} as the opener AND end with a long-toss build-up (e.g. 30→45→60→90ft). The intermediate drill rotates.`}
- Do NOT use generic warmups like "arm circles" or "butt kicks" alone
- Mobility and activation phases also rotate across days — do not repeat the exact same mobility pair on consecutive days.
- 3 drills per day from the pitching drill library, varied across the week
- Cues: ≤7 words each, three per drill (body / timing / finish). Reps must be specific ("3x8 @ moderate tempo", not "repeat").
- 2 arm care exercises per day (band work, stretches, recovery)
- Banned voice: no "unlock / supercharge / leverage / elevate / transform / seamlessly / synergy / next-level / game-changing"
- NO lazy placeholders. Every exercise must have real descriptions.
- Keep JSON valid.`;
}

// JSON Schema describing the full plan shape — passed to claude-sonnet-4-6
// as a tool input_schema. Anthropic strictly enforces this at generation
// time, which is meaningfully more reliable than asking for "STRICT JSON"
// in a system prompt and parsing the result. The validatePlan check below
// still runs because JSON Schema can't easily encode "exactly N unique day
// numbers" or "weekly_blocks length depends on planDays" — those remain
// imperative.
//
// History: armiq used to do per-week generation (one tool call per 7 days)
// to work around gpt-4o output token limits, but the per-week pattern
// timed out the Lambda on Sonnet (~2m43s per week × 6 weeks > 10min cap).
// Switched to whole-plan tool_use on 2026-05-10 mirroring batiq — Sonnet
// 4.6 handles 16k-token outputs cleanly in one shot, and tool_choice forces
// structured output every time.
// Shared per-day item shape, used by PLAN_TOOL_SCHEMA, WEEK_TOOL_SCHEMA,
// and the legacy whole-plan flow. Extracted so per-week orchestration and
// whole-plan tool-use enforce the exact same per-day contract.
const DAY_ITEM_SCHEMA = {
        type: "object",
        required: [
          "day", "week", "session_time_min", "focus", "warmup", "drills",
          "arm_care", "parent_help", "success_metric",
        ],
        properties: {
          day: { type: "integer" },
          week: { type: "integer" },
          session_time_min: { type: "integer" },
          focus: { type: "string" },
          // Structured 3-phase warmup. Mobility → activation → throwing-prep
          // (distance ramp). Anthropic enforces this at generation time, so
          // once the model returns a tool_use call we know each day has all
          // three phases present — validatePlan still checks minimum item
          // counts per phase. distance_ft is REQUIRED on throwing_prep so
          // the ramp can never be silently dropped.
          warmup: {
            type: "object",
            required: ["mobility", "activation", "throwing_prep"],
            properties: {
              // minItems is enforced by Claude tool-use. Without it the
              // model will skimp on warmup on later days as it approaches
              // the output token budget, producing 1-2 throwing_prep items
              // instead of the 3-item distance ramp. We fixed this on
              // 2026-05-10 after CloudWatch showed odd days with only 1-2
              // throwing_prep entries.
              mobility: {
                type: "array",
                minItems: 2,
                items: {
                  type: "object",
                  required: ["name", "description", "reps"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    reps: { type: "string" },
                  },
                },
              },
              activation: {
                type: "array",
                minItems: 2,
                items: {
                  type: "object",
                  required: ["name", "description", "reps"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    reps: { type: "string" },
                  },
                },
              },
              throwing_prep: {
                type: "array",
                minItems: 3,
                items: {
                  type: "object",
                  required: ["name", "description", "reps", "distance_ft"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    reps: { type: "string" },
                    distance_ft: { type: "string" },
                  },
                },
              },
            },
          },
          drills: {
            type: "array",
            minItems: 3,
            items: {
              type: "object",
              required: ["name", "purpose", "how_to", "reps", "cues", "common_mistakes"],
              properties: {
                name: { type: "string" },
                purpose: { type: "string" },
                how_to: { type: "string" },
                reps: { type: "string" },
                cues: { type: "array", items: { type: "string" } },
                common_mistakes: { type: "array", items: { type: "string" } },
              },
            },
          },
          arm_care: {
            type: "array",
            minItems: 2,
            items: {
              type: "object",
              required: ["name", "description", "reps"],
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                reps: { type: "string" },
              },
            },
          },
          parent_help: { type: "array", items: { type: "string" } },
          success_metric: { type: "string" },
        },
};

// Whole-plan tool schema. Kept for posterity / future small-plan paths but
// the active runtime path is per-week orchestration via WEEK_TOOL_SCHEMA +
// SKELETON_TOOL_SCHEMA. Whole-plan tool_use kept hitting max_tokens because
// claude-sonnet-4-6 fills any output budget you give it before closing
// daily_plan as a valid array — see commit log 2026-05-10 for the receipts.
const PLAN_TOOL_SCHEMA = {
  type: "object",
  required: [
    "title", "overview", "weekly_structure", "weekly_blocks",
    "daily_plan", "equipment_notes", "safety_notes", "arm_care_overview",
  ],
  properties: {
    title: { type: "string" },
    overview: { type: "string" },
    weekly_structure: { type: "string" },
    arm_care_overview: { type: "string" },
    weekly_blocks: {
      type: "array",
      items: {
        type: "object",
        required: ["week", "theme", "goals", "focus_points"],
        properties: {
          week: { type: "integer" },
          theme: { type: "string" },
          goals: { type: "array", items: { type: "string" } },
          focus_points: { type: "array", items: { type: "string" } },
        },
      },
    },
    daily_plan: { type: "array", items: DAY_ITEM_SCHEMA },
    equipment_notes: { type: "array", items: { type: "string" } },
    safety_notes: { type: "array", items: { type: "string" } },
  },
};

// Skeleton schema: everything except daily_plan. Used in step 1 of the
// per-week orchestration flow. Output is small (~2-3K tokens), so this call
// completes quickly and never bumps the SDK's 10-minute streaming guard.
const SKELETON_TOOL_SCHEMA = {
  type: "object",
  required: [
    "title", "overview", "weekly_structure", "weekly_blocks",
    "equipment_notes", "safety_notes", "arm_care_overview",
  ],
  properties: {
    title: { type: "string" },
    overview: { type: "string" },
    weekly_structure: { type: "string" },
    arm_care_overview: { type: "string" },
    weekly_blocks: {
      type: "array",
      items: {
        type: "object",
        required: ["week", "theme", "goals", "focus_points"],
        properties: {
          week: { type: "integer" },
          theme: { type: "string" },
          goals: { type: "array", items: { type: "string" } },
          focus_points: { type: "array", items: { type: "string" } },
        },
      },
    },
    equipment_notes: { type: "array", items: { type: "string" } },
    safety_notes: { type: "array", items: { type: "string" } },
  },
};

// Per-week schema: just the days array for one week. Output is bounded to
// ~5-6K tokens for a 7-day week, well under any single-call cap. Each week
// call takes ~2-3min; for a 14-day plan that's 1 skeleton + 2 weeks = 3
// calls fitting comfortably in the 900s Lambda budget.
const WEEK_TOOL_SCHEMA = {
  type: "object",
  required: ["days"],
  properties: {
    days: { type: "array", items: DAY_ITEM_SCHEMA },
  },
};

// Whole-plan rotation validator. JSON Schema can't express "across the 7
// days of week N, ≥6 distinct throwing_prep drill names." The v2 failure
// mode (same 3 drills on every day) bypasses every shape check and only
// shows up when you compare day-to-day, so this stays imperative. Returns
// list of error strings — empty array == ok.
function validateThrowingPrepRotation(plan) {
  const errors = [];
  const daily = Array.isArray(plan?.daily_plan) ? plan.daily_plan : [];
  const byWeek = new Map();
  for (const d of daily) {
    const wk = Number(d?.week) || 1;
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk).push(d);
  }
  for (const [wk, days] of byWeek.entries()) {
    if (days.length < 2) continue;
    const tpNames = new Set();
    for (const d of days) {
      const tp = d?.warmup?.throwing_prep;
      if (Array.isArray(tp)) {
        for (const item of tp) {
          const n = String(item?.name || "").toLowerCase().trim();
          if (n) tpNames.add(n);
        }
      }
    }
    const minDistinct = Math.min(days.length + 1, 6);
    if (tpNames.size < minDistinct) {
      errors.push(`week ${wk} throwing_prep rotation too narrow: ${tpNames.size} distinct names across ${days.length} days (need ≥${minDistinct})`);
    }
  }
  return errors;
}

// Per-week orchestrated generation. The single-shot whole-plan tool_use
// pattern (used by batiq) repeatedly hit max_tokens on armiq because armiq's
// per-day shape (structured warmup with distance ramp + 3 drills + 2
// arm_care) is ~30-40% larger than batiq's. claude-sonnet-4-6 fills
// whatever output budget you give it before closing daily_plan as a valid
// array, so bumping max_tokens just bought longer runs without solving the
// truncation. Splitting solves both: each week call is bounded to ~5-6K
// output tokens (well under any cap) and each call finishes in 2-3min, so
// a 14-day plan fits in 1 skeleton + 2 weeks ≈ 8-9min < the 900s Lambda.
async function generateValidPlan({ anthropic, planDays, analysis }) {
  const sport = analysis.sport || "baseball";
  const ageGroup = analysis.age_group || "12U";
  const weekCount = expectedWeekCount(planDays);

  // Step 1: skeleton call — title/overview/weekly_blocks/notes. Small output
  // (~2-3K tokens) so this almost never fails.
  const skeletonPrompt = promptForSkeleton({ planDays, analysis, sport, ageGroup });
  const skeletonHash = crypto.createHash("sha256").update(skeletonPrompt).digest("hex").slice(0, 8);
  console.log(`[plan] skeleton model=${PLAN_MODEL} prompt_version=${PROMPT_VERSION} prompt_hash=${skeletonHash}`);

  const skResp = await anthropic.messages.create({
    model: PLAN_MODEL,
    max_tokens: 4000,
    temperature: 0.25,
    tools: [{
      name: "submit_skeleton",
      description: "Submit the high-level plan skeleton (no daily content).",
      input_schema: SKELETON_TOOL_SCHEMA,
    }],
    tool_choice: { type: "tool", name: "submit_skeleton" },
    messages: [{ role: "user", content: skeletonPrompt }],
  });
  const skTool = (skResp.content || []).find(b => b && b.type === "tool_use" && b.name === "submit_skeleton");
  if (!skTool || !skTool.input || typeof skTool.input !== "object") {
    throw Object.assign(new Error("Plan generation failed: skeleton call returned no tool_use"), { errors: ["skeleton tool_use missing"] });
  }
  const skeleton = skTool.input;
  console.log(`[plan] skeleton ok stop_reason=${skResp.stop_reason} input_tokens=${skResp.usage?.input_tokens} output_tokens=${skResp.usage?.output_tokens} weeks=${(skeleton.weekly_blocks || []).length}`);

  // Step 2: one tool-use call per week. Each call returns just `days` for
  // that week with the same DAY_ITEM_SCHEMA enforcement as whole-plan
  // tool_use. We pass the skeleton's weekly_structure + the week's theme so
  // the model anchors on a consistent narrative across calls.
  //
  // Week sizes come from chunkWeeks() — the last week of a 30/45-day plan
  // is intentionally 8-10 days long, not 7. Earlier code used a fixed 7-day
  // step which silently dropped the trailing days (e.g. 30-day plan only
  // got 28 days generated, then validatePlan failed "day 29 missing").
  const allDays = [];
  const overviewContext = `PLAN OVERVIEW (so this week stays consistent with the rest):\n${skeleton.overview || ""}\nWeekly structure: ${skeleton.weekly_structure || ""}`;
  const weekSizes = chunkWeeks(planDays);
  let dayCursor = 1;

  for (let wk = 1; wk <= weekCount; wk++) {
    const weekBlock = (skeleton.weekly_blocks || []).find(b => Number(b.week) === wk) || { theme: `Week ${wk}` };
    const startDay = dayCursor;
    const daysInWeek = weekSizes[wk - 1];
    dayCursor += daysInWeek;
    const weekPrompt = promptForWeek({
      weekNum: wk,
      weekTheme: weekBlock.theme || `Week ${wk}`,
      daysInWeek,
      startDay,
      sport,
      ageGroup,
      analysis,
      overviewContext,
    });
    const weekHash = crypto.createHash("sha256").update(weekPrompt).digest("hex").slice(0, 8);
    console.log(`[plan] week=${wk}/${weekCount} startDay=${startDay} daysInWeek=${daysInWeek} prompt_hash=${weekHash}`);

    let weekDays = null;
    let lastWeekErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const wResp = await anthropic.messages.create({
        model: PLAN_MODEL,
        // 12000 leaves comfortable headroom for a 7-day week with structured
        // warmup + 3 drills + 2 arm_care per day. Earlier 8000 hit
        // max_tokens with days_returned=-1 because Sonnet's tool-use output
        // is more verbose than naive math predicts (each tool field carries
        // overhead beyond just the string content). Keep this below the
        // SDK's 10-minute streaming guard threshold (~24K).
        max_tokens: 12000,
        temperature: 0.25,
        tools: [{
          name: "submit_week",
          description: `Submit Week ${wk} (Days ${startDay}-${startDay + daysInWeek - 1}) with full per-day structure.`,
          input_schema: WEEK_TOOL_SCHEMA,
        }],
        tool_choice: { type: "tool", name: "submit_week" },
        messages: [{ role: "user", content: weekPrompt }],
      });
      const wTool = (wResp.content || []).find(b => b && b.type === "tool_use" && b.name === "submit_week");
      const days = wTool?.input?.days;
      console.log(`[plan] week=${wk} attempt=${attempt} stop_reason=${wResp.stop_reason} input_tokens=${wResp.usage?.input_tokens} output_tokens=${wResp.usage?.output_tokens} days_returned=${Array.isArray(days) ? days.length : -1}`);

      if (Array.isArray(days) && days.length === daysInWeek) {
        weekDays = days;
        break;
      }
      lastWeekErr = `week ${wk} returned ${Array.isArray(days) ? days.length : "?"} days, expected ${daysInWeek} (stop_reason=${wResp.stop_reason})`;
    }
    if (!weekDays) {
      throw Object.assign(new Error(`Plan generation failed: ${lastWeekErr}`), { errors: [lastWeekErr] });
    }
    allDays.push(...weekDays);
  }

  // Step 3: stitch into the whole-plan shape and run the existing
  // whole-plan validators (day count, rotation, etc.).
  const plan = {
    title: skeleton.title,
    overview: skeleton.overview,
    weekly_structure: skeleton.weekly_structure,
    weekly_blocks: skeleton.weekly_blocks,
    daily_plan: allDays,
    equipment_notes: skeleton.equipment_notes || [],
    safety_notes: skeleton.safety_notes || [],
    arm_care_overview: skeleton.arm_care_overview || "",
  };

  const v = validatePlan(plan, planDays);
  const rotationErrs = validateThrowingPrepRotation(plan);
  if (!v.ok || rotationErrs.length > 0) {
    const errs = [...v.errors, ...rotationErrs];
    console.log(`[plan] stitched validation_failed errors=${JSON.stringify(errs.slice(0, 10))} daily_plan_len=${plan.daily_plan.length}`);
    throw Object.assign(new Error("Plan generation failed validation after retries"), { errors: errs });
  }

  return {
    plan: normalizePlan(plan, planDays),
    meta: {
      prompt_version: PROMPT_VERSION,
      model_id: PLAN_MODEL,
      prompt_hash: skeletonHash,
      attempts: 1,
      warmup_repairs: 0,
    },
  };
}

function weeklyBlocksHtml(plan) {
  const blocks = plan.weekly_blocks || [];
  return blocks
    .map(
      (w) => `
      <div class="wkCard">
        <div class="wkTitle">Week ${escapeHtml(w.week)} - ${escapeHtml(w.theme)}</div>
        <div class="wkCols">
          <div>
            <div class="label">Goals</div>
            <ul>${(w.goals || []).map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ul>
          </div>
          <div>
            <div class="label">Focus Points</div>
            <ul>${(w.focus_points || []).map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
          </div>
        </div>
      </div>
    `
    )
    .join("");
}

function warmupPhaseHtml(label, items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  const inner = items
    .map((w) => {
      const meta = [w.reps, w.distance_ft].filter(Boolean).map(escapeHtml).join(" · ");
      return `
        <div class="mini">
          <div class="miniTitle">${escapeHtml(w.name)}</div>
          <div class="miniText">${escapeHtml(w.description)}</div>
          ${meta ? `<div class="miniMeta">${meta}</div>` : ""}
        </div>`;
    })
    .join("");
  return `
    <div class="warmupPhase">
      <div class="phaseLabel">${escapeHtml(label)}</div>
      ${inner}
    </div>`;
}

function dayCardHtml(d) {
  // Warmup is now {mobility, activation, throwing_prep}. Legacy flat-array
  // plans get coerced to this shape in normalizePlan, so reading the object
  // form is always safe here.
  const w = d.warmup || {};
  const warm = [
    warmupPhaseHtml("Mobility", w.mobility),
    warmupPhaseHtml("Activation", w.activation),
    warmupPhaseHtml("Throwing Prep", w.throwing_prep),
  ].join("");

  const drills = (d.drills || [])
    .map((dr) => {
      const cues = (dr.cues || []).map((c) => `<li>${escapeHtml(c)}</li>`).join("");
      const mistakes = (dr.common_mistakes || []).map((m) => `<li>${escapeHtml(m)}</li>`).join("");
      return `
        <div class="drill">
          <div class="drillHead">
            <div class="drillName">${escapeHtml(dr.name)}</div>
            <div class="drillReps">${escapeHtml(dr.reps)}</div>
          </div>
          <div class="drillPurpose">${escapeHtml(dr.purpose)}</div>
          <div class="drillHow">${escapeHtml(dr.how_to)}</div>
          <div class="drillGrid">
            <div>
              <div class="label">Cues</div>
              <ul>${cues}</ul>
            </div>
            <div>
              <div class="label">Watch for</div>
              <ul>${mistakes}</ul>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  const armCare = (d.arm_care || [])
    .map(
      (ac) => `
      <div class="mini">
        <div class="miniTitle">${escapeHtml(ac.name)}</div>
        <div class="miniText">${escapeHtml(ac.description)}</div>
        <div class="miniMeta">${escapeHtml(ac.reps)}</div>
      </div>`
    )
    .join("");

  const parent = (d.parent_help || []).map((p) => `<li>${escapeHtml(p)}</li>`).join("");

  return `
    <div class="dayCard">
      <div class="dayTop">
        <div class="dayBadge">Day ${escapeHtml(d.day)}</div>
        <div class="dayFocus">${escapeHtml(d.focus)}</div>
        <div class="dayTime">${escapeHtml(d.session_time_min)} min</div>
      </div>

      <div class="dayBody">
        <div class="box">
          <div class="boxTitle">Warm-up</div>
          ${warm || `<div class="miniText">Light warm-up + movement prep.</div>`}
        </div>

        <div class="box">
          <div class="boxTitle">Drills</div>
          ${drills}
        </div>

        ${armCare ? `<div class="box">
          <div class="boxTitle">Arm Care (Post-Session)</div>
          ${armCare}
        </div>` : ""}

        <div class="box">
          <div class="boxTitle">Parent / Coach Notes</div>
          <ul class="parentList">${parent}</ul>
          <div class="metric">${escapeHtml(d.success_metric)}</div>
        </div>
      </div>
    </div>
  `;
}

function planToHtml({ email, planDays, analysis, plan }) {
  const top3 = (analysis.top3 || []).map((x, i) => `<li><span class="fixNum">${i + 1}</span> ${escapeHtml(x)}</li>`).join("");
  const equip = (plan.equipment_notes || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("");
  const safety = (plan.safety_notes || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("");

  const scoreColor = (analysis.score || 0) >= 85 ? "#16a34a" : (analysis.score || 0) >= 70 ? "#f59e0b" : "#dc2626";

  const byWeek = new Map();
  for (const d of plan.daily_plan || []) {
    const w = Number(d.week) || 1;
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(d);
  }

  const weeksOrdered = Array.from(byWeek.keys()).sort((a, b) => a - b);

  const weeklyPages = weeksOrdered
    .map((w, idx) => {
      const days = byWeek.get(w) || [];
      const block = (plan.weekly_blocks || []).find(x => Number(x.week) === w);

      return `
        <div class="pageBreak ${idx === 0 ? "firstBreak" : ""}"></div>
        <div class="weekStart">
          <div class="weekBanner">
            <div class="weekBannerInner">
              <div class="weekBannerNum">Week ${w}</div>
              <div class="weekBannerTheme">${escapeHtml(block?.theme || "")}</div>
            </div>
          </div>
          ${days.length > 0 ? dayCardHtml(days[0]) : ""}
        </div>
        ${days.slice(1).map(dayCardHtml).join("")}
      `;
    })
    .join("");

  return `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          color: #1a1a1a;
          background: #fff;
          font-size: 13px;
          line-height: 1.5;
        }
        .wrap { padding: 32px; max-width: 800px; margin: 0 auto; }

        /* ── Cover ── */
        .coverBar { height: 4px; background: ${BRAND_PRIMARY}; border-radius: 0 0 2px 2px; }
        .coverHeader { display: flex; align-items: center; gap: 10px; margin: 20px 0 4px; }
        .brandDot { width: 10px; height: 10px; border-radius: 3px; background: ${BRAND_PRIMARY}; }
        .brandText { font-size: 13px; font-weight: 800; color: #1a1a1a; letter-spacing: -0.2px; }
        h1 { font-size: 26px; font-weight: 900; letter-spacing: -0.8px; color: #111; line-height: 1.15; margin-bottom: 4px; }
        .coverSub { color: #888; font-size: 11px; margin-bottom: 20px; }

        /* ── Score card ── */
        .scoreCard { display: flex; gap: 24px; padding: 20px; border-radius: 16px; background: #fafafa; margin-bottom: 16px; }
        .scoreLeft { text-align: center; min-width: 100px; }
        .scoreNum { font-size: 56px; font-weight: 900; line-height: 1; letter-spacing: -2px; }
        .scoreLabelSmall { font-size: 11px; color: #888; font-weight: 700; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.3px; }
        .scorePill { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #f0f0f0; font-size: 11px; font-weight: 800; color: #555; margin-top: 6px; }
        .scoreRight { flex: 1; }
        .breakdownGrid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-bottom: 14px; }
        .bdItem { text-align: center; padding: 10px 6px; border-radius: 10px; background: #fff; border: 1px solid #eee; }
        .bdLabel { font-size: 10px; color: #888; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 2px; }
        .bdVal { font-size: 22px; font-weight: 900; color: #111; }
        .fixList { list-style: none; margin: 0; padding: 0; }
        .fixList li { padding: 6px 0; border-bottom: 1px solid #f0f0f0; font-size: 12px; font-weight: 700; color: #333; display: flex; align-items: baseline; gap: 8px; }
        .fixList li:last-child { border-bottom: none; }
        .fixNum { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: #111; color: #fff; font-size: 10px; font-weight: 900; flex-shrink: 0; }

        /* ── Overview ── */
        .overviewCard { padding: 20px; border-radius: 16px; border: 1px solid #eee; margin-bottom: 16px; }
        .overviewTitle { font-size: 16px; font-weight: 900; color: #111; margin-bottom: 8px; letter-spacing: -0.3px; }
        .overviewText { color: #444; font-size: 13px; line-height: 1.6; }
        .structureLabel { font-size: 10px; color: #888; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; margin: 12px 0 4px; }

        /* ── Week blocks ── */
        .wkCard { border: 1px solid #eee; border-radius: 12px; padding: 14px; margin-top: 10px; }
        .wkTitle { font-weight: 900; font-size: 13px; color: #111; margin-bottom: 8px; }
        .wkCols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .wkCols .label { font-size: 10px; color: #888; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 4px; }
        .wkCols ul { margin: 0 0 0 16px; font-size: 12px; color: #444; }
        .wkCols li { margin-bottom: 3px; }

        /* ── Notes grid ── */
        .notesGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
        .noteBox { padding: 14px; border-radius: 12px; background: #fafafa; }
        .noteBox .label { font-size: 10px; color: #888; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 6px; }
        .noteBox ul { margin: 0 0 0 16px; font-size: 12px; color: #444; }
        .noteBox li { margin-bottom: 3px; }

        /* ── Week banner ── */
        .pageBreak { page-break-before: always; height: 1px; }
        .firstBreak { page-break-before: auto; }
        .weekStart { page-break-inside: avoid; }
        .weekBanner { margin: 8px 0 16px; padding: 16px 20px; border-radius: 14px; background: #111; color: #fff; page-break-after: avoid; }
        .weekBannerInner { display: flex; align-items: baseline; gap: 12px; }
        .weekBannerNum { font-size: 18px; font-weight: 900; letter-spacing: -0.3px; }
        .weekBannerTheme { font-size: 13px; font-weight: 700; opacity: 0.7; }

        /* ── Day cards ── */
        .dayCard { border: 1px solid #eee; border-radius: 14px; margin: 10px 0; overflow: hidden; page-break-inside: avoid; }
        .dayTop { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: #fafafa; border-bottom: 1px solid #eee; }
        .dayBadge { display: inline-flex; align-items: center; justify-content: center; padding: 3px 10px; border-radius: 8px; background: ${BRAND_PRIMARY}; color: #fff; font-size: 11px; font-weight: 900; }
        .dayFocus { font-weight: 800; color: #111; flex: 1; font-size: 13px; }
        .dayTime { color: #888; font-size: 11px; font-weight: 700; white-space: nowrap; }
        .dayBody { padding: 14px 16px; }

        .box { margin-bottom: 14px; }
        .box:last-child { margin-bottom: 0; }
        .boxTitle { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #f0f0f0; }

        .warmupPhase { margin-bottom: 8px; }
        .warmupPhase:last-child { margin-bottom: 0; }
        .phaseLabel { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.4px; color: ${BRAND_PRIMARY}; margin: 4px 0 4px 2px; }

        .mini { padding: 8px 10px; border-radius: 8px; background: #f8f8f8; margin-bottom: 6px; }
        .miniTitle { font-weight: 800; font-size: 12px; color: #111; }
        .miniText { color: #555; margin-top: 2px; font-size: 12px; }
        .miniMeta { color: #888; font-size: 11px; margin-top: 3px; font-weight: 700; }

        .drill { padding: 10px 12px; border-radius: 10px; background: #f8f8f8; margin-bottom: 8px; }
        .drillHead { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 4px; }
        .drillName { font-weight: 900; font-size: 13px; color: #111; }
        .drillReps { color: ${BRAND_PRIMARY}; font-size: 11px; font-weight: 800; white-space: nowrap; }
        .drillPurpose { color: #555; font-size: 12px; margin-bottom: 3px; }
        .drillHow { color: #333; font-size: 12px; line-height: 1.5; margin-bottom: 6px; }
        .drillGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .drillGrid .label { font-size: 10px; color: #888; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 3px; }
        .drillGrid ul { margin: 0 0 0 14px; font-size: 11px; color: #555; }
        .drillGrid li { margin-bottom: 2px; }

        .parentList { list-style: none; margin: 0; padding: 0; }
        .parentList li { padding: 4px 0; font-size: 12px; color: #444; border-bottom: 1px solid #f5f5f5; }
        .parentList li:last-child { border-bottom: none; }
        .metric { margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: #f0fdf4; border: 1px solid #dcfce7; font-size: 12px; font-weight: 700; color: #166534; }

        .footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid #eee; color: #aaa; font-size: 10px; text-align: center; }
        .label { color: #888; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
        ol { margin: 8px 0 0 18px; }
        ul { margin: 6px 0 0 16px; }
        @page { margin: 14mm; }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="coverBar"></div>
        <div class="coverHeader">
          <div class="brandDot"></div>
          <div class="brandText">${escapeHtml(BRAND_NAME)}</div>
        </div>
        <h1>Custom ${escapeHtml(planDays)}-Day Pitching Program</h1>
        <div class="coverSub">Prepared for ${escapeHtml(email)} · Based on your pitch analysis</div>

        <!-- Score card -->
        <div class="scoreCard">
          <div class="scoreLeft">
            <div class="scoreNum" style="color:${scoreColor}">${escapeHtml(analysis.score)}</div>
            <div class="scoreLabelSmall">Pitch Score</div>
            <div class="scorePill">${escapeHtml(analysis.score_label)}</div>
          </div>
          <div class="scoreRight">
            <div class="breakdownGrid">
              <div class="bdItem">
                <div class="bdLabel">Balance</div>
                <div class="bdVal">${escapeHtml(analysis.breakdown?.balance ?? "—")}</div>
              </div>
              <div class="bdItem">
                <div class="bdLabel">Stride</div>
                <div class="bdVal">${escapeHtml(analysis.breakdown?.stride ?? analysis.breakdown?.power_transfer ?? "—")}</div>
              </div>
              <div class="bdItem">
                <div class="bdLabel">Arm Path</div>
                <div class="bdVal">${escapeHtml(analysis.breakdown?.arm_path ?? analysis.breakdown?.timing ?? "—")}</div>
              </div>
              <div class="bdItem">
                <div class="bdLabel">Release</div>
                <div class="bdVal">${escapeHtml(analysis.breakdown?.release ?? analysis.breakdown?.bat_control ?? "—")}</div>
              </div>
              <div class="bdItem">
                <div class="bdLabel">Finish</div>
                <div class="bdVal">${escapeHtml(analysis.breakdown?.finish ?? "—")}</div>
              </div>
            </div>
            <ol class="fixList">${top3}</ol>
          </div>
        </div>

        <!-- Overview -->
        <div class="overviewCard">
          <div class="overviewTitle">${escapeHtml(plan.title || "Program Overview")}</div>
          <div class="overviewText">${escapeHtml(plan.overview || "")}</div>
          <div class="structureLabel">Weekly progression</div>
          <div class="overviewText">${escapeHtml(plan.weekly_structure || "")}</div>

          ${weeklyBlocksHtml(plan)}

          ${plan.arm_care_overview ? `<div style="margin-top:14px; padding:14px; border-radius:12px; background:#f0fdf4; border:1px solid #dcfce7;">
            <div class="label" style="color:#166534;">Arm Care Program</div>
            <div style="margin-top:4px; font-size:12px; color:#166534; font-weight:700; line-height:1.5;">${escapeHtml(plan.arm_care_overview)}</div>
          </div>` : ""}

          <div class="notesGrid">
            <div class="noteBox">
              <div class="label">Equipment</div>
              <ul>${equip}</ul>
            </div>
            <div class="noteBox">
              <div class="label">Safety & Pitch Count Guidelines</div>
              <ul>${safety}</ul>
            </div>
          </div>
        </div>

        ${weeklyPages}

        <div class="footer">
          ${escapeHtml(BRAND_NAME)} · Custom pitching development program · For skill development, not medical advice
        </div>
      </div>
    </body>
  </html>
  `;
}

async function setJobStatus(job_id, status, extra = {}) {
  const names = { "#s": "status" };
  const values = { ":s": status, ":t": new Date().toISOString() };
  let update = "SET #s = :s, updated_at = :t";

  for (const [k, v] of Object.entries(extra)) {
    const nk = `#${k}`;
    const vk = `:${k}`;
    names[nk] = k;
    values[vk] = v;
    update += `, ${nk} = ${vk}`;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: update,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

// ---------- main handler ----------
module.exports.handler = async (event) => {
  const { job_id } = event;

  if (!SWING_TABLE || !JOBS_TABLE || !SES_FROM || !ANTHROPIC_API_KEY) {
    throw new Error("Missing env vars SWING_TABLE/JOBS_TABLE/SES_FROM/ANTHROPIC_API_KEY");
  }

  // Load job
  const jobRes = await ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: { job_id } }));
  const job = jobRes.Item;
  if (!job) return;

  // If already sent, stop
  if (job.status === "sent") {
    console.log("Already sent:", job_id);
    return;
  }

  // Acquire lock: set status=processing only if not processing/sent
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: JOBS_TABLE,
        Key: { job_id },
        UpdateExpression: "SET #s = :processing, processing_started_at = :t",
        ConditionExpression: "attribute_not_exists(#s) OR (#s <> :sent AND #s <> :processing)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":processing": "processing",
          ":sent": "sent",
          ":t": new Date().toISOString(),
        },
      })
    );
  } catch (e) {
    console.log("Lock not acquired (already processing/sent):", job_id);
    return;
  }

  try {
    console.log("DEBUG_TABLE_REGION", {
      SWING_TABLE,
      JOBS_TABLE,
      swing_id: job.swing_id,
      plan_days: job.plan_days,
      email: job.email,
    });

    // Load analysis
    const analysisRes = await ddb.send(
      new GetCommand({ TableName: SWING_TABLE, Key: { swing_id: job.swing_id } })
    );
    const analysis = analysisRes.Item;

    // Missing analysis: graceful email + status
    if (!analysis) {
      const subject = `Action needed: upload your swing to generate your ${job.plan_days}-day program`;
      const text =
        `We received your purchase, but we cannot find the swing upload linked to your order.\n\n` +
        `Please upload your swing here: ${REUPLOAD_URL}\n\n` +
        `Order: ${job.order_id || ""}\n` +
        `If you reply to this email with your swing video, we will generate it manually.\n`;

      const rawEmail = buildRawEmail({
        to: job.email,
        subject,
        text,
        attachments: [],
      });

      const sesResp = await ses.send(new SendRawEmailCommand({ RawMessage: { Data: rawEmail } }));
      await setJobStatus(job_id, "needs_swing", {
        error_message: "Missing pitch analysis record",
        ses_message_id: sesResp?.MessageId || "unknown",
        failed_at: new Date().toISOString(),
      });

      console.log("Missing analysis - sent needs_swing email:", job_id);
      return;
    }

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    // Generate VALID plan (with per-week warmup-shape retries). Returns the
    // plan plus metadata (prompt_version / model_id / prompt_hash / attempts)
    // so we can stamp PlanJobs and A/B compare quality across versions.
    const planDays = Number(job.plan_days) || 14;
    const { plan, meta: planMeta } = await generateValidPlan({ anthropic, planDays, analysis });

    // Build PDF
    const html = planToHtml({
      email: job.email,
      planDays,
      analysis,
      plan,
    });

    const pdfBuffer = await htmlToPdfBuffer(html);
    const filename = `${BRAND_NAME}-Custom-${planDays}-Day-Pitching-Program.pdf`.replace(/\s+/g, "-");

    const subject = `Your Custom ${planDays}-Day Pitching Program (PDF)`;
    const text = `Attached is your custom ${planDays}-day program based on your pitch analysis.`;

    const rawEmail = buildRawEmail({
      to: job.email,
      subject,
      text,
      attachments: [
        {
          filename,
          contentType: "application/pdf",
          base64: pdfBuffer.toString("base64"),
        },
      ],
    });

    const sesResp = await ses.send(new SendRawEmailCommand({ RawMessage: { Data: rawEmail } }));

    await setJobStatus(job_id, "sent", {
      sent_at: new Date().toISOString(),
      ses_message_id: sesResp?.MessageId || "unknown",
      plan_json: JSON.stringify(plan),
      plan_days_generated: planDays,
      // Telemetry — keeps a paper trail of which prompt/model produced this
      // plan so we can A/B across PROMPT_VERSION bumps and trace specific
      // user complaints back to a specific prompt revision.
      plan_prompt_version: planMeta.prompt_version,
      plan_model_id: planMeta.model_id,
      plan_prompt_hash: planMeta.prompt_hash,
      plan_gen_attempts: planMeta.attempts,
      plan_warmup_repairs: planMeta.warmup_repairs,
    });

    console.log("Sent PDF email + stored plan JSON:", job_id);
  } catch (err) {
    console.error("Job failed:", job_id, err);

    // log raw if present
    if (err && err.raw) {
      console.log("PLAN_RAW_OUTPUT_START");
      console.log(err.raw);
      console.log("PLAN_RAW_OUTPUT_END");
    }
    if (err && err.errors) {
      console.log("PLAN_VALIDATION_ERRORS:", err.errors);
    }

    await setJobStatus(job_id, "failed", {
      failed_at: new Date().toISOString(),
      error_message: (err && err.message) ? err.message.slice(0, 900) : String(err).slice(0, 900),
    });

    throw err;
  }
};