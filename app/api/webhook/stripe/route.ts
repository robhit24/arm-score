import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { stripePost, STRIPE_APP_TAG } from "../../../lib/stripe";

export const runtime = "nodejs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

// Paginated customer-id lookup. Scan applies Limit BEFORE FilterExpression,
// so the previous Limit:1 scans evaluated one arbitrary item and missed real
// matches — breaking renewal portal extensions and unsubscribe marking.
async function findUserByCustomerId(customerId: string): Promise<Record<string, any> | undefined> {
  let lastKey: Record<string, any> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: "ArmIQUsers",
        FilterExpression: "stripe_customer_id = :c",
        ExpressionAttributeValues: { ":c": customerId },
        ExclusiveStartKey: lastKey,
      })
    );
    if (page.Items?.[0]) return page.Items[0];
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return undefined;
}

// Mirrors swing-score/api/webhook/stripe with two armiq-specific differences:
//   1. ArmIQUsers / source:"armiq" / armiq Lambda function name
//   2. PageView/Purchase Meta CAPI events use armiq.ai event_source_url
// Trial flow: checkout.session.completed with metadata.trial=="true" sets
// subscribed=false and grants portal_expires for trial_period_days. The first
// invoice.paid (billing_reason!=subscription_create) flips subscribed=true and
// extends portal to 30 days, matching batiq's pattern decided 2026-04-27.
export async function POST(req: Request) {
  try {
    const body = await req.text();
    let event: any;
    try {
      event = JSON.parse(body);
    } catch {
      return Response.json({ received: true });
    }

    console.log("Stripe webhook event:", event.type, JSON.stringify(event.data?.object || {}).slice(0, 500));

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // Shared-account gate: this endpoint receives EVERY checkout on the
      // account, including batiq's and HIT24's. Without this check, batiq
      // buyers were written into ArmIQUsers with subscribed=true (free armiq
      // Pro) and their purchases fired armiq's Meta pixel — discovered
      // 2026-07-19 when a Stripe backfill trusted those polluted rows. All
      // armiq-created sessions carry source and/or app = "armiq".
      const sessionApp = session.metadata?.app || session.metadata?.source;
      if (sessionApp !== "armiq") {
        console.log("Ignoring non-armiq checkout session:", session.id, "app:", sessionApp || "none");
        return Response.json({ received: true });
      }

      let email = (
        session.customer_email ||
        session.customer_details?.email ||
        session.metadata?.email ||
        ""
      ).toLowerCase().trim();

      if (!email && session.customer) {
        const match = await findUserByCustomerId(session.customer);
        if (match) {
          email = match.email;
        }
      }

      if (email && session.mode === "subscription") {
        const isTrial = session.metadata?.trial === "true";
        const trialPlanDays = Number(session.metadata?.plan_days) || 0;
        const trialSwingId = session.metadata?.swing_id || "";

        // Trial: portal_expires = trial_period_days; full sub: 30 days rolling.
        // subscribed flips to true on first non-trial invoice.paid below.
        const portalDays = isTrial ? trialPlanDays : 30;
        const portalExpires = new Date(Date.now() + portalDays * 24 * 60 * 60 * 1000).toISOString();

        await ddb.send(
          new UpdateCommand({
            TableName: "ArmIQUsers",
            Key: { email },
            UpdateExpression: "SET subscribed = :t, stripe_customer_id = :c, subscribed_at = :now, portal_expires = :exp, portal_plan_days = :days",
            ExpressionAttributeValues: {
              ":t": isTrial ? false : true,
              ":c": session.customer || "",
              ":now": new Date().toISOString(),
              ":exp": portalExpires,
              ":days": portalDays,
            },
          })
        );
        console.log(isTrial ? "Trial started:" : "Marked subscribed:", email, isTrial ? `(${trialPlanDays} days)` : "");

        // Trial gets a plan generated immediately so user has something to use
        // during the free week — same as one-time purchases.
        if (isTrial && trialSwingId && trialPlanDays > 0) {
          const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
          const jobId = `trial-${session.id}`;

          await ddb.send(
            new PutCommand({
              TableName: "PlanJobs",
              Item: {
                job_id: jobId,
                email,
                swing_id: trialSwingId,
                plan_days: trialPlanDays,
                status: "scheduled",
                source: "armiq",
                created_at: new Date().toISOString(),
              },
            })
          );

          const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
          const lambda = new LambdaClient({ region: "us-east-2" });
          await lambda.send(
            new InvokeCommand({
              FunctionName: "armiq-generate-plan-live-generateAndSendPlan",
              InvocationType: "Event",
              Payload: Buffer.from(JSON.stringify({ job_id: jobId })),
            })
          );
          console.log("Trial plan job created:", jobId, trialPlanDays, "days");
        }
      } else if (email && session.mode === "payment") {
        const planDays = Number(session.metadata?.plan_days) || 30;
        const swingId = session.metadata?.swing_id || "";

        if (swingId) {
          const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
          const jobId = `stripe-${session.id}`;

          await ddb.send(
            new PutCommand({
              TableName: "PlanJobs",
              Item: {
                job_id: jobId,
                email,
                swing_id: swingId,
                plan_days: planDays,
                status: "scheduled",
                source: "armiq",
                created_at: new Date().toISOString(),
              },
            })
          );

          // One-time purchase: portal access matches plan duration.
          const portalExpires = new Date(Date.now() + planDays * 24 * 60 * 60 * 1000).toISOString();
          await ddb.send(
            new UpdateCommand({
              TableName: "ArmIQUsers",
              Key: { email },
              UpdateExpression: "SET portal_expires = :exp, portal_plan_days = :days",
              ExpressionAttributeValues: {
                ":exp": portalExpires,
                ":days": planDays,
              },
            })
          );
          console.log("Portal access granted:", email, planDays, "days until", portalExpires);

          const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
          const lambda = new LambdaClient({ region: "us-east-2" });
          await lambda.send(
            new InvokeCommand({
              FunctionName: "armiq-generate-plan-live-generateAndSendPlan",
              InvocationType: "Event",
              Payload: Buffer.from(JSON.stringify({ job_id: jobId })),
            })
          );

          console.log("One-time plan job created:", jobId, planDays, "days");
        } else {
          console.log("One-time purchase but no swing_id in metadata:", session.id);
        }
      } else {
        console.log("No email found in checkout session:", session.id);
      }

      // Meta CAPI server-side conversion. Mirrors batiq except event_source_url
      // points at armiq.ai so attribution lands on the right pixel surface.
      if (email) {
        try {
          const crypto = await import("crypto");
          const hashedEmail = crypto.createHash("sha256").update(email).digest("hex");
          const value = session.amount_total ? session.amount_total / 100 : 0;
          const planDays = Number(session.metadata?.plan_days) || 0;

          let userFbp = session.metadata?.fbp || "";
          let userFbc = session.metadata?.fbc || "";
          try {
            const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
            const userRecord = await ddb.send(
              new GetCommand({ TableName: "ArmIQUsers", Key: { email } })
            );
            if (userRecord.Item) {
              if (!userFbp && userRecord.Item.fbp) userFbp = userRecord.Item.fbp;
              if (!userFbc && userRecord.Item.fbc) userFbc = userRecord.Item.fbc;
            }
          } catch (e) {
            console.log("Failed to fetch user data:", e);
          }

          const pixelToken = process.env.META_PIXEL_TOKEN;
          if (pixelToken) {
            const userData: Record<string, any> = { em: [hashedEmail] };
            if (userFbp) userData.fbp = userFbp;
            if (userFbc) userData.fbc = userFbc;

            const events = [
              {
                event_name: "CompleteRegistration",
                event_time: Math.floor(Date.now() / 1000),
                action_source: "website",
                event_source_url: "https://armiq.ai",
                user_data: userData,
                custom_data: {
                  currency: "USD",
                  value,
                  content_name: session.mode === "subscription" ? "Pro subscription" : `${planDays}-day plan`,
                },
              },
              {
                event_name: "Purchase",
                event_time: Math.floor(Date.now() / 1000),
                action_source: "website",
                event_source_url: "https://armiq.ai",
                user_data: userData,
                custom_data: { currency: "USD", value },
              },
            ];
            const metaRes = await fetch(
              `https://graph.facebook.com/v21.0/1812432239715347/events?access_token=${pixelToken}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ data: events }),
              }
            );
            const metaBody = await metaRes.text();
            console.log("Meta CAPI response:", metaRes.status, metaBody, "fbp:", userFbp ? "yes" : "no", "fbc:", userFbc ? "yes" : "no");
          }
        } catch (e) {
          console.log("Meta events failed:", e);
        }
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const customerId = sub.customer;

      // Shared-account gate: armiq subscriptions are tagged app:"armiq" at
      // creation (stripePost). Anything else — batiq/HIT24 or untagged — is
      // not ours; without this, a batiq cancellation could mark an armiq
      // record unsubscribed via a polluted ArmIQUsers row.
      if (sub.metadata?.app !== STRIPE_APP_TAG) {
        console.log("Ignoring non-armiq subscription.deleted:", sub.id, "app:", sub.metadata?.app || "none");
        return Response.json({ received: true });
      }

      const user = await findUserByCustomerId(customerId);
      if (user) {
        await ddb.send(
          new UpdateCommand({
            TableName: "ArmIQUsers",
            Key: { email: user.email },
            UpdateExpression: "SET subscribed = :f, cancelled_at = :now",
            ExpressionAttributeValues: {
              ":f": false,
              ":now": new Date().toISOString(),
            },
          })
        );
        console.log("Marked unsubscribed:", user.email);
      }
    }

    // First non-create invoice = trial converted OR monthly renewal. Both
    // promote subscribed=true and extend portal to a fresh 30-day window.
    // billing_reason==="subscription_create" is the trial-start invoice (often
    // $0) that's already handled by checkout.session.completed — skip it so we
    // don't prematurely flip subscribed=true during the trial week.
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const subscriptionId = invoice.subscription;

      // Shared-account gate: only invoices from armiq-tagged subscriptions
      // are ours. Everything below — PI tagging, portal extension,
      // subscribed=true — must not run for batiq/HIT24 renewals, which this
      // endpoint also receives.
      const subMeta =
        invoice.subscription_details?.metadata ||
        invoice.parent?.subscription_details?.metadata ||
        {};
      if (subMeta.app !== STRIPE_APP_TAG) {
        console.log("Ignoring non-armiq invoice.paid:", invoice.id, "app:", subMeta.app || "none");
        return Response.json({ received: true });
      }

      // Subscription-cycle charges never inherit checkout or subscription
      // metadata, so without this the $1.99 first invoice and every $14.99
      // renewal would be untagged — and HIT24's finance reporting counts
      // untagged charges as HIT24 revenue. Stamp app:armiq onto the invoice's
      // PaymentIntent here.
      try {
        const piId =
          typeof invoice.payment_intent === "string"
            ? invoice.payment_intent
            : invoice.payment_intent?.id;
        if (piId) {
          const tagRes = await stripePost(`payment_intents/${piId}`, new URLSearchParams());
          console.log("Tagged invoice PI:", piId, tagRes.ok ? "ok" : tagRes.data?.error?.message);
        }
      } catch (e: any) {
        console.log("Invoice PI tagging failed:", e?.message || e);
      }

      if (invoice.billing_reason === "subscription_create") {
        console.log("Skipping initial invoice for:", customerId);
      } else if (subscriptionId) {
        try {
          const user = await findUserByCustomerId(customerId);
          if (user) {
            const portalExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
            await ddb.send(
              new UpdateCommand({
                TableName: "ArmIQUsers",
                Key: { email: user.email },
                UpdateExpression: "SET portal_expires = :exp, portal_plan_days = :days, subscribed = :t",
                ExpressionAttributeValues: {
                  ":exp": portalExpires,
                  ":days": 30,
                  ":t": true,
                },
              })
            );
            console.log("Subscription renewed, portal extended:", user.email, "until", portalExpires);
          }
        } catch (e) {
          console.log("Renewal portal extension failed:", e);
        }
      }
    }

    return Response.json({ received: true });
  } catch (err: any) {
    console.error("Stripe webhook error:", err?.message || err);
    return Response.json({ received: true });
  }
}
