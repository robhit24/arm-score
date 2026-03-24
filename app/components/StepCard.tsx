import s from "./StepCard.module.css";

export function StepCard({
  num,
  title,
  desc,
}: {
  num: string;
  title: string;
  desc: string;
}) {
  return (
    <div className={s.card}>
      <div className={s.header}>
        <div className={s.num}>{num}</div>
        <div className={s.title}>{title}</div>
      </div>
      <div className={s.desc}>{desc}</div>
    </div>
  );
}
