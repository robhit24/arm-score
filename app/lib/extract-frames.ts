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

  canvas.width = 1280;
  canvas.height = 720;

  // Evenly space frames across the middle 80% of the video
  // Skip first 10% and last 10% to avoid black frames
  const startPct = 0.10;
  const endPct = 0.90;
  const range = endPct - startPct;
  const times = Array.from({ length: frameCount }, (_, i) =>
    Math.max(0.1, Math.min(duration - 0.1, (startPct + (range * (i + 0.5)) / frameCount) * duration))
  );

  const frames: string[] = [];
  for (const t of times) {
    video.currentTime = t;
    await new Promise<void>((resolve) => (video.onseeked = () => resolve()));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL("image/jpeg", 0.85));
  }

  URL.revokeObjectURL(url);
  return frames;
}
