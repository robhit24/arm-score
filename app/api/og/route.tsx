import { ImageResponse } from "next/og";

export const runtime = "edge";

// Mirrors the canonical 5-metric pitching model from app/lib/score.ts so the
// share preview matches what users see on the actual result card. Order is
// chronological — setup → stride → arm action → release → follow-through —
// and intentionally matches METRIC_ORDER for visual consistency.
export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#111",
          fontFamily: "system-ui, sans-serif",
          position: "relative",
        }}
      >
        {/* Red glow */}
        <div
          style={{
            position: "absolute",
            top: -80,
            left: "50%",
            transform: "translateX(-50%)",
            width: 700,
            height: 400,
            background: "radial-gradient(circle, rgba(225,6,0,0.3), transparent 70%)",
          }}
        />

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            position: "relative",
          }}
        >
          {/* Brand */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
            <div style={{ width: 16, height: 16, borderRadius: 4, background: "#e10600" }} />
            <span style={{ color: "#fff", fontSize: 22, fontWeight: 900 }}>ArmIQ</span>
          </div>

          {/* Title */}
          <div style={{ color: "#fff", fontSize: 68, fontWeight: 900, letterSpacing: -2, lineHeight: 1.1, marginBottom: 12 }}>
            Free Pitch Score
          </div>
          <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 26, fontWeight: 800, marginBottom: 32 }}>
            Upload a pitch → Get your score + top 3 fixes
          </div>

          {/* 5-metric chronological breakdown — matches METRIC_ORDER */}
          <div style={{ display: "flex", gap: 14 }}>
            {[
              { label: "BALANCE", value: "84", color: "#00e5ff" },
              { label: "STRIDE", value: "78", color: "#00ff87" },
              { label: "ARM PATH", value: "91", color: "#ff00e5" },
              { label: "RELEASE", value: "86", color: "#f59e0b" },
              { label: "FINISH", value: "82", color: "#e10600" },
            ].map((item) => (
              <div
                key={item.label}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.10)",
                  borderRadius: 16,
                  padding: "16px 22px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                }}
              >
                <span style={{ color: item.color, fontSize: 48, fontWeight: 900 }}>{item.value}</span>
                <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, fontWeight: 800, letterSpacing: 1 }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
