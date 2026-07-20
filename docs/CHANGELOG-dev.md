# Dev Changelog

## 2026-07-19
- Commit `d9d5674` pushed + auto-deployed to armiq.ai (project is git-linked; push to main = prod deploy).
- NEW `app/lib/stripe.ts`: all Stripe writes via `stripePost()`, auto-stamps `metadata.app=armiq` (+ `payment_intent_data`/`subscription_data` metadata on Checkout sessions). Shared account with HIT24/batiq — untagged charges count as HIT24 revenue.
- Webhook (`app/api/webhook/stripe`): gated all 3 handlers to armiq-owned objects (session metadata `source`/`app`, subscription `metadata.app`); stamps `app:armiq` on invoice PaymentIntents; fixes batiq buyers getting armiq Pro + armiq Meta pixel firing on batiq purchases.
- NEW `app/lib/dynamo.ts` `queryFirstMatch()` + webhook `findUserByCustomerId()`: fix DynamoDB Limit-before-FilterExpression misses (webhook customer lookups; latest-swing queries in generate-plan / admin grant-plan / analyze).
- Stripe backfill mis-tagged 4 batiq subs as armiq (sourced from polluted ArmIQUsers) — corrected to `app:batiq` by Rob/batiq; final sweep: 0 armiq, 8 batiq, 18 untagged (HIT24) subs.
- ArmIQUsers: 4 batiq-polluted rows cleaned (`subscribed=false`, `stripe_customer_id` removed) — run by Rob via aws CLI.
- Shipped all May WIP in same commit: 8 landing variants, admin panel + grant-plan API, checkout-trial, pixel-event, score lib, dashboard restyle, Lambda handler rewrite (Lambda itself unchanged — May 10 deploy already current; `serverless deploy` reported "No changes").
- Live verification: deployed `/api/checkout` produces sessions with `metadata.app=armiq` (checked via live key). Charge-level Dashboard proof pending one real purchase.
