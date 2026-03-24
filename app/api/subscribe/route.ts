export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });
    }

    const { email } = await req.json();

    if (!email || !email.includes("@")) {
      return new Response("Invalid email", { status: 400 });
    }

    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) {
      return new Response("Missing STRIPE_PRICE_ID", { status: 500 });
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
    console.error("Subscribe error:", err?.message || err);
    return new Response(`Subscribe failed: ${err?.message}`, { status: 500 });
  }
}
