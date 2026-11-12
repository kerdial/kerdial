/**
 * `copy/access-tokens.ts` — « Accès pour assistants IA » on « Mon compte »
 * and its create dialog (ADR-0019; MCP-FR-19..MCP-FR-23, MCP-L2, MCP-L11,
 * MCP-L17).
 *
 * The server's refusals (`ACCESS_TOKEN_LIMIT_REACHED`,
 * `ACCESS_TOKEN_NOT_FOUND`, `CURRENT_PASSWORD_INCORRECT`, the login backoff)
 * are worded in `problem-messages.ts`, not here: one code, one sentence,
 * wherever it surfaces. `sessionEnded` is the exception because it is not a
 * mapping of `UNAUTHENTICATED` in general — only this dialog renders that
 * code instead of leaving it to the global handler.
 */
export type AccessTokensCopyKey =
  | "sectionTitle"
  | "intro"
  | "passwordNote"
  | "docLink"
  | "empty"
  | "create"
  | "dialogTitle"
  | "labelLabel"
  | "labelHint"
  | "expiryLabel"
  | "expiry30"
  | "expiry90"
  | "expiry180"
  | "expiry365"
  | "expiryNever"
  | "neverNote"
  | "currentPasswordLabel"
  | "currentPasswordHint"
  | "scope"
  | "disclosure"
  | "acknowledge"
  | "submit"
  | "sessionEnded"
  | "secretTitle"
  | "secretLabel"
  | "secretWarning"
  | "copy"
  | "copied"
  | "copyFailed"
  | "close"
  | "colLabel"
  | "colCreated"
  | "colExpires"
  | "colLastUsed"
  | "colStatus"
  | "neverUsed"
  | "noExpiry"
  | "statusActive"
  | "statusExpired"
  | "statusRevoked"
  | "revoke"
  | "revokeAria"
  | "revokeTitle"
  | "revokeBody"
  | "revokeConfirm"
  | "cancel";

export const ACCESS_TOKENS_COPY = {
  sectionTitle: "Accès pour assistants IA",
  intro:
    "Un jeton d'accès permet à un assistant IA (Claude Code, Claude Desktop…) de lire vos données de portefeuille, sans rien pouvoir modifier. Aucun accès n'existe tant que vous n'avez pas créé de jeton.",
  /** MCP-L14: a password change revokes every token. */
  passwordNote: "Changer votre mot de passe révoque tous vos jetons.",
  /** MCP-L19: the link opens the public documentation in a new tab. */
  docLink: "Connecter un assistant : documentation",
  /** MCP-FR-1: opt-in — nothing is reachable until a token exists. */
  empty: "Aucun jeton : l'accès pour assistants IA est désactivé.",
  create: "Créer un jeton",
  dialogTitle: "Nouveau jeton d'accès",
  labelLabel: "Nom du jeton",
  labelHint: "Par exemple : Claude Desktop – portable",
  expiryLabel: "Expiration",
  expiry30: "30 jours",
  expiry90: "90 jours",
  expiry180: "180 jours",
  expiry365: "1 an",
  expiryNever: "Jamais",
  /** MCP-L2: « Jamais » is selectable, with this note shown beside it. */
  neverNote: "Un jeton sans expiration reste valable jusqu'à ce que vous le révoquiez.",
  /** MCP-L17: creating a token re-authenticates. */
  currentPasswordLabel: "Mot de passe actuel",
  currentPasswordHint: "Pour confirmer que c'est bien vous qui créez ce jeton.",
  scope:
    "Ce jeton donne accès en lecture à toutes les données de portefeuille du foyer, notes comprises. Il ne permet aucune modification.",
  /** MCP-FR-22. */
  disclosure:
    "Les données qu'un assistant IA lit avec ce jeton quittent cette instance et sont envoyées au fournisseur de l'assistant.",
  /** MCP-L11: required, never sent to the server. */
  acknowledge: "J'ai compris que ces données seront transmises au fournisseur de l'assistant.",
  submit: "Créer le jeton",
  /** `401 UNAUTHENTICATED` on create: the session ended while the request waited. */
  sessionEnded:
    "Votre session a pris fin et aucun jeton n'a été créé. Fermez cette fenêtre pour vous reconnecter.",
  secretTitle: "Copiez votre jeton maintenant",
  secretLabel: "Votre jeton",
  secretWarning: "Il ne sera plus jamais affiché. Conservez-le comme un mot de passe.",
  copy: "Copier",
  copied: "Copié",
  /** No clipboard on a plain-HTTP origin, or the browser refused the write. */
  copyFailed: "Copie impossible ici : sélectionnez le jeton et copiez-le manuellement.",
  close: "Fermer",
  colLabel: "Nom",
  colCreated: "Créé le",
  colExpires: "Expiration",
  colLastUsed: "Dernière utilisation",
  colStatus: "État",
  neverUsed: "Jamais",
  noExpiry: "Jamais",
  statusActive: "Actif",
  statusExpired: "Expiré",
  statusRevoked: "Révoqué",
  revoke: "Révoquer",
  revokeAria: "Révoquer le jeton {label}",
  revokeTitle: "Révoquer ce jeton ?",
  revokeBody:
    "Les assistants qui l'utilisent perdront l'accès immédiatement. Cette action est définitive.",
  revokeConfirm: "Révoquer",
  cancel: "Annuler",
} as const satisfies Readonly<Record<AccessTokensCopyKey, string>>;
