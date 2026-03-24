"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Result } from "./types";
import { extractFrames } from "./lib/extract-frames";
import { scoreColor, easeOutCubic, clamp, money } from "./lib/utils";
import { Bar } from "./components/Bar";
import { Chip } from "./components/Chip";
import { CheckLine } from "./components/CheckLine";
import { MiniRow } from "./components/MiniRow";
import { PlanCard } from "./components/PlanCard";
import { FAQ } from "./components/FAQ";
import { ExampleScorePreview } from "./components/ExampleScorePreview";
import { ResultSkeleton } from "./components/ResultSkeleton";
import { ShareCard } from "./components/ShareCard";
import { SwingChat } from "./components/SwingChat";
import s from "./page.module.css";

export default function Page() {
  const [email, setEmail] = useState("");
  const [sport, setSport] = useState<"baseball" | "softball">("baseball");
  const [ageGroup, setAgeGroup] = useState("12U");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [swingId, setSwingId] = useState<string>("");

  const [analysisSaved, setAnalysisSaved] = useState(false);
  const [animatedScore, setAnimatedScore] = useState<number>(0);

  const [progress, setProgress] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  const progressTimer = useRef<number | null>(null);

  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [urgencyCount] = useState(() => Math.floor(Math.random() * 12) + 14);

  const steps = useMemo(
    () => ["Uploading frames", "Reading mechanics", "Generating your score"],
    []
  );

  const scoreTopRef = useRef<HTMLDivElement | null>(null);
  const scoreBoxRef = useRef<HTMLDivElement | null>(null);
  const offersRef = useRef<HTMLDivElement | null>(null);
  const [showFloatingCta, setShowFloatingCta] = useState(false);
  const [showStickyBar, setShowStickyBar] = useState(false);

  const STORE_ANALYSIS_URL =
    "https://8156f6tuae.execute-api.us-east-2.amazonaws.com/live/store-analysis";

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Handle post-subscription redirect
  const [showSubWelcome, setShowSubWelcome] = useState(false);
  const [subLinkSent, setSubLinkSent] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("subscribed") === "true") {
      setShowSubWelcome(true);
      // Auto-send magic link if we have their email
      const subEmail = params.get("email");
      if (subEmail) {
        fetch("/api/auth/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: subEmail }),
        }).then(() => setSubLinkSent(true)).catch(() => {});
      }
      window.history.replaceState({}, "", "/");
    }
  }, []);

  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 480px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    if (mq.addEventListener) mq.addEventListener("change", apply);
    else mq.addListener(apply);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", apply);
      else mq.removeListener(apply);
    };
  }, []);

  // Capture UTM params from URL
  const [utmParams, setUtmParams] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const utms: string[] = [];
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
      const val = params.get(key);
      if (val) utms.push(`${key}=${encodeURIComponent(val)}`);
    }
    if (utms.length) setUtmParams("&" + utms.join("&"));
  }, []);

  // Generate thumbnail when file is selected
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
      if (!revoked) { revoked = true; URL.revokeObjectURL(url); }
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
      video.currentTime = Math.min((video.duration || 2) * 0.3, video.duration - 0.1);
    };

    video.onseeked = capture;

    // Fallback: if onseeked never fires after 3s, try capturing anyway
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
    setSwingId("");
    setAnalysisSaved(false);
    setAnimatedScore(0);
    setFile(null);
    setThumbnailUrl(null);
    setProgress(0);
    setStepIdx(0);
  }

  async function hashFrames(frames: string[]): Promise<string> {
    // Fast hash from first 500 chars of each frame (unique enough, fast)
    const sample = frames.map((f) => f.slice(0, 500)).join("|");
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sample));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function getCachedResult(hash: string): { result: Result; swingId: string } | null {
    try {
      const raw = localStorage.getItem(`swing_cache_${hash}`);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      // Expire after 24 hours
      if (Date.now() - cached.ts > 86400000) {
        localStorage.removeItem(`swing_cache_${hash}`);
        return null;
      }
      return { result: cached.result, swingId: cached.swingId };
    } catch { return null; }
  }

  function setCachedResult(hash: string, result: Result, swingId: string) {
    try {
      localStorage.setItem(`swing_cache_${hash}`, JSON.stringify({ result, swingId, ts: Date.now() }));
    } catch {}
  }

  async function handleSubscribe() {
    if (!email.includes("@")) return alert("Enter a valid email first.");
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { url } = await res.json();
      if (typeof window !== "undefined" && (window as any).fbq) {
        (window as any).fbq("track", "InitiateCheckout", {
          content_name: "ArmIQ Pro Monthly",
          currency: "USD",
          value: 14.99,
        });
      }
      window.location.href = url;
    } catch (err: any) {
      alert(err?.message || "Something went wrong.");
    }
  }

  function trackCheckout(planName: string, price: number) {
    if (typeof window !== "undefined" && (window as any).fbq) {
      (window as any).fbq("track", "InitiateCheckout", {
        content_name: planName,
        currency: "USD",
        value: price,
      });
    }
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
      const frames = await extractFrames(file, 4);

      // Use first extracted frame as fallback thumbnail if video capture failed
      if (!thumbnailUrl && frames[0]) {
        setThumbnailUrl(frames[0]);
      }

      // Check for duplicate swing
      const frameHash = await hashFrames(frames);
      const cached = getCachedResult(frameHash);

      let data: Result;
      let newSwingId: string;

      if (cached) {
        // Same swing — return cached result instantly
        data = cached.result;
        newSwingId = cached.swingId;
        finishProgress();
      } else {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, sport, age_group: ageGroup, frames, frame_hash: frameHash }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(errText);
        }

        data = (await res.json()) as Result;
        finishProgress();

        newSwingId = crypto.randomUUID();

        // Cache for dedup
        setCachedResult(frameHash, data, newSwingId);
      }

      setSwingId(newSwingId);
      setResult(data);

      // Meta Pixel: Lead event (free score generated)
      if (typeof window !== "undefined" && (window as any).fbq) {
        (window as any).fbq("track", "Lead", {
          content_name: "Pitch Score",
          content_category: sport,
          value: data.score,
        });
      }

      const storeRes = await fetch(STORE_ANALYSIS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          swing_id: newSwingId,
          email,
          sport,
          age_group: ageGroup,
          frame_hash: frameHash,
          analysis: data,
        }),
      });

      const storeTxt = await storeRes.text();
      console.log("STORE_ANALYSIS_STATUS:", storeRes.status, storeTxt);

      if (!storeRes.ok) throw new Error("StoreAnalysis failed: " + storeTxt);
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
    // Scroll to top of results so score is fully visible
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [result]);

  // Show floating CTA on mobile whenever result exists
  useEffect(() => {
    setShowFloatingCta(!!result && isMobile);
  }, [result, isMobile]);

  // Show sticky bar only after main score scrolls out of view
  useEffect(() => {
    if (!result) {
      setShowStickyBar(false);
      return;
    }
    const el = scoreBoxRef.current;
    if (!el) return;

    const obs = new IntersectionObserver(
      ([entry]) => setShowStickyBar(!entry.isIntersecting),
      { threshold: 0.1 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [result]);

  useEffect(() => {
    return () => {
      if (progressTimer.current) window.clearInterval(progressTimer.current);
    };
  }, []);

  const scoreTint = result ? scoreColor(result.score) : "#111";

  const enabledOffers = analysisSaved && !!swingId;

  const price14 = 29.99;
  const price30 = 59.99;
  const price45 = 79.99;

  const perDay14 = `${money(price14 / 14)}/day`;
  const perDay30 = `${money(price30 / 30)}/day`;
  const perDay45 = `${money(price45 / 45)}/day`;

  const strike14 = "$49.99";
  const strike30 = "$89.99";
  const strike45 = "$119.99";

  const saveVs14 = price14 * 2 - price30;
  const bestValueLine =
    saveVs14 > 0
      ? `Best value (saves ${money(saveVs14)} vs buying two 14-day plans)`
      : "Best value for most athletes";

  const link14 = `https://hit24.com/cart/add?id=53076624900403&quantity=1&properties[swing_id]=${encodeURIComponent(
    swingId
  )}&properties[plan_days]=14&return_to=/checkout${utmParams}`;

  const link30 = `https://hit24.com/cart/add?id=53076624933171&quantity=1&properties[swing_id]=${encodeURIComponent(
    swingId
  )}&properties[plan_days]=30&return_to=/checkout${utmParams}`;

  const link45 = `https://hit24.com/cart/add?id=53076624965939&quantity=1&properties[swing_id]=${encodeURIComponent(
    swingId
  )}&properties[plan_days]=45&return_to=/checkout${utmParams}`;

  return (
    <main className={s.main}>
      {/* Post-subscription welcome */}
      {showSubWelcome && (
        <div className={s.subWelcomeOverlay}>
          <div className={s.subWelcomeCard}>
            <div className={s.subWelcomeIcon}>🎉</div>
            <div className={s.subWelcomeTitle}>Welcome to ArmIQ Pro!</div>
            <div className={s.subWelcomeText}>
              {subLinkSent
                ? "We just sent a sign-in link to your email. Click it to access your dashboard, track scores, and generate your custom training plan."
                : "Your subscription is active. Head to your dashboard to track scores, view history, and generate your first custom training plan."
              }
            </div>
            {subLinkSent ? (
              <div className={s.subWelcomeCheck}>📧 Check your email for the sign-in link</div>
            ) : (
              <a href="/dashboard" className={s.subWelcomeBtn}>
                Go to My Dashboard →
              </a>
            )}
            <button
              type="button"
              className={s.subWelcomeDismiss}
              onClick={() => setShowSubWelcome(false)}
            >
              {subLinkSent ? "Close" : "Stay on this page"}
            </button>
          </div>
        </div>
      )}

      <div
        className={s.container}
        data-result-mobile={!!result && isMobile}
      >
        <div className={s.inner}>
          <header className={s.header}>
            <div className={s.brandRow}>
              <div className={s.brandMark} />
              <span className={s.brandName}>ArmIQ AI</span>
              <span className={s.brandTag}>Powered by HIT24</span>
              <a href="/dashboard" className={s.signInLink}>Sign in</a>
            </div>
            <h1 className={s.headline}>
              See what&apos;s <em>costing you velocity.</em>
            </h1>
            <p className={s.subhead}>
              Upload a pitch, get your score + top 3 fixes in seconds.
              Custom pitching program delivered in 2 hours.
            </p>
            <div className={s.proofRow}>
              <span className={s.proofItem}>1,000+ swings analyzed</span>
              <span className={s.proofDivider} />
              <span className={s.proofItem}>Built from your frames</span>
            </div>
          </header>

          {!result && loading && <ResultSkeleton step={steps[stepIdx]} />}

          {!result && !loading && (
            <div className={s.formSection}>
              <div className={s.formGrid}>
                <div className={s.formCol}>
                  <div className={s.fields}>
                    <label className={s.fieldWrap}>
                      <span className={s.fieldLabel}>Email (required)</span>
                      <input
                        placeholder="you@email.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className={s.inputAlt}
                      />
                    </label>

                    <div className={s.fieldRow}>
                      <label className={s.fieldWrap}>
                        <span className={s.fieldLabel}>Sport</span>
                        <select
                          value={sport}
                          onChange={(e) => setSport(e.target.value as any)}
                          className={s.select}
                        >
                          <option value="baseball">Baseball</option>
                          <option value="softball">Softball</option>
                        </select>
                      </label>

                      <label className={s.fieldWrap}>
                        <span className={s.fieldLabel}>Age group</span>
                        <select
                          value={ageGroup}
                          onChange={(e) => setAgeGroup(e.target.value)}
                          className={s.select}
                        >
                          <option value="8U">8U</option>
                          <option value="9U">9U</option>
                          <option value="10U">10U</option>
                          <option value="11U">11U</option>
                          <option value="12U">12U</option>
                          <option value="13U">13U</option>
                          <option value="14U">14U</option>
                          <option value="15U">15U</option>
                          <option value="16U">16U</option>
                          <option value="17U">17U</option>
                          <option value="18U">18U</option>
                          <option value="College/Adult">College/Adult</option>
                        </select>
                      </label>
                    </div>

                    <div className={s.fieldWrap}>
                      <span className={s.fieldLabel}>Swing video</span>

                      {/* Video requirements — always visible */}
                      <div className={s.videoReqs}>
                        <div className={s.videoReq}>
                          <span className={s.videoReqIcon}>📐</span>
                          <span>Side angle</span>
                        </div>
                        <div className={s.videoReq}>
                          <span className={s.videoReqIcon}>🧍</span>
                          <span>Full body visible</span>
                        </div>
                        <div className={s.videoReq}>
                          <span className={s.videoReqIcon}>1️⃣</span>
                          <span>One pitch only</span>
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
                        onClick={() => fileInputRef.current?.click()}
                        className={s.uploadBtn}
                        data-has-file={!!file}
                      >
                        {thumbnailUrl ? (
                          <>
                            <img src={thumbnailUrl} alt="Preview" className={s.uploadThumb} />
                            <div className={s.uploadChange}>Tap to change video</div>
                          </>
                        ) : (
                          <div className={s.uploadTitle}>
                            🎥 Tap to upload your mechanics (under 10 sec)
                          </div>
                        )}
                      </button>
                    </div>

                    {/* #11: Timeline steps instead of cards */}
                    <div className={s.timeline}>
                      <div className={s.timelineStep}>
                        <div className={s.timelineDot}>1</div>
                        <div className={s.timelineLabel}>Upload</div>
                      </div>
                      <div className={s.timelineLine} />
                      <div className={s.timelineStep}>
                        <div className={s.timelineDot}>2</div>
                        <div className={s.timelineLabel}>Get Score</div>
                      </div>
                      <div className={s.timelineLine} />
                      <div className={s.timelineStep}>
                        <div className={s.timelineDot}>3</div>
                        <div className={s.timelineLabel}>Go Custom</div>
                      </div>
                    </div>

                    <button
                      onClick={analyze}
                      disabled={loading}
                      className={s.primaryBtn}
                      data-loading={loading}
                    >
                      {loading ? "Analyzing mechanics..." : "Get My Free Pitch Score →"}
                    </button>

                    <div className={s.disclaimer}>
                      No signup. We only email your results (and plan if you order).
                    </div>
                  </div>
                </div>

                {/* #3: Shows on mobile too */}
                <ExampleScorePreview />
              </div>
            </div>
          )}

          {result && (
            <section className={s.resultSection}>
              <div ref={scoreTopRef} />

              <div className={s.scoreTop} ref={scoreBoxRef}>
                <div className={s.pulseRing} style={{ color: scoreTint }} />
                <div className={s.scoreNum} style={{ color: scoreTint }}>
                  {animatedScore}
                </div>
                <div className={s.scoreTitle}>Pitch Score</div>
                <div className={s.scoreLabel}>{result.score_label}</div>

                {/* Percentile rank */}
                <div className={s.rankSection}>
                  <div className={s.rankBar}>
                    <div className={s.rankFill} style={{ width: `${Math.min(result.score, 100)}%` }} />
                    <div className={s.rankMarker} style={{ left: `${Math.min(result.score, 100)}%` }}>
                      <div className={s.rankMarkerDot} style={{ background: scoreTint }} />
                      <div className={s.rankMarkerLabel}>You</div>
                    </div>
                  </div>
                  <div className={s.rankLabels}>
                    <span>Needs Work</span>
                    <span>Average</span>
                    <span>Great</span>
                    <span>Elite</span>
                  </div>
                  <div className={s.rankText}>
                    {result.score >= 85
                      ? "Top 10% of athletes analyzed"
                      : result.score >= 75
                      ? `Top ${100 - result.score + 3}% — above average but fixable gaps`
                      : result.score >= 65
                      ? `${100 - result.score + 2}th percentile — common issues holding you back`
                      : `Bottom ${100 - result.score}% — significant gains available with the right drills`
                    }
                  </div>
                </div>
              </div>

              {/* Top 3 fixes — immediately after score for urgency */}
              <div className={s.quickFixes}>
                <div className={s.quickFixesTitle}>Your top 3 velocity killers</div>
                <div className={s.fixGrid}>
                  {(result.top3 || []).slice(0, 3).map((t, idx) => (
                    <CheckLine key={idx} text={t} num={idx + 1} />
                  ))}
                </div>
                <div className={s.upliftText}>
                  <span className={s.fixItLabel}>If we fix these:</span>{" "}
                  {result.uplift_line}
                </div>
              </div>

              {/* Chat — ask about your score */}
              <SwingChat result={result} />

              {/* BRIDGE — what the plan actually is */}
              <div className={s.bridgeSection}>
                <div className={s.bridgeCard}>
                  <div className={s.bridgeTitle}>
                    You know the problem. Here&apos;s the fix.
                  </div>
                  <div className={s.bridgeText}>
                    Your custom plan is built from your exact score breakdown — not generic drills.
                    Here&apos;s a preview of what Day 1 looks like:
                  </div>
                  <div className={s.bridgePreview}>
                    <div className={s.bridgeDay}>Day 1 Preview</div>
                    <div className={s.bridgeItems}>
                      <div className={s.bridgeItem}>
                        <span className={s.bridgeIcon}>🎯</span>
                        <span>Targeted warm-up for your weak areas</span>
                      </div>
                      <div className={s.bridgeItem}>
                        <span className={s.bridgeIcon}>🔧</span>
                        <span>3 drills designed to fix issue #1: {(result.top3?.[0] || "").split("—")[0].trim()}</span>
                      </div>
                      <div className={s.bridgeItem}>
                        <span className={s.bridgeIcon}>📋</span>
                        <span>Exact reps, sets, and cues for each drill</span>
                      </div>
                      <div className={s.bridgeItem}>
                        <span className={s.bridgeIcon}>👨‍👩‍👧</span>
                        <span>Parent coaching notes — what to watch for</span>
                      </div>
                    </div>
                  </div>
                  <div className={s.bridgeCompare}>
                    <div className={s.compareCol}>
                      <div className={s.compareHeader} data-type="without">Without a plan</div>
                      <div className={s.compareItem}>❌ Generic YouTube drills</div>
                      <div className={s.compareItem}>❌ No progression structure</div>
                      <div className={s.compareItem}>❌ Same mistakes repeat</div>
                    </div>
                    <div className={s.compareCol}>
                      <div className={s.compareHeader} data-type="with">With your custom plan</div>
                      <div className={s.compareItem}>✅ Drills matched to YOUR score</div>
                      <div className={s.compareItem}>✅ Gets harder each week</div>
                      <div className={s.compareItem}>✅ {result.uplift_line}</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* PRICING */}
              <div className={s.offersWrap}>
                {!analysisSaved && (
                  <p className={s.savingMsg}>
                    Saving your mechanics so we can generate your custom program…
                  </p>
                )}

                <div ref={offersRef} />

                <div className={s.offersHeader}>
                  <div className={s.offersTitle}>
                    Fix your {result.score < 70 ? result.score < 55 ? "swing" : "mechanics" : "timing"} — pick your plan
                  </div>
                  <div className={s.offersSubtitle}>
                    Custom-built from your {result.score} score. Delivered in{" "}
                    <span className={s.accent}>2 hours</span>.
                  </div>
                </div>

                <div className={s.urgency}>
                  <span className={s.urgencyCount}>{urgencyCount} plans</span>{" "}
                  generated today
                </div>

                {/* Subscription card */}
                <div className={s.subCard}>
                  <div className={s.subBadge}>Best for Ongoing Improvement</div>
                  <div className={s.subTop}>
                    <div>
                      <div className={s.subName}>ArmIQ Pro</div>
                      <div className={s.subPriceRow}>
                        <span className={s.subPrice}>$14.99</span>
                        <span className={s.subPer}>/month</span>
                      </div>
                    </div>
                  </div>
                  <div className={s.subBullets}>
                    <div className={s.subBullet}>✅ Unlimited swing analyses</div>
                    <div className={s.subBullet}>✅ Score tracking + progress chart</div>
                    <div className={s.subBullet}>✅ Monthly updated training plan</div>
                    <div className={s.subBullet}>✅ Unlimited ArmIQ AI chat</div>
                    <div className={s.subBullet}>✅ Leaderboard access</div>
                    <div className={s.subBullet}>✅ Cancel anytime</div>
                  </div>
                  <button
                    type="button"
                    className={s.subCta}
                    onClick={handleSubscribe}
                  >
                    Start ArmIQ Pro →
                  </button>
                </div>

                <div className={s.orDivider}>
                  <span className={s.orLine} />
                  <span className={s.orText}>or get a one-time plan</span>
                  <span className={s.orLine} />
                </div>

                <div className={s.planGrid}>
                  <PlanCard
                    label="14-Day Plan"
                    price={price14}
                    strike={strike14}
                    perDay={perDay14}
                    subtitle="Fast improvement plan — perfect if you need quick results."
                    bullets={[
                      "Your top 3 mechanical fixes + drill plan",
                      "Daily reps + cage structure",
                      "Great for tryouts & quick timelines",
                    ]}
                    href={link14}
                    enabled={enabledOffers}
                    onClick={() => trackCheckout("14-Day Plan", price14)}
                  />

                  <PlanCard
                    label="30-Day Plan"
                    price={price30}
                    strike={strike30}
                    perDay={perDay30}
                    badge="Most Popular • Best Value"
                    badgeTone="red"
                    subtitle="Best balance of speed + lasting swing changes."
                    bullets={[
                      bestValueLine,
                      "Fix mechanics + build repeatable timing",
                      "Weekly focus blocks + progression drills",
                    ]}
                    href={link30}
                    primary
                    enabled={enabledOffers}
                    onClick={() => trackCheckout("30-Day Plan", price30)}
                  />

                  <PlanCard
                    label="45-Day Plan"
                    price={price45}
                    strike={strike45}
                    perDay={perDay45}
                    badge="Most Complete"
                    badgeTone="dark"
                    subtitle="Full rebuild + repeatability under game speed."
                    bullets={[
                      "Deep mechanical rebuild + pattern training",
                      "Harder progression each week",
                      "Best for serious development phases",
                    ]}
                    href={link45}
                    enabled={enabledOffers}
                    onClick={() => trackCheckout("45-Day Plan", price45)}
                  />
                </div>

                {/* #10: Trust bar as icon+label grid */}
                <div className={s.trustGrid}>
                  <div className={s.trustItem}>
                    <span className={s.trustIcon}>🔒</span>
                    <span>Secure checkout</span>
                  </div>
                  <div className={s.trustItem}>
                    <span className={s.trustIcon}>📧</span>
                    <span>Delivered by email</span>
                  </div>
                  <div className={s.trustItem}>
                    <span className={s.trustIcon}>🎥</span>
                    <span>Your exact frames</span>
                  </div>
                  <div className={s.trustItem}>
                    <span className={s.trustIcon}>📋</span>
                    <span>Drill plan + reps</span>
                  </div>
                </div>

                <div className={s.faqWrap}>
                  <div className={s.faqTitle}>Quick FAQ</div>
                  <div className={s.faqGrid}>
                    <FAQ
                      q="How is this custom?"
                      a="Your plan is generated from your pitching frames and your score breakdown (timing, power transfer, bat control). You get your top 3 fixes + the exact drills and reps to correct them."
                    />
                    <FAQ
                      q="When do I get it?"
                      a="Within 2 hours after checkout. It's delivered to the email you entered."
                    />
                    <FAQ
                      q="What if I upload a bad angle?"
                      a="We recommend side-angle with full body visible. If the angle is unusable, upload a new clip and re-run the Free Pitch Score so we generate the plan from clean frames."
                    />
                  </div>
                </div>
              </div>

              {/* DETAILED BREAKDOWN — below pricing for scrollers */}
              <div className={s.detailSection}>
                <div className={s.detailHeader}>Full Breakdown</div>

                {thumbnailUrl && (
                  <div className={s.thumbnail}>
                    <img src={thumbnailUrl} alt="Your mechanics" className={s.thumbnailImg} />
                  </div>
                )}

                <div className={s.cardsColumn}>
                  <div className={s.resultCard}>
                    <div className={s.cardIcon}>💡</div>
                    <div className={s.sectionTitle}>What this means</div>
                    <div className={s.impactText}>{result.impact_line}</div>
                    <div className={s.upliftText}>
                      <span className={s.fixItLabel}>If we fix it:</span>{" "}
                      {result.uplift_line}
                    </div>
                  </div>

                  <div className={s.resultCard}>
                    <div className={s.cardIcon}>📊</div>
                    <div className={s.sectionTitle}>Score Breakdown</div>
                    <div className={s.barGrid}>
                      <Bar label="Arm Path" value={result.breakdown.timing} />
                      <Bar label="Mechanics" value={result.breakdown.power_transfer} />
                      <Bar label="Command" value={result.breakdown.bat_control} />
                    </div>
                  </div>

                  <div className={s.resultCard}>
                    <div className={s.cardIcon}>🎯</div>
                    <div className={s.sectionTitle}>Your plan targets these scores</div>
                    <div className={s.personRows}>
                      <MiniRow k="Arm Path" v={`${result.breakdown.timing}`} />
                      <MiniRow k="Mechanics" v={`${result.breakdown.power_transfer}`} />
                      <MiniRow k="Command" v={`${result.breakdown.bat_control}`} />
                    </div>
                  </div>
                </div>

                <ShareCard result={result} />

                <button type="button" className={s.startOverInline} onClick={startOver}>
                  Analyze another pitch
                </button>
              </div>
            </section>
          )}
        </div>
      </div>

      {result && isMobile && showFloatingCta && (
        <button
          type="button"
          onClick={() => offersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className={s.floatingCta}
        >
          Get Custom Plan ↓
        </button>
      )}
    </main>
  );
}
