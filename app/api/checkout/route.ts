export const runtime = "nodejs";

import { stripePost } from "../../lib/stripe";

// Funnel-variant pricing (discounted "this visit only" tier shown when urgency
// timer is live).
const PRICES: Record<string, string> = {
  "7": "price_1TUrEnH3giAURZQ1daFAsDZF",   // $9.99  — 7-day variant discount
  "14": "price_1TUrKxH3giAURZQ1nLd3P6Vg",  // $19.99 — 14-day variant discount
  "30": "price_1TEjjqH3giAURZQ1RZGsnFV8",  // $59.99 — 30-day
  "45": "price_1TEjk7H3giAURZQ1luxhm7N8",  // $79.99 — 45-day
};

// Home-page / urgency-expired pricing. Sent by variant pages after their
// countdown expires (tier === "home") OR when checkout originates from
// landing_page === "/". Mirrors batiq's pattern decided 2026-04-27 — keeping
// the discount as a real difference from full price keeps the urgency banner
// honest.
const HOME_PRICES: Record<string, string> = {
  "7": "price_1TUXw6H3giAURZQ1YiCEyguh",   // $14.99 — 7-day full
  "14": "price_1TEjjWH3giAURZQ1PO4xNpKr",  // $29.99 — 14-day full
};

export async function POST(req: Request) {
  try {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });
    }

    const { email, plan_days, swing_id, fbp, fbc, utm, landing_page, tier } = await req.json();

    if (!email || !email.includes("@")) {
      return new Response("Invalid email", { status: 400 });
    }

    // Persist tracking to ArmIQUsers before checkout. if_not_exists guards
    // landing_page/utm so first-touch attribution survives a returning visit.
    try {
      const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
      const ddbUser = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));
      const parts = ["SET updated_at = :now"];
      const vals: Record<string, any> = { ":now": new Date().toISOString() };
      if (landing_page) { parts.push("landing_page = if_not_exists(landing_page, :lp)"); vals[":lp"] = landing_page; }
      if (utm && Object.keys(utm).length > 0) { parts.push("utm = if_not_exists(utm, :utm)"); vals[":utm"] = utm; }
      if (fbp) { parts.push("fbp = :fbp"); vals[":fbp"] = fbp; }
      if (fbc) { parts.push("fbc = :fbc"); vals[":fbc"] = fbc; }
      await ddbUser.send(new UpdateCommand({ TableName: "ArmIQUsers", Key: { email: email.toLowerCase().trim() }, UpdateExpression: parts.join(", "), ExpressionAttributeValues: vals }));
    } catch {}

    // tier === "home" is sent by variant pages after their countdown expires.
    // landing_page === "/" is the natural home-route case. Either triggers the
    // higher-tier price. Falls through to the variant discount when neither.
    const useHomeTier = tier === "home" || landing_page === "/";
    const priceId =
      (useHomeTier && HOME_PRICES[String(plan_days)]) ||
      PRICES[String(plan_days)];
    if (!priceId) {
      return new Response("Invalid plan_days", { status: 400 });
    }

    const portalDays = Number(plan_days);

    const origin = req.headers.get("origin") || "https://armiq.ai";

    const params = new URLSearchParams({
      mode: "payment",
      "payment_method_types[0]": "card",
      customer_email: email,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: `${origin}?purchased=true&plan_days=${portalDays}`,
      cancel_url: `${origin}?purchased=cancelled`,
      "metadata[email]": email,
      "metadata[plan_days]": String(portalDays),
      "metadata[swing_id]": swing_id || "",
      "metadata[fbp]": fbp || "",
      "metadata[fbc]": fbc || "",
      "metadata[source]": "armiq",
    });

    const { ok, data } = await stripePost("checkout/sessions", params);

    if (!ok) {
      console.error("Stripe error:", data);
      return new Response(`Stripe error: ${data?.error?.message}`, { status: 500 });
    }

    return Response.json({ url: data.url });
  } catch (err: any) {
    console.error("Checkout error:", err?.message || err);
    return new Response(`Checkout failed: ${err?.message}`, { status: 500 });
  }
}
