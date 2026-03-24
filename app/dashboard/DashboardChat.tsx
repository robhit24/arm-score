"use client";

import { useState, useRef, useEffect } from "react";
import s from "./dashboard-chat.module.css";

type Message = { role: "user" | "assistant"; text: string };

export function DashboardChat({ email, latestScore, breakdown, top3 }: {
  email: string;
  latestScore?: number;
  breakdown?: { timing: number; power_transfer: number; bat_control: number };
  top3?: string[];
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  async function send() {
    const q = input.trim();
    if (!q || loading) return;

    const userMsg: Message = { role: "user", text: q };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: q,
          result: {
            score: latestScore || 0,
            breakdown: breakdown || { timing: 0, power_transfer: 0, bat_control: 0 },
            top3: top3 || [],
            score_label: "",
            impact_line: "",
            uplift_line: "",
          },
          history: updated.slice(-6),
          dashboard: true,
        }),
      });

      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setMessages([...updated, { role: "assistant", text: data.answer }]);
    } catch {
      setMessages([...updated, { role: "assistant", text: "Sorry, something went wrong. Try again." }]);
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={s.promptBtn} onClick={() => setOpen(true)}>
        <span className={s.promptIcon}>🤖</span>
        <span className={s.promptText}>
          <span className={s.promptTitle}>Ask your coach</span>
          <span className={s.promptSub}>Drill questions, plan help, mechanics tips</span>
        </span>
        <span className={s.promptArrow}>→</span>
      </button>
    );
  }

  return (
    <div className={s.wrap}>
      <div className={s.header}>
        <div className={s.headerLeft}>
          <span className={s.headerIcon}>🤖</span>
          <span className={s.headerTitle}>Your Coach</span>
        </div>
        <button type="button" className={s.closeBtn} onClick={() => setOpen(false)}>✕</button>
      </div>

      <div className={s.messages} ref={messagesRef}>
        <div className={s.msg} data-role="assistant">
          <div className={s.msgBubble} data-role="assistant">
            Hey! I know your scores and your plan. Ask me anything — how to do a drill, what a score means, what to focus on this week, or any mechanics question.
          </div>
        </div>

        {messages.map((m, i) => (
          <div key={i} className={s.msg} data-role={m.role}>
            <div className={s.msgBubble} data-role={m.role}>{m.text}</div>
          </div>
        ))}

        {loading && (
          <div className={s.msg} data-role="assistant">
            <div className={s.msgBubble} data-role="assistant">
              <span className={s.typing}>Thinking…</span>
            </div>
          </div>
        )}

      </div>

      <div className={s.inputRow}>
        <input
          className={s.input}
          placeholder="How do I do the hip separation drill?"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={loading}
        />
        <button
          type="button"
          className={s.sendBtn}
          onClick={send}
          disabled={loading || !input.trim()}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
