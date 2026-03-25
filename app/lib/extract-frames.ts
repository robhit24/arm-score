export async function extractFrames(file: File, frameCount = 8): Promise<string[]> {
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

  // Pitching: 3 frames in first half (wind-up, leg lift, stride)
  // 5 frames clustered in second half (arm cocking, acceleration, release, follow-through)
  const earlyFrames = [0.12, 0.25, 0.38]; // wind-up phases
  const lateFrames = [0.48, 0.56, 0.64, 0.72, 0.82]; // arm action + release
  const phasePoints = [...earlyFrames, ...lateFrames].slice(0, frameCount);
  const times = phasePoints.map((p) =>
    Math.max(0.1, Math.min(duration - 0.1, p * duration))
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
