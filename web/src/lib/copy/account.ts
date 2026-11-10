/**
 * `copy/account.ts` — **« Mon compte »** (`account-setup` FR-409, UR-67–UR-69).
 *
 * A module of its own rather than more keys in `auth.ts`: that file is the
 * *unauthenticated* screen's catalogue (login, and the first-run setup form
 * that replaces it), while these strings belong to a signed-in user changing
 * their own credentials. The field labels the two screens genuinely share —
 * the 8-character hint, the confirm-mismatch message — stay in `auth.ts` and
 * are read from there, so there is one wording for one rule, not two.
 */
export type AccountCopyKey =
  | "title"
  | "emailSectionTitle"
  | "emailLabel"
  | "emailCurrentPasswordLabel"
  | "emailSubmit"
  | "emailChanged"
  | "passwordSectionTitle"
  | "currentPasswordLabel"
  | "newPasswordLabel"
  | "confirmPasswordLabel"
  | "passwordSubmit"
  | "passwordChanged";

export const ACCOUNT_COPY = {
  title: "Mon compte",
  emailSectionTitle: "Adresse e-mail",
  emailLabel: "Nouvelle adresse e-mail",
  /**
   * The email form re-authenticates, like the password form
   * beside it. Its own label rather than a shared one: the two forms ask the
   * same question but each must read on its own, and `currentPasswordLabel`
   * below belongs to the password section's sequence of three fields.
   */
  emailCurrentPasswordLabel: "Mot de passe actuel",
  emailSubmit: "Modifier l'adresse",
  /** UR-69: an inline success state on the same screen — no navigation away. */
  emailChanged: "Votre adresse e-mail a été modifiée.",
  passwordSectionTitle: "Mot de passe",
  currentPasswordLabel: "Mot de passe actuel",
  newPasswordLabel: "Nouveau mot de passe",
  confirmPasswordLabel: "Confirmer le nouveau mot de passe",
  passwordSubmit: "Modifier le mot de passe",
  /** FR-415/FR-416: the caller's other sessions are revoked, this one survives — said plainly, because it is a security-relevant effect. */
  passwordChanged: "Votre mot de passe a été modifié. Vos autres sessions ont été déconnectées.",
} as const satisfies Readonly<Record<AccountCopyKey, string>>;
