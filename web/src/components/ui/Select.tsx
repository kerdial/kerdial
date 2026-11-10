import { useId, type SelectHTMLAttributes } from "react";
import { Icon } from "./Icon.js";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * A native `<select>` under the design's shell.
 *
 * Native rather than a custom listbox on purpose: the app's existing selects
 * (`CurrencySelect`, `ExchangeMicSelect`) are native, mobile gets the platform
 * picker for free, and nothing in the design's select spec needs behaviour the
 * native element cannot provide. The transaction drawer's asset combobox *does* need more,
 * and that is a separate component, not a reason to rebuild this one.
 */
export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "className" | "size" | "children"
> {
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly options: readonly SelectOption[];
  readonly size?: "sm" | "md" | "lg";
}

export function Select({ label, hint, error, options, size = "md", id, ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const messageId = `${selectId}-message`;
  const hasError = error !== undefined;
  const message = error ?? hint;

  return (
    <div className={`k-field k-field-${size}`}>
      {label !== undefined ? (
        <label htmlFor={selectId} className="k-field-label">
          {label}
        </label>
      ) : null}
      <div className={`k-input-shell k-select-shell${hasError ? " k-input-shell-error" : ""}`}>
        <select
          {...rest}
          id={selectId}
          className="k-select"
          aria-invalid={hasError ? true : undefined}
          aria-describedby={message !== undefined ? messageId : undefined}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size="sm" className="k-select-chevron" />
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
