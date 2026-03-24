"use client";

import { useEffect, useRef, useState } from "react";
import { extractFrames } from "../lib/extract-frames";
import s from "./dashboard.module.css";
import { PlanViewer } from "./PlanViewer";
import { Leaderboard } from "./Leaderboard";

type Swing = {
  swing_id: string;
  score: number;
  score_label: string;
  breakdown: { timing: number; power_transfer: number; bat_control: number };
  top3: string[];
  sport: string;
  age_group: string;
  created_at: string;
};

type User = {
  authenticated: boolean;
  email?: string;
  subscribed?: boolean;
};

export default function Dashboard() {
  const [user, setUser] = useState<User | null>(null);
  const [swings, setSwings] = useState<Swing[]>([]);
  const [loading, setLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState("");
  const [linkSent, setLinkSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [planMsg, setPlanMsg] = useState("");
  const [generatingPlan, setGeneratingPlan] = useState(false);
  const [plans, setPlans] = useState<any[]>([]);
  const [ageRank, setAgeRank] = useState<{ rank: number; total: number; percentile: number; age: string } | null>(null);

  // Inline pitch analysis
  const [analyzeFile, setAnalyzeFile] = useState<File | null>(null);
  const [analyzeSport, setAnalyzeSport] = useState("baseball");
  const [analyzeAge, setAnalyzeAge] = useState("12U");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeResult, setAnalyzeResult] = useState<Swing | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data) => {
        setUser(data);
        if (data.authenticated) {
          fetch("/api/swings")
            .then((r) => r.json())
            .then((d) => {
              setSwings(d.swings || []);
              // Fetch age group rank based on latest swing
              const latest = d.swings?.[0];
              if (latest?.age_group) {
                fetch(`/api/leaderboard?age_group=${encodeURIComponent(latest.age_group)}`)
                  .then((r) => r.json())
                  .then((lb) => {
                    if (lb.my_rank) {
                      setAgeRank({
                        rank: lb.my_rank,
                        total: lb.total_athletes,
                        percentile: lb.my_percentile,
                        age: latest.age_group,
                      });
                    }
                  })
                  .catch(() => {});
              }
            });
          fetch("/api/plans")
            .then((r) => r.json())
            .then((d) => setPlans(d.plans || []))
            .catch(() => {});
        }
      })
      .finally(() => setLoading(false));
  }, []);

  async function sendMagicLink() {
    if (!loginEmail.includes("@")) return;
    setSending(true);
    try {
      const res = await fetch("/api/auth/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: loginEmail }),
      });
      if (res.ok) setLinkSent(true);
    } finally {
      setSending(false);
    }
  }

  async function hashFrames(frames: string[]): Promise<string> {
    const sample = frames.map((f) => f.slice(0, 500)).join("|");
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sample));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function analyzeSwing() {
    if (!analyzeFile || !user?.email) return;
    setAnalyzing(true);
    setAnalyzeResult(null);
    try {
      const frames = await extractFrames(analyzeFile, 4);
      const frameHash = await hashFrames(frames);

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: user.email,
          sport: analyzeSport,
          age_group: analyzeAge,
          frames,
          frame_hash: frameHash,
        }),
      });

      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      // Store the analysis
      const swingId = crypto.randomUUID();
      await fetch(
        "https://8156f6tuae.execute-api.us-east-2.amazonaws.com/live/store-analysis",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            swing_id: swingId,
            email: user.email,
            sport: analyzeSport,
            age_group: analyzeAge,
            frame_hash: frameHash,
            source: "armiq",
            analysis: data,
          }),
        }
      );

      const newSwing: Swing = {
        swing_id: swingId,
        score: data.score,
        score_label: data.score_label,
        breakdown: data.breakdown,
        top3: data.top3,
        sport: analyzeSport,
        age_group: analyzeAge,
        created_at: new Date().toISOString(),
      };

      setAnalyzeResult(newSwing);
      setSwings((prev) => [newSwing, ...prev]);
      setAnalyzeFile(null);
    } catch (err: any) {
      alert(err?.message || "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }

  async function generatePlan() {
    setGeneratingPlan(true);
    setPlanMsg("");
    try {
      const res = await fetch("/api/generate-plan", { method: "POST" });
      const data = await res.json();
      setPlanMsg(data.message);
    } catch {
      setPlanMsg("Something went wrong. Try again.");
    } finally {
      setGeneratingPlan(false);
    }
  }

  if (loading) {
    return (
      <div className={s.page}>
        <div className={s.container}>
          <div className={s.loading}>Loading...</div>
        </div>
      </div>
    );
  }

  // Not logged in — show login
  if (!user?.authenticated) {
    return (
      <div className={s.page}>
        <div className={s.container}>
          <div className={s.loginCard}>
            <div className={s.brandRow}>
              <div className={s.brandDot} />
              <span className={s.brandName}>ArmIQ</span>
            </div>
            <h1 className={s.loginTitle}>Sign in to your dashboard</h1>
            <p className={s.loginSub}>
              Enter the email you used to subscribe or analyze a pitch.
            </p>

            {linkSent ? (
              <div className={s.sentMsg}>
                Check your email — we sent a sign-in link to <strong>{loginEmail}</strong>
              </div>
            ) : (
              <div className={s.loginForm}>
                <input
                  type="email"
                  placeholder="you@email.com"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendMagicLink()}
                  className={s.loginInput}
                />
                <button
                  onClick={sendMagicLink}
                  disabled={sending || !loginEmail.includes("@")}
                  className={s.loginBtn}
                >
                  {sending ? "Sending..." : "Send sign-in link"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Logged in — show dashboard
  const latest = swings[0];
  const scoreHistory = swings
    .filter((sw) => sw.score != null)
    .slice(0, 20)
    .reverse();

  const highScore = swings.length
    ? Math.max(...swings.map((sw) => sw.score || 0))
    : 0;

  const improvement =
    scoreHistory.length >= 2
      ? scoreHistory[scoreHistory.length - 1].score - scoreHistory[0].score
      : 0;

  return (
    <div className={s.page}>
      <div className={s.container}>
        {/* Header */}
        <div className={s.header}>
          <div className={s.brandRow}>
            <div className={s.brandDot} />
            <span className={s.brandName}>ArmIQ</span>
            <span className={s.headerEmail}>{user.email}</span>
          </div>
          {!user.subscribed && (
            <a href="/" className={s.upgradeBtn}>
              Upgrade to Pro
            </a>
          )}
        </div>

        {/* Stats row */}
        <div className={s.statsRow}>
          <div className={s.statCard}>
            <div className={s.statValue}>
              {ageRank ? `#${ageRank.rank}` : "—"}
            </div>
            <div className={s.statLabel}>
              {ageRank ? `${ageRank.age} Rank` : "Age Rank"}
            </div>
          </div>
          <div className={s.statCard}>
            <div className={s.statValue}>{highScore || "—"}</div>
            <div className={s.statLabel}>High Score</div>
          </div>
          <div className={s.statCard}>
            <div className={s.statValue}>
              {improvement > 0 ? `+${improvement}` : improvement || "—"}
            </div>
            <div className={s.statLabel}>Improvement</div>
          </div>
        </div>

        {/* Generate plan card (subscribers only) */}
        {user.subscribed && swings.length > 0 && (
          <div className={s.planCard}>
            <div className={s.planCardLeft}>
              <div className={s.planCardTitle}>Monthly Training Plan</div>
              <div className={s.planCardSub}>
                Generate a custom 30-day plan from your latest pitch analysis. Delivered to your email.
              </div>
            </div>
            <button
              className={s.planCardBtn}
              onClick={generatePlan}
              disabled={generatingPlan}
            >
              {generatingPlan ? "Generating..." : "Generate My Plan"}
            </button>
            {planMsg && <div className={s.planCardMsg}>{planMsg}</div>}
          </div>
        )}

        {/* Current plan */}
        {plans.length > 0 && (
          <PlanViewer
            plan={plans[0].plan}
            planDays={plans[0].plan_days}
            sentAt={plans[0].sent_at}
          />
        )}

        {/* Score chart */}
        {scoreHistory.length >= 2 && (
          <div className={s.chartCard}>
            <div className={s.chartTitle}>Score History</div>
            <div className={s.chart}>
              {scoreHistory.map((sw, i) => (
                <div key={sw.swing_id} className={s.chartBar}>
                  <div
                    className={s.chartFill}
                    style={{ height: `${sw.score}%` }}
                    data-score={sw.score >= 85 ? "green" : sw.score >= 70 ? "amber" : "red"}
                  />
                  <div className={s.chartLabel}>{sw.score}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Latest swing */}
        {latest && (
          <div className={s.latestCard}>
            <div className={s.latestHeader}>
              <div className={s.latestTitle}>Latest Pitch</div>
              <div className={s.latestDate}>
                {new Date(latest.created_at).toLocaleDateString()}
              </div>
            </div>
            <div className={s.latestScore} data-level={
              latest.score >= 85 ? "green" : latest.score >= 70 ? "amber" : "red"
            }>
              {latest.score}
            </div>
            <div className={s.latestLabel}>{latest.score_label}</div>
            <div className={s.breakdownRow}>
              <div className={s.bdItem}>
                <div className={s.bdVal}>{latest.breakdown?.timing}</div>
                <div className={s.bdLabel}>Timing</div>
              </div>
              <div className={s.bdItem}>
                <div className={s.bdVal}>{latest.breakdown?.power_transfer}</div>
                <div className={s.bdLabel}>Power</div>
              </div>
              <div className={s.bdItem}>
                <div className={s.bdVal}>{latest.breakdown?.bat_control}</div>
                <div className={s.bdLabel}>Bat Ctrl</div>
              </div>
            </div>
            <div className={s.fixList}>
              {(latest.top3 || []).map((fix, i) => (
                <div key={i} className={s.fixItem}>
                  <span className={s.fixNum}>{i + 1}</span>
                  {fix}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Analyze new swing — inline */}
        <div className={s.analyzeCard}>
          <div className={s.analyzeTitle}>Analyze New Pitch</div>

          {analyzeResult ? (
            <div className={s.analyzeResultCard}>
              <div className={s.analyzeScore} data-level={
                analyzeResult.score >= 85 ? "green" : analyzeResult.score >= 70 ? "amber" : "red"
              }>
                {analyzeResult.score}
              </div>
              <div className={s.analyzeLabel}>{analyzeResult.score_label}</div>
              <button
                type="button"
                className={s.analyzeAgainBtn}
                onClick={() => setAnalyzeResult(null)}
              >
                Analyze Another
              </button>
            </div>
          ) : (
            <div className={s.analyzeForm}>
              <div className={s.analyzeRow}>
                <select
                  value={analyzeSport}
                  onChange={(e) => setAnalyzeSport(e.target.value)}
                  className={s.analyzeSelect}
                >
                  <option value="baseball">Baseball</option>
                  <option value="softball">Softball</option>
                </select>
                <select
                  value={analyzeAge}
                  onChange={(e) => setAnalyzeAge(e.target.value)}
                  className={s.analyzeSelect}
                >
                  {["8U","9U","10U","11U","12U","13U","14U","15U","16U","17U","18U","College/Adult"].map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>

              <input
                ref={fileRef}
                type="file"
                accept="video/*"
                onChange={(e) => setAnalyzeFile(e.target.files?.[0] || null)}
                style={{ display: "none" }}
              />

              <button
                type="button"
                className={s.analyzeUploadBtn}
                onClick={() => fileRef.current?.click()}
              >
                {analyzeFile ? `✅ ${analyzeFile.name.slice(0, 25)}` : "🎥 Tap to upload pitching video"}
              </button>

              <button
                className={s.analyzeSubmitBtn}
                onClick={analyzeSwing}
                disabled={!analyzeFile || analyzing}
              >
                {analyzing ? "Analyzing..." : "Get Score →"}
              </button>
            </div>
          )}
        </div>

        {/* Swing history — most recent 10 */}
        {swings.length > 1 && (
          <div className={s.historySection}>
            <div className={s.historyHeader}>
              <div className={s.historyTitle}>Recent Pitches</div>
              <div className={s.historyCount}>{swings.length} total</div>
            </div>
            {swings.slice(0, 10).map((sw) => (
              <div key={sw.swing_id} className={s.historyRow}>
                <div className={s.historyScore} data-level={
                  sw.score >= 85 ? "green" : sw.score >= 70 ? "amber" : "red"
                }>
                  {sw.score}
                </div>
                <div className={s.historyInfo}>
                  <div className={s.historyLabel}>{sw.score_label}</div>
                  <div className={s.historyMeta}>
                    {sw.sport} · {sw.age_group || "—"} ·{" "}
                    {new Date(sw.created_at).toLocaleDateString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Leaderboard */}
        {swings.length > 0 && <Leaderboard />}

        {/* Empty state */}
        {swings.length === 0 && (
          <div className={s.empty}>
            <div className={s.emptyTitle}>No pitches yet</div>
            <div className={s.emptySub}>
              Upload your first swing to start tracking your progress.
            </div>
            <a href="/" className={s.analyzeBtn}>
              Analyze Your First Pitch →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
