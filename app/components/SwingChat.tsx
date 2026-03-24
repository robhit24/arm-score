"use client";

import { useState, useRef, useEffect } from "react";
import type { Result } from "../types";
import s from "./SwingChat.module.css";

type Message = { role: "user" | "assistant"; text: string };

export function SwingChat({ result }: { result: Result }) {
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
        body: JSON.stringify({ question: q, result, history: updated.slice(-6) }),
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
      <div className={s.promptWrap}>
        <button type="button" className={s.promptBtn} onClick={() => setOpen(true)}>
          <span className={s.promptIcon}>🤖</span>
          <span className={s.promptText}>
            <span className={s.promptTitle}>Have a question about your score?</span>
            <span className={s.promptSub}>Ask BatIQ AI</span>
          </span>
          <span className={s.promptArrow}>→</span>
        </button>
      </div>
    );
  }

  return (
    <div className={s.wrap}>
      <div className={s.header}>
        <div className={s.headerLeft}>
          <span className={s.headerIcon}>🤖</span>
          <span className={s.headerTitle}>BatIQ AI</span>
        </div>
        <button type="button" className={s.closeBtn} onClick={() => setOpen(false)}>✕</button>
      </div>

      <div className={s.messages} ref={messagesRef}>
        <div className={s.msg} data-role="assistant">
          <div className={s.msgBubble} data-role="assistant">
            I&apos;ve analyzed your swing. Your score is {result.score} with timing at {result.breakdown.timing}, power at {result.breakdown.power_transfer}, and bat control at {result.breakdown.bat_control}. Ask me anything — what a score means, how to fix an issue, or what drills would help.
          </div>
        </div>

        {messages.map((m, i) => (
          <div key={i} className={s.msg} data-role={m.role}>
            <div className={s.msgBubble} data-role={m.role}>
              {m.text}
            </div>
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
          placeholder="Ask about your swing..."
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
