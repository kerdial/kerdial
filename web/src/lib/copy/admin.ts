/**
 * `copy/admin.ts` — **« Utilisateurs »**, the instance admin's own screen
 * (`account-setup` FR-418–FR-424, UR-70–UR-73).
 *
 * Its own module for the reason `account.ts` is: a different screen, a
 * different audience, and a catalogue boundary is what lets a copy audit say
 * something about one screen without reading every string in the app.
 *
 * The **« Créer un compte »** form on this screen is `<AccountForm
 * mode="create-user">` — one component, two mountings (UR-72) — so only the
 * strings that *differ* from the setup mounting live here; the shared field
 * labels and the shared password rules stay in `copy/auth.ts`.
 */
export type AdminCopyKey =
  | "title"
  | "forbidden"
  | "listTitle"
  | "columnEmail"
  | "columnCreatedAt"
  | "columnLastLoginAt"
  | "columnActions"
  | "neverLoggedIn"
  | "emptyList"
  | "createTitle"
  | "createSubmit"
  | "createSuccess"
  | "resetTitle"
  | "resetForEmail"
  | "resetSubmit"
  | "resetSuccess";

export const ADMIN_COPY = {
  title: "Utilisateurs",
  /**
   * FR-420/UR-70's route-level half. The menu entry is absent for a
   * non-admin, so this is only ever reached by typing the URL — an honest
   * refusal, not an error: nothing failed, the screen is simply not theirs.
   * The enforcement is the database's (LD-4); this is what the screen says
   * while refusing to ask it anything.
   */
  forbidden: "Cette page est réservée à l'administrateur de l'instance.",
  listTitle: "Comptes du foyer",
  columnEmail: "Adresse e-mail",
  columnCreatedAt: "Création",
  columnLastLoginAt: "Dernière connexion",
  columnActions: "Action",
  /** UR-71: `app_user.last_login_at` is nullable, and a freshly provisioned account genuinely has no value — an explicit state, never a blank cell. */
  neverLoggedIn: "Jamais connecté",
  emptyList: "Aucun compte à afficher.",
  createTitle: "Créer un compte",
  createSubmit: "Créer le compte",
  createSuccess: "Le compte a été créé.",
  resetTitle: "Réinitialiser le mot de passe",
  /** `{email}` is the target account, filled by the caller — the one place this screen names *whose* password is about to change, because an admin acting on the wrong row is the mistake this affordance can make. */
  resetForEmail: "Réinitialiser le mot de passe de {email}",
  resetSubmit: "Réinitialiser",
  resetSuccess: "Le mot de passe a été réinitialisé.",
} as const satisfies Readonly<Record<AdminCopyKey, string>>;
