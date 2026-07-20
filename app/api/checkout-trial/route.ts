export const runtime = "nodejs";

import { stripePost } from "../../lib/stripe";

// Mirrors swing-score/api/checkout-trial: $1.99 one-time + $14.99/mo with 7-day
// trial. Implemented as an API route (not a Stripe Payment Link redirect) so we
// can attach metadata[source]=armiq and persist UTM/fbp/fbc attribution into
// ArmIQUsers before the redirect — same pattern as the rest of armiq's funnel.
export async function POST(req: Request) {
  try {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });
    }

    const { email, swing_id, fbp, fbc, utm, landing_page } = await req.json();

    if (!email || !email.includes("@")) {
      return new Response("Invalid email", { status: 400 });
    }

    // Persist tracking to ArmIQUsers before checkout. if_not_exists guards
    // landing_page/utm so a returning user's first-touch attribution isn't
    // overwritten by a later visit.
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

    const origin = req.headers.get("origin") || "https://armiq.ai";

    // Two line items in subscription mode:
    //   [0] price_1TUXx9... — $1.99 one-time charge (immediate access fee)
    //   [1] price_1TEYsI... — $14.99/mo with subscription_data.trial_period_days=7
    // Webhook treats subscribed:false during trial; flips to true on invoice.paid.
    const params = new URLSearchParams({
      mode: "subscription",
      "payment_method_types[0]": "card",
      customer_email: email,
      "line_items[0][price]": "price_1TUXx9H3giAURZQ1NGcn9rwY",
      "line_items[0][quantity]": "1",
      "line_items[1][price]": "price_1TEYsIH3giAURZQ1NkdSDuiB",
      "line_items[1][quantity]": "1",
      "subscription_data[trial_period_days]": "7",
      success_url: `${origin}?purchased=true&plan_days=7`,
      cancel_url: `${origin}?purchased=cancelled`,
      "metadata[email]": email,
      "metadata[plan_days]": "7",
      "metadata[swing_id]": swing_id || "",
      "metadata[fbp]": fbp || "",
      "metadata[fbc]": fbc || "",
      "metadata[trial]": "true",
      "metadata[source]": "armiq",
    });

    const { ok, data } = await stripePost("checkout/sessions", params);

    if (!ok) {
      console.error("Stripe trial error:", data);
      return new Response(`Stripe error: ${data?.error?.message}`, { status: 500 });
    }

    return Response.json({ url: data.url });
  } catch (err: any) {
    console.error("Trial checkout error:", err?.message || err);
    return new Response(`Checkout failed: ${err?.message}`, { status: 500 });
  }
}
