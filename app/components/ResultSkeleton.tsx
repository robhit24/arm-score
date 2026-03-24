import s from "./ResultSkeleton.module.css";

export function ResultSkeleton({ step }: { step: string }) {
  return (
    <div className={s.wrap}>
      <div className={s.spinnerWrap}>
        <div className={s.spinner} />
        <div className={s.stepText}>{step}…</div>
      </div>

      <div className={`${s.scoreCircle} ${s.bone}`} />
      <div className={`${s.labelBar} ${s.bone}`} />
      <div className={`${s.sublabelBar} ${s.bone}`} />

      <div className={s.chipsRow}>
        <div className={`${s.chipSkel} ${s.bone}`} />
        <div className={`${s.chipSkel} ${s.bone}`} />
        <div className={`${s.chipSkel} ${s.bone}`} />
      </div>

      <div className={s.card}>
        <div className={`${s.cardTitle} ${s.bone}`} />
        <div className={s.barRow}>
          {[1, 2, 3].map((i) => (
            <div key={i}>
              <div className={`${s.barLabel} ${s.bone}`} />
              <div className={`${s.barTrack} ${s.bone}`} />
            </div>
          ))}
        </div>
      </div>

      <div className={s.card}>
        <div className={`${s.cardTitle} ${s.bone}`} />
        <div className={s.fixRow}>
          <div className={`${s.fixLine} ${s.bone}`} style={{ width: "85%" }} />
          <div className={`${s.fixLine} ${s.bone}`} style={{ width: "75%" }} />
          <div className={`${s.fixLine} ${s.bone}`} style={{ width: "80%" }} />
        </div>
      </div>
    </div>
  );
}
