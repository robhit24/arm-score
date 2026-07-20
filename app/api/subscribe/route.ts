export const runtime = "nodejs";

import { stripePost } from "../../lib/stripe";

export async function POST(req: Request) {
  try {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });
    }

    const { email, fbp, fbc, utm, landing_page } = await req.json();

    if (!email || !email.includes("@")) {
      return new Response("Invalid email", { status: 400 });
    }

    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) {
      return new Response("Missing STRIPE_PRICE_ID", { status: 500 });
    }

    // Persist first-touch attribution to ArmIQUsers BEFORE the redirect to
    // Stripe, mirroring /api/checkout. landing_page + utm use if_not_exists
    // so a returning visitor keeps their original first-touch path. fbp/fbc
    // overwrite — the most recent click ID is what Meta needs to dedupe
    // against the server-side Conversions API call from the webhook.
    try {
      const { DynamoDBClient: D } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient: DD, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
      const ddb = DD.from(new D({ region: "us-east-2" }));
      const parts: string[] = ["updated_at = :now"];
      const vals: Record<string, any> = { ":now": new Date().toISOString() };
      if (landing_page) { parts.push("landing_page = if_not_exists(landing_page, :lp)"); vals[":lp"] = landing_page; }
      if (utm && Object.keys(utm).length > 0) { parts.push("utm = if_not_exists(utm, :utm)"); vals[":utm"] = utm; }
      if (fbp) { parts.push("fbp = :fbp"); vals[":fbp"] = fbp; }
      if (fbc) { parts.push("fbc = :fbc"); vals[":fbc"] = fbc; }
      await ddb.send(new UpdateCommand({
        TableName: "ArmIQUsers",
        Key: { email: email.toLowerCase().trim() },
        UpdateExpression: "SET " + parts.join(", "),
        ExpressionAttributeValues: vals,
      }));
    } catch (e: any) {
      console.error("Subscribe attribution save failed:", e?.message);
    }

    const origin = req.headers.get("origin") || "https://armiq.ai";

    const params = new URLSearchParams({
      mode: "subscription",
      "payment_method_types[0]": "card",
      customer_email: email,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: `${origin}?subscribed=true&email=${encodeURIComponent(email)}`,
      cancel_url: `${origin}?subscribed=cancelled`,
      "metadata[email]": email,
      "metadata[fbp]": fbp || "",
      "metadata[fbc]": fbc || "",
      "metadata[landing_page]": landing_page || "",
    });

    const { ok, data } = await stripePost("checkout/sessions", params);

    if (!ok) {
      console.error("Stripe error:", data);
      return new Response(`Stripe error: ${data?.error?.message}`, { status: 500 });
    }

    return Response.json({ url: data.url });
  } catch (err: any) {
    console.error("Subscribe error:", err?.message || err);
    return new Response(`Subscribe failed: ${err?.message}`, { status: 500 });
  }
}
