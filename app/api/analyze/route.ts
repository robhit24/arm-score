import OpenAI from "openai";

export const runtime = "nodejs";

function clampInt(n: any) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(100, x));
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response("Missing OPENAI_API_KEY", { status: 500 });
    }

    const client = new OpenAI({ apiKey });

    const { email, sport, age_group, frames, frame_hash } = await req.json();
    const safeAge = age_group || "12U";

    if (!email || !email.includes("@")) {
      return new Response("Invalid email", { status: 400 });
    }

    if (!Array.isArray(frames) || frames.length < 3) {
      return new Response("Need frames[] (>=3)", { status: 400 });
    }

    // Server-side dedup
    if (frame_hash && typeof frame_hash === "string") {
      try {
        const checkUrl = `https://8156f6tuae.execute-api.us-east-2.amazonaws.com/live/store-analysis?frame_hash=${encodeURIComponent(frame_hash)}`;
        const checkRes = await fetch(checkUrl);
        if (checkRes.ok) {
          const cached = await checkRes.json();
          if (cached.found && cached.analysis) {
            return Response.json(cached.analysis);
          }
        }
      } catch (e) {
        console.log("Dedup check failed, proceeding:", e);
      }
    }

    const prompt = `You are an elite baseball/softball pitching mechanics analyst. You are looking at 4 frames extracted from a pitching video (roughly: wind-up/set, leg lift/balance, arm cocking/stride, release/follow-through).

This athlete is in the ${safeAge} age group. Calibrate your expectations accordingly:
- 8U/10U: Focus on balance and basic throwing motion. Don't expect full mechanics.
- 12U/14U: Developing mechanics. Hip-to-shoulder separation should be emerging.
- 16U/18U: Near-adult mechanics expected. Score closer to the full rubric.
- College/Adult: Full rubric, no adjustments. Elite standards.

Score this pitching delivery on THREE separate categories using the rubrics below. Be honest and specific for a ${safeAge} athlete.

═══ ARM PATH (0-100) ═══
90-100: Clean arm circle. Elbow at or above shoulder at foot strike. Smooth acceleration. No inverted W or short-arming.
70-89: Decent arm action but minor issue — elbow may lag slightly, or arm slot inconsistent. Functional but not elite.
50-69: Clear arm path issue — short-arming, elbow below shoulder at foot strike, or forearm flies out. Injury risk.
Below 50: Major red flag — severe inverted W, extreme arm drag, or dangerous deceleration pattern.

═══ MECHANICS (0-100) ═══
90-100: Full hip-to-shoulder separation. Stride lands 85-100% of height. Lead leg braces. Posture stays tall through release. Efficient energy transfer.
70-89: Good rotation but some energy leak — glove side flies open, posture tilts, or stride is short. Power left on the table.
50-69: Limited hip lead. Upper body dominant. Stride too short or too closed/open. Poor direction to plate.
Below 50: All arm, no body. No hip engagement. Falling off to one side. Major inefficiency.

═══ COMMAND (0-100) ═══
90-100: Consistent release point. Repeatable delivery. Balance at finish. Glove tucks. Everything syncs.
70-89: Mostly repeatable but release point wanders. Some deliveries look different. Occasional balance loss.
50-69: Inconsistent release. Head moves off-line. Finish is different every rep. Hard to locate.
Below 50: Wild release. No consistency. Can't repeat the delivery. Head flies off.

IMPORTANT RULES:
- Score each category INDEPENDENTLY based on what you see in the frames
- Be specific in top3 — reference actual body positions visible in the frames
- top3 format: "Issue — impact on pitch", keep each under 12 words
- score_label: one confident phrase (reference their specific pattern)
- impact_line: what their weakest area is costing them right now
- uplift_line: specific mph/command gain if fixed (vary the range, e.g. "2-5 mph" or "improves strike % by 15-20%")
- SCORING HONESTY IS CRITICAL. Use the FULL 0-100 range:
  - A terrible delivery with no mechanics = 15-30
  - A beginner with major flaws = 30-50
  - Average youth pitcher = 50-65
  - Good mechanics with fixable issues = 65-78
  - Very strong delivery = 78-88
  - Elite/near-perfect = 88-100
- Do NOT cluster everything in the 60-80 range. Sugar-coating helps no one.

Return STRICT JSON:
{
  "timing": int 0-100,
  "power_transfer": int 0-100,
  "bat_control": int 0-100,
  "score_label": "string",
  "top3": ["string", "string", "string"],
  "impact_line": "string",
  "uplift_line": "string"
}

IMPORTANT: Map the scores as:
- "timing" = ARM PATH score
- "power_transfer" = MECHANICS score
- "bat_control" = COMMAND score`;

    const imgs = frames.slice(0, 4);

    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...imgs.map((dataUrl: string) => ({
              type: "image_url",
              image_url: { url: dataUrl },
            })),
          ] as any,
        },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);

    const timing = clampInt(parsed?.timing);
    const power_transfer = clampInt(parsed?.power_transfer);
    const bat_control = clampInt(parsed?.bat_control);

    if (timing === null || power_transfer === null || bat_control === null) {
      return new Response("Invalid breakdown scores from model", { status: 500 });
    }

    // Weighted: mechanics 40%, arm path 35%, command 25%
    const score = clampInt(
      Math.round(timing * 0.35 + power_transfer * 0.40 + bat_control * 0.25)
    );

    if (score === null) {
      return new Response("Invalid computed score", { status: 500 });
    }

    const top3Ok = Array.isArray(parsed?.top3) && parsed.top3.length === 3;

    if (
      !top3Ok ||
      typeof parsed?.score_label !== "string" ||
      typeof parsed?.impact_line !== "string" ||
      typeof parsed?.uplift_line !== "string"
    ) {
      return new Response("Invalid model JSON structure", { status: 500 });
    }

    return Response.json({
      score,
      score_label: parsed.score_label,
      breakdown: { timing, power_transfer, bat_control },
      top3: parsed.top3,
      impact_line: parsed.impact_line,
      uplift_line: parsed.uplift_line,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error("Analyze error:", msg);
    return new Response(`Analyze failed: ${msg}`, { status: 500 });
  }
}
