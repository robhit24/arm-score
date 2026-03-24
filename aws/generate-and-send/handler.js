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

// OpenAI package is ESM-first; this works in CommonJS:
const OpenAI = require("openai").default || require("openai");

const ses = new SESClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SWING_TABLE = process.env.SWING_TABLE;
const JOBS_TABLE = process.env.JOBS_TABLE;
const SES_FROM = process.env.SES_FROM;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

function normalizePlan(plan, planDays) {
  // Ensure arrays exist and daily is sorted
  plan.weekly_blocks = Array.isArray(plan.weekly_blocks) ? plan.weekly_blocks : [];
  plan.daily_plan = Array.isArray(plan.daily_plan) ? plan.daily_plan : [];

  plan.daily_plan = plan.daily_plan
    .slice()
    .sort((a, b) => (Number(a?.day) || 0) - (Number(b?.day) || 0));

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

  // Identify weakest area to weight the drill selection
  const bd = analysis.breakdown || {};
  const areas = [
    { name: "arm_path", label: "Arm Path", score: bd.timing || 70 },
    { name: "mechanics", label: "Mechanics", score: bd.power_transfer || 70 },
    { name: "command", label: "Command", score: bd.bat_control || 70 },
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
Arm Path: ${bd.timing} | Mechanics: ${bd.power_transfer} | Command: ${bd.bat_control}
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
- Baseball plans must include 3 arm care exercises EVERY day (not 2)
- At least one exercise from each category: band work, stretching, recovery
- Include "ice 15 minutes after any session with 30+ throws at full effort"
- Weekly: include 1 rest day with ONLY arm care and no throwing

ABSOLUTE RULES:
- Do NOT mention: ${banned.join(", ")}
- No video analysis, no self assessment, no coach feedback references
- This must read like an elite pitching development plan
- Every day must feel DIFFERENT from the day before
- Arm safety is the #1 priority — this plan should make parents feel confident their kid's arm is protected

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
      "warmup": [
        { "name":"string", "description":"2-3 sentences with specific body positions and movements", "reps":"string" }
      ],
      "drills": [
        {
          "name": "string (from the drill library or clearly original)",
          "purpose": "string (tie to athlete's specific weakness)",
          "how_to": "string (2-4 sentences, step-by-step with body positions)",
          "reps": "string (specific — e.g. '3 sets x 8 reps' not just 'repeat')",
          "cues": ["...","...","..."],
          "common_mistakes": ["...","..."]
        }
      ],
      "arm_care": [
        { "name":"string", "description":"string", "reps":"string" }
      ],
      "parent_help": [
        "string (specific observation or action for that day's drills)",
        "string"
      ],
      "success_metric": "string (observable outcome — e.g. 'release point consistent for 3+ consecutive reps')"
    }
  ],
  "equipment_notes": ["...","..."],
  "safety_notes": ["Include age-appropriate pitch count guidelines for ${safeAge}", "Include rest day recommendations", "Include signs of arm fatigue to watch for", "..."],
  "arm_care_overview": "string (3-4 sentences explaining the importance of arm care for this age group and what the daily arm care routine targets)"
}

CONSTRAINTS:
- weekly_blocks: exactly ${weekCount} weeks (1..${weekCount})
- daily_plan: EVERY day 1..${planDays}, no gaps
- Each day MUST include: 5-6 warmup exercises (full 3-phase warm-up: mobility → activation → throwing prep) + exactly 3 drills + 3 arm care exercises (baseball) or 2-3 arm care exercises (softball)
- Warmup MUST follow the full 3-phase progression EVERY SINGLE DAY — not just Day 1. Do NOT shortcut to "arm circles and butt kicks" on later days.
- EVERY day must have: 2 mobility exercises + 2 activation exercises + 2 throwing prep exercises = 6 warmup items minimum
- For softball: MUST include wrist snaps and K-drill in Phase 3 every day
- For baseball: MUST include wrist flicks progressing to long toss every day
- Vary the specific exercises within each phase day-to-day, but NEVER skip a phase
- If I see "arm circles" as the only warmup on any day, the plan is WRONG
- The warm-up alone should take 8-12 minutes. This is NOT optional — a proper warm-up prevents injury.
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

async function generateValidPlan({ openai, planDays, analysis }) {
  const sport = analysis.sport || "baseball";
  const ageGroup = analysis.age_group || "12U";

  let lastRaw = "";
  let lastErrs = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    const isRepair = attempt > 1;
    const prompt = isRepair
      ? promptRepair({ planDays, sport, analysis, previousRaw: lastRaw, errors: lastErrs })
      : promptForPlan({ planDays, analysis, sport, ageGroup });

    const resp = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: isRepair ? 0.25 : 0.35,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const raw = resp.choices?.[0]?.message?.content || "{}";
    lastRaw = raw;

    let plan;
    try {
      plan = JSON.parse(raw);
    } catch (e) {
      lastErrs = ["JSON.parse failed"];
      continue;
    }

    const v = validatePlan(plan, planDays);
    if (v.ok) return normalizePlan(plan, planDays);

    lastErrs = v.errors;
  }

  // if still failing, throw with raw included for debugging
  const err = new Error("Plan generation failed validation after retries");
  err.raw = lastRaw;
  err.errors = lastErrs;
  throw err;
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

function dayCardHtml(d) {
  const warm = (d.warmup || [])
    .map(
      (w) => `
      <div class="mini">
        <div class="miniTitle">${escapeHtml(w.name)}</div>
        <div class="miniText">${escapeHtml(w.description)}</div>
        <div class="miniMeta">${escapeHtml(w.reps)}</div>
      </div>`
    )
    .join("");

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
        .breakdownGrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 14px; }
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
                <div class="bdLabel">Timing</div>
                <div class="bdVal">${escapeHtml(analysis.breakdown?.timing)}</div>
              </div>
              <div class="bdItem">
                <div class="bdLabel">Power</div>
                <div class="bdVal">${escapeHtml(analysis.breakdown?.power_transfer)}</div>
              </div>
              <div class="bdItem">
                <div class="bdLabel">Bat Ctrl</div>
                <div class="bdVal">${escapeHtml(analysis.breakdown?.bat_control)}</div>
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

  if (!SWING_TABLE || !JOBS_TABLE || !SES_FROM || !OPENAI_API_KEY) {
    throw new Error("Missing env vars SWING_TABLE/JOBS_TABLE/SES_FROM/OPENAI_API_KEY");
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

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // Generate VALID plan (with retries)
    const planDays = Number(job.plan_days) || 14;
    const plan = await generateValidPlan({ openai, planDays, analysis });

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