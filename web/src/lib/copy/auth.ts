/**
 * `copy/auth.ts` — the login screen.
 *
 * **The two failure messages are two, and neither names anything the server
 * said.** A 401 says the pair is wrong; anything else says the attempt failed
 * and can be retried. Collapsing them would lose the only distinction a user
 * can act on, and quoting the server's own `detail` would put English,
 * technical text on the one screen an unauthenticated visitor ever sees —
 * `problem-messages.ts`'s own standing rule, applied here by hand because this
 * route deliberately does not go through the shared mapper for a 401.
 */
export type AuthCopyKey =
  | "title"
  | "email"
  | "password"
  | "invalidCredentials"
  | "failed"
  | "submit"
  | "setupChecking"
  | "setupTitle"
  | "setupIntro"
  | "setupSubmit"
  | "passwordConfirm"
  | "passwordMinHint"
  | "passwordTooShort"
  | "passwordMismatch"
  | "baseCurrency"
  | "setupToken"
  | "setupTokenHint";

export const AUTH_COPY = {
  title: "Connexion",
  email: "Adresse e-mail",
  password: "Mot de passe",
  invalidCredentials: "Adresse e-mail ou mot de passe incorrect.",
  failed: "La connexion a échoué. Merci de réessayer.",
  submit: "Se connecter",

  // --- First-run setup (`account-setup` FR-405-FR-407, UR-63-UR-66). The
  // same route, a different form: these keys are the setup branch's own, and
  // none of them overlaps a login key (UR-64's "no key overlap"). ---

  /** D-5's third state: the probe has not settled, so neither form is shown yet. Transient, and deliberately not an error. */
  setupChecking: "Vérification de la configuration…",
  setupTitle: "Configuration initiale",
  setupIntro:
    "Cette instance n'a encore aucun compte. Créez le premier : il sera l'administrateur de l'instance.",
  setupSubmit: "Créer le compte",
  passwordConfirm: "Confirmer le mot de passe",
  /**
   * `{min}` is `api-limits.ts`'s `NEW_PASSWORD_MIN_LENGTH`, pre-formatted by
   * the caller — never a digit written here (`problem-messages.ts`'s OD-6
   * rule, applied to this catalogue too). Shown as `ui/Input`'s `hint` until
   * the field is touched and fails, and only then as its `error` (LD-5, UR-68).
   */
  passwordMinHint: "Au moins {min} caractères.",
  passwordTooShort: "Le mot de passe doit contenir au moins {min} caractères.",
  passwordMismatch: "Les deux mots de passe ne sont pas identiques.",
  baseCurrency: "Devise de référence",

  // --- The one-time setup token. Only the setup mounting
  // asks for it: the admin create-user form is already authenticated. ---

  setupToken: "Jeton d'installation",
  /**
   * Says **where to find it**, because a field whose value the person does
   * not have is a dead end rather than a control. The two sources are the
   * two the API actually supports (`api/src/auth/setup-token.ts`): the line
   * printed once at start-up while the instance is unclaimed, and the
   * `SETUP_TOKEN` variable an operator may set instead. The command is
   * quoted verbatim so it can be pasted.
   */
  setupTokenHint:
    "Affiché une seule fois au démarrage de l'API : docker compose logs api | grep 'setup token'. " +
    "Si la variable SETUP_TOKEN est définie sur le serveur, c'est sa valeur.",
} as const satisfies Readonly<Record<AuthCopyKey, string>>;
