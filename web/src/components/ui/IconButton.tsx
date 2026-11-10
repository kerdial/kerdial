import type { ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./Icon.js";

/**
 * An icon-only control.
 *
 * `label` is **required**, and that is the design system's accessibility decision
 * rather than ours: an icon-only control always announces its action. Keeping
 * it required in the type is what makes that structural — an unlabelled icon
 * button cannot be written, so it cannot be reviewed-and-missed.
 */
export type IconButtonVariant = "plain" | "outline" | "soft" | "solid";
export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "children"
> {
  readonly icon: IconName;
  readonly label: string;
  readonly size?: IconButtonSize;
  readonly variant?: IconButtonVariant;
  readonly round?: boolean;
}

const VARIANT_CLASS: Record<IconButtonVariant, string> = {
  plain: "k-iconbtn-plain",
  outline: "k-iconbtn-outline",
  soft: "k-iconbtn-soft",
  solid: "k-iconbtn-solid",
};

const ICON_SIZE = { sm: "sm", md: "sm", lg: "md" } as const;

export function IconButton({
  icon,
  label,
  size = "md",
  variant = "plain",
  round = false,
  type = "button",
  ...rest
}: IconButtonProps) {
  const className = [
    "k-iconbtn",
    `k-iconbtn-${size}`,
    VARIANT_CLASS[variant],
    round ? "k-iconbtn-round" : "",
  ]
    .filter((c) => c.length > 0)
    .join(" ");

  return (
    <button {...rest} type={type} aria-label={label} title={label} className={className}>
      <Icon name={icon} size={ICON_SIZE[size]} />
    </button>
  );
}
