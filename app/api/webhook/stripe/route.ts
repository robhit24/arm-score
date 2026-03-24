import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

export const runtime = "nodejs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

export async function POST(req: Request) {
  try {
    const body = await req.text();
    let event: any;
    try {
      event = JSON.parse(body);
    } catch {
      return Response.json({ received: true });
    }

    console.log("Stripe webhook event:", event.type, JSON.stringify(event.data?.object || {}).slice(0, 500));

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // Try multiple ways to get the email
      let email = (
        session.customer_email ||
        session.customer_details?.email ||
        session.metadata?.email ||
        ""
      ).toLowerCase().trim();

      // If no email but we have a customer ID, look up by customer ID
      if (!email && session.customer) {
        const scan = await ddb.send(
          new ScanCommand({
            TableName: "ArmIQUsers",
            FilterExpression: "stripe_customer_id = :c",
            ExpressionAttributeValues: { ":c": session.customer },
            Limit: 1,
          })
        );
        if (scan.Items?.[0]) {
          email = scan.Items[0].email;
        }
      }

      if (email) {
        await ddb.send(
          new UpdateCommand({
            TableName: "ArmIQUsers",
            Key: { email },
            UpdateExpression: "SET subscribed = :t, stripe_customer_id = :c, subscribed_at = :now",
            ExpressionAttributeValues: {
              ":t": true,
              ":c": session.customer || "",
              ":now": new Date().toISOString(),
            },
          })
        );
        console.log("Marked subscribed:", email);
      } else {
        console.log("No email found in checkout session:", session.id);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const customerId = sub.customer;

      const result = await ddb.send(
        new ScanCommand({
          TableName: "ArmIQUsers",
          FilterExpression: "stripe_customer_id = :c",
          ExpressionAttributeValues: { ":c": customerId },
          Limit: 1,
        })
      );

      const user = result.Items?.[0];
      if (user) {
        await ddb.send(
          new UpdateCommand({
            TableName: "ArmIQUsers",
            Key: { email: user.email },
            UpdateExpression: "SET subscribed = :f, cancelled_at = :now",
            ExpressionAttributeValues: {
              ":f": false,
              ":now": new Date().toISOString(),
            },
          })
        );
        console.log("Marked unsubscribed:", user.email);
      }
    }

    return Response.json({ received: true });
  } catch (err: any) {
    console.error("Stripe webhook error:", err?.message || err);
    return Response.json({ received: true });
  }
}
