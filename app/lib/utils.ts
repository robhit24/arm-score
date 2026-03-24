export function scoreColor(score: number) {
  return score >= 85 ? "#16a34a" : score >= 70 ? "#f59e0b" : "#dc2626";
}

export function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function money(n: number) {
  return `$${n.toFixed(2)}`;
}
