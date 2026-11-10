import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

/**
 * The kit's button, after the design's `ButtonProps` contract.
 *
 * `primary` is "the one committing action per view" and `accent` is the
 * celebratory CTA — a distinction worth preserving in the type even though
 * this milestone ships no celebratory action, because collapsing them would
 * make the accent colour available for ordinary work, and apricot is the
 * colour the design most insists is not a money signal.
 *
 * Hover, press, focus and disabled are handled here rather than per call site:
 * one step darker plus a 1px lift on hover, `scale(.97)` with an inset shadow
 * on press, a 2px focus ring at 2px offset that cannot be removed, and 45%
 * opacity with `not-allowed` when disabled. All of it runs on the duration
 * tokens, so `prefers-reduced-motion: reduce` collapses it without this file
 * mentioning the media query.
 */
export type ButtonVariant = "primary" | "accent" | "secondary" | "ghost" | "soft" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly iconLeft?: IconName;
  readonly iconRight?: IconName;
  readonly fullWidth?: boolean;
  readonly loading?: boolean;
  readonly children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "k-btn-primary",
  accent: "k-btn-accent",
  secondary: "k-btn-secondary",
  ghost: "k-btn-ghost",
  soft: "k-btn-soft",
  danger: "k-btn-danger",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "k-btn-sm",
  md: "k-btn-md",
  lg: "k-btn-lg",
};

export function Button({
  variant = "secondary",
  size = "md",
  iconLeft,
  iconRight,
  fullWidth = false,
  loading = false,
  disabled = false,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const className = [
    "k-btn",
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    fullWidth ? "k-btn-full" : "",
  ]
    .filter((c) => c.length > 0)
    .join(" ");

  return (
    <button
      {...rest}
      type={type}
      // A loading button is disabled for the same reason it is loading: the
      // action is already in flight, and a second submit is the bug this
      // prevents. `aria-busy` is what tells a screen reader the difference
      // between that and an action that is simply unavailable.
      disabled={disabled || loading}
      aria-busy={loading ? true : undefined}
      className={className}
    >
      {loading ? (
        <Icon name="loader" size={size === "lg" ? "md" : "sm"} className="k-spin" />
      ) : iconLeft !== undefined ? (
        <Icon name={iconLeft} size={size === "lg" ? "md" : "sm"} />
      ) : null}
      {children}
      {iconRight !== undefined && !loading ? (
        <Icon name={iconRight} size={size === "lg" ? "md" : "sm"} />
      ) : null}
    </button>
  );
}
