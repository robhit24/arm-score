import { getSessionEmail } from "@/app/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return Response.json({ authenticated: false });
  }

  // Check subscription status
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand } = await import("@aws-sdk/lib-dynamodb");

  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: "us-east-2" })
  );

  const user = await ddb.send(
    new GetCommand({
      TableName: "ArmIQUsers",
      Key: { email },
    })
  );

  return Response.json({
    authenticated: true,
    email,
    subscribed: user.Item?.subscribed === true,
    stripe_customer_id: user.Item?.stripe_customer_id || null,
  });
}
