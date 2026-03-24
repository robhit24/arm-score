import { getSessionEmail } from "@/app/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, QueryCommand } = await import("@aws-sdk/lib-dynamodb");

  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: "us-east-2" })
  );

  const result = await ddb.send(
    new QueryCommand({
      TableName: "SwingAnalyses",
      IndexName: "email-index",
      KeyConditionExpression: "email = :e",
      FilterExpression: "source = :src",
      ExpressionAttributeValues: { ":e": email, ":src": "armiq" },
      ScanIndexForward: false,
    })
  );

  const swings = (result.Items || []).map((item: any) => ({
    swing_id: item.swing_id,
    score: item.score,
    score_label: item.score_label,
    breakdown: item.breakdown,
    top3: item.top3,
    impact_line: item.impact_line,
    uplift_line: item.uplift_line,
    sport: item.sport,
    age_group: item.age_group,
    created_at: item.created_at,
  }));

  return Response.json({ swings });
}
