// Shared Stripe helper. This app lives on the Stripe account it shares with
// HIT24 (batting-cage memberships) and batiq (acct_1TENE9H3giAURZQ1), so every
// object we create MUST carry metadata.app = "armiq":
//
//   - HIT24's finance reporting treats any charge without a foreign app tag as
//     HIT24 revenue (it checks charge-level and PaymentIntent-level metadata),
//     so untagged armiq charges silently inflate their numbers.
//   - The tag gives us per-app reporting for free: Dashboard payments search
//     metadata["app"]:"armiq", same filter in Sigma/exports.
//   - When armiq graduates to its own Stripe account, the tags identify which
//     customers/subscriptions/charges migrate with it.
//
// Route ALL Stripe writes through stripePost() so the tag is inherited
// automatically instead of remembered at each call site. Checkout does not
// propagate session metadata down on its own, so for checkout/sessions we also
// stamp payment_intent_data.metadata (payment mode) and
// subscription_data.metadata (subscription mode) — that's what puts the tag on
// the actual charge/subscription, not just the session.
//
// Never write to objects tagged app: hit24, webhooks pointing at
// members.hit24.com, the COMP_MEMBER_100 / FREE_MONTH_FEE_WAIVED coupons, or
// the SHOPIFYPAID promotion code — those belong to the membership platform.

export const STRIPE_APP_TAG = "armiq";

/**
 * Form-encoded POST to the Stripe API (create or update — Stripe uses POST
 * for both) with metadata[app]=armiq always stamped on.
 *
 * @param path e.g. "checkout/sessions", "payment_intents/pi_123"
 */
export async function stripePost(
  path: string,
  params: URLSearchParams
): Promise<{ ok: boolean; status: number; data: any }> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("Missing STRIPE_SECRET_KEY");
  }

  params.set("metadata[app]", STRIPE_APP_TAG);
  if (path === "checkout/sessions") {
    const mode = params.get("mode");
    if (mode === "payment") {
      params.set("payment_intent_data[metadata][app]", STRIPE_APP_TAG);
    } else if (mode === "subscription") {
      params.set("subscription_data[metadata][app]", STRIPE_APP_TAG);
    }
  }

  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}
