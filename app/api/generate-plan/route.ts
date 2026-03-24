import { getSessionEmail } from "@/app/lib/auth";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

export const runtime = "nodejs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));
const lambda = new LambdaClient({ region: "us-east-2" });

export async function POST() {
  try {
    const email = await getSessionEmail();
    if (!email) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Check subscription
    const user = await ddb.send(
      new GetCommand({ TableName: "ArmIQUsers", Key: { email } })
    );

    if (!user.Item?.subscribed) {
      return new Response("No active subscription", { status: 403 });
    }

    // Check if they already generated a plan this month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const lastPlan = user.Item?.last_plan_generated;

    if (lastPlan && lastPlan >= monthStart) {
      return Response.json({
        ok: false,
        message: "You already generated a plan this month. Your next plan is available " +
          new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString() + ".",
      });
    }

    // Get their latest swing
    const swingsResult = await ddb.send(
      new QueryCommand({
        TableName: "SwingAnalyses",
        IndexName: "email-index",
        KeyConditionExpression: "email = :e",
        FilterExpression: "#src = :armiq AND score > :zero",
        ExpressionAttributeNames: { "#src": "source" },
        ExpressionAttributeValues: { ":e": email, ":armiq": "armiq", ":zero": 0 },
        ScanIndexForward: false,
        Limit: 10,
      })
    );

    const latestSwing = swingsResult.Items?.[0];
    if (!latestSwing) {
      return Response.json({
        ok: false,
        message: "No pitch analysis found. Analyze a pitch first, then generate your plan.",
      });
    }

    // Create a job in PlanJobs
    const jobId = `sub-${email}-${Date.now()}`;

    await ddb.send(
      new PutCommand({
        TableName: "PlanJobs",
        Item: {
          job_id: jobId,
          email,
          swing_id: latestSwing.swing_id,
          plan_days: 30,
          status: "scheduled",
          source: "armiq",
          created_at: new Date().toISOString(),
        },
      })
    );

    // Invoke the Lambda directly (no 2-hour delay for subscribers)
    await lambda.send(
      new InvokeCommand({
        FunctionName: "armiq-generate-plan-live-generateAndSendPlan",
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ job_id: jobId })),
      })
    );

    // Update last plan generated date
    const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
    await ddb.send(
      new UpdateCommand({
        TableName: "ArmIQUsers",
        Key: { email },
        UpdateExpression: "SET last_plan_generated = :now",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      })
    );

    return Response.json({
      ok: true,
      message: "Your 30-day plan is being generated! Refresh this page in 3-5 minutes to view it here.",
    });
  } catch (err: any) {
    console.error("Generate plan error:", err?.message || err);
    return new Response(`Failed: ${err?.message}`, { status: 500 });
  }
}
