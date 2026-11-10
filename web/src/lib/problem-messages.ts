import { ApiError } from "./api-client.js";
import { formatIsoDateFr } from "./history-status-copy.js";
// The ledger's base currency, reused rather than re-typed — `transaction-form-payload.ts`
// already owns the constant and the form and this message must not disagree
// about which currency a rate converts *to*.
import { BASE_CURRENCY as BASE_CURRENCY_CODE } from "./transaction-form-payload.js";
import {
  INSTRUMENT_ICON_MAX_BYTES,
  INSTRUMENT_ICON_MAX_PIXELS,
} from "@kerdial/core-reference-data";
import {
  INSTRUMENT_ICON_TENANT_ROW_CAP,
  MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES,
  MANUAL_PRICE_POINT_TENANT_ROW_CAP,
  MAX_CASH_ACCOUNTS_PER_PORTFOLIO,
  MAX_CLOSED_POSITIONS_PER_VIEW,
  MAX_DIVIDEND_INSTRUMENTS_PER_VIEW,
  MAX_HOLDINGS_PER_VIEW,
  MAX_PORTFOLIOS_PER_TENANT,
  MAX_REALIZED_GAINS_PER_HOLDING,
  MAX_SALE_LOTS_PER_CLOSED_POSITION,
  MAX_WATCHLIST_ITEMS_PER_TENANT,
  WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES,
} from "./api-limits.js";

/**
 * `problem-messages.ts` — UR-6 (FR-110/FR-113/FR-122, AC99/AC105/AC114, OD-6).
 *
 * `messageForError(err)` turns an RFC 9457 `application/problem+json`
 * response (`api-client.ts`'s `ApiError`) into a non-technical, French,
 * user-facing message. **The server's `detail`/`title` is never rendered**
 * anywhere below — those strings are English and technical (e.g. "at most 36
 * requests in flight are allowed") and would
 * violate FR-128/AC120 as well as FR-110's "never a raw error dump".
 *
 * **Resolution order (load-bearing — this must stay code-first):**
 *
 * 1. `err instanceof ApiError` and `err.code` is in {@link MESSAGE_TABLE} ->
 *    that entry. This precedes any status-based branch, because
 *    `MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED` is a **429** and must read as a
 *    capacity limit, not "trop de requêtes" — a status-first mapper would
 *    mislabel it (FR-122 asks for a throttled state on genuine 429s; this one
 *    is a cap, not a throttle).
 * 2. `err instanceof ApiError` with an unmapped `code` (or no `code`) -> a
 *    status-class default (400/404/409/422/429/5xx), plus a DEV-only
 *    `console.warn` naming the unmapped code (mirroring `Figure.tsx`'s
 *    existing DEV-warn precedent), so a newly added server code becomes
 *    visible to a developer instead of degrading silently forever.
 * 3. Not an `ApiError` and `navigator.onLine === false` -> the offline
 *    message.
 * 4. Otherwise -> the generic fallback message.
 *
 * Cap-referencing messages interpolate from `api-limits.ts` — never a
 * hardcoded digit in this file (OD-6).
 *
 * **Scope decision:** this mapper is the single mechanism for
 * *new* surfaces only. The existing forms (`InstrumentCreateForm`,
 * `PortfolioNameForm`, `TransactionForm`) keep their own inline copy this
 * cycle — retrofitting them would churn security-reviewed components with no
 * requirement behind it. The table below already contains their codes, so a
 * later convergence is a deletion, not a rewrite.
 */
export interface UiMessage {
  readonly text: string;
  readonly tone: "error" | "warning" | "info";
}

const OFFLINE_MESSAGE: UiMessage = {
  text: "Hors ligne — cette action nécessite une connexion.",
  tone: "warning",
};

const GENERIC_FALLBACK_MESSAGE: UiMessage = {
  text: "Une erreur inattendue s'est produite. Réessayez.",
  tone: "error",
};

/** `Intl.NumberFormat("fr-FR")` — the same French thousands-grouping every cap-referencing message below interpolates through, never a hardcoded digit string (OD-6). */
function frCount(n: number): string {
  return new Intl.NumberFormat("fr-FR").format(n);
}

/**
 * The six icon-rejection sentences, as **objects** rather than as entries —
 * because two code families point at each one.
 *
 * `instrument-icons` wrote them; `portfolio-details` found every
 * one of them already entity-neutral (« Cette image est trop volumineuse … »,
 * « Seules les images PNG et JPEG sont acceptées. »), and the six
 * `PORTFOLIO_ICON_*` codes are one-for-one with the six `INSTRUMENT_ICON_*`
 * ones by construction: `portfolio-icon.validate.ts` is
 * `instrument-icon.validate.ts`'s rejection set with a renamed prefix, over the
 * same `sniffInstrumentIcon` and the same ceilings (FR-460, PD-13).
 *
 * So: **one value, two keys.** A seventh-through-twelfth copy of a French
 * sentence is how the two families start wording the same refusal differently,
 * and the `MESSAGE_TABLE` entries below reference these constants rather than
 * repeating them.
 *
 * `INSTRUMENT_ICON_TENANT_CAP_EXCEEDED` is deliberately **not** in this set:
 * its sentence names instruments, and there is no portfolio-icon row cap for a
 * twin to be emitted for.
 *
 * The per-code notes the original entries carried are preserved verbatim
 * below, including the divergence record the group comment in
 * `MESSAGE_TABLE` cross-references.
 */
const ICON_MALFORMED_BASE64_MESSAGE: UiMessage = {
  // A transport problem, not a picture problem — the file never arrived
  // intact. `error`, since waiting changes nothing.
  text: "Ce fichier n'a pas pu être transmis correctement. Réessayez en le sélectionnant à nouveau.",
  tone: "error",
};

const ICON_TOO_LARGE_MESSAGE: UiMessage = {
  // Names the ceiling, from `@kerdial/core-reference-data` rather than as
  // a digit typed here (OD-6). « Ko » follows FR-315's own copy
  // verbatim (assumption A6) rather than being silently corrected to
  // « Kio », which would diverge from the string the spec locked.
  text: `Cette image est trop volumineuse : ${frCount(INSTRUMENT_ICON_MAX_BYTES / 1024)} Ko au maximum.`,
  tone: "error",
};

const ICON_UNSUPPORTED_FORMAT_MESSAGE: UiMessage = {
  text: "Seules les images PNG et JPEG sont acceptées.",
  tone: "error",
};

const ICON_UNREADABLE_MESSAGE: UiMessage = {
  // The signature matched but the header did not parse — a damaged or
  // truncated file. Distinct from the line above on purpose: "choose
  // another format" and "this file is damaged" are two different actions.
  text: "Cette image n'a pas pu être lue : le fichier semble incomplet ou endommagé.",
  tone: "error",
};

const ICON_TYPE_MISMATCH_MESSAGE: UiMessage = {
  // FR-292: the disagreement is itself the signal. The copy says what was
  // observed without naming either side's value — the declared type is a
  // client-supplied string and is never echoed (FR-304, NFR-4(b)).
  text: "Le contenu de ce fichier ne correspond pas à son type déclaré. Réenregistrez-le en PNG ou en JPEG.",
  tone: "error",
};

const ICON_DIMENSIONS_EXCEEDED_MESSAGE: UiMessage = {
  text: `Cette image dépasse la taille maximale de ${frCount(INSTRUMENT_ICON_MAX_PIXELS)} × ${frCount(INSTRUMENT_ICON_MAX_PIXELS)} pixels.`,
  tone: "error",
};

/**
 * Message table.
 */
export const MESSAGE_TABLE: Readonly<Record<string, UiMessage>> = {
  // --- Transaction write/edit/delete/FX-rate endpoints (FR-110) ---
  TRANSACTION_INSUFFICIENT_QUANTITY: {
    text: "Cette opération est refusée : elle entraînerait une vente à découvert (quantité détenue insuffisante).",
    tone: "error",
  },
  TRANSACTION_FX_EDIT_FORBIDDEN: {
    text: "Le taux de change n'est pas modifiable ici : utilisez l'action dédiée de correction de change.",
    tone: "error",
  },
  // `cash-interest` (F-A1): the PATCH raw-body refusal of a `kind`.
  TRANSACTION_KIND_NOT_EDITABLE: {
    text: "La nature d'une opération ne se modifie pas : supprimez-la puis saisissez-la à nouveau avec la bonne nature.",
    tone: "error",
  },
  TRANSACTION_EDIT_EMPTY: {
    text: "Aucune modification n'a été saisie.",
    tone: "error",
  },
  TRANSACTION_GROSS_AMOUNT_NOT_EDITABLE: {
    text: "Le montant brut de cette transaction n'est pas modifiable.",
    tone: "error",
  },
  TRANSACTION_UNIT_PRICE_NOT_EDITABLE: {
    text: "Le prix unitaire de cette transaction n'est pas modifiable.",
    tone: "error",
  },
  TRANSACTION_SELF_SETTLED: {
    text: "Cette transaction ne peut pas se régler elle-même.",
    tone: "error",
  },
  TRANSACTION_INVALID_SHAPE: {
    text: "Les informations saisies pour cette transaction sont incohérentes.",
    tone: "error",
  },
  TRANSACTION_AMOUNT_NOT_POSITIVE: {
    text: "Le montant saisi doit être strictement positif.",
    tone: "error",
  },
  TRANSACTION_EDIT_NOT_EXPRESSIBLE: {
    // Also the code for "this edit would add a fee/withholding leg the
    // row never had" (CA-10's `TransactionCashLegNotAddableError`). That input
    // briefly surfaced as `TRANSACTION_INVALID_SHAPE` after migration `0038`,
    // whose message ("les informations saisies sont incohérentes") is
    // misleading here — the input is fine, the endpoint cannot express it, and
    // the plain statement is the honest one. (A fee can now be added on a
    // cash-settled BUY/SELL/DRIP/CURRENCY_EXCHANGE, so the old advice to
    // recreate the row no longer fits most of the inputs that reach here.)
    text: "Cette modification n'est pas possible sur ce type de transaction.",
    tone: "error",
  },
  // The edit path's half of the 8th kind's shape. The record
  // path already refused these bodies by name; `editTransaction` did not, so
  // the same input travelled to `transaction_share_distribution_shape` and came
  // back as a constraint violation nobody could read.
  TRANSACTION_SHARE_DISTRIBUTION_INVALID_SHAPE: {
    // Says what the kind *is*, then what to do — the field that was refused
    // lives in the problem document's `detail`, which is never rendered
    // (FR-110/AC120), so the copy has to stand without it. Deliberately not
    // `TRANSACTION_INVALID_SHAPE`'s « informations incohérentes »: the user
    // entered a perfectly coherent price or account, on a row that has neither.
    text: "Une attribution d'actions gratuites ne comporte ni prix unitaire, ni compte espèce, ni frais : ce champ ne peut pas lui être ajouté. Supprimez puis recréez la transaction si l'opération était d'une autre nature.",
    tone: "error",
  },
  // --- `security-transfer`: the five codes the transfer write
  // paths add. Each message stands alone,
  // since the `detail` naming the field or the portfolio is never rendered.
  // `TRANSACTION_INSUFFICIENT_QUANTITY` and `PORTFOLIO_NOT_FOUND` are reused
  // as they are, above and below.
  TRANSFER_DESTINATION_IS_SOURCE: {
    text: "Le portefeuille de destination doit être différent du portefeuille d'origine.",
    tone: "error",
  },
  TRANSFER_DESTINATION_NOT_FOUND: {
    // Also the answer for another tenant's portfolio (AC-471), so the copy
    // says "not found" and nothing more.
    text: "Le portefeuille de destination est introuvable.",
    tone: "error",
  },
  TRANSACTION_TRANSFER_IN_NOT_CREATABLE: {
    text: "Une entrée de titres se crée depuis la sortie : indiquez le portefeuille de destination sur le transfert sortant.",
    tone: "error",
  },
  TRANSACTION_TRANSFER_TARGET_READ_ONLY: {
    // Note **and** reference: FR-578 as amended (ND-5 (b)).
    text: "Cette entrée de titres est liée à un transfert sortant : seules sa note et sa référence sont modifiables. Modifiez le transfert d'origine pour changer la quantité ou la valeur.",
    tone: "error",
  },
  TRANSACTION_TRANSFER_INVALID_SHAPE: {
    text: "Un transfert de titres ne comporte ni prix unitaire, ni compte espèce, ni frais : ce champ ne peut pas lui être ajouté. Supprimez puis recréez la transaction si l'opération était d'une autre nature.",
    tone: "error",
  },
  // A 500 with a name: an internal invariant broke and nothing was
  // written. Code-first resolution puts this ahead of the generic 500 copy.
  TRANSFER_PROPAGATION_DID_NOT_SETTLE: {
    text: "Le recalcul des transferts de titres n'a pas abouti et rien n'a été enregistré. Réessayez ; si l'erreur persiste, signalez-la.",
    tone: "error",
  },
  // --- Cash accounts (CA-11) ------------
  TRANSACTION_PORTFOLIO_NOT_EDITABLE: {
    text: "Une transaction ne peut pas être déplacée vers un autre portefeuille : supprimez puis recréez-la.",
    tone: "error",
  },
  CASH_ACCOUNT_NOT_FOUND: {
    text: "Ce compte espèce est introuvable dans ce portefeuille.",
    tone: "error",
  },
  CASH_ACCOUNT_CURRENCY_MISMATCH: {
    text: "La devise de ce compte espèce ne correspond pas à celle de l'opération.",
    tone: "error",
  },
  CASH_ACCOUNT_ARCHIVED: {
    text: "Ce compte espèce est archivé : choisissez-en un autre ou désarchivez-le.",
    tone: "error",
  },
  CASH_ACCOUNT_REQUIRED: {
    text: "Indiquez le compte espèce concerné par cette opération.",
    tone: "error",
  },
  // CA-19: the 409 `CashAccountsController` returns on create **and** rename
  // (AC-172/AC-184 — uniqueness is `(tenant, portfolio, name)`, so a name
  // free in another portfolio is genuinely free).
  CASH_ACCOUNT_NAME_ALREADY_EXISTS: {
    text: "Ce nom de compte espèce est déjà utilisé dans ce portefeuille.",
    tone: "error",
  },
  CASH_ACCOUNT_NOT_ALLOWED: {
    text: "Cette opération ne mouvemente aucune espèce : aucun compte espèce ne peut lui être associé.",
    tone: "error",
  },
  // --- The five codes the fee-tax-breakdown cycle added ---
  //
  // Absent from this table, they fell through to a status-class default here
  // and — on `TransactionForm`, which renders `problem.detail` directly — put
  // the server's English sentence on screen, internal doc references and all
  // (cases D3/D5). The cycle added five codes and this table
  // learned none of them.
  //
  // Each says what the user has to *do*, since in every one of these five the
  // input is well formed and something specific is missing or contradictory.
  CASH_AMOUNT_REQUIRED: {
    text: "Ce compte espèce n'est libellé ni dans la devise de l'opération ni dans la devise de référence : indiquez le montant réellement débité ou crédité.",
    tone: "error",
  },
  CASH_AMOUNT_NOT_ACCEPTED: {
    text: "Le montant réglé se déduit de cette opération : laissez ce champ vide.",
    tone: "error",
  },
  CASH_AMOUNT_STALE: {
    text: "Cette modification change le montant brut ou la devise de règlement : indiquez le nouveau montant réglé dans la même opération.",
    tone: "error",
  },
  COST_COMPONENTS_INVALID: {
    text: "Le détail des frais ne correspond pas au total indiqué : laissez le total vide pour qu'il soit calculé, ou corrigez-le.",
    tone: "error",
  },
  IMPLIED_SETTLEMENT_RATE_OUT_OF_RANGE: {
    text: "Le montant réglé est trop faible au regard du montant brut : le taux implicite dépasse ce que le registre peut représenter.",
    tone: "error",
  },
  // F2: the per-portfolio cash-account cap, worded like
  // `PORTFOLIO_TENANT_CAP_EXCEEDED` below and interpolating the mirrored
  // constant rather than a literal (OD-6). A 409, not a rate limit — the
  // wording says what has to change, since waiting never helps.
  CASH_ACCOUNT_PORTFOLIO_CAP_EXCEEDED: {
    text: `Le nombre maximal de comptes espèce (${frCount(MAX_CASH_ACCOUNTS_PER_PORTFOLIO)}) est atteint pour ce portefeuille.`,
    tone: "error",
  },
  // --- Reachable, not in FR-110's literal list, mapped as a superset ---
  TRANSACTION_NOT_FOUND: {
    text: "Cette transaction est introuvable.",
    tone: "error",
  },
  // Found by reading transactions.controller.ts:626 — the DB-level CHECK
  // defence-in-depth path, not in FR-110's literal list but a superset of
  // its stated intent ("every error code returned by these endpoints").
  TRANSACTION_FX_LEG_IMMUTABLE: {
    text: "Le taux de change de cette transaction ne peut plus être modifié.",
    tone: "error",
  },
  TRANSACTION_FX_RATE_UNAVAILABLE: {
    text: "Le taux de change nécessaire à cette transaction n'est pas disponible.",
    tone: "error",
  },
  TRANSACTION_CRYPTO_RATE_UNAVAILABLE: {
    text: "Le cours de cette cryptomonnaie n'est pas disponible pour cette date.",
    tone: "error",
  },
  TRANSACTION_TRADE_DATE_TOO_OLD: {
    text: "La date de cette transaction est trop ancienne.",
    tone: "error",
  },
  TRANSACTION_TRADE_DATE_IN_FUTURE: {
    text: "La date de cette transaction ne peut pas être future.",
    tone: "error",
  },
  TRANSACTION_INVALID_DRIP_SOURCE: {
    text: "La source de ce réinvestissement de dividende est invalide.",
    tone: "error",
  },
  TRANSACTION_INVALID_SETTLEMENT_ASSET: {
    text: "L'actif de règlement sélectionné est invalide pour cette transaction.",
    tone: "error",
  },
  // --- Manual price entry (FR-113) ---
  MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED: {
    text: `Le nombre maximal de prix saisis manuellement (${frCount(MANUAL_PRICE_POINT_TENANT_ROW_CAP)}) est atteint pour votre organisation.`,
    tone: "warning",
  },
  MANUAL_PRICE_POINT_SCALE_EXCEEDED: {
    text: `Ce prix comporte plus de décimales que la limite autorisée (${frCount(MANUAL_PRICE_POINT_CLOSE_MAX_DECIMAL_PLACES)} au maximum).`,
    tone: "error",
  },
  // --- Instrument icons (IK7; FR-292–FR-294, FR-302, FR-315). The seven codes
  // `PUT /instruments/:id/icon` can answer with that a person needs a sentence
  // for; the eighth, `INSTRUMENT_ICON_NOT_FOUND`, is deliberately absent —
  // it is the read route's answer and the `<img>`'s own `onError` renders the
  // fallback tile, so it never reaches this mapper. Added in the same commit
  // as the taxonomy that emits them, for the reason every group above it
  // records: a cycle that ships server codes and leaves this table alone
  // degrades each one to a status-class default (« Cette opération n'a pas pu
  // aboutir. »), which says nothing a user could act on.
  //
  // **Six of these seven strings are not the originally drafted wording, and
  // that is a decision rather than drift.** The first draft had a sentence
  // per code; what ships below says the same thing at the length the
  // surrounding table uses, and in the four cases where the draft conflated two
  // distinct causes it separates them (see `UNREADABLE` versus
  // `MALFORMED_BASE64`). Recorded here, code by code, so the divergence is
  // reviewable:
  //
  //   UNSUPPORTED_FORMAT     draft: « Ce fichier n'est pas une image PNG ou JPEG »
  //   TOO_LARGE              draft: « Ce fichier dépasse 256 Ko »
  //   DIMENSIONS_EXCEEDED    draft: « Image trop grande (512 × 512 pixels maximum) »
  //   TYPE_MISMATCH          draft: « Le type de fichier déclaré ne correspond pas à son contenu »
  //   UNREADABLE             draft: « Cette image est illisible ou incomplète »
  //   MALFORMED_BASE64       draft: « Ce fichier n'a pas pu être lu »
  //   TENANT_CAP_EXCEEDED  the draft specifies only the shape ("the cap message with
  //                        `frCount(INSTRUMENT_ICON_TENANT_ROW_CAP)` interpolated"),
  //                        which the string below is — the one of the seven that
  //                        does **not** diverge.
  //
  // AC-315 is met either way: every string is French and lives in this copy
  // layer, which is the whole of what that criterion asks. Found by GATE-3 and
  // filed as LOW, so the strings are deliberately left alone rather than
  // reverted to the drafts.
  INSTRUMENT_ICON_MALFORMED_BASE64: ICON_MALFORMED_BASE64_MESSAGE,
  INSTRUMENT_ICON_TOO_LARGE: ICON_TOO_LARGE_MESSAGE,
  INSTRUMENT_ICON_UNSUPPORTED_FORMAT: ICON_UNSUPPORTED_FORMAT_MESSAGE,
  INSTRUMENT_ICON_UNREADABLE: ICON_UNREADABLE_MESSAGE,
  INSTRUMENT_ICON_TYPE_MISMATCH: ICON_TYPE_MISMATCH_MESSAGE,
  INSTRUMENT_ICON_DIMENSIONS_EXCEEDED: ICON_DIMENSIONS_EXCEEDED_MESSAGE,
  INSTRUMENT_ICON_TENANT_CAP_EXCEEDED: {
    // A capacity ceiling reached, not a rejected file — `warning`, and the
    // count comes from `api-limits.ts`, the same shape
    // `MANUAL_PRICE_POINT_TENANT_CAP_EXCEEDED` above uses. It is a **429**,
    // which is exactly why this table is consulted before any status branch:
    // a status-first mapper would read it as « trop de requêtes ».
    text: `Le nombre maximal d'images d'instruments (${frCount(INSTRUMENT_ICON_TENANT_ROW_CAP)}) est atteint pour votre organisation.`,
    tone: "warning",
  },
  // --- Portfolio icons (FR-460, FR-464). The six codes `PUT /portfolios/:id/icon` — and `POST
  // /portfolios` carrying an `icon` — can answer with. Each points at the
  // **same object** its `INSTRUMENT_ICON_*` twin does; see the constants above
  // for why that is one value and not a second translation.
  // `PORTFOLIO_ICON_NOT_FOUND` does not exist: the read route answers `404`,
  // `PortfolioIconTile`'s own `onError` renders the wallet fallback, and
  // `DELETE` is `204` unconditionally — so no removal path reaches this mapper.
  PORTFOLIO_ICON_MALFORMED_BASE64: ICON_MALFORMED_BASE64_MESSAGE,
  PORTFOLIO_ICON_TOO_LARGE: ICON_TOO_LARGE_MESSAGE,
  PORTFOLIO_ICON_UNSUPPORTED_FORMAT: ICON_UNSUPPORTED_FORMAT_MESSAGE,
  PORTFOLIO_ICON_UNREADABLE: ICON_UNREADABLE_MESSAGE,
  PORTFOLIO_ICON_TYPE_MISMATCH: ICON_TYPE_MISMATCH_MESSAGE,
  PORTFOLIO_ICON_DIMENSIONS_EXCEEDED: ICON_DIMENSIONS_EXCEEDED_MESSAGE,
  // --- Valuation reads surfaced by the Operations screen (FR-122) ---
  VALUATION_PRICE_UNAVAILABLE: {
    text: "Le prix nécessaire à cette valorisation n'est pas disponible pour le moment.",
    tone: "warning",
  },
  VALUATION_FX_RATE_UNAVAILABLE: {
    text: "Le taux de change nécessaire à cette valorisation n'est pas disponible pour le moment.",
    tone: "warning",
  },
  VALUATION_RESPONSE_TOO_LARGE: {
    text: `Cette vue dépasse la taille maximale prise en charge (${frCount(MAX_HOLDINGS_PER_VIEW)} positions ou ${frCount(MAX_REALIZED_GAINS_PER_HOLDING)} plus-values réalisées par position, au maximum).`,
    tone: "warning",
  },
  // `closed-positions` FR-333 — the « Clôturées » read's own cap refusal.
  // One code for both caps, distinguished server-side by `detail` (which is
  // never rendered, FR-110/AC120), so this names both numbers. Entered here
  // rather than left to fall through to the 422 status default — the exact
  // regression recorded earlier for the two dividend codes, whose cycle
  // shipped the codes and never taught this table about them.
  CLOSED_POSITIONS_RESPONSE_TOO_LARGE: {
    text: `Cette vue dépasse la taille maximale prise en charge (${frCount(MAX_CLOSED_POSITIONS_PER_VIEW)} positions clôturées ou ${frCount(MAX_SALE_LOTS_PER_CLOSED_POSITION)} cessions par position, au maximum).`,
    tone: "warning",
  },
  // --- `watchlist`'s three refusals (FR-340/FR-341/FR-365), plus WL-1's
  // target-price scale refusal ---
  // Entered here rather than left to fall through to a status-class default,
  // for the reason `CLOSED_POSITIONS_RESPONSE_TOO_LARGE` above records: a cycle
  // that ships server codes and does not teach this table about them puts an
  // English `detail` or a wrong-class French sentence on screen.
  WATCHLIST_TENANT_CAP_EXCEEDED: {
    // A capacity ceiling, not a throttle — and it is a **429**, which is
    // exactly why this table is consulted before any status branch: a
    // status-first mapper would tell the user to wait and retry something that
    // will never succeed. Same shape as
    // `INSTRUMENT_ICON_TENANT_CAP_EXCEEDED`, and the count comes from
    // `api-limits.ts` because the problem body deliberately carries none.
    text: `Le nombre maximal d'instruments suivis (${frCount(MAX_WATCHLIST_ITEMS_PER_TENANT)}) est atteint pour votre organisation. Retirez un instrument de la liste pour en suivre un autre.`,
    tone: "warning",
  },
  WATCHLIST_TARGET_PRICE_SCALE_EXCEEDED: {
    // WL-1 — a **400** on a figure the user typed, so it is an
    // `error`, not a warning, and the sentence names the bound the field
    // itself enforces (the editor refuses the 19th digit before sending; this
    // covers the path that reaches the server anyway). Same shape as
    // `MANUAL_PRICE_POINT_SCALE_EXCEEDED`, on the identical column type.
    text: `Ce cours cible comporte plus de décimales que la limite autorisée (${frCount(WATCHLIST_TARGET_PRICE_MAX_DECIMAL_PLACES)} au maximum).`,
    tone: "error",
  },
  WATCHLIST_ITEM_NOT_FOUND: {
    // `PATCH` on an instrument this tenant does not watch. A 404 that is not a
    // missing *instrument*: the row is what is absent, so the copy names the
    // action that fixes it rather than suggesting the instrument is unknown.
    text: "Cet instrument n'est pas dans votre liste de suivi : il n'y a rien à modifier.",
    tone: "warning",
  },
  WATCHLIST_RESPONSE_TOO_LARGE: {
    // FR-365/NFR-39 — refused, never truncated. The one control this screen has
    // is the number of instruments it follows, so that is what the copy names.
    text: `Cette vue dépasse la taille maximale prise en charge (${frCount(MAX_WATCHLIST_ITEMS_PER_TENANT)} instruments suivis, au maximum).`,
    tone: "warning",
  },
  // ADR-0016: the one generic "retry shortly" 429. The server has a
  // single instance-wide admission bound on every /api/v1 route; the
  // per-tenant read/write concurrency codes it replaced are gone.
  ADMISSION_BOUND_EXCEEDED: {
    text: "Trop de requêtes simultanées. Patientez un instant puis réessayez.",
    tone: "warning",
  },
  // --- `GET /dividends/summary`'s two refusals (DV6/DV11). The cycle
  // shipped both codes and this table learned neither, so each fell through to
  // the 422 status default — « Cette opération n'a pas pu aboutir. » — on the
  // Dividendes screen's own DEFAULT view. The same regression the five
  // fee-tax-breakdown codes above were added for.
  DIVIDEND_SUMMARY_RESPONSE_TOO_LARGE: {
    // The cap's own shape, from `api-limits.ts` like every sibling (OD-6): the
    // server refuses rather than truncating (DV6), so this is a *scope* too
    // wide, not a failure — hence `warning`, matching
    // `VALUATION_RESPONSE_TOO_LARGE` above, whose empty state this code shares.
    text: `Cette vue dépasse la taille maximale prise en charge (${frCount(MAX_DIVIDEND_INSTRUMENTS_PER_VIEW)} instruments distribuant un dividende, au maximum).`,
    tone: "warning",
  },
  DIVIDEND_SUMMARY_AMBIGUOUS_TAX_LEG: {
    // DV11: a stored dividend carries a `fee_amount`, so withholding cannot be
    // told from transaction cost and the server refuses the whole figure. It is
    // **permanent** — no cap to wait under, no throttle to retry past — so the
    // copy says the data needs correcting and says outright that retrying
    // changes nothing, rather than leaving a user to rediscover that. It names
    // no instrument and no transaction: the problem document's `detail` carries
    // those and is never rendered (FR-110/AC120).
    text: "Une transaction de dividende comporte des frais : la retenue à la source ne peut pas en être distinguée. Ce total restera indisponible tant que cette transaction n'aura pas été corrigée ; réessayer n'y changera rien.",
    tone: "error",
  },
  // --- `GET /transactions`'s own refusal ---
  TRANSACTION_AMOUNT_FILTER_REQUIRES_CURRENCY: {
    // The endpoint refuses an amount bound with no currency to scope it,
    // because `gross_amount` is in the trade's own denomination and is never
    // converted — comparing 1 000 JPY with 1 000 EUR is the answer this
    // prevents. Says what to do (choose a currency), since the request is well
    // formed and only under-specified; `error` rather than `warning` for the
    // same reason `CASH_AMOUNT_REQUIRED` is — nothing will change by waiting.
    text: "Un filtre par montant ne peut s'appliquer qu'à une seule devise : sélectionnez la devise concernée.",
    tone: "error",
  },
  // --- Portfolio-related (reachable / OD-6 / existing) ---
  PORTFOLIO_NOT_FOUND: {
    text: "Ce portefeuille est introuvable.",
    tone: "error",
  },
  INSTRUMENT_NOT_FOUND: {
    text: "Cet instrument est introuvable.",
    tone: "error",
  },
  // `PATCH /instruments/:id/identity` (instrument-detail identity edit,
  // 2026-09-09): `figi` is fill-once — this is the 409 a second attempt gets,
  // never a silent overwrite (`ledger`'s `setInstrumentFigi`).
  // `DELETE /instruments/:id` refused. This is the **countless** form,
  // used when the server could not enumerate what blocks it (a reference held
  // by another tenant, which row-level security hides from the count); the
  // counted form is in `specificMessage` below and is what a single-tenant
  // deployment always gets.
  INSTRUMENT_DELETE_BLOCKED_BY_LEDGER: {
    text: "Cet instrument ne peut pas être supprimé : des écritures y font encore référence.",
    tone: "error",
  },
  INSTRUMENT_FIGI_ALREADY_SET: {
    text: "Cet instrument a déjà un FIGI enregistré : il ne peut pas être remplacé depuis cet écran.",
    tone: "error",
  },
  // `scpi` cycle (SCD-8): `PATCH /instruments/:id/scpi-attributes`
  // on an instrument that is not an SCPI. The shipped UI offers the section
  // only on an SCPI; this exists so a direct API caller's error reads in French.
  INSTRUMENT_ATTRIBUTES_NOT_APPLICABLE: {
    text: "Ces caractéristiques ne s'appliquent qu'à une SCPI.",
    tone: "warning",
  },
  // --- History reload (IB13; FR-183/FR-184/FR-193) — the distinguishable
  // rejections of `POST /instruments/:id/history-reload` (the 5/hour rate cap
  // has since been removed). None of them promises an automatic retry (NG1) or names
  // a failure reason (NG2); the 404 case is `INSTRUMENT_NOT_FOUND` above,
  // deliberately the same message a genuinely unknown id gets, because the
  // route answers both identically on purpose (it must not become an
  // existence oracle).
  HISTORY_RELOAD_IN_PROGRESS: {
    text: "Une récupération de l'historique est déjà en cours pour cet instrument.",
    tone: "info",
  },
  INSTRUMENT_NOT_BACKFILLABLE: {
    text: "Cet instrument n'a aucune source de cours automatique : son historique se saisit manuellement.",
    tone: "info",
  },
  // `scpi` cycle (SCD-10): `GET /instruments/discovery` for a kind
  // no provider serves (`SCPI`). The shipped create form never searches for
  // one; this exists so a direct API caller's error still reads in French.
  DISCOVERY_NOT_AVAILABLE_FOR_KIND: {
    text: "La recherche n'est pas disponible pour ce type d'instrument : saisissez-le à la main.",
    tone: "info",
  },
  MARKET_DATA_NOT_CONFIGURED: {
    text: "La récupération automatique des cours n'est pas configurée sur cette installation.",
    tone: "warning",
  },
  PORTFOLIO_TENANT_CAP_EXCEEDED: {
    text: `Le nombre maximal de portefeuilles (${frCount(MAX_PORTFOLIOS_PER_TENANT)}) est atteint pour votre organisation.`,
    tone: "warning",
  },
  PORTFOLIO_NAME_ALREADY_EXISTS: {
    text: "Ce nom de portefeuille est déjà utilisé.",
    tone: "error",
  },
  PORTFOLIO_DELETE_BLOCKED_BY_LINKED_TRANSACTION: {
    text: "Ce portefeuille ne peut pas être supprimé : des transactions y sont encore liées.",
    tone: "error",
  },
  DATE_RANGE_TOO_WIDE: {
    text: "La période sélectionnée est trop étendue.",
    tone: "error",
  },
  // --- CSV import, whole-request failures only (CI-22). A file in which *some rows* did not import is a
  // `200` with a summary, never an error — the codes below are the ones that
  // mean no row was ever looked at, so none of them may read as "partially
  // done". The two `HEADER_MISMATCH`/`MALFORMED_FILE` entries are `parse`'s
  // own file-level failures, promoted to a `400` by the controller.
  HEADER_MISMATCH: {
    text: "Ce fichier n'a pas l'en-tête attendu : vérifiez que c'est bien le type de fichier sélectionné, exporté depuis Portfolio Performance.",
    tone: "error",
  },
  MALFORMED_FILE: {
    text: "Ce fichier n'a pas pu être lu comme un export CSV.",
    tone: "error",
  },
  IMPORT_MULTIPART_REQUIRED: {
    text: "Le fichier n'a pas été transmis correctement. Resélectionnez-le puis réessayez.",
    tone: "error",
  },
  IMPORT_FILE_REQUIRED: {
    text: "Aucun fichier n'a été transmis. Sélectionnez un fichier puis réessayez.",
    tone: "error",
  },
  IMPORT_UNEXPECTED_FILE_PART: {
    text: "Le fichier n'a pas été transmis correctement. Resélectionnez-le puis réessayez.",
    tone: "error",
  },
  IMPORT_TOO_MANY_FILES: {
    text: "Un import ne porte que sur un seul fichier à la fois.",
    tone: "error",
  },
  IMPORT_MALFORMED_UPLOAD: {
    text: "L'envoi du fichier a été interrompu. Réessayez.",
    tone: "error",
  },
  IMPORT_FILE_TOO_LARGE: {
    text: "Ce fichier dépasse la taille maximale acceptée pour un import.",
    tone: "warning",
  },
  IMPORT_TOO_MANY_ROWS: {
    text: "Ce fichier contient trop de lignes pour un seul import.",
    tone: "warning",
  },
  IMPORT_REQUEST_INVALID: {
    text: "Cette demande d'import est incomplète : reprenez le choix du portefeuille et du compte espèces.",
    tone: "error",
  },

  // --- `portfolio-export-import`: the two Kerdial packages' whole-file
  // refusals, plus the catalogue export's own ceiling. The same rule as the
  // block above applies — each of these means **no row and no entry was ever
  // looked at**, so none may read as "partially done".
  //
  // The five `400`s are the two whole-file error classes the controller maps
  // (`ImportFileError`'s three `KERDIAL_CSV_*` codes and `CatalogueFileError`'s
  // two readable-document ones). `IMPORT_FILE_TOO_LARGE`, the third code
  // `CatalogueFileError` carries, is **not** repeated here: it is already
  // above, it is the same fact answered by the same status, and a second entry
  // would be a second wording for one refusal.
  KERDIAL_CSV_VERSION_UNSUPPORTED: {
    text: "Ce fichier d'opérations a été écrit par une version de Kerdial que celle-ci ne sait pas relire.",
    tone: "error",
  },
  KERDIAL_CSV_UNKNOWN_COLUMN: {
    text: "Ce fichier d'opérations contient une colonne que cette version ne connaît pas : exportez-le à nouveau depuis Kerdial.",
    tone: "error",
  },
  KERDIAL_CSV_MISSING_COLUMN: {
    text: "Ce fichier d'opérations n'a pas toutes les colonnes attendues : vérifiez qu'il s'agit bien d'un export Kerdial, non modifié.",
    tone: "error",
  },
  KERDIAL_JSON_MALFORMED: {
    text: "Ce fichier n'a pas pu être lu comme un catalogue Kerdial : il n'est pas un document JSON valide.",
    tone: "error",
  },
  KERDIAL_JSON_SCHEMA_VERSION_UNSUPPORTED: {
    text: "Ce catalogue a été écrit par une version de Kerdial que celle-ci ne sait pas relire.",
    tone: "error",
  },
  /**
   * The export side's own refusal — `413`, and the only one of this group that
   * is about a file *leaving* rather than arriving.
   *
   * The two export links are plain `<a href download>` navigations, so a browser hitting this code lands on a raw JSON body rather than
   * on this sentence: the screen states the ceiling and the `icons=omitted`
   * remedy inline, *before* the click, for exactly that reason. This entry is
   * here so that the day any `fetch` path issues the same request — a
   * pre-flight check, an export from another screen — it has a French sentence
   * rather than a status-class default that would say « trop de requêtes ».
   */
  EXPORT_TOO_LARGE: {
    text: "Cet export dépasse la taille maximale : exportez le catalogue sans les icônes, qui en sont la plus grande part.",
    tone: "warning",
  },
  /**
   * The 429 both Kerdial import routes share (`kerdial-import-throttle.interceptor.ts`,
   * `KERDIAL_IMPORT_MAX_CONCURRENT = 1`) — added by a security
   * confirm, F7, which found the code shipped with no French sentence.
   *
   * **Why this one earns a row where `PUBLIC_WRITE_THROTTLED` and
   * `PUBLIC_WRITE_INSTANCE_THROTTLED` deliberately do not** (see the block
   * below): those two mean "too many requests", which is exactly what the 429
   * status-class default says. This one does not — it means *one* import runs at
   * a time on this instance, and the default « Trop de requêtes simultanées »
   * would tell a user who made a single request that they made too many, and
   * leave the actual remedy (wait for the other import to finish) unsaid.
   *
   * No duration in the copy: `Retry-After` is 30 s but that is a floor, not a
   * promise — the slot is held for the whole handler, body receipt included.
   * « quelques instants » is the honest form of a bound the screen cannot state.
   */
  KERDIAL_IMPORT_THROTTLED: {
    text: "Un import est déjà en cours sur cette instance ; réessayez dans quelques instants.",
    tone: "warning",
  },

  // --- `account-setup`: the first-run setup screen,
  // « Mon compte » and « Utilisateurs » all surface their server errors
  // *through this mapper*, unlike `LoginRoute`'s own bespoke 401 handling —
  // so the server's English `detail`/`title` is never rendered on any of
  // them. A 429 here is either the instance-wide `ADMISSION_BOUND_EXCEEDED`
  // above or one of the two anonymous public-write caps on `POST /auth/setup`
  // and `POST /auth/login` (`PUBLIC_WRITE_THROTTLED` per client address,
  // `PUBLIC_WRITE_INSTANCE_THROTTLED` instance-wide).
  // The latter two are deliberately *not* in this table: the 429 status-class
  // default below already reads « Trop de requêtes simultanées. Patientez un
  // instant puis réessayez. », which is the same sentence
  // `ADMISSION_BOUND_EXCEEDED` carries and the right answer for all three. A
  // row per code would only duplicate it.
  SETUP_TOKEN_INVALID: {
    // 403 on `POST /auth/setup`. Says where the value comes
    // from, because the field is the one thing on the first-run screen the
    // person cannot simply re-type from memory — and deliberately does not
    // say whether the token was close, since the attempt is also counted by
    // the login rate limiter.
    text: "Jeton d'installation incorrect. Copiez celui affiché dans le journal de l'API au démarrage.",
    tone: "error",
  },
  SETUP_ALREADY_DONE: {
    // 409 on `POST /auth/setup` when a concurrent request won the race: the
    // instance now has an account, so the answer is "use the login screen",
    // not "retry".
    text: "Cette instance est déjà configurée. Connectez-vous avec le compte existant.",
    tone: "error",
  },
  EMAIL_ALREADY_IN_USE: {
    // 409, and the same wording whichever route produced it (NFR-43: one
    // disclosure posture — a caller must not be able to tell the setup, the
    // self-service and the admin path apart by their messages).
    text: "Cette adresse e-mail est déjà utilisée.",
    tone: "error",
  },
  CURRENT_PASSWORD_INCORRECT: {
    // 401, shown inline on « Mon compte » — which is only reachable because
    // that mutation carries `meta: { skipGlobal401: true }`;
    // without it the global handler would log the user out on a typo.
    text: "Le mot de passe actuel est incorrect.",
    tone: "error",
  },
  NOT_INSTANCE_ADMIN: {
    text: "Vous n'avez pas les droits nécessaires pour cette action.",
    tone: "error",
  },
  UNKNOWN_CURRENCY: {
    // 422 — the code is well-formed but no such currency exists. Says what to
    // do (pick one from the list), because the field is a picker.
    text: "Cette devise n'existe pas. Choisissez-en une dans la liste.",
    tone: "error",
  },
  USER_NOT_FOUND: {
    text: "Ce compte n'existe plus.",
    tone: "error",
  },
};

const STATUS_CLASS_DEFAULTS: Readonly<Record<number, UiMessage>> = {
  400: {
    text: "Cette requête n'est pas valide. Vérifiez les informations saisies.",
    tone: "error",
  },
  404: { text: "Cette ressource est introuvable.", tone: "error" },
  409: { text: "Cette opération est en conflit avec l'état actuel des données.", tone: "error" },
  422: { text: "Cette opération n'a pas pu aboutir.", tone: "error" },
  429: {
    text: "Trop de requêtes simultanées. Patientez un instant puis réessayez.",
    tone: "warning",
  },
};

function statusClassDefault(status: number): UiMessage {
  if (status >= 500) {
    return { text: "Une erreur est survenue côté serveur. Réessayez plus tard.", tone: "error" };
  }
  return STATUS_CLASS_DEFAULTS[status] ?? GENERIC_FALLBACK_MESSAGE;
}

/**
 * Turns any thrown/caught value into a `UiMessage`. See this file's header
 * for the load-bearing resolution order.
 */
/**
 * Messages that can say something **specific** when the problem body carried
 * the facts to say it with, and fall back to their table entry when it did not.
 *
 * `VALUATION_FX_RATE_UNAVAILABLE` is why this exists. « Le taux de change
 * nécessaire à cette valorisation n'est pas disponible pour le moment. » names
 * neither the pair nor the date, so a reader cannot tell which rate is missing,
 * whether it is one holding or all of them, or whether waiting would help. The
 * server has always known the currency and the valuation date; they now travel
 * as RFC 9457 extension members and are rendered here.
 *
 * On the remedy, deliberately: rates come from the ECB daily reference feed
 * (FR-62/FR-63), ingested by the worker. **There is no user-facing control that
 * triggers that ingestion** — no screen surfaces it and no endpoint exposes it
 * — so the copy says the figure appears once that day's rates are ingested and
 * stops there. Promising a button that does not exist would be worse than the
 * vague sentence it replaces.
 */
function specificMessage(err: ApiError): UiMessage | undefined {
  const { params } = err;
  const currency = typeof params.currency === "string" ? params.currency : undefined;
  const valuationDate = typeof params.valuationDate === "string" ? params.valuationDate : undefined;

  if (err.code === "VALUATION_FX_RATE_UNAVAILABLE" && currency !== undefined) {
    const on = valuationDate === undefined ? "" : ` au ${formatIsoDateFr(valuationDate)}`;
    return {
      text:
        `Le taux de change ${currency} → ${BASE_CURRENCY_CODE}${on} n'est pas disponible : aucun ` +
        `taux n'a été publié à cette date ou avant. Les taux proviennent du référentiel quotidien ` +
        `de la BCE ; cette valeur apparaîtra une fois les taux de cette date récupérés.`,
      tone: "warning",
    };
  }

  // A portfolio-level read names the holding it could not price, so
  // the sentence says which one; `ValuationErrorState` renders the range, the
  // fiche link and the one-click remedy beneath it.
  const instrument = priceGapInstrumentLabel(params);
  if (
    err.code === "VALUATION_PRICE_UNAVAILABLE" &&
    valuationDate !== undefined &&
    instrument !== undefined
  ) {
    return {
      text:
        `Le cours de ${instrument} n'est pas disponible au ${formatIsoDateFr(valuationDate)} : ` +
        `aucun cours, automatique ou saisi manuellement, n'a été publié à cette date ou avant.`,
      tone: "warning",
    };
  }

  if (err.code === "VALUATION_PRICE_UNAVAILABLE" && valuationDate !== undefined) {
    return {
      text:
        `Le prix nécessaire à cette valorisation n'est pas disponible au ${formatIsoDateFr(valuationDate)} : ` +
        `aucun cours, automatique ou saisi manuellement, n'a été publié à cette date ou avant. ` +
        `Vous pouvez saisir un cours manuellement depuis la fiche de l'instrument.`,
      tone: "warning",
    };
  }

  // The counted refusal. Says *what* holds the instrument, because
  // « des écritures y font encore référence » leaves the reader with nothing to
  // do: the counts tell them whether this is one stray transaction to delete or
  // a whole position's history they had forgotten about.
  if (err.code === "INSTRUMENT_DELETE_BLOCKED_BY_LEDGER") {
    const parts = [
      countPhrase(params["transactions"], "transaction", "transactions"),
      countPhrase(params["postings"], "écriture comptable", "écritures comptables"),
      countPhrase(params["holdings"], "position", "positions"),
      countPhrase(params["realizedGains"], "plus-value réalisée", "plus-values réalisées"),
    ].filter((part): part is string => part !== undefined);
    if (parts.length > 0) {
      return {
        text:
          `Cet instrument ne peut pas être supprimé : ${joinFr(parts)} y font encore référence. ` +
          `Supprimez d'abord les transactions concernées depuis l'écran Activité.`,
        tone: "error",
      };
    }
  }

  return undefined;
}

/**
 * « NEWCO (Newco SA) », or whichever half the problem carried — the
 * `symbol`/`instrumentName` members of a portfolio-level
 * `VALUATION_PRICE_UNAVAILABLE`. `undefined` when it carried neither.
 */
export function priceGapInstrumentLabel(
  params: Readonly<Record<string, string | number>>,
): string | undefined {
  const symbol = typeof params["symbol"] === "string" ? params["symbol"] : undefined;
  const name = typeof params["instrumentName"] === "string" ? params["instrumentName"] : undefined;
  if (symbol !== undefined && name !== undefined) return `${symbol} (${name})`;
  return symbol ?? name;
}

/** `3` + « transaction » -> « 3 transactions »; `0` and a non-number -> nothing to say. */
function countPhrase(value: unknown, singular: string, plural: string): string | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return `${String(value)} ${value === 1 ? singular : plural}`;
}

/** « a, b et c » — the French list conjunction, not a bare comma join. */
function joinFr(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(", ")} et ${parts[parts.length - 1] as string}`;
}

export function messageForError(err: unknown): UiMessage {
  if (err instanceof ApiError) {
    const specific = specificMessage(err);
    if (specific !== undefined) return specific;
    if (err.code !== undefined) {
      const mapped = MESSAGE_TABLE[err.code];
      if (mapped !== undefined) return mapped;
    }
    if (import.meta.env.DEV) {
      console.warn(
        `problem-messages.ts: unmapped ApiError code — falling back to a status-class default`,
        { status: err.status, code: err.code },
      );
    }
    return statusClassDefault(err.status);
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return OFFLINE_MESSAGE;
  }
  return GENERIC_FALLBACK_MESSAGE;
}
