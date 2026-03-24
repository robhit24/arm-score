import { ImageResponse } from "next/og";

export const runtime = "edge";

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

          {/* Score boxes */}
          <div style={{ display: "flex", gap: 16 }}>
            {[
              { label: "SCORE", value: "72", color: "#f59e0b" },
              { label: "ARM PATH", value: "68", color: "#00e5ff" },
              { label: "MECHANICS", value: "75", color: "#00ff87" },
              { label: "COMMAND", value: "74", color: "#ff00e5" },
            ].map((item) => (
              <div
                key={item.label}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.10)",
                  borderRadius: 16,
                  padding: "18px 32px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                }}
              >
                <span style={{ color: item.color, fontSize: 52, fontWeight: 900 }}>{item.value}</span>
                <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, fontWeight: 800 }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
