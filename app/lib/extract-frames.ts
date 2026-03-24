export async function extractFrames(file: File, frameCount = 4): Promise<string[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Could not load video"));
  });

  const duration = video.duration || 6;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");

  canvas.width = 720;
  canvas.height = 400;

  // Target key pitching phases:
  // ~10% = wind-up/set, ~35% = leg lift/balance, ~55% = arm cocking/stride, ~75% = release/follow-through
  const phasePoints = [0.10, 0.35, 0.55, 0.75];
  const times = phasePoints
    .slice(0, frameCount)
    .map((p) => Math.max(0, Math.min(duration - 0.05, p * duration)));

  const frames: string[] = [];
  for (const t of times) {
    video.currentTime = t;
    await new Promise<void>((resolve) => (video.onseeked = () => resolve()));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL("image/jpeg", 0.7));
  }

  URL.revokeObjectURL(url);
  return frames;
}
