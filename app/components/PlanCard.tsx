import { Chip } from "./Chip";
import { CheckLine } from "./CheckLine";
import { money } from "../lib/utils";
import s from "./PlanCard.module.css";

export function PlanCard({
  label,
  price,
  perDay,
  strike,
  badge,
  badgeTone,
  subtitle,
  bullets,
  href,
  primary,
  enabled,
  onClick,
}: {
  label: string;
  price: number;
  perDay: string;
  strike?: string;
  badge?: string;
  badgeTone?: "dark" | "red" | "green" | "amber";
  subtitle: string;
  bullets: string[];
  href: string;
  primary?: boolean;
  enabled: boolean;
  onClick?: () => void;
}) {
  return (
    <a
      href={href}
      target={href === "#" ? undefined : "_blank"}
      rel="noreferrer"
      className={s.link}
      data-disabled={!enabled}
      onClick={(e) => {
        if (onClick) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div
        className={s.card}
        data-primary={!!primary}
        data-disabled={!enabled}
      >
        <div className={s.topSection}>
          <div className={s.badgeRow}>
            <div className={s.label}>{label}</div>
            {badge ? <Chip text={badge} tone={badgeTone || "dark"} /> : null}
          </div>

          <div className={s.priceRow}>
            <div className={s.price}>{money(price)}</div>
            <div className={s.priceDetail}>
              {strike ? <div className={s.strike}>{strike}</div> : null}
              <div className={s.perDay}>{perDay}</div>
            </div>
          </div>

          <div className={s.subtitle}>{subtitle}</div>
        </div>

        <div className={s.separator} />

        <div className={s.bottomSection}>
          <div className={s.bullets}>
            {bullets.map((b, idx) => (
              <CheckLine key={idx} text={b} />
            ))}
          </div>

          <button
            className={s.cta}
            data-primary={!!primary}
            data-disabled={!enabled}
          >
            Get My {label} →
          </button>

          <div className={s.delivery}>
            Delivered by email in{" "}
            <span className={s.deliveryAccent}>minutes</span>
          </div>
        </div>
      </div>
    </a>
  );
}
