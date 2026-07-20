import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";

export const runtime = "nodejs";

// Convert a `data:image/...;base64,xxxx` URL to Anthropic's vision input
// shape. Returns null if the URL isn't a recognizable base64 image — caller
// drops null entries silently.
function dataUrlToAnthropicImage(dataUrl: string) {
  const m = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  return {
    type: "image" as const,
    source: { type: "base64" as const, media_type: m[1] as any, data: m[2] },
  };
}

// Tool-use schema for the analyze response. claude-opus-4-7 is forced to
// call submit_analysis with this exact shape, which removes the JSON-parse
// failure mode entirely (vs. the prior gpt-4o response_format json_object
// path that occasionally produced trailing prose).
//
// 5-metric pitching model (migrated 2026-05-07):
//   balance / stride / arm_path / release / finish
// See app/lib/score.ts for canonical names + weights. UI may relabel
// arm_path→"Circle" and release→"Snap" for softball, but storage uses
// these canonical keys regardless of sport.
const ANALYZE_TOOL_SCHEMA = {
  type: "object",
  required: ["balance", "stride", "arm_path", "release", "finish", "score_label", "top3", "impact_line", "uplift_line"],
  properties: {
    balance: { type: "integer", minimum: 0, maximum: 100 },
    stride: { type: "integer", minimum: 0, maximum: 100 },
    arm_path: { type: "integer", minimum: 0, maximum: 100 },
    release: { type: "integer", minimum: 0, maximum: 100 },
    finish: { type: "integer", minimum: 0, maximum: 100 },
    score_label: { type: "string" },
    top3: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
    impact_line: { type: "string" },
    uplift_line: { type: "string" },
  },
};

function clampInt(n: any) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(100, x));
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response("Missing ANTHROPIC_API_KEY", { status: 500 });
    }

    const client = new Anthropic({ apiKey });

    const { email, sport, age_group, frames, frame_hash, force_fresh, landing_page, utm, fbp, fbc } = await req.json();
    const safeAge = age_group || "12U";
    const safeSport = sport === "softball" ? "softball" : "baseball";
    const isSoftball = safeSport === "softball";

    // Save tracking fields to ArmIQUsers on every pitch submission. Same
    // pattern as swing-score/BatIQUsers — UTMs/fbp/fbc captured once at
    // first touch, refreshed on every analyze so cookie rotations don't
    // lose attribution.
    if (email && email.includes("@")) {
      try {
        const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
        const { DynamoDBDocumentClient, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
        const ddbUser = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));
        const emailClean = email.toLowerCase().trim();
        const updateParts = ["SET updated_at = :now"];
        const exprValues: Record<string, any> = { ":now": new Date().toISOString() };
        if (landing_page) {
          updateParts.push("landing_page = if_not_exists(landing_page, :lp)");
          exprValues[":lp"] = landing_page;
        }
        if (utm && Object.keys(utm).length > 0) {
          updateParts.push("utm = if_not_exists(utm, :utm)");
          exprValues[":utm"] = utm;
        }
        if (fbp) {
          updateParts.push("fbp = :fbp");
          exprValues[":fbp"] = fbp;
        }
        if (fbc) {
          updateParts.push("fbc = :fbc");
          exprValues[":fbc"] = fbc;
        }
        await ddbUser.send(new UpdateCommand({
          TableName: "ArmIQUsers",
          Key: { email: emailClean },
          UpdateExpression: updateParts.join(", "),
          ExpressionAttributeValues: exprValues,
        }));
      } catch {
        // Non-fatal — don't block analysis if tracking fails
      }
    }

    if (!email || !email.includes("@")) {
      return new Response("Invalid email", { status: 400 });
    }

    if (!Array.isArray(frames) || frames.length < 3) {
      return new Response("Need frames[] (>=3)", { status: 400 });
    }

    // Frame-hash cache. Same pitch video must produce the same analysis or
    // it looks like bogus data to the user. claude-opus-4-7 is non-deterministic
    // (fixed sampling, not zero), and force_fresh actively pushes "make
    // top3 different" — both drift on re-uploads. Cache by (email, frame_hash)
    // so a repeat upload of the same file gets identical scores + top3.
    //
    // No Limit on the query: DynamoDB applies Limit BEFORE FilterExpression,
    // so `Limit:1 + filter frame_hash = X` reads 1 row by sort key and returns
    // empty if that row didn't match — caused near-100% miss rate on users
    // with multiple swings (discovered on swing-score 2026-05-07).
    if (frame_hash && typeof frame_hash === "string") {
      try {
        const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
        const { DynamoDBDocumentClient, QueryCommand } = await import("@aws-sdk/lib-dynamodb");
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));
        const cached = await ddb.send(new QueryCommand({
          TableName: "SwingAnalyses",
          IndexName: "email-index",
          KeyConditionExpression: "email = :e",
          FilterExpression: "frame_hash = :fh AND #src = :armiq AND score > :zero",
          ExpressionAttributeNames: { "#src": "source" },
          ExpressionAttributeValues: {
            ":e": email.toLowerCase().trim(),
            ":fh": frame_hash,
            ":armiq": "armiq",
            ":zero": 0,
          },
          ScanIndexForward: false,
        }));
        const hit = cached.Items?.[0];
        if (hit) {
          console.log(`[analyze] cache_hit frame_hash=${frame_hash.slice(0, 8)} swing_id=${hit.swing_id}`);
          // Reconstruct the analyze response shape from the stored row.
          // Older rows may use legacy field names (timing/power_transfer/
          // bat_control) — fall back to the legacy mapping so cache hits
          // never produce a worse response than a fresh run. See
          // normalizeBreakdown() in app/lib/score.ts for the same logic.
          const bd = hit.breakdown || {};
          return Response.json({
            score: hit.score,
            score_label: hit.score_label,
            breakdown: {
              balance: bd.balance,
              stride: bd.stride ?? bd.power_transfer,
              arm_path: bd.arm_path ?? bd.timing,
              release: bd.release ?? bd.bat_control,
              finish: bd.finish,
            },
            top3: hit.top3 || [],
            impact_line: hit.impact_line || "",
            uplift_line: hit.uplift_line || "",
            cached: true,
          });
        }
      } catch (e) {
        // Cache lookup failure is non-fatal — proceed to fresh analysis.
        console.log("Frame-hash cache lookup failed:", e);
      }
    }

    // Fetch previous analysis for comparison (subscribers — force_fresh path)
    let previousAnalysis = "";
    if (force_fresh && email) {
      try {
        const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
        const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
        const { queryFirstMatch } = await import("../../lib/dynamo");
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

        const last = await queryFirstMatch(ddb, {
          TableName: "SwingAnalyses",
          IndexName: "email-index",
          KeyConditionExpression: "email = :e",
          FilterExpression: "#src = :armiq AND score > :zero",
          ExpressionAttributeNames: { "#src": "source" },
          ExpressionAttributeValues: { ":e": email.toLowerCase().trim(), ":armiq": "armiq", ":zero": 0 },
          ScanIndexForward: false,
        });
        if (last) {
          // Read both new and legacy fields so historical rows still produce
          // useful comparison context after the 5-metric migration.
          const lb = last.breakdown || {};
          const prevBalance = lb.balance ?? "?";
          const prevStride = lb.stride ?? lb.power_transfer ?? "?";
          const prevArmPath = lb.arm_path ?? lb.timing ?? "?";
          const prevRelease = lb.release ?? lb.bat_control ?? "?";
          const prevFinish = lb.finish ?? "?";
          previousAnalysis = `
PREVIOUS ANALYSIS (from their last upload):
Previous Score: ${last.score} | Balance: ${prevBalance} | Stride: ${prevStride} | Arm Path: ${prevArmPath} | Release: ${prevRelease} | Finish: ${prevFinish}
Previous top 3: ${(last.top3 || []).join(", ")}

IMPORTANT: Compare what you see NOW to their previous analysis. Note what IMPROVED and what STILL NEEDS WORK. Your top3 must be DIFFERENT from the previous top3 if the issues have changed. If an issue is fixed, acknowledge it and find the next priority.`;
        }
      } catch (e) {
        console.log("Previous analysis lookup failed:", e);
      }
    }

    // Rate limit: 2 free analyses per day per email (subscribers bypass
    // via force_fresh). Counts both lowercase and original-case rows because
    // older entries may have mixed case.
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
            FilterExpression: "created_at >= :since AND #src = :armiq",
            ExpressionAttributeNames: { "#src": "source" },
            ExpressionAttributeValues: { ":e": emailLower, ":since": oneDayAgo, ":armiq": "armiq" },
          })),
          emailLower !== emailOrig ? ddb.send(new QueryCommand({
            TableName: "SwingAnalyses",
            IndexName: "email-index",
            KeyConditionExpression: "email = :e",
            FilterExpression: "created_at >= :since AND #src = :armiq",
            ExpressionAttributeNames: { "#src": "source" },
            ExpressionAttributeValues: { ":e": emailOrig, ":since": oneDayAgo, ":armiq": "armiq" },
          })) : Promise.resolve({ Items: [] }),
        ]);

        const todayCount = (r1.Items || []).length + (r2.Items || []).length;
        if (todayCount >= 2) {
          return new Response("You've reached your daily limit of 2 free analyses. Subscribe to ArmIQ Pro for unlimited analyses.", { status: 429 });
        }
      } catch (e) {
        console.log("Rate limit check failed:", e);
      }
    }

    // Sport block — same pattern as swing-score's softball/baseball
    // injection (handler.js sportBlock). Rubrics differ enough between
    // overhand and windmill that a generic prompt grades softball pitchers
    // against the wrong criteria. Keep this block short — Claude already
    // knows pitching mechanics; we just steer it to the right vocabulary.
    const sportBlock = isSoftball ? `
SPORT: SOFTBALL (fastpitch / windmill)
- Delivery is a full underhand windmill. Pitch from a flat circle — there's no mound and no downhill plane.
- Power comes from the drag drive: back foot drags forward, both legs push together, pelvis whips into the K-position at the top of the circle.
- Stride lands closed/parallel, not aligned to the plate like baseball. Lead foot landing should be firm with the lead leg posting up.
- Arm circle is the dominant phase — full 360°. Cues to look for: K-position at top, brush contact at the hip, snap timing, wrist whip at release.
- Release happens at the hip with a wrist snap and hip whip — NOT out front like baseball. Trunk should stay tall.
- Finish is a balanced, athletic position with the lead leg posted. No falling off to the glove side.
- DO NOT use baseball language ("inverted W", "elbow at shoulder", "downhill plane", "mound"). Use windmill language: "circle path", "K-position", "brush contact", "snap", "drag drive".
- For ${safeAge} pitchers: distance is 35ft (8U-10U), 40ft (12U), 43ft (14U+).
` : `
SPORT: BASEBALL (overhand)
- Delivery is overhand from a mound. Stride goes downhill toward the plate.
- Power comes from back-leg drive into the rubber, hip-shoulder separation, and trunk rotation. Stride length should be ~85-100% of height.
- Arm action: full circle from glove break, scapular load, elbow at or above shoulder at foot strike. Watch for inverted W, short-arming, or arm drag — all baseball-specific injury patterns.
- Release: out front with trunk tilt. Front leg braces, head stays on line, posture stays tall.
- Finish: glove tucks, controlled deceleration, balanced into a fielding position.
- Use baseball language: "arm slot", "elbow at shoulder", "inverted W", "downhill plane", "rubber", "mound".
- For ${safeAge} pitchers: mound distance is 46ft (10U), 50ft (12U), 54ft (13U-14U), 60.5ft (15U+).
`;

    const prompt = `You are an elite ${safeSport} pitching mechanics analyst. You are looking at 8 frames extracted from a pitching video, with extra frames clustered around the arm action and release phase for detail. Frames roughly cover: wind-up/balance, leg lift, stride, arm cocking, acceleration, release, early follow-through, finish.

${sportBlock}

This athlete is in the ${safeAge} age group. Calibrate your expectations accordingly:
- 8U/10U: Focus on balance and basic throwing motion. Don't expect full mechanics or hip-shoulder separation.
- 12U/14U: Developing mechanics. Hip-shoulder separation should be emerging. Score against age-appropriate benchmarks.
- 16U/18U: Near-adult mechanics expected. Score closer to the full rubric.
- College/Adult: Full rubric, no adjustments. Elite standards.

${previousAnalysis}

Score this pitching delivery on FIVE separate categories using the rubrics below. The five map to chronological phases: setup → stride → arm action → release → follow-through. Be honest and specific for a ${safeAge} ${safeSport} pitcher.

═══ BALANCE (0-100) — setup + leg lift ═══
90-100: Stacked over the rubber/post leg. Controlled leg lift. Head stays centered. No drift, no rocking back excessively. Tempo is unhurried.
70-89: Mostly balanced but minor leak — slight head drift, leg lift a touch rushed, or weight shifts early. Functional but loses some efficiency.
50-69: Visible balance issue — drifts forward early, leg lift wobbles, or weight crashes into the back leg. Loses energy before stride begins.
Below 50: No balance phase. Rushes, rocks, or collapses immediately. Cannot repeat from this start.

═══ STRIDE (0-100) — drive + landing ═══
${isSoftball ? `90-100: Drag drive is powerful and direct — back foot drags through, both legs explode together. Stride lands firm, lead leg posts up to brace.
70-89: Decent drive but stride is short or lead leg lands soft. Drag is mostly clean, hip whip starts to show.
50-69: Limited lower-half — small drag, short stride, lead leg buckles or doesn't post. Power generated mostly by arm.
Below 50: No drag drive. Short hop step, lead leg collapses, no ground force into the pitch.` : `90-100: Stride length 85-100% of height. Direction is on-line to the plate. Lead leg lands firm and braces. Strong back-leg drive into the rubber. Closed/square at landing.
70-89: Good stride but slightly short, or direction drifts open/closed. Lead leg braces but not aggressive. Some back-side leak.
50-69: Stride is short (under 80% height), open or closed direction, lead leg collapses. Limited back-leg drive. Energy leaks before release.
Below 50: Tiny stride. Falls off to one side. Lead leg buckles. No ground force, no direction.`}

═══ ARM PATH (0-100) — cocking + acceleration ═══
${isSoftball ? `90-100: Smooth full circle. K-position is clean at the top — elbow up, ball facing back. Wrist stays loaded. Brush contact at the hip is on-time. No arm whip drift.
70-89: Circle is mostly clean but K-position has minor flaw — elbow not fully up, or wrist breaks early. Brush is functional but not crisp.
50-69: Circle wobbles or flattens. K-position is broken — elbow drops, wrist leads, or arm flies wide. Brush contact is off or absent.
Below 50: Circle path is wild. No K-position. Arm flails away from body. Brush is missed entirely. High injury and inconsistency risk.` : `90-100: Clean arm circle, scapular load is visible. Elbow at or above shoulder at foot strike. Smooth acceleration. No inverted W, no short-arming, no forearm flyout.
70-89: Decent arm action but minor issue — elbow lags slightly, arm slot inconsistent, or arm circle is short. Functional but leaves velo on the table.
50-69: Clear arm path issue — short-arming, elbow below shoulder at foot strike, forearm flies out, or arm drags badly. Injury risk + lost velo.
Below 50: Major red flag — severe inverted W, extreme arm drag, or dangerous deceleration pattern. Refer to a pitching coach.`}

═══ RELEASE (0-100) — extension + command ═══
${isSoftball ? `90-100: Snap is crisp at the hip with hip whip. Wrist fires through with intent. Trunk stays tall. Release point is consistent and out front.
70-89: Snap is solid but timing is slightly off — hip whip lags behind arm, or wrist doesn't fully fire. Release wanders one ball-width.
50-69: Snap is weak or late. Trunk leaks forward at release. Release point varies more than a ball-width every pitch.
Below 50: No snap. Pushed release. Body collapses through the release. Cannot repeat or locate.` : `90-100: Out-front extension. Trunk tilt is clean. Front leg braces hard. Head stays on the target line. Release point is consistent and high.
70-89: Solid release but slight inconsistency — release point wanders, trunk tilt is shallow, or front leg softens. Mostly repeatable.
50-69: Release is inconsistent — point changes each pitch. Trunk lurches, front leg buckles, head moves off-line. Hard to locate.
Below 50: Wild release. Pushed throws. No consistent point. Falls off to one side every rep.`}

═══ FINISH (0-100) — follow-through ═══
${isSoftball ? `90-100: Lead leg posts firmly. Trunk stays tall through finish. Glove side stable. Athletic, balanced position — ready to field.
70-89: Mostly balanced finish but slight tilt or glove drift. Lead leg posts but not aggressive.
50-69: Falls off to glove side, or lead leg collapses through finish. Cannot field after the pitch.
Below 50: No controlled finish. Spins off, falls forward, or collapses. Effort dies at the snap.` : `90-100: Glove tucks cleanly. Bat-arm decelerates safely with full extension. Balanced into a fielding position. No falling off.
70-89: Decent finish but slightly cut off — glove drifts, or trunk tilts off-line. Mostly balanced.
50-69: Falls off to glove side or pulls off the target. Glove flails. Cannot field after the pitch.
Below 50: Crashes through the finish. No deceleration control. Falls forward or off-balance every rep.`}

IMPORTANT RULES:
- Score each category INDEPENDENTLY based on what you see in the frames
- Be specific in top3 — reference actual body positions visible in the frames
- top3 format: "Issue — impact on the pitch", keep each under 12 words
- score_label: one confident phrase unique to this delivery (not generic)
- impact_line: what their weakest area is costing them right now
- uplift_line: specific gain if fixed (vary: "2-5 mph", "15-20% more strikes", "3-6 ft of late movement")
- SCORING HONESTY IS CRITICAL. Use the FULL 0-100 range:
  - A terrible delivery with no mechanics = 15-30
  - A beginner with major flaws = 30-50
  - Average youth pitcher = 50-65
  - Good mechanics with fixable issues = 65-78
  - Very strong delivery = 78-88
  - Elite/near-perfect = 88-100
- If the delivery is bad, say so. A score of 25 is valid. Do NOT cluster everything in 60-80.
- Parents need honest scores to understand where their kid actually stands.

CONSISTENCY RULES (critical):
- Base scores strictly on visible mechanics in the frames, not assumptions
- Score the SAME way every time: identical frames should produce scores within 2-3 points of each other
- Each category score must be independently justified by what you see
- Do NOT randomize. If the elbow is below shoulder, that's a 50-65 arm_path score every time, not sometimes 50 and sometimes 75
- top3 issues should reference the same mechanical problems if the same problems are visible

Return STRICT JSON:
{
  "balance": int 0-100,
  "stride": int 0-100,
  "arm_path": int 0-100,
  "release": int 0-100,
  "finish": int 0-100,
  "score_label": "string",
  "top3": ["string", "string", "string"],
  "impact_line": "string",
  "uplift_line": "string"
}`;

    const imgs = frames.slice(0, 8);

    // Telemetry stamp so we can correlate output regressions to model/prompt
    // changes (mirrors swing-score analyze route logging).
    const ANALYZE_MODEL = "claude-opus-4-7";
    const promptHash = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 8);
    console.log(`[analyze] model=${ANALYZE_MODEL} prompt_hash=${promptHash} frames=${imgs.length} sport=${safeSport}`);

    // Convert each frame to Anthropic's vision input shape. Drop unrecognized
    // entries silently rather than failing the whole request.
    const imageBlocks = imgs
      .map((dataUrl: string) => dataUrlToAnthropicImage(dataUrl))
      .filter((b: any) => b !== null) as any[];

    if (imageBlocks.length < 3) {
      return new Response("Frames must be base64 data URLs (jpeg/png/webp)", { status: 400 });
    }

    // Tool-use forcing: Claude MUST emit submit_analysis with the exact schema
    // shape, eliminating the JSON-parse failure mode that the prior gpt-4o
    // response_format=json_object path occasionally hit. claude-opus-4-7
    // deprecates `temperature` — sampling is fixed by the model. Determinism
    // for repeated frames now comes from the prompt's CONSISTENCY RULES +
    // tool-use schema, not a low temp.
    const resp = await client.messages.create({
      model: ANALYZE_MODEL,
      max_tokens: 1024,
      tools: [
        {
          name: "submit_analysis",
          description: "Submit the pitching analysis scores and feedback.",
          input_schema: ANALYZE_TOOL_SCHEMA as any,
        },
      ],
      tool_choice: { type: "tool", name: "submit_analysis" },
      messages: [
        {
          role: "user",
          content: [...imageBlocks, { type: "text", text: prompt }],
        },
      ],
    });

    const toolUse = (resp.content || []).find(
      (b: any) => b.type === "tool_use" && b.name === "submit_analysis"
    ) as any;
    if (!toolUse?.input) {
      return new Response("Model did not return submit_analysis tool call", { status: 500 });
    }
    const parsed = toolUse.input;

    const balance = clampInt(parsed?.balance);
    const stride = clampInt(parsed?.stride);
    const arm_path = clampInt(parsed?.arm_path);
    const release = clampInt(parsed?.release);
    const finish = clampInt(parsed?.finish);

    if (balance === null || stride === null || arm_path === null || release === null || finish === null) {
      return new Response("Invalid breakdown scores from model", { status: 500 });
    }

    // Overall score: weighted average across the 5 phases. Weights chosen
    // 2026-05-07 — Arm Path + Release carry the most because they're the
    // strongest predictors of velocity AND injury risk. See app/lib/score.ts
    // METRIC_WEIGHTS — keep these in sync.
    const score = clampInt(
      Math.round(
        balance * 0.15 +
        stride * 0.20 +
        arm_path * 0.25 +
        release * 0.25 +
        finish * 0.15
      )
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
      breakdown: { balance, stride, arm_path, release, finish },
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
