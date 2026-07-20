import { cookies } from "next/headers";
import { encodeSession } from "@/app/lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const origin = req.headers.get("origin") || new URL(req.url).origin;

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return Response.redirect(`${origin}/?auth=invalid`, 302);
    }

    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = await import(
      "@aws-sdk/lib-dynamodb"
    );

    const ddb = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: "us-east-2" })
    );

    // Look up token
    const result = await ddb.send(
      new QueryCommand({
        TableName: "ArmIQUsers",
        IndexName: "magic_token-index",
        KeyConditionExpression: "magic_token = :t",
        ExpressionAttributeValues: { ":t": token },
        Limit: 1,
      })
    );

    const user = result.Items?.[0];
    if (!user) {
      return Response.redirect(`${origin}/?auth=invalid`, 302);
    }

    // Check expiry
    if (user.magic_expires && new Date(user.magic_expires) < new Date()) {
      return Response.redirect(`${origin}/?auth=expired`, 302);
    }

    // Capture the post-login redirect *before* the UpdateCommand wipes it.
    // Re-validate the same way /api/auth/send does — defense-in-depth in
    // case the table was edited out of band.
    const storedRedirect =
      typeof user.magic_redirect === "string" &&
      user.magic_redirect.startsWith("/") &&
      !user.magic_redirect.startsWith("//")
        ? user.magic_redirect
        : null;

    // Clear magic token + redirect (one-time use). Also bump login_count
    // so the admin dashboard can sort by activity.
    await ddb.send(
      new UpdateCommand({
        TableName: "ArmIQUsers",
        Key: { email: user.email },
        UpdateExpression:
          "REMOVE magic_token, magic_expires, magic_redirect SET last_login = :now, login_count = if_not_exists(login_count, :zero) + :one",
        ExpressionAttributeValues: { ":now": new Date().toISOString(), ":zero": 0, ":one": 1 },
      })
    );

    // Set session cookie
    const sessionToken = encodeSession(user.email);
    const cookieStore = await cookies();
    cookieStore.set({
      name: "armiq_session",
      value: sessionToken,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });

    return Response.redirect(`${origin}${storedRedirect || "/dashboard"}`, 302);
  } catch (err: any) {
    console.error("Auth verify error:", err?.message || err);
    return Response.redirect(`${origin}/?auth=error`, 302);
  }
}
