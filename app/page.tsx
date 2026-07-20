"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Result } from "./types";
import { extractFrames } from "./lib/extract-frames";
import { easeOutCubic, clamp, money } from "./lib/utils";
import { normalizeBreakdown, weakestMetric, METRIC_ORDER, pickPitchingLabels } from "./lib/score";
import s from "./page.module.css";

// ArmIQ landing page — copper/leather design system ported from batiq on
// 2026-05-07 to match BatIQ's visual treatment. Pitching content + 5
// pitching metrics (balance/stride/arm_path/release/finish) replace the
// hitting equivalents. Sport selection (baseball vs softball) drives the
// label resolver in pickPitchingLabels — softball pitchers see Circle/Snap
// where baseball sees Arm Path/Release.

type UtmMap = Record<string, string>;

function trackPixel(
  eventName: string,
  data: Record<string, any> = {},
  email?: string,
  landingPage?: string
) {
  // Dual-fire: Meta Pixel client-side + /api/pixel-event for our DynamoDB
  // audit trail (powers the /admin funnel cards). Same pattern as the
  // variant pages (bbv1p1c etc.) — the pixel-event route stamps
  // product:"armiq" so the shared PixelEvents table can serve both apps
  // without crossing wires.
  if (typeof window !== "undefined" && (window as any).fbq) {
    (window as any).fbq("track", eventName, data);
  }
  fetch("/api/pixel-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event_name: eventName,
      email: email || undefined,
      value: data.value || 0,
      currency: data.currency || "USD",
      content_name: data.content_name || undefined,
      landing_page:
        landingPage || (typeof window !== "undefined" ? window.location.pathname : "/"),
      source: "client",
    }),
  }).catch(() => {});
}

// Same-email + same-video → identical score. Hashes a stable slice of each
// frame's base64 (chars 100-5000 dodges the data-url header collision risk
// flagged in batiq commit aa7207d4). /api/analyze caches by (email, frame_hash)
// filtered to source="armiq", so re-uploads return the cached row instead of
// re-running the model — fixes "I uploaded the same video and got a different
// score" complaints. SHA-256 via SubtleCrypto, hex-encoded.
async function hashFrames(frames: string[]): Promise<string> {
  const sample = frames.map((f) => f.slice(100, 5000)).join("|");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sample));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Score tier colors aligned with the copper/leather palette so the score
// reveal sits inside the page instead of clashing with the parchment fixes
// section. Same thresholds as batiq.
function scoreTone(score: number): { fill: string; label: string } {
  if (score >= 85) return { fill: "#22c55e", label: "elite" };
  if (score >= 70) return { fill: "#10b981", label: "fixable" };
  return { fill: "#ef4444", label: "needs work" };
}

export default function Page() {
  const [email, setEmail] = useState("");
  const [sport, setSport] = useState<"baseball" | "softball">("baseball");
  const [ageGroup, setAgeGroup] = useState("12U");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [pitchId, setPitchId] = useState<string>("");
  const [analysisSaved, setAnalysisSaved] = useState(false);
  const [animatedScore, setAnimatedScore] = useState<number>(0);

  const [progress, setProgress] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  const progressTimer = useRef<number | null>(null);
  const steps = useMemo(
    () => ["Reading frames", "Measuring mechanics", "Writing your breakdown"],
    []
  );

  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const formRef = useRef<HTMLDivElement | null>(null);
  const offersRef = useRef<HTMLDivElement | null>(null);

  const [showRateLimit, setShowRateLimit] = useState(false);
  const [showSubWelcome, setShowSubWelcome] = useState(false);
  const [subLinkSent, setSubLinkSent] = useState(false);
  const [showFloatingCta, setShowFloatingCta] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  const [landingPage, setLandingPage] = useState("");
  const [utmData, setUtmData] = useState<UtmMap>({});
  const [fbp, setFbp] = useState("");
  const [fbc, setFbc] = useState("");

  // External Lambda that persists analyses to SwingAnalyses (shared with
  // batiq — same store-analysis endpoint, source field disambiguates rows).
  const STORE_ANALYSIS_URL =
    "https://8156f6tuae.execute-api.us-east-2.amazonaws.com/live/store-analysis";

  // ---- demo mode ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);

    if (params.get("demo") === "true") {
      setResult({
        score: 87,
        score_label: "Strong delivery — one fixable mechanical leak",
        breakdown: { balance: 84, stride: 88, arm_path: 91, release: 86, finish: 85 },
        top3: [
          "Glove side flies open early — leaks energy off plane",
          "Stride lands short — limits hip-shoulder separation",
          "Release point drifts up — costs command at the knees",
        ],
        impact_line: "Mechanical inefficiency capping velo and command consistency.",
        uplift_line: "Fixing these could add 2–4 mph and tighten command by half a zone.",
        sport: "baseball",
      });
      setPitchId("demo");
      setAnalysisSaved(true);
      window.history.replaceState({}, "", "/");
    }
  }, []);

  // ---- post-purchase redirect handling ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);

    if (params.get("purchased") === "true") {
      setShowSubWelcome(true);
      const planDays = params.get("plan_days") || "30";
      const prices: Record<string, number> = { "7": 14.99, "14": 29.99, "30": 59.99 };
      trackPixel(
        "Purchase",
        {
          currency: "USD",
          value: prices[planDays] || 14.99,
          content_name: `${planDays}-day plan`,
        },
        params.get("email") || email || undefined,
        landingPage
      );
      const subEmail = params.get("email") || email;
      if (subEmail) {
        fetch("/api/auth/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: subEmail }),
        })
          .then(() => setSubLinkSent(true))
          .catch(() => {});
      }
      window.history.replaceState({}, "", "/");
    }

    if (params.get("subscribed") === "true") {
      setShowSubWelcome(true);
      trackPixel(
        "Purchase",
        {
          currency: "USD",
          value: 19.99,
          content_name: "ArmIQ Pro subscription",
        },
        params.get("email") || email || undefined,
        landingPage
      );
      const subEmail = params.get("email");
      if (subEmail) {
        fetch("/api/auth/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: subEmail }),
        })
          .then(() => setSubLinkSent(true))
          .catch(() => {});
      }
      window.history.replaceState({}, "", "/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- mobile detect ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 520px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // ---- UTM / cookie capture ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const utmObj: UtmMap = {};
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "via"]) {
      const v = params.get(k);
      if (v) utmObj[k] = v;
    }
    setUtmData(utmObj);
    setLandingPage(window.location.pathname);

    const cookies = document.cookie.split(";").reduce((acc, c) => {
      const [k, v] = c.trim().split("=");
      if (k && v) acc[k] = v;
      return acc;
    }, {} as Record<string, string>);
    if (cookies._fbp) setFbp(cookies._fbp);
    if (cookies._fbc) {
      setFbc(cookies._fbc);
    } else {
      const fbclid = params.get("fbclid");
      if (fbclid) setFbc(`fb.1.${Date.now()}.${fbclid}`);
    }

    // Log PageView to DynamoDB so /admin can chart the funnel from this
    // page. fbq's own PageView already fires from app/layout.tsx for Meta.
    fetch("/api/pixel-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_name: "PageView",
        landing_page: window.location.pathname,
        source: "client",
      }),
    }).catch(() => {});
  }, []);

  // ---- thumbnail from selected file ----
  useEffect(() => {
    if (!file) {
      setThumbnailUrl(null);
      return;
    }
    let revoked = false;
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";

    const cleanup = () => {
      if (!revoked) {
        revoked = true;
        URL.revokeObjectURL(url);
      }
    };

    const capture = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 720;
        canvas.height = 400;
        const ctx = canvas.getContext("2d");
        if (ctx && video.videoWidth > 0) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          setThumbnailUrl(canvas.toDataURL("image/jpeg", 0.8));
        }
      } catch (_) {}
      cleanup();
    };

    video.onloadedmetadata = () => {
      video.currentTime = Math.min((video.duration || 2) * 0.3, (video.duration || 2) - 0.1);
    };
    video.onseeked = capture;

    const fallbackTimer = setTimeout(() => {
      if (!thumbnailUrl && video.readyState >= 2) capture();
    }, 3000);

    video.onerror = cleanup;

    return () => {
      clearTimeout(fallbackTimer);
      cleanup();
    };
  }, [file]);

  function startProgress() {
    setProgress(0);
    setStepIdx(0);
    if (progressTimer.current) window.clearInterval(progressTimer.current);
    progressTimer.current = window.setInterval(() => {
      setProgress((p) => {
        const next = p + (p < 60 ? 4 : p < 85 ? 2 : 0.6);
        return Math.min(92, next);
      });
    }, 120);
    window.setTimeout(() => setStepIdx(1), 800);
    window.setTimeout(() => setStepIdx(2), 1700);
  }
  function finishProgress() {
    if (progressTimer.current) window.clearInterval(progressTimer.current);
    progressTimer.current = null;
    setProgress(100);
  }

  function startOver() {
    setResult(null);
    setPitchId("");
    setAnalysisSaved(false);
    setAnimatedScore(0);
    setFile(null);
    setThumbnailUrl(null);
    setProgress(0);
    setStepIdx(0);
  }

  async function analyze() {
    if (!email.includes("@")) return alert("Enter a valid email.");
    if (!file) return alert("Upload a pitching video.");

    setLoading(true);
    setResult(null);
    setAnimatedScore(0);
    setAnalysisSaved(false);
    startProgress();

    try {
      // 8 frames clustered around release for pitching (vs 4 for swings) —
      // pitching delivery has more discrete phases that need coverage.
      const frames = await extractFrames(file, 8);
      if (!thumbnailUrl && frames[0]) setThumbnailUrl(frames[0]);
      const frameHash = await hashFrames(frames);

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          sport,
          age_group: ageGroup,
          frames,
          frame_hash: frameHash,
          landing_page: landingPage,
          utm: utmData,
          fbp,
          fbc,
        }),
      });

      if (!res.ok) {
        if (res.status === 429) {
          finishProgress();
          setShowRateLimit(true);
          return;
        }
        throw new Error(await res.text());
      }

      const data = (await res.json()) as Result;
      finishProgress();
      const newPitchId = crypto.randomUUID();
      setPitchId(newPitchId);
      setResult({ ...data, sport });

      trackPixel(
        "Lead",
        {
          content_name: "Pitch Score",
          content_category: sport,
          value: data.score,
        },
        email,
        landingPage
      );

      const storeRes = await fetch(STORE_ANALYSIS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          swing_id: newPitchId,
          email,
          sport,
          age_group: ageGroup,
          frame_hash: frameHash,
          analysis: data,
          landing_page: landingPage,
          utm: utmData,
          source: "armiq",
        }),
      });
      if (!storeRes.ok) throw new Error("StoreAnalysis failed");
      setAnalysisSaved(true);
    } catch (err: any) {
      if (progressTimer.current) window.clearInterval(progressTimer.current);
      progressTimer.current = null;
      setProgress(0);
      alert(err?.message || "Something failed.");
    } finally {
      setLoading(false);
    }
  }

  async function buyPlan(planDays: number, price: number, label: string) {
    if (!email.includes("@")) return alert("Enter a valid email first.");
    if (!pitchId) return alert("Run a pitch analysis first.");
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          plan_days: planDays,
          swing_id: pitchId,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { url } = await res.json();
      trackPixel(
        "InitiateCheckout",
        { content_name: label, currency: "USD", value: price },
        email,
        landingPage
      );
      window.location.href = url;
    } catch (err: any) {
      alert(err?.message || "Something went wrong.");
    }
  }

  async function handleSubscribe() {
    if (!email.includes("@")) return alert("Enter a valid email first.");
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, fbp, fbc, utm: utmData, landing_page: landingPage }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { url } = await res.json();
      trackPixel(
        "InitiateCheckout",
        { content_name: "ArmIQ Pro Monthly", currency: "USD", value: 19.99 },
        email,
        landingPage
      );
      window.location.href = url;
    } catch (err: any) {
      alert(err?.message || "Something went wrong.");
    }
  }

  useEffect(() => {
    if (!result) return;
    const target = clamp(Math.round(result.score), 0, 100);
    const durationMs = 650;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      const eased = easeOutCubic(t);
      setAnimatedScore(Math.round(eased * target));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [result]);

  useEffect(() => {
    if (!result) return;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [result]);

  useEffect(() => {
    if (!result || !isMobile) {
      setShowFloatingCta(false);
      return;
    }
    const el = offersRef.current;
    if (!el) {
      setShowFloatingCta(true);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => setShowFloatingCta(!entry.isIntersecting),
      { threshold: 0.1 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [result, isMobile]);

  function scrollToForm() {
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function scrollToOffers() {
    offersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const percentileLine = useMemo(() => {
    if (!result) return "";
    const pct = Math.max(1, Math.min(99, Math.round(result.score)));
    const bd = normalizeBreakdown(result.breakdown);
    const weakestKey = weakestMetric(bd);
    const labels = pickPitchingLabels(result.sport ?? sport);
    const weakest = labels[weakestKey].toLowerCase();
    if (result.score >= 85) return "Top 10% — elite mechanics";
    if (result.score >= 75) return `Top ${100 - pct}% — strong delivery, one fixable gap`;
    if (result.score >= 65) return `${pct}th percentile — ${weakest} is the lever`;
    return `Below average — ${weakest} is where the work starts`;
  }, [result, sport]);

  const tone = result ? scoreTone(result.score) : null;
  const offersEnabled = analysisSaved && !!pitchId;

  // Hero example uses currently-selected sport so toggling baseball/softball
  // before scrolling down updates the example labels live.
  const heroLabels = pickPitchingLabels(sport);
  const heroSampleBars: Array<[string, number]> = [
    [heroLabels.balance, 84],
    [heroLabels.stride, 88],
    [heroLabels.arm_path, 91],
    [heroLabels.release, 86],
    [heroLabels.finish, 85],
  ];

  return (
    <main className={s.page}>
      {!result && (
      <section className={s.hero}>
        <a href="/dashboard" className={s.heroSignIn}>
          Sign in →
        </a>
        <div className={s.heroInner}>
          <div className={s.heroLeft}>
            <div className={s.kicker}>AI pitch analysis · Baseball + Softball</div>
            <h1 className={s.heroHeadline}>
              Find the <em>leak.</em>
              <br />
              Fix the <em>delivery.</em>
            </h1>
            <p className={s.heroSub}>
              Upload one pitch. We return a precise score, your three biggest
              mechanical leaks, and a drill plan built from your frames. Most
              pitchers feel it in the first session.
            </p>
            <div className={s.heroMicro}>
              <span>Built for baseball + softball</span>
              <span className={s.dot} aria-hidden>•</span>
              <span>no signup</span>
              <span className={s.dot} aria-hidden>•</span>
              <span>under a minute</span>
            </div>
            <div className={s.heroCtaRow}>
              <button type="button" className={s.heroCta} onClick={scrollToForm}>
                Score my pitch — free <span aria-hidden>→</span>
              </button>
            </div>
          </div>
          <aside className={s.heroSample} aria-label="Example pitch score">
            <div className={s.sampleKicker}>Example result</div>
            <div className={s.sampleScoreRow}>
              <div className={s.sampleScoreNum}>87</div>
              <div className={s.sampleScoreMeta}>
                <div className={s.sampleOutOf}>out of 100</div>
                <div className={s.sampleTier}>Top 13% · strong mechanics</div>
              </div>
            </div>
            <div className={s.sampleBars}>
              {heroSampleBars.map(([label, value]) => (
                <div key={label} className={s.sampleBar}>
                  <div className={s.sampleBarHead}>
                    <span className={s.sampleBarLabel}>{label}</span>
                    <span className={s.sampleBarValue}>{value}</span>
                  </div>
                  <div className={s.sampleBarTrack}>
                    <div
                      className={s.sampleBarFill}
                      style={{ width: `${value}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className={s.sampleFixes}>
              <div className={s.sampleFixesLabel}>Top 3 fixes</div>
              <ol className={s.sampleFixList}>
                <li>Glove side flies open early — leaks energy off plane</li>
                <li>Stride lands short — limits hip-shoulder separation</li>
                <li>Release point drifts up — costs command at the knees</li>
              </ol>
            </div>
          </aside>
        </div>
        <div className={s.heroGrain} aria-hidden />
      </section>
      )}

      {loading ? (
        <section className={s.loadingSection}>
          <div className={s.loadingInner}>
            <div className={s.loadingLabel}>{steps[stepIdx]}</div>
            <div className={s.loadingBar}>
              <div className={s.loadingFill} style={{ width: `${progress}%` }} />
            </div>
            <div className={s.loadingHint}>
              Don&apos;t close this tab. Results land in ~20 seconds.
            </div>
          </div>
        </section>
      ) : !result ? (
        <section ref={formRef} className={s.formSection}>
          <div className={s.formInner}>
            <div className={s.sectionKicker}>Step one</div>
            <h2 className={s.sectionHead}>One pitch. Three fixes. A plan.</h2>
            <p className={s.sectionSub}>
              Film side-on. Full body in frame. One clean delivery, under ten seconds.
            </p>

            <div className={s.formGrid}>
              <label className={s.field}>
                <span className={s.fieldLabel}>Email</span>
                <input
                  type="email"
                  className={s.input}
                  placeholder="where should we send it?"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>

              <div className={s.fieldRow}>
                <div className={s.field}>
                  <span className={s.fieldLabel}>Sport</span>
                  <div className={s.pillGroup} role="tablist" aria-label="Sport">
                    {(["baseball", "softball"] as const).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        role="tab"
                        aria-selected={sport === opt}
                        className={`${s.pill} ${sport === opt ? s.pillActive : ""}`}
                        onClick={() => setSport(opt)}
                      >
                        {opt === "baseball" ? "Baseball" : "Softball"}
                      </button>
                    ))}
                  </div>
                </div>

                <label className={s.field}>
                  <span className={s.fieldLabel}>Age group</span>
                  <select
                    className={s.select}
                    value={ageGroup}
                    onChange={(e) => setAgeGroup(e.target.value)}
                  >
                    {[
                      "8U",
                      "9U",
                      "10U",
                      "11U",
                      "12U",
                      "13U",
                      "14U",
                      "15U",
                      "16U",
                      "17U",
                      "18U",
                      "College/Adult",
                    ].map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className={s.field}>
                <span className={s.fieldLabel}>Your pitching video</span>
                <div className={s.reqGrid}>
                  <div className={s.reqCard}>
                    <div className={s.reqIcon} aria-hidden>📐</div>
                    <div className={s.reqTitle}>Side angle</div>
                    <div className={s.reqBody}>
                      Camera perpendicular to the rubber, glove side or arm side
                    </div>
                  </div>
                  <div className={s.reqCard}>
                    <div className={s.reqIcon} aria-hidden>🧍</div>
                    <div className={s.reqTitle}>Full body</div>
                    <div className={s.reqBody}>
                      Feet to head in frame all the way through release
                    </div>
                  </div>
                  <div className={s.reqCard}>
                    <div className={s.reqIcon} aria-hidden>1️⃣</div>
                    <div className={s.reqTitle}>One pitch</div>
                    <div className={s.reqBody}>
                      Under 10 seconds, one take, no cuts
                    </div>
                  </div>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  style={{ display: "none" }}
                />

                <button
                  type="button"
                  className={s.uploadBtn}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {thumbnailUrl ? (
                    <>
                      <img src={thumbnailUrl} alt="" className={s.uploadThumb} />
                      <span>Change video</span>
                    </>
                  ) : (
                    <span>🎥 Upload pitching video</span>
                  )}
                </button>
              </div>

              <button
                type="button"
                className={s.submit}
                onClick={analyze}
                disabled={loading}
              >
                {loading ? "Reading your delivery…" : "Score my pitch →"}
              </button>

              <div className={s.disclaimer}>
                No signup. No spam. Your video is used only to generate your analysis.
              </div>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section className={s.scoreSection}>
            <div className={s.scoreInner}>
              <div className={s.sectionKicker}>Your pitch score</div>
              <div className={s.scoreFace}>
                <div
                  className={s.scoreNumber}
                  style={{ color: tone?.fill }}
                >
                  {animatedScore}
                </div>
                <div className={s.scoreOutOf}>out of 100</div>
              </div>
              <div className={s.scoreTier}>{result.score_label}</div>

              <div className={s.percentileBar}>
                <div className={s.percentileTrack}>
                  <div
                    className={s.percentileMarker}
                    style={{
                      left: `${clamp(result.score, 0, 100)}%`,
                      background: tone?.fill,
                    }}
                  />
                </div>
                <div className={s.percentileLabel}>{percentileLine}</div>
              </div>

              <div className={s.insight}>
                <div className={s.insightLabel}>Coach&apos;s read</div>
                <div className={s.insightBody}>{result.impact_line}</div>
              </div>

              <div className={s.breakdown}>
                {(() => {
                  const bd = normalizeBreakdown(result.breakdown);
                  const labels = pickPitchingLabels(result.sport ?? sport);
                  return METRIC_ORDER.map((key) => {
                    const value = bd[key];
                    return (
                      <div key={key} className={s.bar}>
                        <div className={s.barHead}>
                          <span className={s.barLabel}>{labels[key]}</span>
                          <span className={s.barValue}>{value}</span>
                        </div>
                        <div className={s.barTrack}>
                          <div
                            className={s.barFill}
                            style={{
                              width: `${clamp(value, 0, 100)}%`,
                              background: "var(--copper-dark)",
                            }}
                          />
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          </section>

          <section className={s.fixesSection}>
            <div className={s.fixesInner}>
              <div className={s.sectionKicker}>Your top 3 fixes</div>
              <h2 className={s.sectionHead}>What&apos;s costing you velo &amp; command</h2>
              <p className={s.sectionSub}>
                Three leaks, ranked by impact. Fix these and the score moves.
              </p>

              <ol className={s.fixList}>
                {result.top3.slice(0, 3).map((fix, i) => (
                  <li key={i} className={s.fixItem}>
                    <div className={s.fixNum}>{i + 1}</div>
                    <div className={s.fixText}>{fix}</div>
                  </li>
                ))}
              </ol>

              <div className={s.uplift}>
                <div className={s.upliftLabel}>Estimated uplift</div>
                <div className={s.upliftBody}>{result.uplift_line}</div>
              </div>
            </div>
          </section>

          <section className={s.bridgeSection}>
            <div className={s.bridgeInner}>
              <h2 className={s.bridgeHead}>
                Now fix it. <em>Built from your frames, not YouTube.</em>
              </h2>
              <p className={s.bridgeBody}>
                Every drill, rep count, and coaching cue is chosen from your
                delivery&apos;s specific leaks. No generic drills. Delivered to your
                email in minutes.
              </p>
            </div>
          </section>

          <section ref={offersRef} className={s.plansSection}>
            <div className={s.plansInner}>
              <div className={s.planGrid}>
                <PlanCard
                  tier="7-Day Quick Fix"
                  tagline="Prove it works"
                  price={14.99}
                  sub="The fastest way to feel a difference"
                  features={[
                    "Your #1 leak, targeted",
                    "3 drills/day + arm care, coaching cues, rep counts",
                    "Pitcher dashboard for 7 days",
                  ]}
                  ctaText="Start 7-day fix"
                  subCta="Money-back if you don't feel a difference"
                  enabled={offersEnabled}
                  onClick={() => buyPlan(7, 14.99, "7-Day Quick Fix")}
                />
                <PlanCard
                  tier="14-Day Fix"
                  badge="Most chosen"
                  tagline="Fix all three leaks"
                  price={29.99}
                  sub="Build the fix, then lock it in"
                  features={[
                    "All 3 leaks, week 1 isolation → week 2 sequencing",
                    "3 drills/day with arm care, cues, progression reps",
                    "Weekly progression plan built from your frames",
                    "Pitcher dashboard + score tracking",
                  ]}
                  ctaText="Start 14-day fix"
                  subCta="Money-back guarantee"
                  enabled={offersEnabled}
                  featured
                  onClick={() => buyPlan(14, 29.99, "14-Day Fix")}
                />
              </div>

              <div className={s.proDivider}>
                <span>or go unlimited</span>
              </div>

              <div className={s.proCard}>
                <div className={s.proLeft}>
                  <div className={s.proBadge}>For serious pitchers</div>
                  <div className={s.proName}>ArmIQ Pro</div>
                  <div className={s.proPrice}>
                    <span className={s.proPriceNum}>$19.99</span>
                    <span className={s.proPriceUnit}>/month</span>
                  </div>
                  <div className={s.proTagline}>Never stop training</div>
                  <p className={s.proSub}>
                    Unlimited pitches. New plan every month. AI coach on demand.
                  </p>
                </div>
                <ul className={s.proFeatures}>
                  <li>Unlimited pitch analyses</li>
                  <li>New custom plan every month</li>
                  <li>Score tracking + progress chart</li>
                  <li>AI coach chat — ask anything, any time</li>
                  <li>Age-group leaderboard</li>
                  <li>Cancel in one click, no contract</li>
                </ul>
                <button
                  type="button"
                  className={s.proCta}
                  onClick={handleSubscribe}
                  disabled={!email.includes("@")}
                >
                  Start ArmIQ Pro →
                </button>
                <div className={s.proSubCta}>Cancel any time. No questions.</div>
              </div>
            </div>
          </section>

          <section className={s.proofSection}>
            <div className={s.proofInner}>
              <div className={s.sectionKicker}>Why it works</div>
              <h2 className={s.sectionHead}>
                Built from real pitching frames, not stock drills.
              </h2>

              <div className={s.proofGrid}>
                <figure className={s.quoteCard}>
                  <blockquote className={s.quote}>
                    &ldquo;The three fixes were the same things his pitching
                    coach had been saying for months — he didn&apos;t buy in until
                    he saw the score. Velo up 4 mph in six weeks and his
                    command finally caught up.&rdquo;
                  </blockquote>
                  <figcaption className={s.quoteAttr}>
                    <span>Mike D. · dad of a 13U RHP</span>
                    <span className={s.quoteRole}>Frisco, TX</span>
                  </figcaption>
                </figure>

                <figure className={s.quoteCard}>
                  <blockquote className={s.quote}>
                    &ldquo;I don&apos;t hand my guys anything an AI made. This one&apos;s
                    the exception. Arm-path read is accurate and the drill
                    progression isn&apos;t dumb — matches what I&apos;d program.
                    Using it between bullpens.&rdquo;
                  </blockquote>
                  <figcaption className={s.quoteAttr}>
                    <span>Coach Ramirez · 12U travel</span>
                    <span className={s.quoteRole}>Houston area</span>
                  </figcaption>
                </figure>

                <figure className={s.statCard}>
                  <div className={s.statNumber}>+9</div>
                  <div className={s.statUnit}>points</div>
                  <div className={s.statBody}>
                    Average score jump from first to fifth analyzed pitch.
                  </div>
                </figure>
              </div>
            </div>
          </section>

          <section className={s.trustSection}>
            <div className={s.trustInner}>
              {[
                { label: "Secure checkout", body: "Stripe + SSL" },
                { label: "Plan in minutes", body: "Not days" },
                { label: "Built from your frames", body: "Not stock drills" },
                { label: "Money-back, no questions", body: "Email and we refund" },
              ].map((t) => (
                <div key={t.label} className={s.trustItem}>
                  <div className={s.trustLabel}>{t.label}</div>
                  <div className={s.trustBody}>{t.body}</div>
                </div>
              ))}
            </div>
          </section>

          <section className={s.guaranteeSection}>
            <div className={s.guaranteeInner}>
              <h2 className={s.guaranteeHead}>100% money-back guarantee.</h2>
              <p className={s.guaranteeBody}>
                If you don&apos;t feel a difference after your plan, email us. We
                refund you. No questions, no forms, no hoops.
              </p>
            </div>
          </section>

          <section className={s.faqSection}>
            <div className={s.faqInner}>
              <div className={s.sectionKicker}>FAQ</div>
              <h2 className={s.sectionHead}>Common questions</h2>

              <div className={s.faqList}>
                <FaqItem
                  q="What do I get with the free score?"
                  a="A real score, your top 3 mechanical leaks, and an estimated uplift — all from one pitch. No signup. We email you the results."
                />
                <FaqItem
                  q="How is this different from YouTube drills?"
                  a="Every drill on your plan is chosen from your delivery's breakdown. An arm-path score of 71 gets different drills than 82. Generic coaching ignores the leaks. We don't."
                />
                <FaqItem
                  q="How fast will I see results?"
                  a="Most pitchers feel a difference in the first 1–2 sessions. The plan builds: isolation first, then sequencing, then bullpen-speed. Nothing is random."
                />
                <FaqItem
                  q="When do I get the plan?"
                  a="Within minutes of purchase. It appears in your pitcher dashboard and a PDF lands in your inbox."
                />
              </div>
            </div>
          </section>

          <div className={s.startOverWrap}>
            <button type="button" className={s.startOver} onClick={startOver}>
              Analyze another pitch
            </button>
          </div>
        </>
      )}

      <footer className={s.footer}>
        <div className={s.footerInner}>
          <div className={s.footerLinks}>
            <a href="/dashboard">Sign in</a>
            <span className={s.dot} aria-hidden>•</span>
            <a href="/terms">Terms</a>
            <span className={s.dot} aria-hidden>•</span>
            <a href="/privacy">Privacy</a>
            <span className={s.dot} aria-hidden>•</span>
            <a href="/contact">Contact</a>
          </div>
          <div className={s.footerCross}>
            Also a hitter?{" "}
            <a href="https://batiq.ai" target="_blank" rel="noopener">
              BatIQ.ai →
            </a>
          </div>
          <div className={s.footerCopy}>© 2026 ArmIQ AI · Powered by HIT24</div>
        </div>
      </footer>

      {showFloatingCta && (
        <button type="button" className={s.floatingCta} onClick={scrollToOffers}>
          See your plan →
        </button>
      )}

      {showSubWelcome && (
        <div className={s.modalBackdrop} role="dialog" aria-modal="true">
          <div className={s.modalCard}>
            <h3 className={s.modalHead}>You&apos;re in.</h3>
            <p className={s.modalBody}>
              {subLinkSent
                ? "Check your inbox — we just sent a sign-in link to access your dashboard and your custom plan."
                : "Your plan is being built. Head to your dashboard to view it, track your score, and chat with your AI coach."}
            </p>
            {subLinkSent && (
              <div className={s.modalInfo}>
                📧 Sign-in link sent — check your email
              </div>
            )}
            <div className={s.modalActions}>
              {!subLinkSent && (
                <a href="/dashboard" className={s.modalPrimary}>
                  Go to dashboard →
                </a>
              )}
              <button
                type="button"
                className={s.modalSecondary}
                onClick={() => setShowSubWelcome(false)}
              >
                {subLinkSent ? "Close" : "Stay on this page"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showRateLimit && (
        <div className={s.modalBackdrop} role="dialog" aria-modal="true">
          <div className={s.modalCard}>
            <div className={s.modalIcon} aria-hidden>⚡</div>
            <h3 className={s.modalHead}>You&apos;ve used your 2 free scores today</h3>
            <p className={s.modalBody}>
              Upgrade to ArmIQ Pro for unlimited pitches, monthly plans, and
              the AI coach.
            </p>
            <div className={s.modalActions}>
              <button
                type="button"
                className={s.modalPrimary}
                onClick={() => {
                  setShowRateLimit(false);
                  handleSubscribe();
                }}
              >
                Start Pro →
              </button>
              <button
                type="button"
                className={s.modalSecondary}
                onClick={() => setShowRateLimit(false)}
              >
                Maybe tomorrow
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

type PlanCardProps = {
  tier: string;
  tagline: string;
  sub: string;
  price: number;
  strikePrice?: number;
  features: string[];
  ctaText: string;
  subCta: string;
  badge?: string;
  featured?: boolean;
  enabled: boolean;
  onClick: () => void;
};

function PlanCard({
  tier,
  tagline,
  sub,
  price,
  strikePrice,
  features,
  ctaText,
  subCta,
  badge,
  featured,
  enabled,
  onClick,
}: PlanCardProps) {
  return (
    <div className={`${s.planCard} ${featured ? s.planCardFeatured : ""}`}>
      {badge && <div className={s.planBadge}>{badge}</div>}
      <div className={s.planTier}>{tier}</div>
      <div className={s.planTagline}>{tagline}</div>
      <div className={s.planPriceRow}>
        <span className={s.planPrice}>{money(price)}</span>
        {strikePrice && <span className={s.planStrike}>{money(strikePrice)}</span>}
      </div>
      <div className={s.planSub}>{sub}</div>
      <ul className={s.planFeatures}>
        {features.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
      <button
        type="button"
        className={s.planCta}
        disabled={!enabled}
        onClick={onClick}
      >
        {enabled ? `${ctaText} →` : "Run analysis first"}
      </button>
      <div className={s.planSubCta}>{subCta}</div>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`${s.faqItem} ${open ? s.faqItemOpen : ""}`}>
      <button
        type="button"
        className={s.faqQ}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{q}</span>
        <span className={s.faqChev} aria-hidden>
          {open ? "–" : "+"}
        </span>
      </button>
      {open && <div className={s.faqA}>{a}</div>}
    </div>
  );
}
