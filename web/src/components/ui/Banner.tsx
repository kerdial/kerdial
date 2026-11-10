import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

/**
 * A business error, stated in place.
 *
 * The rule this exists to enforce: **validation and business
 * errors always render inside the drawer, modal or panel that owns them, and
 * only successes become toasts.** A banner is the in-place half of that; a
 * toast that carries an error is the failure it prevents.
 *
 * Hoisted here from the Contrôles restyle, which built the same
 * treatment in its own stylesheet — three screens need it (four banners on
 * one, "FX can't be edited here" on another, three on the third), and the 3px
 * inset left bar is the sort of detail that comes out one pixel different the
 * second time somebody re-implements it.
 *
 * `action` is for the one case the design gives a banner a control: a network
 * error with a retry. It is not a general slot for putting buttons in errors.
 */
export type BannerTone = "loss" | "warn" | "neutral" | "brand";

export interface BannerProps {
  readonly tone: BannerTone;
  /**
   * Optional: a banner whose whole content is one sentence passes it as
   * `children` and omits this, rather than passing an empty title and
   * rendering a stray empty node.
   */
  readonly title?: string;
  readonly children?: ReactNode;
  readonly icon?: IconName;
  readonly action?: ReactNode;
  readonly testId?: string;
}

const DEFAULT_ICON: Record<BannerTone, IconName> = {
  loss: "circle-alert",
  warn: "alert-triangle",
  neutral: "info",
  brand: "info",
};

export function Banner({ tone, title, children, icon, action, testId }: BannerProps) {
  return (
    <div
      // `role="alert"` only for the tones that report a problem the user must
      // act on. A neutral informational banner announcing itself assertively
      // would interrupt whatever is being read to say nothing urgent.
      role={tone === "loss" || tone === "warn" ? "alert" : "status"}
      data-testid={testId}
      data-tone={tone}
      className={`k-banner k-banner-${tone}`}
    >
      <Icon name={icon ?? DEFAULT_ICON[tone]} size="sm" className="k-banner-icon" />
      <div className="k-banner-body">
        {title !== undefined && title !== "" ? <p className="k-banner-title">{title}</p> : null}
        {children !== undefined ? <div className="k-banner-message">{children}</div> : null}
      </div>
      {action !== undefined ? <div className="k-banner-action">{action}</div> : null}
    </div>
  );
}
