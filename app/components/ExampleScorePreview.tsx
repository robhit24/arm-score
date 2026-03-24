import s from "./ExampleScorePreview.module.css";

export function ExampleScorePreview() {
  return (
    <div className={s.wrap}>
      <div className={s.card}>
        <div className={s.badgeWrap}>
          <div className={s.badge}>Example result</div>
        </div>

        <div className={s.scoreWrap}>
          <div className={s.scoreNum}>89</div>
          <div className={s.scoreLabel}>Pitch Score</div>
          <div className={s.scoreSub}>Elite mechanics — top 10% of athletes</div>
        </div>

        <div className={s.bars}>
          {[
            { label: "Arm Path", value: 91 },
            { label: "Mechanics", value: 88 },
            { label: "Command", value: 86 },
          ].map((item) => (
            <div key={item.label} className={s.barItem}>
              <div className={s.barHeader}>
                <span>{item.label}</span>
                <span className={s.barValue}>{item.value}</span>
              </div>
              <div className={s.barTrack}>
                <div className={s.barFill} style={{ width: `${item.value}%` }} />
              </div>
            </div>
          ))}
        </div>

        <div className={s.fixes}>
          <div className={s.fixesTitle}>Top 3 fixes</div>
          <div className={s.fixList}>
            {[
              "Elbow drops below shoulder at foot strike",
              "Glove side flies open early — leaks power",
              "Stride lands short — limits hip drive",
            ].map((text, idx) => (
              <div key={idx} className={s.fixItem}>
                <div className={s.fixIcon}>
                  <div className={s.fixIconDot} />
                </div>
                <div className={s.fixText}>{text}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={s.proTip}>
        <div className={s.proTipTitle}>Pro tip</div>
        <div className={s.proTipBody}>
          Best results come from a side-angle video where your full body
          and arm path are visible through the entire delivery.
        </div>
      </div>
    </div>
  );
}
