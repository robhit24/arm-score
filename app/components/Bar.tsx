import { clamp } from "../lib/utils";
import s from "./Bar.module.css";

export function Bar({ label, value }: { label: string; value: number }) {
  const v = clamp(value, 0, 100);

  return (
    <div className={s.wrap}>
      <div className={s.header}>
        <span>{label}</span>
        <span className={s.value}>{v}</span>
      </div>
      <div className={s.track}>
        <div className={s.fill} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}
