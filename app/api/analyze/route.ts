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

    const { email, sport, age_group, frames, frame_hash, force_fresh } = await req.json();
    const safeAge = age_group || "12U";

    // Fetch previous analysis for comparison (subscribers)
    let previousAnalysis = "";
    if (force_fresh && email) {
      try {
        const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
        const { DynamoDBDocumentClient, QueryCommand } = await import("@aws-sdk/lib-dynamodb");
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

        const prev = await ddb.send(new QueryCommand({
          TableName: "SwingAnalyses",
          IndexName: "email-index",
          KeyConditionExpression: "email = :e",
          FilterExpression: "#src = :armiq AND score > :zero",
          ExpressionAttributeNames: { "#src": "source" },
          ExpressionAttributeValues: { ":e": email.toLowerCase().trim(), ":armiq": "armiq", ":zero": 0 },
          ScanIndexForward: false,
          Limit: 1,
        }));

        const last = prev.Items?.[0];
        if (last) {
          previousAnalysis = `
PREVIOUS ANALYSIS (from their last upload):
Previous Score: ${last.score} | Arm Path: ${last.breakdown?.timing || "?"} | Mechanics: ${last.breakdown?.power_transfer || "?"} | Command: ${last.breakdown?.bat_control || "?"}
Previous top 3: ${(last.top3 || []).join(", ")}

IMPORTANT: Compare what you see NOW to their previous analysis. Note what IMPROVED and what STILL NEEDS WORK. Your top3 must be DIFFERENT from the previous top3 if the issues have changed. If an issue is fixed, acknowledge it and find the next priority. If the same issue persists, describe it differently (more specific).`;
        }
      } catch (e) {
        console.log("Previous analysis lookup failed:", e);
      }
    }

    if (!email || !email.includes("@")) {
      return new Response("Invalid email", { status: 400 });
    }

    if (!Array.isArray(frames) || frames.length < 3) {
      return new Response("Need frames[] (>=3)", { status: 400 });
    }

    // Rate limit: 2 free analyses per day per email (subscribers bypass via force_fresh)
    if (!force_fresh) {
      try {
        const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
        const { DynamoDBDocumentClient, QueryCommand } = await import("@aws-sdk/lib-dynamodb");
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const emailLower = email.toLowerCase().trim();
        const emailOrig = email.trim();

        const [r1, r2] = await Promise.all([
          ddb.send(new QueryCommand({
            TableName: "SwingAnalyses",
            IndexName: "email-index",
            KeyConditionExpression: "email = :e",
            FilterExpression: "created_at >= :since",
            ExpressionAttributeValues: { ":e": emailLower, ":since": oneDayAgo },
          })),
          emailLower !== emailOrig ? ddb.send(new QueryCommand({
            TableName: "SwingAnalyses",
            IndexName: "email-index",
            KeyConditionExpression: "email = :e",
            FilterExpression: "created_at >= :since",
            ExpressionAttributeValues: { ":e": emailOrig, ":since": oneDayAgo },
          })) : Promise.resolve({ Items: [] }),
        ]);

        const result = { Items: [...(r1.Items || []), ...(r2.Items || [])] };

        const todayCount = (result.Items || []).length;
        if (todayCount >= 2) {
          return new Response("You've reached your daily limit of 2 free analyses. Subscribe to ArmIQ Pro for unlimited analyses.", { status: 429 });
        }
      } catch (e) {
        console.log("Rate limit check failed:", e);
      }
    }


    const prompt = `You are an elite baseball/softball pitching mechanics analyst. You are looking at 4 frames extracted from a pitching video (roughly: wind-up/set, leg lift/balance, arm cocking/stride, release/follow-through).


This athlete is in the ${safeAge} age group. Calibrate your expectations accordingly:
- 8U/10U: Focus on balance and basic throwing motion. Don't expect full mechanics.
- 12U/14U: Developing mechanics. Hip-to-shoulder separation should be emerging.
- 16U/18U: Near-adult mechanics expected. Score closer to the full rubric.
- College/Adult: Full rubric, no adjustments. Elite standards.

${previousAnalysis}

FIRST: Study each frame carefully and note what you see:
- Frame 1: What position is the pitcher in? Where are the feet, hips, arm?
- Frame 2: What phase? Leg lift height? Balance? Where is the glove?
- Frame 3: Arm position? Stride length? Hip rotation started?
- Frame 4: Release or follow-through? Where did the arm finish? Balance?

THEN score this pitching delivery on THREE separate categories using the rubrics below. Your top3 must reference SPECIFIC things you saw in the frames, not generic textbook issues. Be honest and specific for a ${safeAge} athlete.

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
- top3 format: "Issue — impact", keep each under 12 words
- score_label: one confident phrase unique to this delivery
- impact_line: what their #1 weakness costs them
- uplift_line: specific gain if fixed (vary: "2-5 mph", "15-20% more strikes", "3-6 ft of movement")
- Use FULL 0-100 range. Average youth = 50-65. Do NOT cluster 60-80.

TOP 3 VARIETY (critical — do NOT repeat the same generic issues every time):
Look for ALL of these and only report the 3 that are MOST visible in the frames:
- Arm path: inverted W, short-arming, forearm flyout, arm drag, late arm cocking, elbow spiral issues, arm slot inconsistency
- Lower half: stride length (% of height), stride direction (open/closed), lead leg brace or collapse, back hip drive, weight transfer timing, front foot landing angle
- Upper body: trunk tilt at release, head position (on-line or off), glove side pull/tuck, posture collapse, early shoulder rotation, spine angle
- Timing/sequence: hip-shoulder separation amount, when hips fire vs arm, early trunk rotation, rushing delivery
- Release: release point height, release point consistency, wrist position, pronation timing, finger position
- Balance: finish position, falling off to side, ability to field after release, back leg drive through
- ${sport === "softball" ? "Softball-specific: windmill circle path, snap timing, brush contact, wrist snap angle, stride to power line" : "Baseball-specific: back leg drive, hip/trunk connection, front side stability, velo arm speed"}

Do NOT default to "elbow below shoulder, stride short, release inconsistent" unless those are genuinely the 3 most visible issues. Be SPECIFIC about what you see in each frame.

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
      temperature: 0.15,
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
