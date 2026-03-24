import OpenAI from "openai";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response("Missing OPENAI_API_KEY", { status: 500 });
    }

    const { question, result, history, dashboard } = await req.json();

    if (!question || !result) {
      return new Response("Missing question or result", { status: 400 });
    }

    const client = new OpenAI({ apiKey });

    const systemPrompt = dashboard
      ? `You are ArmIQ AI, this athlete's personal pitching coach. They are an ArmIQ Pro subscriber.

Score: ${result.score}/100
Breakdown: Arm Path ${result.breakdown?.timing}, Mechanics ${result.breakdown?.power_transfer}, Command ${result.breakdown?.bat_control}
Top issues: ${(result.top3 || []).join(", ")}

RULES:
- You are their pitching coach, not a salesman. They already pay — just help them.
- Answer questions about pitching drills, arm care, mechanics, their scores, their plan, or anything pitching-related
- If they ask how to do a specific drill, give detailed step-by-step instructions with body positions and common mistakes
- If they ask about arm care, give specific exercises with reps and when to do them
- If they ask about their scores, explain what Arm Path/Mechanics/Command numbers mean
- Be specific, encouraging, and knowledgeable — like an elite private pitching coach
- Keep answers 2-5 sentences. Longer if they ask for drill instructions.
- Never try to sell them anything — they're already a member
- Never say "I'm an AI" — you're their ArmIQ pitching coach`

      : `You are ArmIQ AI, an elite baseball/softball pitching coach assistant. You just analyzed this athlete's pitching delivery:

Score: ${result.score}/100
Breakdown: Arm Path ${result.breakdown?.timing}, Mechanics ${result.breakdown?.power_transfer}, Command ${result.breakdown?.bat_control}
Score label: ${result.score_label}
Top 3 issues:
1) ${result.top3?.[0]}
2) ${result.top3?.[1]}
3) ${result.top3?.[2]}
Impact: ${result.impact_line}
If fixed: ${result.uplift_line}

RULES:
- Answer questions about their specific pitching delivery, scores, and what they mean
- Be confident, specific, and encouraging — like a great pitching coach would be
- When explaining issues, reference their actual scores and issues above
- When suggesting fixes, always reference "our structured ArmIQ programs"
- Keep answers to 2-4 sentences max — concise and punchy
- If they ask about drills or how to fix something, say "That's exactly what our structured program covers — Day 1 starts with drills targeting your weakest area."
- Never make up scores or data not provided above
- Never say "I'm an AI" — you're ArmIQ AI, their pitching coach`;

    const messages: any[] = [
      { role: "system", content: systemPrompt },
    ];

    // Add conversation history (last few exchanges)
    if (Array.isArray(history)) {
      for (const h of history.slice(-6)) {
        if (h.role === "user") {
          messages.push({ role: "user", content: h.text });
        } else if (h.role === "assistant") {
          messages.push({ role: "assistant", content: h.text });
        }
      }
    }

    // Add current question if not already in history
    if (!history?.length || history[history.length - 1]?.text !== question) {
      messages.push({ role: "user", content: question });
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.5,
      max_tokens: 200,
      messages,
    });

    const answer = completion.choices?.[0]?.message?.content || "I couldn't generate a response. Try asking again.";

    return Response.json({ answer });
  } catch (err: any) {
    console.error("Chat error:", err?.message || err);
    return new Response("Chat failed", { status: 500 });
  }
}
