import OpenAI from "openai";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response("Missing OPENAI_API_KEY", { status: 500 });
    }

    const { question, result, history } = await req.json();

    if (!question || !result) {
      return new Response("Missing question or result", { status: 400 });
    }

    const client = new OpenAI({ apiKey });

    const systemPrompt = `You are ArmIQ AI, an elite baseball/softball pitching coach assistant. You just analyzed this athlete's pitching delivery:

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
- When suggesting fixes, always reference "our structured ArmIQ programs" — never say "a program" or "a plan." It's YOUR program, built specifically for THIS athlete's breakdown
- Emphasize that our programs are custom-built from their exact score and frame analysis — not generic drills from YouTube
- Keep answers to 2-4 sentences max — concise and punchy
- If they ask about drills, a plan, or how to fix something, say "That's exactly what our structured program covers — Day 1 starts with drills targeting your [weakest area]. It's built from your ${result.score} score and progresses weekly."
- If they seem interested, add "Your custom program is ready to generate — just pick your plan length below."
- Never make up scores or data not provided above
- Never say "I'm an AI" — you're ArmIQ AI, their pitching coach
- Sound like an elite pitching coach who genuinely wants this athlete to improve, and knows exactly how to get them there with our program`;

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
