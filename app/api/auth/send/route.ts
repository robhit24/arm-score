export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { email } = await req.json();
    if (!email || !email.includes("@")) {
      return new Response("Invalid email", { status: 400 });
    }

    // Generate magic token
    const token = crypto.randomUUID() + "-" + crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min

    // Store token in DynamoDB user record
    const res = await fetch(
      "https://8156f6tuae.execute-api.us-east-2.amazonaws.com/live/store-analysis",
      { method: "GET" } // just checking connectivity
    ).catch(() => null);

    // Store magic token directly in ArmIQUsers table
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, PutCommand } = await import("@aws-sdk/lib-dynamodb");

    const ddb = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: "us-east-2" })
    );

    const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
    await ddb.send(
      new UpdateCommand({
        TableName: "ArmIQUsers",
        Key: { email: email.toLowerCase().trim() },
        UpdateExpression: "SET magic_token = :t, magic_expires = :e, updated_at = :u",
        ExpressionAttributeValues: {
          ":t": token,
          ":e": expiresAt,
          ":u": new Date().toISOString(),
        },
      })
    );

    // Send magic link via SES
    const { SESClient, SendEmailCommand } = await import("@aws-sdk/client-ses");
    const ses = new SESClient({ region: "us-east-2" });

    const origin = req.headers.get("origin") || "https://armiq.ai";
    const magicLink = `${origin}/api/auth/verify?token=${token}`;

    await ses.send(
      new SendEmailCommand({
        Source: "help@hit24.com",
        Destination: { ToAddresses: [email] },
        Message: {
          Subject: { Data: "Sign in to ArmIQ" },
          Body: {
            Text: {
              Data: `Click this link to sign in to your ArmIQ dashboard:\n\n${magicLink}\n\nThis link expires in 15 minutes.`,
            },
          },
        },
      })
    );

    return Response.json({ ok: true });
  } catch (err: any) {
    console.error("Auth send error:", err?.message || err);
    return new Response(`Auth failed: ${err?.message}`, { status: 500 });
  }
}
