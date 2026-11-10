import { useId, type ChangeEventHandler } from "react";

/**
 * A checkbox with a label and an optional description line — the shape the
 * design uses for "inclure les frais dans le prix de revient" and the ledger
 * filter panel's two toggles.
 *
 * The description is wired through `aria-describedby` rather than merely
 * rendered next to the control, so it is announced with the checkbox instead
 * of being read as unrelated text after it.
 */
export interface CheckboxProps {
  readonly label: string;
  readonly description?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly name?: string;
  readonly onChange?: ChangeEventHandler<HTMLInputElement>;
}

export function Checkbox({ label, description, checked, disabled, name, onChange }: CheckboxProps) {
  const id = useId();
  const descriptionId = `${id}-description`;

  return (
    <div className="k-checkbox">
      <input
        type="checkbox"
        id={id}
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="k-checkbox-input"
        aria-describedby={description !== undefined ? descriptionId : undefined}
      />
      <div className="k-checkbox-text">
        <label htmlFor={id} className="k-checkbox-label">
          {label}
        </label>
        {description !== undefined ? (
          <p id={descriptionId} className="k-checkbox-description">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}
