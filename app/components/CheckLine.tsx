import s from "./CheckLine.module.css";

export function CheckLine({ text, num }: { text: string; num?: number }) {
  return (
    <div className={s.wrap}>
      <div className={s.icon} data-numbered={num != null}>
        {num != null ? (
          <span className={s.num}>{num}</span>
        ) : (
          <svg className={s.check} viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <div className={s.text}>{text}</div>
    </div>
  );
}
