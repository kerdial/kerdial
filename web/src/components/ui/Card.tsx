import type { HTMLAttributes, ReactNode } from "react";

/**
 * The card recipe: 1px `--border-subtle` plus
 * `--shadow-xs` on white at 18px radius, 20px padding (28px for a hero).
 *
 * `tone="sunken"` exists because of the rule it enforces: **never nest a
 * shadowed card inside another** — a sunken `--paper-200` block is what the
 * design uses instead, and `no-nested-cards.test.ts` checks the negative case.
 * Making the alternative a first-class tone is what makes the rule followable.
 */
export type CardTone = "default" | "sunken" | "brand" | "inverse" | "accent";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "className"> {
  readonly tone?: CardTone;
  /** `"lg"` is the 28px hero padding; `"none"` lets a table sit flush to the edge. */
  readonly padding?: "none" | "default" | "lg";
  readonly interactive?: boolean;
  readonly children?: ReactNode;
}

const TONE_CLASS: Record<CardTone, string> = {
  default: "k-card-default",
  sunken: "k-card-sunken",
  brand: "k-card-brand",
  inverse: "k-card-inverse",
  accent: "k-card-accent",
};

const PADDING_CLASS = {
  none: "k-card-pad-none",
  default: "k-card-pad",
  lg: "k-card-pad-lg",
} as const;

export function Card({
  tone = "default",
  padding = "default",
  interactive = false,
  children,
  ...rest
}: CardProps) {
  const className = [
    "k-card",
    TONE_CLASS[tone],
    PADDING_CLASS[padding],
    interactive ? "k-card-interactive" : "",
  ]
    .filter((c) => c.length > 0)
    .join(" ");

  return (
    <section {...rest} className={className} data-tone={tone}>
      {children}
    </section>
  );
}
