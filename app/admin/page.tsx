import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { getSessionEmail, isAdminEmail } from "@/app/lib/auth";
import { normalizeBreakdown } from "@/app/lib/score";
import { SignIn } from "./SignIn";
import { DeleteSwingButton } from "./DeleteSwingButton";
import { GrantPlanButton } from "./GrantPlanButton";
import s from "./page.module.css";

// Server component — no client JS shipped for the admin himself. The auth
// gate runs server-side via the `armiq_session` cookie + ADMIN_EMAILS
// allowlist. Non-admins see the SignIn client island; admins get the full
// dashboard rendered from in-flight DynamoDB scans.
//
// Tables shared with batiq (SwingAnalyses, PlanJobs, AdminActions) are
// filtered by source="armiq" so this view never picks up hitting data.
// ArmIQUsers is exclusive to this app.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AnyRec = Record<string, any>;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-2" }));

async function scanAll(table: string, filter?: { expr: string; values: AnyRec; names?: AnyRec }) {
  const items: AnyRec[] = [];
  let ExclusiveStartKey: any = undefined;
  // Cap at 10 pages to keep a runaway scan from blowing the function budget.
  for (let i = 0; i < 10; i++) {
    const out: any = await ddb.send(
      new ScanCommand({
        TableName: table,
        ExclusiveStartKey,
        ...(filter
          ? {
              FilterExpression: filter.expr,
              ExpressionAttributeValues: filter.values,
              ...(filter.names ? { ExpressionAttributeNames: filter.names } : {}),
            }
          : {}),
      })
    );
    items.push(...(out.Items || []));
    if (!out.LastEvaluatedKey) break;
    ExclusiveStartKey = out.LastEvaluatedKey;
  }
  return items;
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function relTime(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function money(n: number) {
  return `$${n.toFixed(2)}`;
}

// Stripe price → dollars. Webhook stores `price_paid` for some flows but
// not all, so we derive from plan_days as a fallback. Trial is $1.99 at
// signup. Free 1-day claims are $0. Keep this synced with armiq pricing
// in app/api/checkout/route.ts.
function planRevenue(j: AnyRec): number {
  if (typeof j.price_paid === "number") return j.price_paid;
  const days = Number(j.plan_days);
  if (j.source === "trial" || j.grant_source === "trial") return 1.99;
  if (days === 1) return 0;
  if (days === 7) return 9.99;
  if (days === 14) return 19.99;
  if (days === 30) return 59.99;
  if (days === 45) return 79.99;
  return 0;
}

export default async function AdminPage() {
  const sessionEmail = await getSessionEmail();
  const isAdmin = isAdminEmail(sessionEmail);

  if (!isAdmin) {
    return (
      <main className={s.page}>
        <div className={s.shell}>
          <SignIn notAllowed={!!sessionEmail} />
        </div>
      </main>
    );
  }

  // ---- fetch all data in parallel ----
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // SwingAnalyses + PlanJobs are shared tables — filter by source="armiq"
  // so we don't pick up batiq rows. ArmIQUsers is exclusive to this app.
  // PixelEvents may or may not exist on armiq — scanAll returns [] if the
  // table is empty or no /api/pixel-event route is wired up yet.
  const [users, swings, planJobs, eventsToday] = await Promise.all([
    scanAll("ArmIQUsers"),
    scanAll("SwingAnalyses", {
      expr: "#src = :sv AND created_at >= :since AND attribute_not_exists(is_seed)",
      names: { "#src": "source" },
      values: { ":sv": "armiq", ":since": since7d },
    }),
    scanAll("PlanJobs", {
      expr: "#src = :sv AND created_at >= :since",
      names: { "#src": "source" },
      values: { ":sv": "armiq", ":since": since7d },
    }),
    // PixelEvents is shared with batiq — filter by product so the funnel
    // counts only armiq events. Pre-existing batiq rows have no `product`
    // field, so they won't match and won't pollute these metrics.
    scanAll("PixelEvents", {
      expr: "product = :p AND created_at >= :since",
      values: { ":p": "armiq", ":since": since24h },
    }).catch(() => [] as AnyRec[]),
  ]);

  // ---- metrics ----
  const eventCounts: Record<string, number> = {};
  let revenueToday = 0;
  for (const e of eventsToday) {
    const name = e.event_name || "Unknown";
    eventCounts[name] = (eventCounts[name] || 0) + 1;
    if (name === "Purchase") revenueToday += Number(e.value || 0);
  }

  const subscribers = users.filter((u) => u.subscribed === true).length;
  const totalUsers = users.length;
  const swingsLast7d = swings.length;

  const paidJobs = planJobs.filter((j) => j.status === "sent" && Number(j.plan_days) > 1);
  const freeClaims = planJobs.filter((j) => Number(j.plan_days) === 1);
  const revenue7d = paidJobs.reduce((sum, j) => sum + planRevenue(j), 0);

  // ---- sort tables ----
  swings.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  planJobs.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  users.sort((a, b) => {
    const aT = a.last_login || a.updated_at || "";
    const bT = b.last_login || b.updated_at || "";
    return bT.localeCompare(aT);
  });

  return (
    <main className={s.page}>
      <div className={s.shell}>
        <div className={s.header}>
          <div className={s.title}>ArmIQ admin</div>
          <div className={s.who}>
            {sessionEmail}
            <a href="/dashboard">user dashboard →</a>
          </div>
        </div>

        {/* ============== TODAY METRICS ============== */}
        <div className={s.metricGrid}>
          <Metric label="PageViews · 24h" value={eventCounts["PageView"] || 0} />
          <Metric label="Leads · 24h" value={eventCounts["Lead"] || 0} />
          <Metric label="Init checkout · 24h" value={eventCounts["InitiateCheckout"] || 0} />
          <Metric
            label="Purchases · 24h"
            value={eventCounts["Purchase"] || 0}
            sub={revenueToday > 0 ? money(revenueToday) : undefined}
            tone="good"
          />
          <Metric label="Total users" value={totalUsers} />
          <Metric label="Subscribers" value={subscribers} tone={subscribers > 0 ? "good" : undefined} />
          <Metric label="Pitches · 7d" value={swingsLast7d} />
          <Metric label="Revenue · 7d" value={money(revenue7d)} tone={revenue7d > 0 ? "good" : undefined} />
          <Metric label="Free 1-day claims" value={freeClaims.length} tone="warn" />
        </div>

        {/* ============== RECENT PITCHES ============== */}
        <Section title={`Recent pitches (${swings.length})`} meta="last 7d">
          {swings.length === 0 ? (
            <Empty>No pitches in the last 7 days.</Empty>
          ) : (
            <Table headers={["When", "Email", "Score", "Balance", "Stride", "Arm Path", "Release", "Finish", "Sport · Age", "Landing", ""]}>
              {swings.slice(0, 80).map((sw) => {
                // normalizeBreakdown coerces legacy 3-metric rows
                // (timing/power_transfer/bat_control) into the 5-metric form
                // so historical rows still render numbers in every column.
                const nb = normalizeBreakdown(sw.breakdown || {});
                return (
                <tr key={sw.swing_id || sw.created_at}>
                  <td title={sw.created_at}>{relTime(sw.created_at)}</td>
                  <td>{sw.email || "—"}</td>
                  <td className={s.scoreCell}>{sw.score ?? "—"}</td>
                  <td>{nb.balance || "—"}</td>
                  <td>{nb.stride || "—"}</td>
                  <td>{nb.arm_path || "—"}</td>
                  <td>{nb.release || "—"}</td>
                  <td>{nb.finish || "—"}</td>
                  <td>{`${sw.sport || "?"} · ${sw.age_group || "?"}`}</td>
                  <td>{sw.landing_page || "—"}</td>
                  <td>
                    {sw.swing_id ? (
                      <DeleteSwingButton swingId={sw.swing_id} email={sw.email || ""} />
                    ) : null}
                  </td>
                </tr>
                );
              })}
            </Table>
          )}
        </Section>

        {/* ============== RECENT PLAN JOBS ============== */}
        <Section title={`Plan jobs (${planJobs.length})`} meta="last 7d">
          {planJobs.length === 0 ? (
            <Empty>No plan jobs in the last 7 days.</Empty>
          ) : (
            <Table headers={["When", "Email", "Plan", "Status", "Source", "Revenue"]}>
              {planJobs.slice(0, 60).map((j) => (
                <tr key={j.job_id || j.created_at}>
                  <td title={j.created_at}>{relTime(j.created_at)}</td>
                  <td>{j.email || "—"}</td>
                  <td>
                    <PlanTag days={Number(j.plan_days)} source={j.source || j.grant_source} />
                  </td>
                  <td>{j.status || "—"}</td>
                  <td>{j.grant_source || j.source || "—"}</td>
                  <td className={s.scoreCell}>
                    {j.status === "sent" && Number(j.plan_days) > 1 ? money(planRevenue(j)) : "—"}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Section>

        {/* ============== USERS ============== */}
        <Section title={`Users (${users.length})`} meta="sorted by last activity">
          {users.length === 0 ? (
            <Empty>No users yet.</Empty>
          ) : (
            <Table
              headers={[
                "Last seen",
                "Email",
                "Status",
                "Plan days",
                "Logins",
                "Landing",
                "UTM source",
                "",
              ]}
            >
              {users.slice(0, 200).map((u) => (
                <tr key={u.email}>
                  <td title={u.last_login || u.updated_at}>
                    {relTime(u.last_login || u.updated_at)}
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <UserStatus user={u} />
                  </td>
                  <td>{u.plan_days ?? u.portal_plan_days ?? "—"}</td>
                  <td>{u.login_count ?? 0}</td>
                  <td>{u.landing_page || "—"}</td>
                  <td>{u.utm?.utm_source || u.utm?.via || "—"}</td>
                  <td>
                    {u.email ? <GrantPlanButton email={u.email} /> : null}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      </div>
    </main>
  );
}

// ---- presentational helpers ----

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "good" | "warn";
}) {
  const toneClass = tone === "good" ? s.metricGood : tone === "warn" ? s.metricWarn : "";
  return (
    <div className={s.metric}>
      <div className={s.metricLabel}>{label}</div>
      <div className={`${s.metricValue} ${toneClass}`}>{value}</div>
      {sub && <div className={s.metricSub}>{sub}</div>}
    </div>
  );
}

function Section({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={s.section}>
      <div className={s.sectionHead}>
        <div className={s.sectionTitle}>{title}</div>
        {meta && <div className={s.sectionMeta}>{meta}</div>}
      </div>
      <div className={s.tableWrap}>{children}</div>
    </section>
  );
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <table className={s.table}>
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className={s.empty}>{children}</div>;
}

function PlanTag({ days, source }: { days: number; source?: string }) {
  if (source === "trial") return <span className={`${s.tag} ${s.tagSub}`}>Trial $1.99</span>;
  if (days === 1) return <span className={`${s.tag} ${s.tagFree}`}>Free 1-day</span>;
  if (days > 1) return <span className={`${s.tag} ${s.tagPaid}`}>{days}-day</span>;
  return <span className={s.tag}>—</span>;
}

function UserStatus({ user }: { user: AnyRec }) {
  if (user.subscribed === true) return <span className={`${s.tag} ${s.tagSub}`}>Pro</span>;
  const days = Number(user.plan_days ?? user.portal_plan_days);
  if (days > 1) return <span className={`${s.tag} ${s.tagPaid}`}>{days}-day</span>;
  if (days === 1) return <span className={`${s.tag} ${s.tagFree}`}>Free</span>;
  return <span className={s.tag}>Visitor</span>;
}
