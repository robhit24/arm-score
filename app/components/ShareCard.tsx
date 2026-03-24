"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Result } from "../types";
import s from "./ShareCard.module.css";

function scoreColor(score: number) {
  return score >= 85 ? "#00ff87" : score >= 70 ? "#ffea00" : "#ff3366";
}

function drawCard(canvas: HTMLCanvasElement, result: Result) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = 1080;
  const H = 1350;
  canvas.width = W;
  canvas.height = H;

  const neon = scoreColor(result.score);
  const cyan = "#00e5ff";
  const magenta = "#ff00e5";

  // ─── Dark background ───
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#080012");
  bg.addColorStop(0.5, "#0a0018");
  bg.addColorStop(1, "#060010");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Big neon glow behind score
  const glow1 = ctx.createRadialGradient(W / 2, 360, 10, W / 2, 360, 420);
  glow1.addColorStop(0, neon + "35");
  glow1.addColorStop(0.4, neon + "12");
  glow1.addColorStop(1, "transparent");
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, W, H);

  // Secondary glow (magenta bottom-left)
  const glow2 = ctx.createRadialGradient(100, H - 200, 10, 100, H - 200, 500);
  glow2.addColorStop(0, magenta + "15");
  glow2.addColorStop(1, "transparent");
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // Cyan glow top-right
  const glow3 = ctx.createRadialGradient(W - 100, 100, 10, W - 100, 100, 400);
  glow3.addColorStop(0, cyan + "10");
  glow3.addColorStop(1, "transparent");
  ctx.fillStyle = glow3;
  ctx.fillRect(0, 0, W, H);

  // Top neon line
  const topLine = ctx.createLinearGradient(0, 0, W, 0);
  topLine.addColorStop(0, cyan);
  topLine.addColorStop(0.5, neon);
  topLine.addColorStop(1, magenta);
  ctx.fillStyle = topLine;
  ctx.fillRect(0, 0, W, 5);

  // ─── Brand ───
  ctx.fillStyle = neon;
  ctx.font = "900 28px -apple-system, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.shadowColor = neon;
  ctx.shadowBlur = 20;
  ctx.fillText("ArmIQ", 60, 58);
  ctx.shadowBlur = 0;

  // ─── "MY PITCH SCORE" ───
  const cx = W / 2;
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.font = "900 72px -apple-system, system-ui, sans-serif";
  ctx.shadowColor = neon;
  ctx.shadowBlur = 40;
  ctx.fillText("MY PITCH SCORE", cx, 150);
  ctx.shadowBlur = 0;

  // ─── Giant score ───
  ctx.fillStyle = neon;
  ctx.font = "900 280px -apple-system, system-ui, sans-serif";
  ctx.shadowColor = neon;
  ctx.shadowBlur = 80;
  ctx.fillText(`${result.score}`, cx, 420);
  ctx.shadowBlur = 40;
  ctx.fillText(`${result.score}`, cx, 420);
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#fff";
  ctx.fillText(`${result.score}`, cx, 420);

  // Score label
  ctx.fillStyle = neon;
  ctx.font = "800 30px -apple-system, system-ui, sans-serif";
  ctx.shadowColor = neon;
  ctx.shadowBlur = 15;
  ctx.fillText(result.score_label, cx, 475);
  ctx.shadowBlur = 0;

  // ─── Breakdown boxes ───
  const boxY = 520;
  const boxW = 290;
  const boxH = 120;
  const gap = 30;
  const totalW = boxW * 3 + gap * 2;
  const startX = (W - totalW) / 2;

  const barData = [
    { label: "ARM PATH", value: result.breakdown.timing, glow: cyan },
    { label: "MECHANICS", value: result.breakdown.power_transfer, glow: neon },
    { label: "COMMAND", value: result.breakdown.bat_control, glow: magenta },
  ];

  barData.forEach((item, i) => {
    const x = startX + i * (boxW + gap);

    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.strokeStyle = item.glow + "30";
    ctx.lineWidth = 1.5;
    roundRect(ctx, x, boxY, boxW, boxH, 18);
    ctx.fill();
    roundRect(ctx, x, boxY, boxW, boxH, 18);
    ctx.stroke();

    ctx.fillStyle = "#fff";
    ctx.font = "900 56px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.shadowColor = item.glow;
    ctx.shadowBlur = 20;
    ctx.fillText(`${item.value}`, x + boxW / 2, boxY + 65);
    ctx.shadowBlur = 0;

    ctx.fillStyle = item.glow;
    ctx.font = "800 15px -apple-system, system-ui, sans-serif";
    ctx.fillText(item.label, x + boxW / 2, boxY + 98);
  });

  // ─── Divider ───
  const divGrad = ctx.createLinearGradient(80, 0, W - 80, 0);
  divGrad.addColorStop(0, "transparent");
  divGrad.addColorStop(0.2, cyan + "40");
  divGrad.addColorStop(0.5, neon + "60");
  divGrad.addColorStop(0.8, magenta + "40");
  divGrad.addColorStop(1, "transparent");
  ctx.fillStyle = divGrad;
  ctx.fillRect(80, 680, W - 160, 2);

  // ─── "WHAT TO FIX" ───
  ctx.textAlign = "left";
  ctx.fillStyle = neon;
  ctx.font = "900 36px -apple-system, system-ui, sans-serif";
  ctx.shadowColor = neon;
  ctx.shadowBlur = 15;
  ctx.fillText("WHAT TO FIX", 80, 745);
  ctx.shadowBlur = 0;

  // ─── Top 3 fixes ───
  const fixColors = [cyan, neon, magenta];
  const fixes = (result.top3 || []).slice(0, 3);
  fixes.forEach((fix, i) => {
    const y = 790 + i * 100;
    const fc = fixColors[i];

    ctx.fillStyle = fc;
    ctx.shadowColor = fc;
    ctx.shadowBlur = 16;
    roundRect(ctx, 80, y, 52, 52, 14);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = "#000";
    ctx.font = "900 28px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${i + 1}`, 106, y + 36);

    ctx.textAlign = "left";
    ctx.fillStyle = "#fff";
    ctx.font = "800 26px -apple-system, system-ui, sans-serif";

    const maxW = W - 240;
    const words = fix.split(" ");
    let line = "";
    let lineY = y + 24;
    let lineCount = 0;

    for (const word of words) {
      const test = line + (line ? " " : "") + word;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, 152, lineY);
        line = word;
        lineY += 32;
        lineCount++;
        if (lineCount >= 2) { line += "…"; break; }
      } else {
        line = test;
      }
    }
    ctx.fillText(line, 152, lineY);
  });

  // ─── Bottom CTA ───
  const ctaY = H - 170;

  const ctaGrad = ctx.createLinearGradient(60, 0, W - 60, 0);
  ctaGrad.addColorStop(0, cyan);
  ctaGrad.addColorStop(0.5, neon);
  ctaGrad.addColorStop(1, magenta);

  ctx.shadowColor = neon;
  ctx.shadowBlur = 30;
  ctx.fillStyle = ctaGrad;
  roundRect(ctx, 50, ctaY, W - 100, 110, 24);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.textAlign = "center";
  ctx.fillStyle = "#000";
  ctx.font = "900 38px -apple-system, system-ui, sans-serif";
  ctx.fillText("GET YOUR FREE SCORE", cx, ctaY + 52);

  ctx.fillStyle = "rgba(0,0,0,0.50)";
  ctx.font = "800 22px -apple-system, system-ui, sans-serif";
  ctx.fillText("armiq.ai", cx, ctaY + 86);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function ShareCard({ result }: { result: Result }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (canvasRef.current) {
      drawCard(canvasRef.current, result);
    }
  }, [result]);

  const handleDownload = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.toBlob((blob) => {
      if (!blob) return;

      if (navigator.share && navigator.canShare) {
        const file = new File([blob], "my-arm-score.png", { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({
            files: [file],
            title: "My ArmIQ Score",
            text: `I scored ${result.score} on my pitch analysis! Get yours free → https://armiq.ai`,
          }).catch(() => {});
          return;
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "my-arm-score.png";
      a.click();
      URL.revokeObjectURL(url);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }, "image/png");
  }, [result]);

  return (
    <div className={s.wrap}>
      <canvas ref={canvasRef} className={s.canvas} />
      <button type="button" className={s.shareBtn} onClick={handleDownload}>
        {saved ? "Saved ✓" : "📤 Share My Score"}
      </button>
    </div>
  );
}
