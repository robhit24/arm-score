import { getSessionEmail, isAdminEmail } from "@/app/lib/auth";

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
      FilterExpression: "#src = :srcVal",
      ExpressionAttributeNames: { "#src": "source" },
      ExpressionAttributeValues: { ":e": email, ":srcVal": "armiq" },
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

// Delete a single swing the caller owns. Used by the dashboard delete-row
// button so the daily rate limit can be cleared while testing. Auth-gated:
// only the swing's owner — or an admin (ADMIN_EMAILS allowlist) — can
// delete. Admin override is what lets /admin moderate swings.
export async function DELETE(req: Request) {
  const email = await getSessionEmail();
  if (!email) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const swingId = url.searchParams.get("id");
  if (!swingId) {
    return new Response("Missing id", { status: 400 });
  }

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand, DeleteCommand } = await import(
    "@aws-sdk/lib-dynamodb"
  );
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

  const existing = await ddb.send(
    new GetCommand({ TableName: "SwingAnalyses", Key: { swing_id: swingId } })
  );
  if (!existing.Item) {
    return new Response("Not found", { status: 404 });
  }
  const ownerEmail = String(existing.Item.email || "").toLowerCase().trim();
  const isAdmin = isAdminEmail(email);
  if (!isAdmin && ownerEmail !== email.toLowerCase().trim()) {
    return new Response("Forbidden", { status: 403 });
  }

  await ddb.send(
    new DeleteCommand({ TableName: "SwingAnalyses", Key: { swing_id: swingId } })
  );

  return Response.json({ ok: true });
}
