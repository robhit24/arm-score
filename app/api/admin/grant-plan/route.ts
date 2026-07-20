import { requireAdmin } from "@/app/lib/auth";

export const runtime = "nodejs";

// Admin grant-plan endpoint. Lets the admin manually comp plans/Pro to a
// user — used for refunds, failed Stripe webhooks, VIP comps, customer
// service recovery. Mirrors the side-effects of the Stripe webhook
// (ArmIQUsers portal fields + PlanJobs row + Lambda invoke for the email)
// so the user gets the same experience as a real purchase.
//
// Audit trail: every grant writes to AdminActions so we can answer "who
// gave that comp + when + why" later.
export async function POST(req: Request) {
  const adminEmail = await requireAdmin();
  if (!adminEmail) {
    return new Response("Forbidden", { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const targetEmail = String(body.email || "").toLowerCase().trim();
  const planDays = Number(body.plan_days || 0);
  const pro = body.pro === true;
  const note = String(body.note || "").slice(0, 500);

  if (!targetEmail) {
    return new Response("Missing email", { status: 400 });
  }
  // Permitted day values mirror Stripe price tiers — anything else likely
  // a typo. 0 is allowed only when granting Pro alone.
  const ALLOWED_DAYS = new Set([0, 1, 7, 14, 30, 45]);
  if (!ALLOWED_DAYS.has(planDays)) {
    return new Response("Invalid plan_days", { status: 400 });
  }
  if (planDays === 0 && !pro) {
    return new Response("Nothing to grant", { status: 400 });
  }

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, UpdateCommand, PutCommand, GetCommand } =
    await import("@aws-sdk/lib-dynamodb");
  const { queryFirstMatch } = await import("@/app/lib/dynamo");
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

  // We don't auto-create — admin should grant to known accounts. Avoids
  // typo'd emails creating phantom accounts.
  const existing = await ddb.send(
    new GetCommand({ TableName: "ArmIQUsers", Key: { email: targetEmail } })
  );
  if (!existing.Item) {
    return new Response("User not found", { status: 404 });
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // Pro grants get 30 days portal (matches a paid Pro month). Plan-day
  // grants set portal to plan_days. If both, pro wins on duration.
  const portalDays = pro ? Math.max(30, planDays) : planDays;
  const portalExpires =
    portalDays > 0
      ? new Date(now.getTime() + portalDays * 24 * 60 * 60 * 1000).toISOString()
      : existing.Item.portal_expires || null;

  const setParts: string[] = ["granted_by = :gb", "granted_at = :gat"];
  const values: Record<string, any> = { ":gb": adminEmail, ":gat": nowIso };

  if (pro) {
    setParts.push("subscribed = :t", "subscribed_at = :gat");
    values[":t"] = true;
  }
  if (portalDays > 0 && portalExpires) {
    setParts.push("portal_expires = :exp", "portal_plan_days = :days");
    values[":exp"] = portalExpires;
    values[":days"] = portalDays;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: "ArmIQUsers",
      Key: { email: targetEmail },
      UpdateExpression: "SET " + setParts.join(", "),
      ExpressionAttributeValues: values,
    })
  );

  // Find the user's most recent armiq swing so we can generate + email
  // a personalized plan. Filter on source="armiq" — the SwingAnalyses
  // table is shared with batiq, and granting an armiq comp must not pick
  // up a hitting swing by accident.
  let jobId: string | null = null;
  if (planDays > 0) {
    const latestSwing = await queryFirstMatch(ddb, {
      TableName: "SwingAnalyses",
      IndexName: "email-index",
      KeyConditionExpression: "email = :e",
      FilterExpression: "#src = :sv",
      ExpressionAttributeNames: { "#src": "source" },
      ExpressionAttributeValues: { ":e": targetEmail, ":sv": "armiq" },
      ScanIndexForward: false,
    });

    if (latestSwing?.swing_id) {
      jobId = `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await ddb.send(
        new PutCommand({
          TableName: "PlanJobs",
          Item: {
            job_id: jobId,
            email: targetEmail,
            swing_id: latestSwing.swing_id,
            plan_days: planDays,
            status: "scheduled",
            source: "armiq",
            grant_source: "admin-grant",
            granted_by: adminEmail,
            created_at: nowIso,
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
    }
  }

  // Audit log — record after the grant succeeds so failed grants don't
  // pollute the log. `product:"armiq"` distinguishes from batiq grants
  // since both apps share AdminActions.
  const actionId = `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await ddb.send(
    new PutCommand({
      TableName: "AdminActions",
      Item: {
        action_id: actionId,
        action_type: "grant_plan",
        product: "armiq",
        admin_email: adminEmail,
        target_email: targetEmail,
        plan_days: planDays,
        pro,
        note,
        plan_job_id: jobId,
        portal_expires: portalExpires,
        created_at: nowIso,
      },
    })
  );

  return Response.json({
    ok: true,
    target_email: targetEmail,
    plan_days: planDays,
    pro,
    portal_expires: portalExpires,
    plan_job_id: jobId,
    plan_email_skipped: planDays > 0 && !jobId,
    action_id: actionId,
  });
}
