import { getSessionEmail } from "@/app/lib/auth";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

export const runtime = "nodejs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Scan PlanJobs for this user's completed plans
  const result = await ddb.send(
    new ScanCommand({
      TableName: "PlanJobs",
      FilterExpression: "email = :e AND #s = :sent",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":e": email,
        ":sent": "sent",
      },
    })
  );

  const plans = (result.Items || [])
    .filter((item: any) => item.plan_json)
    .map((item: any) => {
      let plan = null;
      try { plan = JSON.parse(item.plan_json); } catch {}
      return {
        job_id: item.job_id,
        plan_days: item.plan_days || item.plan_days_generated || 30,
        created_at: item.created_at,
        sent_at: item.sent_at,
        plan,
      };
    })
    .filter((p: any) => p.plan)
    .sort((a: any, b: any) => (b.sent_at || "").localeCompare(a.sent_at || ""));

  return Response.json({ plans });
}
