import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { AccountForm } from "./AccountForm.js";
import { NEW_PASSWORD_MIN_LENGTH } from "../lib/api-limits.js";

/**
 * `account-setup` UR-63–UR-65/UR-72/UR-74 — the two client-side rules and the
 * pre-selection, at the only layer that can prove "blocked **before** any
 * network call": `onSubmit` is the caller's mutation, so a form that renders
 * an error and still calls it has not blocked anything.
 *
 * Both blocking cases are **paired** with a later, valid submission in the
 * same test (this repo's recorded lesson about a bare `not.toHaveBeenCalled()`
 * right after a click, which passes just as well against a form whose submit
 * handler never runs at all): the guard is only proven if lifting it lets
 * exactly one call through.
 */
const CURRENCIES = [
  { code: "CHF", name: "Franc suisse", minorUnit: 2 },
  { code: "EUR", name: "Euro", minorUnit: 2 },
  { code: "USD", name: "Dollar américain", minorUnit: 2 },
] as const;

const VALID_PASSWORD = "a".repeat(NEW_PASSWORD_MIN_LENGTH);
const TOO_SHORT_PASSWORD = "a".repeat(NEW_PASSWORD_MIN_LENGTH - 1);

/** Any non-empty value: the form never validates it, the server does. */
const SETUP_TOKEN = "a-setup-token-from-the-api-log";

function renderForm(
  onSubmit: (values: {
    email: string;
    password: string;
    baseCurrency?: string;
    setupToken?: string;
  }) => void,
  mode: "setup" | "create-user" = "setup",
): void {
  render(
    (mode === "setup" ? (
      <AccountForm
        mode="setup"
        currencies={CURRENCIES}
        onSubmit={onSubmit}
        pending={false}
        error={undefined}
      />
    ) : (
      <AccountForm mode="create-user" onSubmit={onSubmit} pending={false} error={undefined} />
    )) as ReactElement,
  );
}

function fill(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

describe("<AccountForm> — the setup mounting (UR-63–UR-65)", () => {
  it("pre-selects EUR whatever the list's own order is (UR-65)", () => {
    renderForm(vi.fn());
    // CHF is the first option; EUR is selected anyway, unconditionally.
    expect((screen.getByTestId("setup-base-currency") as HTMLSelectElement).value).toBe("EUR");
  });

  it("states the minimum as a hint before the field is touched, and as an error only after", () => {
    renderForm(vi.fn());
    const hint = screen.getByText(`Au moins ${String(NEW_PASSWORD_MIN_LENGTH)} caractères.`);
    expect(hint).toBeInTheDocument();
    // A hint, not an accusation: no `alert` role and no `aria-invalid` yet.
    expect(hint).not.toHaveAttribute("role", "alert");
    expect(screen.getByTestId("setup-password")).not.toHaveAttribute("aria-invalid");

    fill("setup-password", TOO_SHORT_PASSWORD);
    fireEvent.blur(screen.getByTestId("setup-password"));

    expect(
      screen.getByText(
        `Le mot de passe doit contenir au moins ${String(NEW_PASSWORD_MIN_LENGTH)} caractères.`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("setup-password")).toHaveAttribute("aria-invalid", "true");
  });

  it("blocks a too-short password before any network call — and lets exactly one through once it clears the floor", () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit);

    fill("setup-email", "first@example.test");
    fill("setup-token", SETUP_TOKEN);
    fill("setup-password", TOO_SHORT_PASSWORD);
    fill("setup-password-confirm", TOO_SHORT_PASSWORD);
    fireEvent.click(screen.getByTestId("setup-submit"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        `Le mot de passe doit contenir au moins ${String(NEW_PASSWORD_MIN_LENGTH)} caractères.`,
      ),
    ).toBeInTheDocument();

    // The pairing: the very same form, one character longer, submits. If the
    // block above had leaked, this call count would be 2.
    fill("setup-password", VALID_PASSWORD);
    fill("setup-password-confirm", VALID_PASSWORD);
    fireEvent.click(screen.getByTestId("setup-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      email: "first@example.test",
      password: VALID_PASSWORD,
      baseCurrency: "EUR",
      setupToken: SETUP_TOKEN,
    });
  });

  it("the setup mounting asks for the one-time token, says where to find it, and offers no autofill", () => {
    renderForm(vi.fn());

    const field = screen.getByTestId("setup-token");
    expect(field).toBeInTheDocument();
    // Not a credential of the person filling the form: nothing should offer
    // to save it or fill it from a vault.
    expect(field).toHaveAttribute("autocomplete", "off");
    // The hint names **where the value comes from** — a field whose value
    // the operator cannot find is a dead end rather than a control. Matched
    // on the command, which is the actionable half.
    const hintId = field.getAttribute("aria-describedby");
    expect(hintId).not.toBeNull();
    expect(document.getElementById(hintId!)).toHaveTextContent("docker compose logs api");
  });

  it("the setup mounting keeps username/new-password: the person filling it IS the account", () => {
    renderForm(vi.fn());
    expect(screen.getByTestId("setup-email")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByTestId("setup-password")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByTestId("setup-password-confirm")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
  });

  it("blocks a confirmation mismatch inline (UR-64) — and lets exactly one through once the two match", () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit);

    fill("setup-email", "first@example.test");
    fill("setup-token", SETUP_TOKEN);
    fill("setup-password", VALID_PASSWORD);
    fill("setup-password-confirm", `${VALID_PASSWORD}x`);
    fireEvent.click(screen.getByTestId("setup-submit"));

    expect(onSubmit).not.toHaveBeenCalled();
    // Inline on the field, never a toast: the message is the confirm input's
    // own `aria-describedby` target.
    const confirm = screen.getByTestId("setup-password-confirm");
    expect(confirm).toHaveAttribute("aria-invalid", "true");
    const messageId = confirm.getAttribute("aria-describedby");
    expect(messageId).not.toBeNull();
    expect(document.getElementById(messageId!)).toHaveTextContent(
      "Les deux mots de passe ne sont pas identiques.",
    );

    fill("setup-password-confirm", VALID_PASSWORD);
    fireEvent.click(screen.getByTestId("setup-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("<AccountForm> — the create-user mounting (UR-72)", () => {
  it("is the same form under the admin screen's own testids and submit copy", () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit, "create-user");

    // No base-currency picker on this mounting: the currency is the
    // shared household tenant's, chosen once at first-run setup.
    expect(screen.queryByTestId("admin-create-user-base-currency")).toBeNull();
    expect(screen.getByTestId("admin-create-user-submit")).toHaveTextContent("Créer le compte");
    // The setup mounting's own ids are absent — this is one component, not a
    // second form that happens to look alike.
    expect(screen.queryByTestId("setup-submit")).toBeNull();

    fill("admin-create-user-email", "second@example.test");
    fill("admin-create-user-password", VALID_PASSWORD);
    fill("admin-create-user-password-confirm", VALID_PASSWORD);
    fireEvent.click(screen.getByTestId("admin-create-user-submit"));

    // The shared rules travel with the component, not with the mounting.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // And the setup-only fields travel with the
    // *mounting*: no token input, no currency picker, and neither key on the
    // submitted values. `POST /admin/users` parses the two-field schema, and
    // `AdminUsersRoute.test.tsx` pins the exact argument object.
    expect(screen.queryByTestId("setup-token")).toBeNull();
    expect(onSubmit).toHaveBeenCalledWith({
      email: "second@example.test",
      password: VALID_PASSWORD,
    });
  });

  it("all three credential fields are autocomplete=off: the admin is typing SOMEBODY ELSE'S credentials", () => {
    renderForm(vi.fn(), "create-user");
    // The pair with the setup-mounting assertion above is what makes this a
    // difference between the two mountings rather than a blanket `off`.
    expect(screen.getByTestId("admin-create-user-email")).toHaveAttribute("autocomplete", "off");
    expect(screen.getByTestId("admin-create-user-password")).toHaveAttribute("autocomplete", "off");
    expect(screen.getByTestId("admin-create-user-password-confirm")).toHaveAttribute(
      "autocomplete",
      "off",
    );
  });
});
