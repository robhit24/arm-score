export const runtime = "nodejs";

const PRICES: Record<string, string> = {
  "14": "price_1TEjjWH3giAURZQ1PO4xNpKr",
  "30": "price_1TEjjqH3giAURZQ1RZGsnFV8",
  "45": "price_1TEjk7H3giAURZQ1luxhm7N8",
};

export async function POST(req: Request) {
  try {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });
    }

    const { email, plan_days, swing_id } = await req.json();

    if (!email || !email.includes("@")) {
      return new Response("Invalid email", { status: 400 });
    }

    const priceId = PRICES[String(plan_days)];
    if (!priceId) {
      return new Response("Invalid plan_days", { status: 400 });
    }

    const origin = req.headers.get("origin") || "https://armiq.ai";

    const params = new URLSearchParams({
      mode: "payment",
      "payment_method_types[0]": "card",
      customer_email: email,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: `${origin}?purchased=true&plan_days=${plan_days}`,
      cancel_url: `${origin}?purchased=cancelled`,
      "metadata[email]": email,
      "metadata[plan_days]": String(plan_days),
      "metadata[swing_id]": swing_id || "",
      "metadata[source]": "armiq",
    });

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Stripe error:", data);
      return new Response(`Stripe error: ${data?.error?.message}`, { status: 500 });
    }

    return Response.json({ url: data.url });
  } catch (err: any) {
    console.error("Checkout error:", err?.message || err);
    return new Response(`Checkout failed: ${err?.message}`, { status: 500 });
  }
}
