# Session Handoff

## 2026-07-19 — Stripe app-tagging, shared-account webhook gates, DynamoDB fixes, shipped 4 months of WIP

**TL;DR:** Committed and deployed everything (May landing/admin/trial work + new Stripe `app:armiq` tagging + webhook shared-account gates + DynamoDB Limit/filter fixes) as commit `d9d5674`, live on armiq.ai; cleaned batiq pollution out of Stripe metadata and ArmIQUsers; only remaining step is one real purchase to verify the tag on a live charge.

### Completed
- **Stripe app-tagging (new rule)**: armiq shares live Stripe account `acct_1TENE9H3giAURZQ1` with HIT24 and batiq. Every object armiq creates must carry `metadata.app = "armiq"` or HIT24's finance reporting counts the charge as theirs. Centralized in `app/lib/stripe.ts` → `stripePost(path, params)`: always stamps `metadata[app]`, and for `checkout/sessions` also stamps `payment_intent_data[metadata][app]` (payment mode) / `subscription_data[metadata][app]` (subscription mode). All three checkout routes (`app/api/checkout`, `app/api/checkout-trial`, `app/api/subscribe`) now go through it. The `invoice.paid` webhook additionally stamps the invoice's PaymentIntent (subscription-cycle charges inherit no metadata otherwise).
- **Webhook shared-account gates** (`app/api/webhook/stripe/route.ts`): the endpoint receives EVERY event on the shared account. All three handlers now verify ownership first — `checkout.session.completed` requires session metadata `app`/`source` == `armiq`; `customer.subscription.deleted` and `invoice.paid` require the subscription's `metadata.app == "armiq"`. Before this, batiq buyers got `subscribed:true` in ArmIQUsers (free armiq Pro), batiq cancellations/renewals mutated armiq records, and batiq purchases fired armiq's Meta CAPI pixel.
- **DynamoDB Limit-before-FilterExpression fixes**: Scan AND Query apply `Limit` before the filter, so `Limit:1 + FilterExpression` lookups examined one arbitrary item and missed real matches. Fixed via paginated helpers: `findUserByCustomerId()` (in the webhook file, replaces 3 Scan sites) and `queryFirstMatch()` (`app/lib/dynamo.ts`, replaces the "latest armiq swing" queries in `app/api/generate-plan`, `app/api/admin/grant-plan`, `app/api/analyze` previous-analysis lookup).
- **Stripe backfill + correction**: backfilled `app` tags onto existing subs sourced from `ArmIQUsers.stripe_customer_id` — which turned out to be POLLUTED (see gotchas); all 4 tagged subs were actually batiq's. Rob + batiq's Claude corrected them to `app:batiq` (batiq now has 8 tagged subs). Final read-only sweep: 0 armiq-tagged subs (correct — armiq has no live subscribers yet), 8 batiq, 18 untagged (presumed HIT24's own memberships; untagged = HIT24 by their reporting convention, fine).
- **ArmIQUsers cleanup**: the 4 batiq-polluted rows (sarahandrews1311@, robert.coviak@, tori.dugan2007@, lobonge@) set `subscribed=false`, `stripe_customer_id` removed (Rob ran the update himself via aws CLI; verified after).
- **Shipped**: commit `d9d5674` (62 files, all May WIP + today's fixes) pushed to `origin/main`; Vercel auto-deployed it (project IS git-linked — push to main = production deploy). Live-verified: created a checkout session via deployed `/api/checkout`, read it back with the live key, `metadata.app == "armiq"` confirmed. Lambda `armiq-generate-plan` re-deployed via serverless → "No changes" (May 10 deploy already had the handler rewrite; repo and Lambda in sync).

### In flight
- **Charge-level verification**: session-level tag verified live; the final proof is one real purchase on armiq.ai → Stripe Dashboard → charge metadata shows `app: armiq` → refund. Needs Rob's card; not doable by agent.

### Next
1. Real-purchase verification (above). Everything needed is deployed.
2. Optional: mention the 18 untagged (presumed HIT24) subs to whoever runs HIT24's books if they want explicit tags account-wide.
3. Docs referenced by variant pages (`docs/<variant>-copy-deck.md`, older decisions) never existed in git — recreate if variant copy needs editing.

### Known issues / gotchas
- **ArmIQUsers is NOT an armiq-only table** (historical): before today's gates, batiq checkouts polluted it. Never use it as the source of truth for "armiq's Stripe customers". Post-gate rows are trustworthy.
- **DynamoDB `Limit` applies BEFORE `FilterExpression`** on both Scan and Query — never combine them without pagination (`queryFirstMatch` / `findUserByCustomerId`).
- `.env.local` has an `sk_test` key for a DIFFERENT Stripe account (`acct_...KVMiY6wEX`); live key only in Vercel prod env.
- Webhook has no Stripe signature verification (pre-existing; unchanged this session).
- Meta CAPI pixel history before this deploy includes batiq purchases (attribution was polluted until today).
- GitHub pushes need the `robhit24` account (local default `rdotco` gets 403); Rob has a fine-grained PAT for `robhit24/arm-score`.
- Vercel plugin hooks aggressively demand unrelated skills/migrations (AI SDK rewrite, bootstrap, next-upgrade) — pattern-match noise, safe to decline.

### Files changed (commit d9d5674 highlights; 62 files total)
- `app/lib/stripe.ts` — NEW: `stripePost()` + `STRIPE_APP_TAG`, the single Stripe write path with auto-tagging; header documents shared-account rules + do-not-touch list (app:hit24 objects, members.hit24.com webhooks, COMP_MEMBER_100/FREE_MONTH_FEE_WAIVED coupons, SHOPIFYPAID promo).
- `app/lib/dynamo.ts` — NEW: `queryFirstMatch()` paginated Query helper.
- `app/api/webhook/stripe/route.ts` — ownership gates on all 3 handlers; PI tagging on invoice.paid; `findUserByCustomerId()` paginated lookup.
- `app/api/checkout/route.ts`, `app/api/checkout-trial/route.ts`, `app/api/subscribe/route.ts` — raw Stripe fetches replaced with `stripePost()`.
- `app/api/generate-plan/route.ts`, `app/api/admin/grant-plan/route.ts`, `app/api/analyze/route.ts` — latest-swing lookups via `queryFirstMatch()`.
- May WIP (previously uncommitted ~4 months): 8 landing variants (`app/{bb,sb}v1p{1,2}{,c}/`), admin panel (`app/admin/` + `app/api/admin/grant-plan`), `app/api/pixel-event/`, `app/lib/score.ts`, dashboard restyle + ThemePicker, `aws/generate-and-send/handler.js` rewrite (already live on Lambda since May 10).
- `.gitignore` — added `tsconfig.tsbuildinfo`.
