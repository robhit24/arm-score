"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Result } from "../types";
import { extractFrames } from "../lib/extract-frames";
import { easeOutCubic, clamp, money } from "../lib/utils";
import { normalizeBreakdown, weakestMetric, METRIC_ORDER, pickPitchingLabels } from "../lib/score";
import s from "./page.module.css";

// /bbv1p2c — Copper/Leather redesign. Scope: landing page only. See
// docs/bbv1p2c-copy-deck.md for the copy source of truth and
// docs/decisions.md (2026-04-21) for the design-direction rationale.
// Every state/effect/handler below mirrors app/page.tsx on purpose — the
// page's behavior must be identical to / so Meta attribution, Stripe
// metadata, rate-limiting, and post-purchase flows keep working. Only the
// presentation layer changes.

type UtmMap = Record<string, string>;

function trackPixel(
  eventName: string,
  data: Record<string, any> = {},
  email?: string,
  landingPage?: string
) {
  // Dual-fire: Meta Pixel for CAPI + /api/pixel-event for our DynamoDB
  // audit trail. See docs/decisions.md — "Pixel Event Dual-Logging".
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
        landingPage || (typeof window !== "undefined" ? window.location.pathname : "/bbv1p2c"),
      source: "client",
    }),
  }).catch(() => {});
}

// Same-email + same-video → identical score. Hashes a stable slice of each
// frame's base64 (chars 100-5000 dodges the data-url header collision risk
// flagged in batiq commit aa7207d4). /api/analyze caches by (email, frame_hash)
// filtered to source="armiq", so re-uploads return the cached row instead of
// re-running the model. SHA-256 via SubtleCrypto, hex-encoded.
async function hashFrames(frames: string[]): Promise<string> {
  const sample = frames.map((f) => f.slice(100, 5000)).join("|");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sample));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Warmer score tier colors that sit inside the copper/leather palette
// instead of the bright alarm-red/amber/green on /. Visually coherent
// with the rest of the page — the old palette looks garish on parchment.
function scoreTone(score: number): { fill: string; label: string } {
  if (score >= 85) return { fill: "#22c55e", label: "elite" };
  if (score >= 70) return { fill: "#10b981", label: "fixable" };
  return { fill: "#ef4444", label: "needs work" };
}

export default function Page() {
  // ---- form state ----
  const [email, setEmail] = useState("");
  const [sport, setSport] = useState<"baseball" | "softball">("baseball");
  const [ageGroup, setAgeGroup] = useState("12U");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [pitchId, setPitchId] = useState<string>("");
  const [analysisSaved, setAnalysisSaved] = useState(false);
  const [animatedScore, setAnimatedScore] = useState<number>(0);

  // ---- progress / step state ----
  const [progress, setProgress] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  const progressTimer = useRef<number | null>(null);
  const steps = useMemo(
    () => ["Reading frames", "Measuring mechanics", "Writing your breakdown"],
    []
  );

  // ---- media state ----
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---- layout refs ----
  const formRef = useRef<HTMLDivElement | null>(null);
  const offersRef = useRef<HTMLDivElement | null>(null);

  // ---- UI state ----
  const [showRateLimit, setShowRateLimit] = useState(false);
  const [showSubWelcome, setShowSubWelcome] = useState(false);
  const [subLinkSent, setSubLinkSent] = useState(false);
  const [showFloatingCta, setShowFloatingCta] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // ---- attribution state ----
  const [landingPage, setLandingPage] = useState("");
  const [utmData, setUtmData] = useState<UtmMap>({});
  const [fbp, setFbp] = useState("");
  const [fbc, setFbc] = useState("");

  // External Lambda that persists analyses to SwingAnalyses. Hardcoded on /
  // too — see app/page.tsx line 113.
  const STORE_ANALYSIS_URL =
    "https://8156f6tuae.execute-api.us-east-2.amazonaws.com/live/store-analysis";

  // ---- demo mode + saved result load ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);

    if (params.get("demo") === "true") {
      setResult({
        score: 68,
        score_label: "Developing mechanics — fixable arm path leak",
        breakdown: { balance: 72, stride: 75, arm_path: 70, release: 68, finish: 74 },
        top3: [
          "Hands drift forward before hips fire — lost power",
          "Back elbow drops below slot — barrel drags through zone",
          "Front foot lands open — pulls off outside pitch",
        ],
        impact_line: "Mechanical inefficiency limiting velocity and consistency.",
        uplift_line: "Fixing these could add 4–8 mph exit velo and 15–25 feet to hits.",
      });
      setPitchId("demo");
      setAnalysisSaved(true);
      window.history.replaceState({}, "", "/bbv1p2c");
    }

    const resultId = params.get("r");
    if (resultId) {
      (async () => {
        try {
          const res = await fetch(`/api/result?id=${encodeURIComponent(resultId)}`);
          const data = await res.json();
          if (data.found) {
            setResult({
              score: data.score,
              score_label: data.score_label,
              breakdown: data.breakdown,
              top3: data.top3,
              impact_line: data.impact_line,
              uplift_line: data.uplift_line,
            });
            setPitchId(resultId);
            setAnalysisSaved(true);
          }
        } catch {}
      })();
    }
  }, []);

  // ---- post-purchase redirect handling ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const variantCookie = document.cookie
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("_variant="));
    const savedVariant = variantCookie ? variantCookie.split("=")[1] : window.location.pathname;

    if (params.get("purchased") === "true") {
      setShowSubWelcome(true);
      const planDays = params.get("plan_days") || "30";
      const prices: Record<string, number> = { "7": 9.99, "14": 19.99, "30": 59.99 };
      trackPixel(
        "Purchase",
        { currency: "USD", value: prices[planDays] || 9.99, content_name: `${planDays}-day plan` },
        undefined,
        savedVariant
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
      window.history.replaceState({}, "", "/bbv1p2c");
    }

    if (params.get("subscribed") === "true") {
      setShowSubWelcome(true);
      trackPixel(
        "Purchase",
        { currency: "USD", value: 14.99, content_name: "Pro subscription" },
        undefined,
        savedVariant
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
      window.history.replaceState({}, "", "/bbv1p2c");
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

  // ---- UTM / cookie / PageView capture ----
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

  // ---- analyze progress ----
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
    if (!file) return alert("Upload a pitch video.");

    setLoading(true);
    setResult(null);
    setAnimatedScore(0);
    setAnalysisSaved(false);
    startProgress();

    try {
      const frames = await extractFrames(file, 4);
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
      setResult(data);

      trackPixel(
        "Lead",
        { content_name: "Pitch Score", content_category: sport, value: data.score },
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

      // Fire-and-forget results email
      fetch("/api/send-results", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          score: data.score,
          top3: data.top3,
          impact_line: data.impact_line,
          uplift_line: data.uplift_line,
          swing_id: newPitchId,
        }),
      }).catch(() => {});
    } catch (err: any) {
      if (progressTimer.current) window.clearInterval(progressTimer.current);
      progressTimer.current = null;
      setProgress(0);
      alert(err?.message || "Something failed.");
    } finally {
      setLoading(false);
    }
  }

  async function buyTrial() {
    if (!email.includes("@")) return alert("Enter a valid email first.");
    if (!pitchId) return alert("Run a pitch analysis first.");
    try {
      const res = await fetch("/api/checkout-trial", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          swing_id: pitchId,
          fbp,
          fbc,
          utm: utmData,
          landing_page: landingPage,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { url } = await res.json();
      trackPixel(
        "InitiateCheckout",
        { content_name: "7-Day Trial $1.99", currency: "USD", value: 1.99 },
        email,
        landingPage
      );
      window.location.href = url;
    } catch (err: any) {
      alert(err?.message || "Something went wrong.");
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
          fbp,
          fbc,
          utm: utmData,
          landing_page: landingPage,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { url } = await res.json();
      // InitiateCheckout fires AFTER the API returns a URL — see
      // docs/decisions.md (2026-04-06). Firing on click caused a user to
      // spam 101 events on a failing checkout.
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
        body: JSON.stringify({
          email,
          fbp,
          fbc,
          utm: utmData,
          landing_page: landingPage,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { url } = await res.json();
      trackPixel(
        "InitiateCheckout",
        { content_name: "ArmIQ Pro Monthly", currency: "USD", value: 14.99 },
        email,
        landingPage
      );
      window.location.href = url;
    } catch (err: any) {
      alert(err?.message || "Something went wrong.");
    }
  }

  // ---- animated score ----
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

  // ---- scroll to top on new result ----
  useEffect(() => {
    if (!result) return;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [result]);

  // ---- mobile floating CTA when offers out of view ----
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

  // ---- percentile copy from copy deck ----
  const percentileLine = useMemo(() => {
    if (!result) return "";
    const pct = Math.max(1, Math.min(99, Math.round(result.score)));
    const bd = normalizeBreakdown(result.breakdown);
    const weakestKey = weakestMetric(bd);
    const labels = pickPitchingLabels(sport);
    const weakest = labels[weakestKey].toLowerCase();
    if (result.score >= 85) return "Top 10% — elite mechanics";
    if (result.score >= 75) return `Top ${100 - pct}% — strong swing, one fixable gap`;
    if (result.score >= 65) return `${pct}th percentile — ${weakest} is the lever`;
    return `Below average — ${weakest} is where the work starts`;
  }, [result]);

  const tone = result ? scoreTone(result.score) : null;
  const offersEnabled = analysisSaved && !!pitchId;

  // ---- render ----
  return (
    <main className={s.page}>
      {/* HERO is sales material — once the user has their own result, the
          example card is dead weight (and on mobile it pushes the real
          score below the fold after the post-result scrollTo(top)). Hide
          the entire hero block when `result` is set so the score reveal
          becomes the top of the page. */}
      {!result && (
      <section className={s.hero}>
        {/* Top-right sign-in for returning users. Pinned to the hero so it
            disappears with the rest of the sales chrome once a result lands
            — at that point the user is mid-flow on their own data, not
            shopping for a way back to /dashboard. The footer link below
            handles post-result + always-visible access. */}
        <a href="/dashboard" className={s.heroSignIn}>
          Sign in →
        </a>
        <div className={s.heroInner}>
          <div className={s.heroLeft}>
            <div className={s.kicker}>AI pitch analysis · Baseball + Softball</div>
            <h1 className={s.heroHeadline}>
              Find the <em>leak.</em>
              <br />
              Fix the <em>pitch.</em>
            </h1>
            <p className={s.heroSub}>
              Upload one pitch. We return a precise score, your three biggest
              mechanical leaks, and a drill plan built from your frames. Most players
              feel it in the first session.
            </p>
            <div className={s.heroMicro}>
              <span>1,000+ pitches analyzed</span>
              <span className={s.dot} aria-hidden>
                •
              </span>
              <span>no signup</span>
              <span className={s.dot} aria-hidden>
                •
              </span>
              <span>under a minute</span>
            </div>
            <div className={s.heroCtaRow}>
              <button type="button" className={s.heroCta} onClick={scrollToForm}>
                Score my pitch — free <span aria-hidden>→</span>
              </button>
            </div>
          </div>
          {/* Product peek above the fold — replaces dead hero-right space and
              previews the deliverable in one second. Mirrors the "EXAMPLE
              RESULT 89" card from / that was doing real conversion work. */}
          <aside className={s.heroSample} aria-label="Example pitch score">
            <div className={s.sampleKicker}>Example result</div>
            <div className={s.sampleScoreRow}>
              <div className={s.sampleScoreNum}>89</div>
              <div className={s.sampleScoreMeta}>
                <div className={s.sampleOutOf}>out of 100</div>
                <div className={s.sampleTier}>Top 10% · elite mechanics</div>
              </div>
            </div>
            <div className={s.sampleBars}>
              {(() => {
                const heroLabels = pickPitchingLabels(sport);
                const bars: Array<[string, number]> = [
                  [heroLabels.balance, 87],
                  [heroLabels.stride, 90],
                  [heroLabels.arm_path, 91],
                  [heroLabels.release, 88],
                  [heroLabels.finish, 86],
                ];
                return bars.map(([label, value]) => (
                <div key={label as string} className={s.sampleBar}>
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
              ));
              })()}
            </div>
            <div className={s.sampleFixes}>
              <div className={s.sampleFixesLabel}>Top 3 fixes</div>
              <ol className={s.sampleFixList}>
                <li>Hands drift forward before hips fire</li>
                <li>Back elbow drops below slot at load</li>
                <li>Front foot lands open on outside pitch</li>
              </ol>
            </div>
          </aside>
        </div>
        <div className={s.heroGrain} aria-hidden />
      </section>
      )}

      {/* ========== LOADING / FORM / RESULT SWITCH ========== */}
      {loading ? (
        <section className={s.loadingSection}>
          <div className={s.loadingInner}>
            <div className={s.loadingLabel}>{steps[stepIdx]}</div>
            <div className={s.loadingBar}>
              <div className={s.loadingFill} style={{ width: `${progress}%` }} />
            </div>
            <div className={s.loadingHint}>
              Don't close this tab. Results land in ~20 seconds.
            </div>
          </div>
        </section>
      ) : !result ? (
        <section ref={formRef} className={s.formSection}>
          <div className={s.formInner}>
            <div className={s.sectionKicker}>Step one</div>
            <h2 className={s.sectionHead}>One pitch. Three fixes. A plan.</h2>
            <p className={s.sectionSub}>
              Film side-on. Full body in frame. One clean swing, under ten seconds.
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
                <span className={s.fieldLabel}>Your pitch video</span>
                <div className={s.reqGrid}>
                  <div className={s.reqCard}>
                    <div className={s.reqIcon} aria-hidden>
                      📐
                    </div>
                    <div className={s.reqTitle}>Side angle</div>
                    <div className={s.reqBody}>
                      Camera perpendicular to the plate, behind the catcher line
                    </div>
                  </div>
                  <div className={s.reqCard}>
                    <div className={s.reqIcon} aria-hidden>
                      🧍
                    </div>
                    <div className={s.reqTitle}>Full body</div>
                    <div className={s.reqBody}>
                      Feet to head in frame all the way through contact
                    </div>
                  </div>
                  <div className={s.reqCard}>
                    <div className={s.reqIcon} aria-hidden>
                      1️⃣
                    </div>
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
                    <span>🎥 Upload pitch video</span>
                  )}
                </button>
              </div>

              <button
                type="button"
                className={s.submit}
                onClick={analyze}
                disabled={loading}
              >
                {loading ? "Reading your pitch…" : "Score my pitch →"}
              </button>

              <div className={s.disclaimer}>
                No signup. No spam. Your video is used only to generate your analysis.
              </div>
            </div>
          </div>
        </section>
      ) : (
        <>
          {/* ========== SCORE REVEAL ========== */}
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
                <div className={s.insightLabel}>Coach's read</div>
                <div className={s.insightBody}>{result.impact_line}</div>
              </div>

              <div className={s.breakdown}>
                {(() => {
                  const bd = normalizeBreakdown(result.breakdown);
                  const labels = pickPitchingLabels(result.sport ?? sport);
                  return METRIC_ORDER.map((key) => {
                    const label = labels[key];
                    const value = bd[key];
                    return (
                      <div key={key} className={s.bar}>
                        <div className={s.barHead}>
                          <span className={s.barLabel}>{label}</span>
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

          {/* ========== TOP 3 FIXES ========== */}
          <section className={s.fixesSection}>
            <div className={s.fixesInner}>
              <div className={s.sectionKicker}>Your top 3 fixes</div>
              <h2 className={s.sectionHead}>What's costing you power</h2>
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

          {/* ========== BRIDGE ========== */}
          <section className={s.bridgeSection}>
            <div className={s.bridgeInner}>
              <h2 className={s.bridgeHead}>
                Now fix it. <em>Built from your frames, not YouTube.</em>
              </h2>
              <p className={s.bridgeBody}>
                Every drill, rep count, and coaching cue is chosen from your
                pitch's specific leaks. No generic drills. Delivered to your
                email in minutes.
              </p>
            </div>
          </section>

          {/* ========== PLANS ========== */}
          <section ref={offersRef} className={s.plansSection}>
            <div className={s.plansInner}>
              <div className={s.planGrid}>
                <PlanCard
                  tier="7-Day Trial"
                  badge="Start here"
                  tagline="Try it for under two bucks"
                  price={1.99}
                  sub="Then $14.99/mo — cancel anytime"
                  features={[
                    "Custom 7-day drill plan from your pitch",
                    "3 drills/day + warm-up, cues, rep counts",
                    "Full dashboard + AI coach chat",
                    "New custom plan every month if you stay",
                  ]}
                  ctaText="Start 7-day trial — $1.99"
                  subCta="Cancel any time during the trial"
                  enabled={offersEnabled}
                  onClick={buyTrial}
                />
                <PlanCard
                  tier="14-Day Fix"
                  badge="Most chosen"
                  tagline="Fix all three leaks"
                  price={19.99}
                  strikePrice={29.99}
                  sub="Build the fix, then lock it in"
                  features={[
                    "All 3 leaks, week 1 isolation → week 2 sequencing",
                    "3 drills/day with warm-up, cues, progression reps",
                    "Weekly progression plan built from your frames",
                    "Player dashboard + score tracking",
                  ]}
                  ctaText="Start 14-day fix"
                  subCta="Money-back guarantee"
                  enabled={offersEnabled}
                  featured
                  onClick={() => buyPlan(14, 19.99, "14-Day Fix")}
                />
              </div>

              <div className={s.proDivider}>
                <span>or go unlimited</span>
              </div>

              <div className={s.proCard}>
                <div className={s.proLeft}>
                  <div className={s.proBadge}>For serious players</div>
                  <div className={s.proName}>ArmIQ Pro</div>
                  <div className={s.proPrice}>
                    <span className={s.proPriceStrike}>$19.99</span>
                    <span className={s.proPriceNum}>$14.99</span>
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

          {/* ========== PROOF CLUSTER ========== */}
          <section className={s.proofSection}>
            <div className={s.proofInner}>
              <div className={s.sectionKicker}>Why it works</div>
              <h2 className={s.sectionHead}>
                Built from real swing frames, not stock drills.
              </h2>

              <div className={s.proofGrid}>
                <figure className={s.quoteCard}>
                  <blockquote className={s.quote}>
                    "Honestly thought the AI thing was gimmicky. But the three fixes
                    were the same ones his hitting coach had been saying for
                    months — he didn't buy in until he saw the score. Exit velo
                    up 5 mph in a month."
                  </blockquote>
                  <figcaption className={s.quoteAttr}>
                    <span>Mike D. · dad of a 13U pitcher</span>
                    <span className={s.quoteRole}>Frisco, TX</span>
                  </figcaption>
                </figure>

                <figure className={s.quoteCard}>
                  <blockquote className={s.quote}>
                    "I don't hand my guys anything an AI made. This one's the
                    exception. Barrel-path read is accurate and the drill
                    progression isn't dumb — matches what I'd program. Using it
                    between lessons."
                  </blockquote>
                  <figcaption className={s.quoteAttr}>
                    <span>Coach Ramirez · 12U travel</span>
                    <span className={s.quoteRole}>Houston area</span>
                  </figcaption>
                </figure>

                <figure className={s.statCard}>
                  <div className={s.statNumber}>+11</div>
                  <div className={s.statUnit}>points</div>
                  <div className={s.statBody}>
                    Average score jump from first to fifth analyzed pitch.
                  </div>
                </figure>
              </div>
            </div>
          </section>

          {/* ========== TRUST GRID ========== */}
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

          {/* ========== GUARANTEE BAR ========== */}
          <section className={s.guaranteeSection}>
            <div className={s.guaranteeInner}>
              <h2 className={s.guaranteeHead}>100% money-back guarantee.</h2>
              <p className={s.guaranteeBody}>
                If you don't feel a difference after your plan, email us. We refund
                you. No questions, no forms, no hoops.
              </p>
            </div>
          </section>

          {/* ========== FAQ ========== */}
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
                  a="Every drill on your plan is chosen from your pitch's breakdown. A sequencing score of 71 gets different drills than 82. Generic coaching ignores the leaks. We don't."
                />
                <FaqItem
                  q="How fast will I see results?"
                  a="Most players feel a difference in the first 1–2 sessions. The plan builds: isolation first, then sequencing, then game-speed. Nothing is random."
                />
                <FaqItem
                  q="When do I get the plan?"
                  a="Within minutes of purchase. It appears in your player dashboard and a PDF lands in your inbox."
                />
              </div>
            </div>
          </section>

          {/* ========== START OVER ========== */}
          <div className={s.startOverWrap}>
            <button type="button" className={s.startOver} onClick={startOver}>
              Analyze another pitch
            </button>
          </div>
        </>
      )}

      {/* ========== FOOTER ========== */}
      <footer className={s.footer}>
        <div className={s.footerInner}>
          <div className={s.footerLinks}>
            <a href="/dashboard">Sign in</a>
            <span className={s.dot} aria-hidden>
              •
            </span>
            <a href="/terms">Terms</a>
            <span className={s.dot} aria-hidden>
              •
            </span>
            <a href="/privacy">Privacy</a>
            <span className={s.dot} aria-hidden>
              •
            </span>
            <a href="/contact">Contact</a>
          </div>
          <div className={s.footerCross}>
            Also a pitcher?{" "}
            <a href="https://armiq.ai" target="_blank" rel="noopener">
              ArmIQ.ai →
            </a>
          </div>
          <div className={s.footerCopy}>© 2026 ArmIQ AI · Powered by HIT24</div>
        </div>
      </footer>

      {/* ========== MOBILE FLOATING CTA ========== */}
      {showFloatingCta && (
        <button type="button" className={s.floatingCta} onClick={scrollToOffers}>
          See your plan →
        </button>
      )}

      {/* ========== WELCOME MODAL ========== */}
      {showSubWelcome && (
        <div className={s.modalBackdrop} role="dialog" aria-modal="true">
          <div className={s.modalCard}>
            <h3 className={s.modalHead}>You're in.</h3>
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

      {/* ========== RATE LIMIT MODAL ========== */}
      {showRateLimit && (
        <div className={s.modalBackdrop} role="dialog" aria-modal="true">
          <div className={s.modalCard}>
            <div className={s.modalIcon} aria-hidden>
              ⚡
            </div>
            <h3 className={s.modalHead}>You've used your 2 free scores today</h3>
            <p className={s.modalBody}>
              Upgrade to ArmIQ Pro for unlimited swings, monthly plans, and the AI
              coach.
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

// ---- local components ----

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
