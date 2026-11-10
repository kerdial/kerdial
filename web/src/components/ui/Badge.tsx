import type { HTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

/**
 * A status pill. `tone` is the whole point of the component: the design fixes
 * which meaning gets which colour, and a call site picking a colour directly
 * is how "complete = gain, failed = loss" drifts into three different greens.
 *
 * `dot` renders a status dot instead of an icon — the skin requires the
 * instruments table to signal status with a dot and **never with a coloured
 * row fill**, and this is the affordance that makes that easy to comply with.
 */
export type BadgeTone = "neutral" | "brand" | "gain" | "loss" | "warn" | "accent";

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "className"> {
  readonly tone?: BadgeTone;
  readonly icon?: IconName;
  readonly dot?: boolean;
  readonly children?: ReactNode;
}

export function Badge({ tone = "neutral", icon, dot = false, children, ...rest }: BadgeProps) {
  return (
    <span {...rest} className={`k-badge k-badge-${tone}`} data-tone={tone}>
      {dot ? <span className="k-badge-dot" aria-hidden="true" /> : null}
      {!dot && icon !== undefined ? <Icon name={icon} size="xs" /> : null}
      {children}
    </span>
  );
}
