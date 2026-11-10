import { useState } from "react";
import { Controller, useForm, type FieldErrors, type Resolver } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createInstrumentBodySchema,
  industryLabelSchema,
  isSymbolBasedInstrumentKind,
  isValidIsinCheckDigit,
  type InstrumentKind,
} from "@kerdial/api-contracts";
import {
  ApiError,
  createInstrument,
  searchInstruments,
  type DiscoveryCandidate,
  type InstrumentSummary,
} from "../lib/api-client.js";
import { COMMON_COPY } from "../lib/copy/common.js";
import { fill } from "../lib/copy/fill.js";
import { INSTRUMENT_COPY } from "../lib/copy/instruments.js";
import { useOnlineStatus } from "../hooks/use-online-status.js";
import { sectorDisplayLabel } from "../lib/sector-display.js";
import { InstrumentDiscoverySearch } from "./InstrumentDiscoverySearch.js";
import { ExchangeMicSelect } from "./ExchangeMicSelect.js";
import { CurrencySelect } from "./CurrencySelect.js";
import { Button, Input, Select } from "./ui/index.js";

/**
 * The instrument-creation form — closes a gap: T-37 shipped `POST /instruments` but no UI task ever
 * called it, so T-44's transaction-form instrument picker could only search
 * an already-empty catalogue. AC1/AC2: a share/ETF/
 * fund is added by ISIN + exchange MIC to a canonical record with no
 * duplicate on re-add; a crypto instrument is added by symbol alone, no
 * ISIN required.
 *
 * Same conventions `TransactionForm.tsx` (T-44) established: React Hook Form
 * with a hand-written `Resolver` (validation still runs through the exact
 * same `createInstrumentBodySchema` `api` validates `POST /instruments`
 * against, `@kerdial/api-contracts` — the
 * shared-Zod-schema requirement — this resolver only changes *which* value
 * `handleSubmit` receives on success), fields structurally present/absent by
 * `kind` (ISIN/MIC for ISIN-based kinds, symbol for symbol-based kinds —
 * never both, mirroring CURRENCY_EXCHANGE's own structural omission of
 * instrument fields in T-44), touch targets ≥44px, `inputmode="decimal"`
 * n/a here (no decimal field), French labels, `networkMode: "always"` (a
 * write path — offline writes fail loud, never queued/replayed).
 *
 * **AC1's negative half (duplicate outcome):** `POST /instruments` returns
 * 409 `problem+json` for a duplicate (isin, exchangeMic) or duplicate
 * symbol (`instruments.controller.ts`'s `create` handler) — it does **not**
 * hand back the pre-existing row's id. This form treats that 409 as a
 * calm, explicit outcome (never an unhandled error): it re-queries
 * `GET /instruments?query=` with the submitted isin/symbol and, if a
 * matching row is found, offers it for selection exactly like a normal
 * search result — `onCreated` is called with `outcome: "existing"` so a
 * caller (the transaction form's `InstrumentPicker`) can select it the same
 * way it would a freshly created one. If the pre-existing row cannot be
 * located this way (e.g. a very short symbol below the search endpoint's
 * own 3-alphanumeric-character minimum, `listInstrumentsQuerySchema`'s
 * F5/N1/NEW-2 rule), the outcome is still surfaced calmly — the user is
 * told the instrument already exists and pointed at manual search — never a
 * raw, unexplained error.
 */

export interface InstrumentFormValues {
  kind: InstrumentKind;
  isin: string;
  exchangeMic: string;
  symbol: string;
  listingCurrency: string;
  displayName: string;
  figi: string;
  /**
   * IR-10 — the
   * classification the selected discovery candidate already carried, held in
   * form state so it is **submitted**, and shown as read-only confirmation
   * text. Deliberately **not** an input: OD-2/FR-7 give no create-time editing
   * story, and the correction surface is IR-17's PATCH. `""` means "nothing to
   * carry", which is the fully-manual path's normal state.
   */
  sectorCode: string;
  industryLabel: string;
  /**
   * scpi cycle (FR-611/FR-618) — the two SCPI attributes, as
   * typed. Plain strings: the fee is a decimal string all the way to the
   * server (NFR-76), never a JS number. `""` means "not given" and is omitted
   * from the payload; both are dropped entirely for every other kind.
   */
  managementCompany: string;
  subscriptionFeePct: string;
}

export function defaultInstrumentFormValues(initialDisplayName = ""): InstrumentFormValues {
  return {
    kind: "SHARE",
    isin: "",
    exchangeMic: "",
    symbol: "",
    listingCurrency: "",
    displayName: initialDisplayName,
    figi: "",
    sectorCode: "",
    industryLabel: "",
    managementCompany: "",
    subscriptionFeePct: "",
  };
}

function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The industry label as `createInstrumentBodySchema` would accept it, or
 * `undefined` — **validated with `industryLabelSchema` itself**
 * (`z.string().trim().min(1).max(120)`, `@kerdial/api-contracts`), not with a
 * length comparison, so the trim, the emptiness rule and the bound are one rule
 * from one authored source.
 *
 * LOW (security review). This is the
 * one payload field the user never types: it arrives from a discovery
 * candidate, `toDiscoveryCandidateResponse` forwards the provider's own string
 * verbatim, and nothing caps it on the way out (the response schema that
 * declared 120 characters only ever documented the shape, and went with the
 * OpenAPI descriptors) — so a longer label really can reach this form. Sent as-is
 * it failed {@link instrumentFormResolver}, which routed the issue to
 * `errors.industryLabel`, a field this form deliberately does not render (the
 * value is read-only confirmation text, OD-2/FR-7 define no create-time editing
 * surface). The result was a dead end: `handleSubmit` never reached `onValid`,
 * no request was sent, no message appeared, and the only recovery was to
 * abandon discovery and retype every field.
 *
 * **Dropped rather than surfaced**, which is the deliberate half of this fix:
 * an error message about `industryLabel` would name a value the user did not
 * type and cannot edit, so it leaves them exactly as stuck. Dropping it matches
 * what the sibling worker lane already does with this same input class
 * (`market/composition`'s `captureProviderClassification`) — the label is
 * opaque, display-only, never a key and never aggregated, while `sectorCode`,
 * the half that *is* aggregated, still lands. The creation succeeds without it,
 * and IR-17's `PATCH /instruments/:id/classification` remains the surface for
 * setting one by hand.
 */
function storableIndustryLabelOrUndefined(value: string): string | undefined {
  const parsed = industryLabelSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The raw, pre-`zDecimal`-transform request body — exported for its own unit
 * tests. `kind` decides which of `isin`/`exchangeMic` vs `symbol` is even
 * set, which is what keeps a CRYPTO/INDEX payload free of any ISIN/MIC field
 * and a SHARE/ETF/FUND payload free of any `symbol` field (structurally, not
 * merely left blank).
 */
/**
 * Same trim as {@link trimmedOrUndefined}, plus an uppercase normalisation —
 * LOW (security review): `isin`/`exchangeMic`/`listingCurrency`'s own Zod
 * validators (`isinSchema`/`exchangeMicSchema`/`currencyCodeSchema`,
 * `@kerdial/api-contracts`) require uppercase but, unlike `symbol`'s own
 * `.toUpperCase()` transform, do not themselves normalise the input — a
 * user typing a lowercase ISIN/MIC/currency previously got a validation
 * error instead of having it silently accepted, which is inconsistent with
 * how `symbol` already behaves. Uppercasing here, before the payload is
 * ever validated, cannot create client/server drift: the shared schema
 * still validates the exact same (now-uppercase) value both sides agree on
 * — this only widens the accepted *input* shape, never the *validated* one.
 */
function trimmedUpperOrUndefined(value: string): string | undefined {
  const trimmed = value.trim().toUpperCase();
  return trimmed === "" ? undefined : trimmed;
}

export function buildInstrumentRequestPayload(
  values: InstrumentFormValues,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    kind: values.kind,
    listingCurrency: trimmedUpperOrUndefined(values.listingCurrency),
    displayName: trimmedOrUndefined(values.displayName),
    figi: trimmedOrUndefined(values.figi),
  };

  if (values.kind === "SCPI") {
    // SCPI (AC-507): an SCPI is unlisted and priced by hand — an
    // optional ISIN, an optional code (one of the two is required, the shared
    // schema's refine says so on `symbol`), the two attributes when given, and
    // **no `exchangeMic` and no `quotePolicy` key at all**: the server's
    // default (`MANUAL_ONLY`) is the rule, and the strict SCPI branch refuses
    // anything else.
    body["isin"] = trimmedUpperOrUndefined(values.isin);
    body["symbol"] = trimmedOrUndefined(values.symbol);
    body["managementCompany"] = trimmedOrUndefined(values.managementCompany);
    body["subscriptionFeePct"] = trimmedOrUndefined(values.subscriptionFeePct);
  } else if (isSymbolBasedInstrumentKind(values.kind)) {
    body["symbol"] = trimmedOrUndefined(values.symbol);
  } else {
    body["isin"] = trimmedUpperOrUndefined(values.isin);
    body["exchangeMic"] = trimmedUpperOrUndefined(values.exchangeMic);
    // IC-15: `symbol` is now rendered (and submitted, when
    // filled) for ISIN-based kinds too — `symbol` is already `.optional()` in
    // `createInstrumentBodySchema` for every kind (no schema change), it is
    // never the dedupe key when `isin` is present, and it is what a
    // discovery candidate's own `tickerSymbol`/`providerSymbol` autofills
    // (AC-3) for a SHARE/ETF/FUND selection. Previously omitted structurally
    // on this branch; now included whenever the user (or discovery) filled
    // it, `undefined` (so absent from the JSON body, same as before) when
    // left blank.
    body["symbol"] = trimmedOrUndefined(values.symbol);
  }

  // IR-10/FR-7: SHARE only, and dropped entirely for every other kind rather
  // than sent-and-rejected — `createInstrumentBodySchema`'s `superRefine`
  // returns a 400 for a non-SHARE body carrying either field, which is
  // exactly what a user who selected a SHARE candidate and *then* switched
  // the kind must not hit.
  if (values.kind === "SHARE") {
    body["sectorCode"] = trimmedOrUndefined(values.sectorCode);
    // Not `trimmedOrUndefined`: see {@link storableIndustryLabelOrUndefined} —
    // a provider label the shared schema refuses is dropped here, never sent
    // into a validation failure this form has no way to show or fix.
    body["industryLabel"] = storableIndustryLabelOrUndefined(values.industryLabel);
  }

  return body;
}

function fieldNameForIssuePath(path: string): keyof InstrumentFormValues {
  return path as keyof InstrumentFormValues;
}

/**
 * A hand-written `Resolver`, not `@hookform/resolvers`'s `zodResolver` — same
 * reason `TransactionForm.tsx`'s own resolver gives: `handleSubmit`'s
 * `onValid` needs the original raw form values (ready for
 * `buildInstrumentRequestPayload`), not the parsed `z.infer` output.
 */
function instrumentFormResolver(): Resolver<InstrumentFormValues> {
  return async (values) => {
    const payload = buildInstrumentRequestPayload(values);
    const result = createInstrumentBodySchema.safeParse(payload);
    if (result.success) {
      return { values, errors: {} };
    }
    const errors: FieldErrors<InstrumentFormValues> = {};
    for (const issue of result.error.issues) {
      const fieldName = fieldNameForIssuePath(issue.path.join("."));
      if (errors[fieldName] === undefined) {
        errors[fieldName] = { type: issue.code, message: issue.message };
      }
    }
    return { values: {}, errors };
  };
}

/**
 * Best-effort lookup of the row a 409 pointed at (AC1's negative half) —
 * `GET /instruments?query=` searches `display_name`/`symbol`/`isin`
 * substrings (`ledger`'s `listInstruments`), so the submitted isin/symbol is
 * itself a usable query string. Returns `undefined` (never throws) if the
 * search itself fails or does not turn up an exact match — the caller
 * degrades to the calm "could not be located automatically" notice in that
 * case, never an unhandled error.
 */
export async function resolveExistingInstrument(
  payload: Record<string, unknown>,
): Promise<InstrumentSummary | undefined> {
  const isin = typeof payload["isin"] === "string" ? payload["isin"] : undefined;
  const exchangeMic =
    typeof payload["exchangeMic"] === "string" ? payload["exchangeMic"] : undefined;
  const kind = typeof payload["kind"] === "string" ? payload["kind"] : undefined;
  const rawSymbol = typeof payload["symbol"] === "string" ? payload["symbol"] : undefined;
  // LOW (security review): normalises the lookup key exactly the way
  // `createInstrumentBodySchema`'s own `symbol` field does server-side
  // (`.trim().toUpperCase()`) — a lowercase-typed "doge" against an
  // already-stored uppercase "DOGE" row previously failed this compare
  // with a strict, un-normalised `===`, turning a genuine duplicate into a
  // false "could not be located automatically" dead end.
  const symbol = rawSymbol?.trim().toUpperCase();

  const query = isin ?? symbol;
  if (query === undefined || query.length < 3) return undefined;

  let results: InstrumentSummary[];
  try {
    results = await searchInstruments(query);
  } catch {
    return undefined;
  }

  if (isin !== undefined) {
    // `?? null` (SCPI): an SCPI payload carries no
    // `exchangeMic` key while its stored row carries `null` — without it an
    // SCPI duplicate compared `null` with `undefined` and fell through to the
    // "could not be located" notice. A cross-kind 409 (an SCPI typed with a
    // SHARE's ISIN) still finds nothing here, on purpose: the listed row has a
    // MIC, and offering it as "the instrument you were creating" is the
    // wrong-kind trap the symbol branch below documents.
    return results.find((row) => row.isin === isin && row.exchangeMic === (exchangeMic ?? null));
  }
  // MEDIUM (security review): `symbol` alone is not a unique key across the
  // whole catalogue — it is only unique *per kind* (`instrument_symbol_
  // crypto_key`'s `UNIQUE(symbol) WHERE kind = 'CRYPTO'`, and the
  // symbol-primary kinds' own `UNIQUE(kind, symbol) WHERE isin IS NULL`,
  // `SYMBOL_NO_ISIN_CONSTRAINT`). An ISIN-based row (SHARE/ETF/FUND) can
  // freely carry the same string in its own `symbol` column as an
  // unrelated, non-unique attribute — matching on `symbol` alone could
  // therefore resolve a genuine CRYPTO/INDEX-symbol 409 to a completely
  // unrelated ISIN-based row that merely happens to share the same symbol
  // text, silently offering the wrong instrument (wrong kind, wrong
  // currency, wrong price feed) for selection. A symbol-kind 409's
  // conflicting row is always symbol-primary (`isin IS NULL`) by
  // construction — `createInstrumentBySymbol` (`ledger/src/instrument-
  // service.ts`) always inserts `isin: null, exchangeMic: null` for both
  // CRYPTO and INDEX, and only that partial-unique-index family can ever
  // raise the conflict this branch is resolving — so the full identity
  // match is `(symbol, kind, isin IS NULL)`, never `symbol` alone.
  return results.find((row) => row.symbol === symbol && row.kind === kind && row.isin === null);
}

/**
 * Kerdial restyle: the fields are the kit's `<Input>`/`<Select>`, which
 * own the kit's inline per-field error treatment. The two
 * shared selects this form does not own (`ExchangeMicSelect`,
 * `CurrencySelect`) keep their own markup and are wrapped in the kit's own
 * `k-field` label/error shell instead. No validation rule moved.
 */

function FieldError({ message }: { message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p role="alert" className="k-field-error">
      {message}
    </p>
  );
}

const KIND_OPTIONS: { value: InstrumentKind; label: string }[] = [
  { value: "SHARE", label: "Action" },
  { value: "ETF", label: "ETF" },
  { value: "FUND", label: "Fonds (OPCVM)" },
  { value: "SCPI", label: "SCPI" },
  { value: "CRYPTO", label: "Crypto-actif" },
  { value: "INDEX", label: "Indice" },
];

export interface InstrumentCreateFormProps {
  /** Called once the instrument is usable — either freshly created (`outcome: "created"`) or the pre-existing row a 409 pointed at and this form successfully located (`outcome: "existing"`). */
  onCreated: (instrument: InstrumentSummary, outcome: "created" | "existing") => void;
  onCancel: () => void;
  /** Prefills `displayName` — e.g. the picker's own search text when launched from its empty-results state, so the user does not retype what they already searched for. */
  initialDisplayName?: string;
}

export function InstrumentCreateForm({
  onCreated,
  onCancel,
  initialDisplayName = "",
}: InstrumentCreateFormProps) {
  const online = useOnlineStatus();
  const queryClient = useQueryClient();
  const [duplicateInstrument, setDuplicateInstrument] = useState<InstrumentSummary | null>(null);
  const [duplicateUnresolved, setDuplicateUnresolved] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    control,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<InstrumentFormValues>({
    resolver: instrumentFormResolver(),
    defaultValues: defaultInstrumentFormValues(initialDisplayName),
  });

  const mutation = useMutation({
    mutationFn: createInstrument,
    // F1 (T-44's own precedent, applied here): `networkMode: "always"` — a
    // write path never pauses/replays offline; the real `fetch()` is
    // attempted immediately and rejects immediately when offline, surfaced
    // via `mutation.isError` below, never silently queued.
    networkMode: "always",
    onSuccess: async (created) => {
      // Invalidates every `["instruments", "search", ...]` cache entry
      // (partial match) so the picker's own next search — and any already
      // -mounted search — sees the newly created row.
      await queryClient.invalidateQueries({ queryKey: ["instruments", "search"] });
      onCreated(created, "created");
    },
    onError: async (err, payload) => {
      if (err instanceof ApiError && err.status === 409) {
        const existing = await resolveExistingInstrument(payload);
        if (existing) {
          setDuplicateInstrument(existing);
        } else {
          setDuplicateUnresolved(true);
        }
      }
      // Any other error renders via `mutation.isError` below, same as
      // `TransactionForm.tsx`'s own submit-error alert.
    },
  });

  const kind = watch("kind");
  const isSymbolBased = isSymbolBasedInstrumentKind(kind);
  // No search, no place de cotation, an optional ISIN, a
  // « Code », a fixed manual quote policy and the two attribute inputs.
  const isScpi = kind === "SCPI";
  // IR-10: watched, not read off `getValues`, so the read-only confirmation
  // text below re-renders when a candidate selection fills it.
  const sectorCodeValue = watch("sectorCode");
  // The label *as the payload will carry it* — so the confirmation text below
  // keeps its own contract ("what the submitted body carries") for a candidate
  // whose provider label the shared schema refuses and
  // `buildInstrumentRequestPayload` therefore drops.
  const industryLabelValue = storableIndustryLabelOrUndefined(watch("industryLabel")) ?? "";

  const onValid = (values: InstrumentFormValues) => {
    setDuplicateInstrument(null);
    setDuplicateUnresolved(false);
    mutation.mutate(buildInstrumentRequestPayload(values));
  };

  /**
   * IC-15 — a
   * selected discovery candidate autofills `displayName`/`symbol`
   * (`tickerSymbol ?? providerSymbol`, verbatim, AC-3) and pre-selects (but
   * does not lock) `listingCurrency`/the MIC dropdown when a curated hint
   * exists (AC-9). **`isin` is never populated from anything the *provider*
   * returned** (decision D2's actual rationale — the equity provider
   * does not return an ISIN, so inventing one from provider data would be a
   * data-integrity bug; `DiscoveryCandidate` structurally has no `isin`
   * field at all, so there is nothing here to even mistakenly wire).
   *
   * What this function *does* echo back is the user's own search text: if
   * `query` (the exact debounced string that produced the candidate list —
   * never anything the provider echoed) is itself a valid ISIN — same
   * check-digit rule the shared schema enforces, `isValidIsinCheckDigit`,
   * not a hand-rolled shape check — for an ISIN-based `kind`
   * (SHARE/ETF/FUND), it is copied into the `isin` field verbatim
   * (uppercased/trimmed exactly as the schema normalises it). This is not a
   * D2 violation: the value placed in the field was typed by the user
   * themselves, not sourced from the provider — ISIN stays exactly as
   * user-typed as D2 requires, this only saves the user from retyping a
   * string they already typed once, into the search box, moments earlier.
   * Still freely editable afterwards — a convenience prefill, never a lock.
   */
  function handleDiscoverySelect(candidate: DiscoveryCandidate, query: string): void {
    setValue("displayName", candidate.displayName);
    setValue("symbol", candidate.tickerSymbol ?? candidate.providerSymbol);
    setValue("listingCurrency", candidate.listingCurrency);
    // IR-10: the classification the candidate row already displayed, carried
    // through verbatim — `sectorCode` is the *mapped* Kerdial code the server
    // computed (`PROVIDER_SECTOR_TO_CODE`, applied once in
    // `api/src/instruments/discovery.schema.ts`), never a provider string, and
    // `web` maps nothing itself. `null`/absent clears the carry-over so a
    // second selection cannot leave the first candidate's sector behind.
    setValue("sectorCode", candidate.sectorCode ?? "");
    setValue("industryLabel", candidate.industryLabel ?? "");
    const suggestedMic = candidate.exchangeHint?.suggestedMic;
    if (suggestedMic !== null && suggestedMic !== undefined) {
      setValue("exchangeMic", suggestedMic);
    }
    if (!isSymbolBased) {
      const normalizedQuery = query.trim().toUpperCase();
      if (isValidIsinCheckDigit(normalizedQuery)) {
        setValue("isin", normalizedQuery);
      }
    }
  }

  if (duplicateInstrument) {
    return (
      <div className="k-dialog-body k-inst-form">
        <p
          role="status"
          data-testid="instrument-duplicate-notice"
          className="k-inst-banner k-inst-banner-warn"
        >
          {fill(INSTRUMENT_COPY.duplicateExists, {
            name: duplicateInstrument.displayName,
            identifier: duplicateInstrument.symbol ?? duplicateInstrument.isin ?? "",
          })}
        </p>
        <div className="k-inst-form-actions">
          <Button
            variant="primary"
            data-testid="instrument-duplicate-use-existing"
            onClick={() => onCreated(duplicateInstrument, "existing")}
          >
            {INSTRUMENT_COPY.useExisting}
          </Button>
        </div>
      </div>
    );
  }

  if (duplicateUnresolved) {
    return (
      <div className="k-dialog-body k-inst-form">
        <p
          role="status"
          data-testid="instrument-duplicate-unresolved-notice"
          className="k-inst-banner k-inst-banner-warn"
        >
          {INSTRUMENT_COPY.duplicateUnresolved}
        </p>
        <div className="k-inst-form-actions">
          <Button
            variant="secondary"
            data-testid="instrument-duplicate-unresolved-close"
            onClick={onCancel}
          >
            {COMMON_COPY.close}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      data-testid="instrument-create-form"
      className="k-dialog-body k-inst-form"
      onSubmit={(event) => void handleSubmit(onValid)(event)}
    >
      <Select
        label={INSTRUMENT_COPY.createKind}
        data-testid="instrument-kind-select"
        options={KIND_OPTIONS}
        {...register("kind", {
          // SC-L12: an SCPI's listing currency defaults to EUR — only when the
          // field is still empty, so a currency the user already chose (or a
          // discovery candidate filled) is never overwritten by the switch.
          onChange: (event: { target: { value: string } }) => {
            if (event.target.value === "SCPI" && getValues("listingCurrency") === "") {
              setValue("listingCurrency", "EUR");
            }
          },
        })}
      />

      {/* IC-14/IC-15: the discovery search sits above the
          identity fields it can autofill. Leaving it untouched keeps the
          form fully manual (AC-5) — it never gates or disables anything
          below. */}
      {/* FR-615/AC-507: an SCPI has no provider to search — no search box. */}
      {!isScpi && <InstrumentDiscoverySearch kind={kind} onSelect={handleDiscoverySelect} />}

      <Input
        type="text"
        label={INSTRUMENT_COPY.displayName}
        data-testid="instrument-display-name-input"
        error={errors.displayName?.message}
        {...register("displayName")}
      />

      {/* AC2/structural omission: a symbol-based kind (CRYPTO, INDEX) never renders an ISIN/MIC field at all. */}
      {!isSymbolBased && (
        <div>
          <Input
            type="text"
            label={isScpi ? INSTRUMENT_COPY.isinOptional : INSTRUMENT_COPY.isin}
            data-testid="instrument-isin-input"
            maxLength={12}
            error={errors.isin?.message}
            {...register("isin")}
          />
          {/* Closes the "why is this field empty?" friction report: the
              search source (Yahoo, for a SHARE/ETF/FUND) never returns an
              ISIN, so unless the user's own search text was itself a valid
              ISIN (echoed back on selection, see `handleDiscoverySelect`),
              this field stays empty and user-typed by design (Locked
              decision D2). */}
          {/* No search for an SCPI, so nothing to explain about what it returns. */}
          {!isScpi && (
            <p data-testid="instrument-isin-source-hint" className="k-field-hint">
              {INSTRUMENT_COPY.isinSourceHint}
            </p>
          )}
        </div>
      )}

      {/* `symbol` is now rendered for ISIN-based kinds
          too (AC-3 requires the discovery-autofilled symbol to be visible
          for SHARE/ETF/FUND, not only CRYPTO/INDEX) — `symbol` is already
          optional in the shared schema for every kind, so no schema change
          and no new required field for the manual path (AC-5). */}
      <Input
        type="text"
        label={
          isScpi
            ? INSTRUMENT_COPY.scpiCode
            : isSymbolBased
              ? INSTRUMENT_COPY.symbol
              : INSTRUMENT_COPY.symbolOptional
        }
        hint={isScpi ? INSTRUMENT_COPY.scpiCodeHint : undefined}
        data-testid="instrument-symbol-input"
        error={errors.symbol?.message}
        {...register("symbol")}
      />

      {!isSymbolBased && !isScpi && (
        <div className="k-field k-field-md">
          <span className="k-field-label">{INSTRUMENT_COPY.exchangeMic}</span>
          <Controller
            name="exchangeMic"
            control={control}
            render={({ field }) => (
              <ExchangeMicSelect
                value={field.value}
                onChange={field.onChange}
                testId="instrument-exchange-mic"
                error={errors.exchangeMic?.message}
              />
            )}
          />
        </div>
      )}

      <div className="k-field k-field-md">
        <span className="k-field-label">{INSTRUMENT_COPY.listingCurrency}</span>
        <Controller
          name="listingCurrency"
          control={control}
          render={({ field }) => (
            <CurrencySelect
              value={field.value}
              onChange={field.onChange}
              testId="instrument-listing-currency-select"
            />
          )}
        />
        <FieldError message={errors.listingCurrency?.message} />
      </div>

      {/* IR-10:
          read-only **confirmation text**, never an input — the value shown is
          what the selected discovery candidate already displayed and what the
          submitted body carries, so the user can see it before creating
          without being offered an editing surface OD-2/FR-7 does not define
          (corrections are IR-17's PATCH). Rendered only when a candidate
          actually supplied something, and never for a non-SHARE kind, whose
          payload drops both fields. */}
      {kind === "SHARE" && (sectorCodeValue !== "" || industryLabelValue !== "") && (
        <div className="k-field k-field-md">
          <span className="k-field-label">{INSTRUMENT_COPY.classificationFromSearch}</span>
          <p data-testid="instrument-classification-confirmation" className="k-field-hint">
            {/* The label comes from `sectorDisplayLabel`, the single
                code-to-text site in `web` — previously this file made its own
                `sectorLabel(code) ?? code` decision. The `!== ""` gate stays
                here: an absent classification drops the part rather than
                rendering « Non classé » beside a provider industry label the
                candidate *did* supply (see `sector-display.ts`'s own note on
                presence gates). */}
            {[sectorCodeValue === "" ? "" : sectorDisplayLabel(sectorCodeValue), industryLabelValue]
              .filter((part) => part !== "")
              .join(" — ")}
          </p>
        </div>
      )}

      {isScpi && (
        <>
          {/* FR-610/FR-618: an SCPI's quote policy is a rule, not a choice —
              shown as fixed text, never an input, and never sent. */}
          <div className="k-field k-field-md">
            <span className="k-field-label">{INSTRUMENT_COPY.quotePolicy}</span>
            <p data-testid="instrument-scpi-quote-policy" className="k-field-hint">
              {INSTRUMENT_COPY.quotePolicyManualFixed}
            </p>
          </div>
          <Input
            type="text"
            label={INSTRUMENT_COPY.managementCompany}
            data-testid="instrument-management-company-input"
            maxLength={120}
            error={errors.managementCompany?.message}
            {...register("managementCompany")}
          />
          {/* NFR-76: a text input carrying a decimal string, never
              `type="number"` — the browser's number parsing is a float. */}
          <Input
            type="text"
            numeric
            label={INSTRUMENT_COPY.subscriptionFeePctInput}
            data-testid="instrument-subscription-fee-input"
            error={errors.subscriptionFeePct?.message}
            {...register("subscriptionFeePct")}
          />
        </>
      )}

      <Input
        type="text"
        label={INSTRUMENT_COPY.figiOptional}
        data-testid="instrument-figi-input"
        maxLength={12}
        error={errors.figi?.message}
        {...register("figi")}
      />

      {mutation.isError &&
        !(mutation.error instanceof ApiError && mutation.error.status === 409) && (
          <p
            role="alert"
            className="k-inst-banner k-inst-banner-loss"
            data-testid="instrument-create-error"
          >
            {mutation.error instanceof Error
              ? mutation.error.message
              : INSTRUMENT_COPY.createFailed}
          </p>
        )}

      {!online && (
        <p
          role="alert"
          className="k-inst-banner k-inst-banner-loss"
          data-testid="instrument-create-offline-error"
        >
          {COMMON_COPY.offlineExplanation}
        </p>
      )}

      <div className="k-inst-form-actions">
        <Button variant="ghost" data-testid="instrument-create-cancel" onClick={onCancel}>
          {COMMON_COPY.cancel}
        </Button>
        <Button
          type="submit"
          variant="primary"
          data-testid="instrument-create-submit"
          disabled={!online || isSubmitting || mutation.isPending}
        >
          {INSTRUMENT_COPY.create}
        </Button>
      </div>
    </form>
  );
}
