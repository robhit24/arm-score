import s from "./Chip.module.css";

export function Chip({
  text,
  tone,
}: {
  text: string;
  tone: "dark" | "red" | "green" | "amber";
}) {
  return (
    <span className={s.chip} data-tone={tone}>
      <span className={s.dot} />
      {text}
    </span>
  );
}
