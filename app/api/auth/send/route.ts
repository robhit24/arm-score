export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { email, redirect } = await req.json();
    if (!email || !email.includes("@")) {
      return new Response("Invalid email", { status: 400 });
    }

    // Open-redirect guard: only honor relative paths starting with `/` and
    // not `//` (which would resolve to an external host). Anything else
    // falls back to the default /dashboard redirect at verify time.
    const safeRedirect =
      typeof redirect === "string" &&
      redirect.startsWith("/") &&
      !redirect.startsWith("//")
        ? redirect
        : null;

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
    // Persist the redirect alongside the token. `magic_redirect` is the
    // single source of truth at verify time — keeping it in DynamoDB (vs.
    // encoded into the token) means the link in the email stays short and
    // we can't be tricked by a tampered URL into redirecting elsewhere.
    // REMOVE clears any stale redirect from a prior attempt so the next
    // sign-in lands on /dashboard by default.
    const setExpr =
      "SET magic_token = :t, magic_expires = :e, updated_at = :u" +
      (safeRedirect ? ", magic_redirect = :r" : "");
    const updateExpression = safeRedirect ? setExpr : `${setExpr} REMOVE magic_redirect`;
    const exprValues: Record<string, any> = {
      ":t": token,
      ":e": expiresAt,
      ":u": new Date().toISOString(),
    };
    if (safeRedirect) exprValues[":r"] = safeRedirect;
    await ddb.send(
      new UpdateCommand({
        TableName: "ArmIQUsers",
        Key: { email: email.toLowerCase().trim() },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: exprValues,
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
