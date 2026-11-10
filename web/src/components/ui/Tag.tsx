import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon.js";
import { COMMON_COPY } from "../../lib/copy/common.js";

/**
 * A removable chip — the ledger's "active filters" strip is the call site this
 * exists for.
 *
 * `color` takes a CSS custom-property reference for the leading dot, normally
 * an asset-class token. It is deliberately not a free-form colour input in
 * spirit: the token lint rule rejects a literal here, so the only values that
 * can reach it are tokens.
 */
export interface TagProps extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "color"> {
  /** e.g. `var(--class-etf)`. Omit for a plain neutral chip. */
  readonly color?: string;
  readonly removable?: boolean;
  readonly onRemove?: () => void;
  /** Announced by the remove button, which is otherwise an unlabelled ×. */
  readonly removeLabel?: string;
  readonly children?: ReactNode;
}

export function Tag({
  color,
  removable = false,
  onRemove,
  removeLabel,
  children,
  ...rest
}: TagProps) {
  return (
    <span {...rest} className="k-tag">
      {color !== undefined ? (
        <span className="k-tag-dot" style={{ background: color }} aria-hidden="true" />
      ) : null}
      {children}
      {removable ? (
        <button
          type="button"
          onClick={onRemove}
          className="k-tag-remove"
          aria-label={removeLabel ?? COMMON_COPY.remove}
        >
          <Icon name="x" size="xs" />
        </button>
      ) : null}
    </span>
  );
}
