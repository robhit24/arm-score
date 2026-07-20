import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

export const runtime = "nodejs";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "us-east-2" })
);

// Pixel event audit log. The PixelEvents table is shared with batiq, so we
// stamp `product: "armiq"` on every write — both admin dashboards filter by
// product so funnels never cross-pollute. See app/admin/page.tsx for the
// matching read-side filter.
export async function POST(req: Request) {
  try {
    const { event_name, email, value, currency, content_name, landing_page, source } = await req.json();

    if (!event_name) {
      return new Response("Missing event_name", { status: 400 });
    }

    const eventId = `${event_name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await ddb.send(
      new PutCommand({
        TableName: "PixelEvents",
        Item: {
          event_id: eventId,
          event_name,
          product: "armiq",
          email: (email || "").toLowerCase().trim() || undefined,
          value: value || 0,
          currency: currency || "USD",
          content_name: content_name || undefined,
          landing_page: landing_page || undefined,
          source: source || "client",
          created_at: new Date().toISOString(),
        },
      })
    );

    return Response.json({ ok: true });
  } catch (err: any) {
    console.error("Pixel event log error:", err?.message || err);
    return new Response("Failed", { status: 500 });
  }
}
