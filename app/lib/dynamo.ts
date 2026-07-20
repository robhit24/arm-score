import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

// Query pages until the first FilterExpression match. Limit and
// FilterExpression can't be combined naively: DynamoDB applies Limit to items
// READ (before the filter runs), so e.g. a Limit:1 "latest armiq swing" query
// misses every older armiq row whenever the newest row is a hitting swing or
// zero-score analysis. Callers pass the query input WITHOUT Limit; each page
// is filtered server-side and the first surviving item (in index order) wins.
export async function queryFirstMatch(
  ddb: DynamoDBDocumentClient,
  input: ConstructorParameters<typeof QueryCommand>[0]
): Promise<Record<string, any> | undefined> {
  let lastKey: Record<string, any> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({ ...input, ExclusiveStartKey: lastKey })
    );
    if (page.Items?.[0]) return page.Items[0];
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return undefined;
}
