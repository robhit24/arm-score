import s from "./MiniRow.module.css";

export function MiniRow({ k, v }: { k: string; v: string }) {
  return (
    <div className={s.row}>
      <span className={s.label}>{k}</span>
      <span className={s.value}>{v}</span>
    </div>
  );
}
