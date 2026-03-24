import { getSessionEmail } from "@/app/lib/auth";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

export const runtime = "nodejs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

export async function GET(req: Request) {
  const email = await getSessionEmail();
  if (!email) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const filterAge = url.searchParams.get("age_group") || "";
  const filterSport = url.searchParams.get("sport") || "";

  // Get all swing analyses
  const result = await ddb.send(
    new ScanCommand({
      TableName: "SwingAnalyses",
      ProjectionExpression: "email, score, age_group, sport, created_at",
    })
  );

  const allSwings = (result.Items || []).filter(
    (item: any) => item.score != null && item.email
  );

  // Get best score per email (with optional filters)
  const bestByUser = new Map<string, any>();
  for (const sw of allSwings) {
    // Apply filters
    if (filterAge && sw.age_group !== filterAge) continue;
    if (filterSport && sw.sport !== filterSport) continue;

    const existing = bestByUser.get(sw.email);
    if (!existing || sw.score > existing.score) {
      bestByUser.set(sw.email, {
        email: sw.email,
        score: sw.score,
        age_group: sw.age_group || "—",
        sport: sw.sport || "baseball",
      });
    }
  }

  // Sort by score descending
  const sorted = Array.from(bestByUser.values()).sort(
    (a, b) => b.score - a.score
  );

  // Calculate percentiles and anonymize
  const total = sorted.length;
  const leaderboard = sorted.map((entry, idx) => {
    const rank = idx + 1;
    const percentile = Math.round(((total - rank) / total) * 100);

    // Anonymize: first letter + "***"
    const name = entry.email.split("@")[0];
    const display = name.charAt(0).toUpperCase() + "***";

    return {
      rank,
      display_name: display,
      score: entry.score,
      percentile,
      age_group: entry.age_group,
      sport: entry.sport,
      is_you: entry.email === email,
    };
  });

  // Find current user's position
  const myEntry = leaderboard.find((e) => e.is_you);

  return Response.json({
    leaderboard: leaderboard.slice(0, 50), // top 50
    total_athletes: total,
    my_rank: myEntry?.rank || null,
    my_percentile: myEntry?.percentile || null,
    my_score: myEntry?.score || null,
  });
}
