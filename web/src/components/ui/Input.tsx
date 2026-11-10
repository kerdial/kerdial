import { useId, type InputHTMLAttributes } from "react";
import { Icon, type IconName } from "./Icon.js";

/**
 * A labelled text input with hint, error and unit-suffix slots.
 *
 * Two things this owns so call sites cannot get them wrong:
 *
 * - **`numeric`** right-aligns and applies `.k-num`. Every money or quantity
 *   field sets it; that is how the tabular-figures rule becomes
 *   structural instead of a review note.
 * - **`error`** replaces the hint, reddens the border, and wires
 *   `aria-invalid` + `aria-describedby`. The design puts validation inline and
 *   per-field; an error that is only a red border announces nothing.
 */
export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "size"
> {
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly iconLeft?: IconName;
  /** Trailing unit — "EUR", "%", "titres". */
  readonly suffix?: string;
  readonly numeric?: boolean;
  readonly size?: "sm" | "md" | "lg";
}

export function Input({
  label,
  hint,
  error,
  iconLeft,
  suffix,
  numeric = false,
  size = "md",
  id,
  ...rest
}: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const messageId = `${inputId}-message`;
  const hasError = error !== undefined;
  const message = error ?? hint;

  return (
    <div className={`k-field k-field-${size}`}>
      {label !== undefined ? (
        <label htmlFor={inputId} className="k-field-label">
          {label}
        </label>
      ) : null}
      <div className={`k-input-shell${hasError ? " k-input-shell-error" : ""}`}>
        {iconLeft !== undefined ? (
          <Icon name={iconLeft} size="sm" className="k-input-icon" />
        ) : null}
        <input
          {...rest}
          id={inputId}
          className={`k-input${numeric ? " k-input-numeric k-num" : ""}`}
          aria-invalid={hasError ? true : undefined}
          aria-describedby={message !== undefined ? messageId : undefined}
          inputMode={numeric ? "decimal" : rest.inputMode}
        />
        {suffix !== undefined ? <span className="k-input-suffix">{suffix}</span> : null}
      </div>
      {message !== undefined ? (
        <p
          id={messageId}
          className={hasError ? "k-field-error" : "k-field-hint"}
          role={hasError ? "alert" : undefined}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
