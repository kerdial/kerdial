import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  exchangeMicSchema,
  importableInstrumentKindSchema,
  type ImportInstrumentResolution,
} from "@kerdial/api-contracts";
import { assetClassLabel } from "../lib/asset-class.js";
import { IMPORT_COPY } from "../lib/copy/imports.js";
import { ExchangeMicSelect } from "./ExchangeMicSelect.js";
import { Select } from "./ui/index.js";

/**
 * The revue step's per-row proposal editor, for the `ASSETS` file only
 * (CI-22).
 *
 * ## What the confirm actually submits
 *
 * A dry run over an asset-catalogue file *proposes* a kind and an exchange per
 * row (rule K plus the discovery fallback). The confirm re-submits the list
 * **as the user left it**, and that is what makes the apply pass issue zero
 * provider calls: the server does not re-derive anything, it takes the
 * confirmed list. So every edit here is load-bearing — it is not a display
 * preference, it is the value that gets written.
 *
 * An edited row's `micSource` becomes `"USER"`, never staying at the
 * `"SUFFIX_TABLE"`/`"DISCOVERY"` the proposal arrived with: `market/ports`
 * requires a provider-derived MIC to have been through a human before it may
 * be persisted, and the field is what records that it has. Leaving the
 * original source on an overridden value would be a false provenance claim.
 * `kindSource` follows the identical rule, for the identical reason.
 *
 * ## Which rows are guesses
 *
 * Rule K proposes `ETF` when the source row carries a TER and `SHARE`
 * otherwise, and `instrument.kind` is granted to `app_owner` only — so an
 * accepted default is a write neither this UI nor the API can ever correct.
 * On a typical asset file most rows are defaults, which is why "defaulted" is
 * rendered as quiet provenance text and **not** as a warning: a warning on
 * nearly every row is noise, and the rows that actually need a decision are the ones
 * whose own name disagrees with the default. Those carry `nameSuggestsFund`
 * and get the loud treatment.
 *
 * Every row also renders its `label` — symbol, else ISIN, else display name.
 * Without it the table addressed rows by line number alone, so acting on a
 * flagged row meant reopening the source file to find out which holding it was.
 *
 * ## Why the whole list is editable rather than only the rejected rows
 *
 * `proposals[]` carries one entry per asset row the dry run could plan,
 * `action: "CREATE" | "SKIP"`. A `SKIP` is "already in the catalogue" — there
 * is nothing to decide — so those rows render read-only rather than being
 * dropped: a user looking for a title they expected to see created needs to
 * find it and read *why* it was not.
 */
/**
 * The per-field MIC check, **and the one the confirm button reads**.
 *
 * `ExchangeMicSelect`'s "Autre" input caps length and uppercases, but applies
 * no format rule, so a hand-typed `ab` reached the server and the tightened
 * echo-back schema refused the **whole request** with a 400 and no field-level
 * feedback. The server-side tightening's acceptance criteria permit that 400 and it stays as the
 * backstop; this is the convenience layer in front of it, never the
 * enforcement.
 *
 * It reuses the exported `exchangeMicSchema` — the same Zod object `api`
 * validates the echo-back against — rather than a re-typed `/^[A-Z0-9]{4}$/`,
 * so the client cannot drift from the rule established server-side.
 * Exported because `ImportWizard` needs the *same* answer to decide whether
 * « Confirmer l'import » may fire: a per-field message the user can ignore by
 * clicking confirm anyway would just be the 400 again, with an extra step.
 */
export function exchangeMicError(mic: string | null): string | undefined {
  // `null` is "no exchange chosen", which is a legitimate proposal state —
  // the server accepts a null `exchangeMic` (`exchangeMicSchema.nullable()`).
  if (mic === null || mic === "") return undefined;
  return exchangeMicSchema.safeParse(mic).success ? undefined : IMPORT_COPY.invalidExchangeMic;
}

/** Whether any row's hand-typed MIC would be refused by the server. */
export function hasInvalidExchangeMic(proposals: readonly ImportInstrumentResolution[]): boolean {
  return proposals.some((proposal) => exchangeMicError(proposal.exchangeMic) !== undefined);
}

export interface ImportProposalEditorProps {
  readonly proposals: readonly ImportInstrumentResolution[];
  readonly onChange: (index: number, next: ImportInstrumentResolution) => void;
  readonly testId: string;
}

/** Two provenance lines per row, and the kind warning wraps — the rows are taller than the 92px this was. */
const ESTIMATED_ROW_HEIGHT_PX = 112;
const SCROLLPORT_HEIGHT_PX = 460;

// The importable subset, not every kind: the review step may never confirm an
// SCPI (`scpi` design SCD-14, FR-622) — the server refuses one on the echo.
const KIND_OPTIONS = importableInstrumentKindSchema.options.map((kind) => ({
  value: kind,
  label: assetClassLabel(kind),
}));

/** Carried for display only, never a decision input on apply. */
const MIC_SOURCE_LABELS: Readonly<Record<ImportInstrumentResolution["micSource"], string>> = {
  SUFFIX_TABLE: "déduite du suffixe du symbole",
  DISCOVERY: "trouvée par recherche",
  USER: "choisie par vous",
};

const MATCH_QUALITY_LABELS: Readonly<Record<"EXACT" | "PROBABLE", string>> = {
  EXACT: "correspondance exacte",
  PROBABLE: "correspondance probable",
};

/** Display only, like {@link MIC_SOURCE_LABELS}. */
const KIND_SOURCE_LABELS: Readonly<Record<ImportInstrumentResolution["kindSource"], string>> = {
  EXPENSE_RATIO: "nature déduite des frais courants du fichier",
  DISCOVERY: "nature trouvée par recherche",
  DEFAULT: "nature par défaut, le fichier ne la précise pas",
  USER: "nature choisie par vous",
};

/**
 * The one case where a defaulted kind is not merely unconfirmed but probably
 * wrong: the file said nothing about the nature of the holding, and the
 * holding's own name says « fonds ». A `SHARE` written here is unrecoverable
 * (`instrument.kind` is `app_owner`-only), so this row is the one that has to
 * be read before confirming.
 */
const KIND_NEEDS_CONFIRMATION =
  "à confirmer : le nom ressemble à un fonds, la nature proposée est celle par défaut";

export function ImportProposalEditor({ proposals, onChange, testId }: ImportProposalEditorProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: proposals.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT_PX,
    overscan: 5,
  });

  if (proposals.length === 0) {
    return (
      <p className="import-note" data-testid={`${testId}-empty`}>
        {IMPORT_COPY.noProposals}
      </p>
    );
  }

  return (
    <div className="import-proposals" data-testid={testId}>
      <div className="import-proposals-grid import-rows-head" data-testid={`${testId}-head`}>
        <span className="micro-label">{IMPORT_COPY.columnLine}</span>
        <span className="micro-label">{IMPORT_COPY.columnSecurity}</span>
        <span className="micro-label">{IMPORT_COPY.columnKind}</span>
        <span className="micro-label">{IMPORT_COPY.columnExchange}</span>
        <span className="micro-label">{IMPORT_COPY.columnOrigin}</span>
      </div>
      <div
        ref={scrollRef}
        className="import-rows-scroll"
        data-testid={`${testId}-scroll`}
        style={{ height: SCROLLPORT_HEIGHT_PX }}
      >
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {rowVirtualizer.getVirtualItems().map((virtualItem) => {
            const proposal = proposals[virtualItem.index];
            if (proposal === undefined) return null;
            const rowTestId = `${testId}-row-${String(proposal.index)}`;
            const editable = proposal.action === "CREATE";
            return (
              <div
                key={proposal.index}
                className="import-proposals-grid import-rows-row"
                data-testid={rowTestId}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: virtualItem.size,
                  transform: `translateY(${String(virtualItem.start)}px)`,
                }}
              >
                <span className="k-num">{proposal.index + 1}</span>
                <span
                  className="import-rows-source"
                  data-testid={`${rowTestId}-label`}
                  title={proposal.label ?? undefined}
                >
                  {proposal.label ?? "—"}
                </span>
                {editable ? (
                  <Select
                    size="sm"
                    data-testid={`${rowTestId}-kind`}
                    options={KIND_OPTIONS}
                    value={proposal.kind}
                    onChange={(event) =>
                      onChange(virtualItem.index, {
                        ...proposal,
                        kind: event.target.value as ImportInstrumentResolution["kind"],
                        // The user has now decided this value too — see this
                        // file's header on why an override never keeps the
                        // proposal's own provenance.
                        kindSource: "USER",
                      })
                    }
                  />
                ) : (
                  <span data-testid={`${rowTestId}-kind-readonly`}>
                    {assetClassLabel(proposal.kind)}
                  </span>
                )}
                {editable ? (
                  <ExchangeMicSelect
                    testId={`${rowTestId}-mic`}
                    error={exchangeMicError(proposal.exchangeMic)}
                    value={proposal.exchangeMic ?? ""}
                    onChange={(mic) =>
                      onChange(virtualItem.index, {
                        ...proposal,
                        exchangeMic: mic === "" ? null : mic,
                        // The user has now decided this value, whatever it was
                        // proposed from — see this file's header.
                        micSource: "USER",
                      })
                    }
                  />
                ) : (
                  <span data-testid={`${rowTestId}-mic-readonly`}>
                    {proposal.exchangeMic ?? "—"}
                  </span>
                )}
                <span className="import-proposals-origin" data-testid={`${rowTestId}-origin`}>
                  {editable ? MIC_SOURCE_LABELS[proposal.micSource] : IMPORT_COPY.alreadyCatalogued}
                  {proposal.matchQuality !== null
                    ? ` — ${MATCH_QUALITY_LABELS[proposal.matchQuality]}`
                    : ""}
                  {editable ? (
                    <span
                      className={
                        proposal.nameSuggestsFund && proposal.kindSource === "DEFAULT"
                          ? "import-proposals-kind-warn"
                          : undefined
                      }
                      data-testid={`${rowTestId}-kind-source`}
                      data-kind-source={proposal.kindSource}
                      data-kind-needs-confirmation={
                        proposal.nameSuggestsFund && proposal.kindSource === "DEFAULT"
                      }
                    >
                      {proposal.nameSuggestsFund && proposal.kindSource === "DEFAULT"
                        ? KIND_NEEDS_CONFIRMATION
                        : KIND_SOURCE_LABELS[proposal.kindSource]}
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
