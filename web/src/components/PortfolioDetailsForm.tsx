import { useState } from "react";
import { useForm, type FieldErrors, type Resolver } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createPortfolioBodySchema, updatePortfolioBodySchema } from "@kerdial/api-contracts";
import { PORTFOLIO_ACCENT_COLORS, type PortfolioAccentColor } from "@kerdial/core-reference-data";
import {
  ApiError,
  createPortfolio,
  deletePortfolioIcon,
  setPortfolioIcon,
  updatePortfolio,
  type PortfolioSummary,
} from "../lib/api-client.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { PORTFOLIO_COPY } from "../lib/copy/portfolios.js";
import { iconBytesToBase64, type PickState } from "../lib/icon-pick.js";
import { portfolioAccentColor } from "../lib/portfolio-accent.js";
import { messageForError } from "../lib/problem-messages.js";
import {
  invalidateAfterPortfolioCreate,
  invalidateAfterPortfolioIconWrite,
  invalidateAfterPortfolioUpdate,
} from "../lib/queries.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { PortfolioIconField, iconIntentOf, type IconIntent } from "./PortfolioIconField.js";
import { Button } from "./ui/index.js";

/**
 * `PortfolioDetailsForm.tsx` — **was `PortfolioNameForm.tsx`**
 * (FR-476, NG8).
 *
 * Still the single form body for **both** create and edit — D12's structural
 * property, unchanged and now carrying four more fields: one `Resolver` over
 * `createPortfolioBodySchema`/`updatePortfolioBodySchema`, both built from the
 * *same* field schemas in `@kerdial/api-contracts`, not a convention two
 * files could drift out of. Mirrors `InstrumentCreateForm.tsx`'s own
 * hand-written `Resolver` (not `@hookform/resolvers`'s `zodResolver`, for the
 * same reason: `handleSubmit`'s `onValid` needs the raw, trimmed form value
 * ready for the request body, not a `z.infer` wrapper).
 *
 * It also stays mounted from the **existing** entry points only — the list
 * row's pencil, the detail header's button and the create dialog. **No new
 * dashboard-card inline-edit surface** (NG8).
 *
 * ## Submission shape, and why "only what changed" is a correctness property
 *
 * **Create** sends one `POST` carrying everything, icon included (FR-455): the
 * server validates the icon *before* any database work, so a rejected file
 * leaves neither a portfolio row nor an icon row. That atomicity is the reason
 * the icon travels in the body here and nowhere else.
 *
 * **Edit** sends a `PATCH` carrying **only the fields react-hook-form reports
 * as dirty**. That is not tidiness: `updatePortfolioBodySchema` is a
 * `z.strictObject` with an "at least one field must be present" refinement
 * (FR-457), so a body with a key the user never touched is a *silent
 * overwrite*, and an empty body is a `400`. Hence {@link buildPatchBody} below,
 * and hence the submit button is **disabled** when nothing is dirty and no icon
 * change is pending — an untouched form must not be able to issue a request the
 * server would refuse.
 *
 * An empty text field means **clear it**: `""` maps to `null`, which the schema
 * accepts and the route writes as `NULL` (FR-453). Absent-versus-null is the
 * whole of that requirement and JSON already expresses it, so there is no
 * sentinel and no `clear: []`.
 *
 * ## The edit path is deliberately not atomic, and says so
 *
 * An edit that changes both a field and the icon issues the `PATCH` **first**
 * and the icon `PUT`/`DELETE` **second, sequentially**. A failed icon upload
 * therefore leaves the field edits committed and reported on the icon field
 * rather than silently rolled back — and the list is invalidated as soon as the
 * `PATCH` returns, so the screen behind the dialog shows the values that did
 * persist. FR-455's atomicity requirement is scoped to *creation*; a two-write
 * edit cannot be made atomic without putting 341 KiB of base64 into the `PATCH`
 * body, which PD-11 rejected. Stated rather than hidden (A-1).
 *
 * ## Why the field is hand-styled instead of mounting the kit's `<Input>`
 *
 * Kerdial skin, and it is structural rather than cosmetic: the kit's
 * input puts its message *outside* the `<label>`, in a sibling of
 * `.k-input-shell`. This form's tests read the field error as
 * `input.closest("label")` -> `[role="alert"]`, and `portfolio-crud.spec.ts`
 * reads it as the input's own parent element. Both would go blind against that
 * shell. The label therefore keeps wrapping its input and its error, and the
 * name field's `data-testid`s are unchanged across the rename for the same
 * reason.
 */

export interface PortfolioDetailsFormValues {
  name: string;
  broker: string;
  description: string;
  /** `""` is « Aucune » — the picker's clear affordance (FR-453), mapped to `null` on the wire. */
  accentColor: PortfolioAccentColor | "";
}

/** The four editable row fields, in the order they are rendered and validated. */
const ROW_FIELDS = ["name", "broker", "description", "accentColor"] as const;

/**
 * Accent label per token. A `Record` keyed by the tuple's own member type, so
 * adding a seventh ramp slot to `PORTFOLIO_ACCENT_COLORS` is a type error here
 * rather than a blank swatch at runtime — `Icon.tsx`'s REGISTRY argument.
 */
const ACCENT_LABEL: Record<PortfolioAccentColor, string> = {
  CHART_1: PORTFOLIO_COPY.accentChart1,
  CHART_2: PORTFOLIO_COPY.accentChart2,
  CHART_3: PORTFOLIO_COPY.accentChart3,
  CHART_4: PORTFOLIO_COPY.accentChart4,
  CHART_5: PORTFOLIO_COPY.accentChart5,
  CHART_6: PORTFOLIO_COPY.accentChart6,
};

function defaultValuesFor(portfolio: PortfolioSummary | undefined): PortfolioDetailsFormValues {
  return {
    name: portfolio?.name ?? "",
    broker: portfolio?.broker ?? "",
    description: portfolio?.description ?? "",
    accentColor: portfolio?.accentColor ?? "",
  };
}

/** `""` ⇒ `null` (clear it), anything else ⇒ its trimmed self. The server trims too; trimming here keeps the sent value and the stored value identical. */
function nullableField(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The `POST` body: every field the user actually filled, plus the icon when one
 * was picked. Empty optional fields are **omitted** rather than sent as `null`
 * — on create there is no prior value for `null` to clear, and
 * `createPortfolioBodySchema` marks them `.optional()`, not `.nullable()`.
 */
export function buildCreateBody(
  values: PortfolioDetailsFormValues,
  icon: IconIntent,
): Record<string, unknown> {
  const body: Record<string, unknown> = { name: values.name.trim() };
  const broker = nullableField(values.broker);
  if (broker !== null) body["broker"] = broker;
  const description = nullableField(values.description);
  if (description !== null) body["description"] = description;
  if (values.accentColor !== "") body["accentColor"] = values.accentColor;
  if (icon.kind === "set") {
    body["icon"] = {
      declaredContentType: icon.contentType,
      bytesBase64: iconBytesToBase64(icon.bytes),
    };
  }
  return body;
}

/**
 * The `PATCH` body: **only** the keys react-hook-form reports as dirty.
 *
 * `dirtyFields` is react-hook-form's own diff against `defaultValues`, so a
 * field the user typed into and then restored is correctly *not* dirty. A key
 * absent here means "leave unchanged" on the wire, which is exactly what the
 * server reads it as.
 *
 * Exported so the form's submit path and the test that pins the body shape read
 * one rule rather than two copies of it.
 */
export function buildPatchBody(
  values: PortfolioDetailsFormValues,
  dirtyFields: Partial<Record<keyof PortfolioDetailsFormValues, boolean | undefined>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dirtyFields.name === true) body["name"] = values.name.trim();
  if (dirtyFields.broker === true) body["broker"] = nullableField(values.broker);
  if (dirtyFields.description === true) body["description"] = nullableField(values.description);
  if (dirtyFields.accentColor === true) {
    body["accentColor"] = values.accentColor === "" ? null : values.accentColor;
  }
  return body;
}

/**
 * One resolver, two schemas. Each mode validates the body *it* would send, so a
 * bound violation lands on the offending field rather than as a form-level
 * message — the issue path and the field name are the same identifier by
 * construction.
 *
 * In edit mode all four keys are validated even though only the dirty ones are
 * sent: a stored value is already valid, so this costs nothing and it keeps the
 * resolver independent of `dirtyFields` (which react-hook-form does not hand a
 * resolver).
 */
function portfolioDetailsResolver(mode: "create" | "edit"): Resolver<PortfolioDetailsFormValues> {
  return async (values) => {
    const candidate =
      mode === "create"
        ? buildCreateBody(values, { kind: "keep" })
        : {
            name: values.name.trim(),
            broker: nullableField(values.broker),
            description: nullableField(values.description),
            accentColor: values.accentColor === "" ? null : values.accentColor,
          };
    const schema = mode === "create" ? createPortfolioBodySchema : updatePortfolioBodySchema;
    const result = schema.safeParse(candidate);
    if (result.success) {
      return { values, errors: {} };
    }
    const errors: FieldErrors<PortfolioDetailsFormValues> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join(".");
      const fieldName = (
        (ROW_FIELDS as readonly string[]).includes(path) ? path : "name"
      ) as keyof PortfolioDetailsFormValues;
      if (errors[fieldName] === undefined) {
        errors[fieldName] = { type: issue.code, message: issue.message };
      }
    }
    return { values: {}, errors };
  };
}

const FIELD_CLASS = "k-pf-input";
const LABEL_CLASS = "k-pf-field";
const ERROR_CLASS = "k-pf-error";

function FieldError({ message }: { message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p role="alert" className={ERROR_CLASS}>
      {message}
    </p>
  );
}

/** Error surfacing branches on `ApiError.code`, never on the raw response body. */
const NAME_ALREADY_EXISTS_MESSAGE = "Ce nom est déjà utilisé par un autre portefeuille.";
const TENANT_CAP_EXCEEDED_MESSAGE =
  "Vous avez atteint la limite de 500 portefeuilles. Supprimez-en un avant d'en créer un nouveau.";
const NOT_FOUND_MESSAGE = "Ce portefeuille n'existe plus.";
const THROTTLED_MESSAGE = "Trop d'opérations simultanées. Réessayez dans un instant.";

/** The six `PORTFOLIO_ICON_*` codes are routed to the icon field rather than to the form banner — the failure belongs to the control that caused it. */
function isPortfolioIconCode(err: unknown): boolean {
  return err instanceof ApiError && (err.code ?? "").startsWith("PORTFOLIO_ICON_");
}

export interface PortfolioDetailsFormProps {
  mode: "create" | "edit";
  /** Required for `mode: "edit"` — the row being edited (id + current values to prefill, `hasIcon` to decide whether removal is offered). */
  portfolio?: PortfolioSummary;
  onSaved: (portfolio: PortfolioSummary) => void;
  onCancel: () => void;
  /**
   * An edit against a portfolio that has vanished concurrently
   * (404 `PORTFOLIO_NOT_FOUND`) closes the dialog and invalidates the list —
   * the caller owns surfacing the "this portfolio no longer exists" notice once
   * closed.
   */
  onNotFound?: () => void;
  /**
   * Called after a successful `PUT`/`DELETE /portfolios/:id/icon`, so the screen
   * that manages this portfolio's icon can bump its `iconVersion`. The
   * invalidation half is done here; the bump is local React state this form
   * does not own, and **both halves are required** — the flag alone leaves a
   * stale bitmap, the bump alone leaves `hasIcon` stale after a removal.
   */
  onIconWritten?: () => void;
}

export function PortfolioDetailsForm({
  mode,
  portfolio,
  onSaved,
  onCancel,
  onNotFound,
  onIconWritten,
}: PortfolioDetailsFormProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const [pick, setPick] = useState<PickState>({ kind: "none" });
  const [removeRequested, setRemoveRequested] = useState(false);
  /** Whether the failed request was the icon one — set before the icon write, so a network failure lands on the icon field too, not only a coded rejection. */
  const [iconPhase, setIconPhase] = useState(false);
  /** Whether the `PATCH` committed before the icon write failed — the honest half of A-1's non-atomicity. */
  const [fieldsCommitted, setFieldsCommitted] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm<PortfolioDetailsFormValues>({
    resolver: portfolioDetailsResolver(mode),
    defaultValues: defaultValuesFor(mode === "edit" ? portfolio : undefined),
  });

  const iconIntent = iconIntentOf(pick, removeRequested);
  const dirtyFieldNames = ROW_FIELDS.filter((field) => dirtyFields[field] === true);
  /**
   * FR-457, enforced at the control: with nothing dirty and no icon change the
   * `PATCH` body would be `{}`, which the server refuses with a `400`. A
   * disabled button is the honest answer; issuing the request and rendering the
   * refusal would be blaming the user for the form's own emptiness.
   */
  const nothingToSubmit =
    mode === "edit" && dirtyFieldNames.length === 0 && iconIntent.kind === "keep";

  const mutation = useMutation({
    mutationFn: async (values: PortfolioDetailsFormValues): Promise<PortfolioSummary> => {
      setIconPhase(false);
      setFieldsCommitted(false);
      if (mode === "create") {
        // One request, icon included — the server validates the bytes before
        // any database work, so a rejected icon leaves no row behind (FR-455).
        return createPortfolio(buildCreateBody(values, iconIntent));
      }
      // `portfolio` is required for `mode: "edit"` by this component's own
      // contract (`PortfolioFormDialog`'s prop typing enforces it) — this guard
      // only exists to keep TypeScript's control-flow narrowing happy.
      if (portfolio === undefined) {
        throw new Error("PortfolioDetailsForm: mode 'edit' requires a portfolio prop");
      }
      let saved = portfolio;
      const patch = buildPatchBody(values, dirtyFields);
      if (Object.keys(patch).length > 0) {
        saved = await updatePortfolio(portfolio.id, patch);
        // Dropped **now**, before the icon write that may fail: the row edits
        // are committed, and the screen behind this dialog must not keep
        // showing the pre-`PATCH` values just because the icon did not make it.
        await invalidateAfterPortfolioUpdate(queryClient);
        setFieldsCommitted(true);
      }
      if (iconIntent.kind !== "keep") {
        setIconPhase(true);
        if (iconIntent.kind === "set") {
          await setPortfolioIcon({
            portfolioId: portfolio.id,
            // The **sniffed** type, not `file.type`: the browser's guess comes
            // from the extension and is exactly the value FR-460 refuses to
            // trust. The server sniffs again and rejects a disagreement.
            declaredContentType: iconIntent.contentType,
            bytesBase64: iconBytesToBase64(iconIntent.bytes),
          });
        } else {
          await deletePortfolioIcon(portfolio.id);
        }
        await invalidateAfterPortfolioIconWrite(queryClient);
        onIconWritten?.();
        setIconPhase(false);
        saved = { ...saved, hasIcon: iconIntent.kind === "set" };
      }
      return saved;
    },
    // F1 (`InstrumentCreateForm.tsx`/`TransactionForm.tsx` precedent): a write
    // path is never paused/replayed offline.
    networkMode: "always",
    onSuccess: async (result) => {
      // Create touches every combined key (a new portfolio
      // changes `portfolioCount`); an edit touches the list only, and already
      // did so inside `mutationFn` above.
      if (mode === "create") {
        await invalidateAfterPortfolioCreate(queryClient);
        if (iconIntent.kind === "set") onIconWritten?.();
      }
      onSaved(result);
    },
    onError: async (err) => {
      if (!(err instanceof ApiError)) return;
      if (err.code === "PORTFOLIO_NAME_ALREADY_EXISTS") {
        setError("name", { type: "conflict", message: NAME_ALREADY_EXISTS_MESSAGE });
        return;
      }
      if (mode === "edit" && err.status === 404 && err.code === "PORTFOLIO_NOT_FOUND") {
        await invalidateAfterPortfolioUpdate(queryClient);
        onNotFound?.();
        return;
      }
      // Any other error (icon rejection/cap/throttle/generic) renders inline.
    },
  });

  const onValid = (values: PortfolioDetailsFormValues) => {
    mutation.mutate(values);
  };

  const iconErrorMessage = ((): string | undefined => {
    if (!mutation.isError) return undefined;
    if (!iconPhase && !isPortfolioIconCode(mutation.error)) return undefined;
    const specific = messageForError(mutation.error).text;
    return fieldsCommitted ? `${PORTFOLIO_COPY.iconFailed} ${specific}` : specific;
  })();

  const genericErrorMessage = ((): string | undefined => {
    if (!mutation.isError) return undefined;
    if (iconErrorMessage !== undefined) return undefined; // routed to the icon field
    const err = mutation.error;
    if (err instanceof ApiError) {
      if (err.code === "PORTFOLIO_NAME_ALREADY_EXISTS") return undefined; // routed to the field above
      if (err.code === "PORTFOLIO_TENANT_CAP_EXCEEDED") return TENANT_CAP_EXCEEDED_MESSAGE;
      if (err.code === "ADMISSION_BOUND_EXCEEDED") return THROTTLED_MESSAGE;
      if (mode === "edit" && err.status === 404 && err.code === "PORTFOLIO_NOT_FOUND") {
        return NOT_FOUND_MESSAGE;
      }
    }
    return mode === "create" ? "La création a échoué." : "L'enregistrement a échoué.";
  })();

  const busy = isSubmitting || mutation.isPending;

  return (
    <form
      data-testid="portfolio-name-form"
      className="k-pf-form-shell"
      onSubmit={(event) => void handleSubmit(onValid)(event)}
    >
      <div className="k-dialog-body k-pf-form">
        <label className={LABEL_CLASS}>
          {PORTFOLIO_COPY.nameField}
          <input
            type="text"
            data-testid="portfolio-name-input"
            className={FIELD_CLASS}
            autoFocus
            {...register("name")}
          />
          <FieldError message={errors.name?.message} />
        </label>

        <label className={LABEL_CLASS}>
          {PORTFOLIO_COPY.brokerField}
          <input
            type="text"
            data-testid="portfolio-broker-input"
            className={FIELD_CLASS}
            placeholder={PORTFOLIO_COPY.brokerPlaceholder}
            {...register("broker")}
          />
          <FieldError message={errors.broker?.message} />
        </label>

        <label className={LABEL_CLASS}>
          {PORTFOLIO_COPY.descriptionField}
          <textarea
            data-testid="portfolio-description-input"
            className={FIELD_CLASS}
            rows={3}
            placeholder={PORTFOLIO_COPY.descriptionPlaceholder}
            {...register("description")}
          />
          <FieldError message={errors.description?.message} />
        </label>

        {/* A radiogroup of native radios: « Aucune » is the first option and is
            the clear affordance FR-453 asks for, not a separate reset button.
            The swatch is a colour *sample* — PD-15's "a ring, never a fill"
            governs the tile, where the colour sits behind the wallet glyph;
            here nothing is drawn on top of it. */}
        <div
          className={LABEL_CLASS}
          role="radiogroup"
          aria-label={PORTFOLIO_COPY.accentField}
          data-testid="portfolio-accent-group"
        >
          <span>{PORTFOLIO_COPY.accentField}</span>
          <div className="k-pf-swatches">
            <label className="k-pf-swatch">
              <input type="radio" value="" {...register("accentColor")} />
              {PORTFOLIO_COPY.accentNone}
            </label>
            {PORTFOLIO_ACCENT_COLORS.map((token) => (
              <label key={token} className="k-pf-swatch">
                <input type="radio" value={token} {...register("accentColor")} />
                <span
                  aria-hidden="true"
                  className="k-pf-swatch-dot"
                  style={{ background: portfolioAccentColor(token) }}
                />
                {ACCENT_LABEL[token]}
              </label>
            ))}
          </div>
          <FieldError message={errors.accentColor?.message} />
        </div>

        <PortfolioIconField
          hasIcon={mode === "edit" && portfolio?.hasIcon === true}
          pick={pick}
          onPickChange={setPick}
          removeRequested={removeRequested}
          onRemoveRequestedChange={setRemoveRequested}
          errorMessage={iconErrorMessage}
          disabled={busy}
        />

        {genericErrorMessage !== undefined && (
          <p role="alert" className={ERROR_CLASS} data-testid="portfolio-name-form-error">
            {genericErrorMessage}
          </p>
        )}

        {!online && (
          <p role="alert" className={ERROR_CLASS} data-testid="portfolio-name-form-offline-error">
            {COMMON_COPY.offlineExplanation}
          </p>
        )}
      </div>

      <div className="k-dialog-foot">
        <Button variant="ghost" data-testid="portfolio-name-form-cancel" onClick={onCancel}>
          {COMMON_COPY.cancel}
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="portfolio-name-form-submit"
          disabled={!online || nothingToSubmit || pick.kind === "rejected"}
          loading={busy}
        >
          {mode === "create" ? PORTFOLIO_COPY.createSubmit : PORTFOLIO_COPY.editSubmit}
        </Button>
      </div>
    </form>
  );
}
