import { useState } from "react";
import {
  portfolioNameSchema,
  type ImportTransferDecisionResponse,
  type ImportTransferDestination,
} from "@kerdial/api-contracts";
import { IMPORT_COPY } from "../lib/copy/imports.js";
import { portfolioSelectOptions } from "../lib/portfolio-options.js";
import { formatIsoDateFr } from "../lib/history-status-copy.js";
import { transactionKindLabel, transactionKindTone } from "../lib/transaction-kind.js";
import { Badge, Input, Select } from "./ui/index.js";

/**
 * The review step's destination picker, one per source-leg transfer row
 * (`security-transfer` FR-583, L4).
 *
 * A Portfolio Performance investment file says units left the account and
 * never says where they went, so the dry run asks, per row, and the
 * confirm carries the answers as `transferDestinations`. Three answers:
 *
 *  - **« Aucun »**, the default — the source leg is written alone (Step A), a
 *    transfer out of Kerdial;
 *  - **an existing portfolio** — offered by name, and never the portfolio this
 *    file is imported into (FR-577: the server refuses it too);
 *  - **« Nouveau portefeuille… »** and a typed name — the import creates it.
 *
 * The answer is a portfolio **name** either way, because that is the wire
 * contract (L4: "named at import and created by name if absent"), so the value
 * this component owns is `index → name`. A row whose "new" name is still empty
 * or blank is held back by {@link incompleteTransferDestination}, which the
 * wizard's confirm button reads: sending nothing for it would be a silent
 * Step A the user did not choose.
 */

/** `index → portfolio name`; a row absent from it is unanswered (Step A). */
export type TransferDestinationChoices = ReadonlyMap<number, string>;

/** The sentinel option value for « Nouveau portefeuille… »; cannot collide with a name, which is trimmed and non-blank. */
const NEW_PORTFOLIO = " new";

/** The answers the confirm sends — every answered row, in row order. */
export function transferDestinationsOf(
  choices: TransferDestinationChoices,
): ImportTransferDestination[] {
  return [...choices]
    .map(([index, portfolioName]) => ({ index, portfolioName }))
    .sort((a, b) => a.index - b.index);
}

/** True while some row's typed name is one the server would refuse — the confirm stays disabled. */
export function incompleteTransferDestination(choices: TransferDestinationChoices): boolean {
  return [...choices.values()].some((name) => !portfolioNameSchema.safeParse(name).success);
}

export function ImportTransferDecisions({
  decisions,
  portfolios,
  sourcePortfolioId,
  choices,
  onChange,
  testId,
}: {
  readonly decisions: readonly ImportTransferDecisionResponse[];
  readonly portfolios: readonly {
    readonly id: string;
    readonly name: string;
    readonly archived: boolean;
  }[];
  /** The portfolio this file is imported into — never offered as a destination. */
  readonly sourcePortfolioId: string;
  readonly choices: TransferDestinationChoices;
  readonly onChange: (next: TransferDestinationChoices) => void;
  readonly testId: string;
}) {
  // Which rows are in « new » mode. Local, because a typed name that happens
  // to equal an existing portfolio's must not flip the select back under the
  // user's cursor; the wire value is the name either way.
  const [typing, setTyping] = useState<ReadonlySet<number>>(new Set());
  const destinations = portfolios.filter((portfolio) => portfolio.id !== sourcePortfolioId);
  // portfolio-archive FR-596: per row, because an archived portfolio stays
  // listed (suffixed) only on the row whose current choice it is. Keyed by
  // name, as the wire value is the name.
  function optionsFor(current: string): { value: string; label: string }[] {
    return [
      { value: "", label: IMPORT_COPY.transferDestinationNone },
      ...portfolioSelectOptions(destinations, current, "name"),
      { value: NEW_PORTFOLIO, label: IMPORT_COPY.transferDestinationNew },
    ];
  }

  function answer(index: number, name: string | undefined): void {
    const next = new Map(choices);
    if (name === undefined) next.delete(index);
    else next.set(index, name);
    onChange(next);
  }

  return (
    <ul className="import-transfer-list" data-testid={testId}>
      {decisions.map((decision) => {
        const chosen = choices.get(decision.index);
        const isNew = typing.has(decision.index);
        const newName = isNew ? (chosen ?? "") : "";
        return (
          <li
            key={decision.index}
            className="import-transfer-row"
            data-testid={`${testId}-row-${String(decision.index)}`}
          >
            <p className="import-transfer-summary">
              <Badge tone={transactionKindTone("TRANSFER_OUT")}>
                {transactionKindLabel("TRANSFER_OUT")}
              </Badge>{" "}
              {[
                formatIsoDateFr(decision.tradeDate),
                decision.instrument,
                `${decision.quantity} titre${decision.quantity === "1" ? "" : "s"}`,
                `${decision.marketValue} ${decision.currency}`,
              ]
                .filter((part): part is string => part !== null)
                .join(" · ")}
            </p>
            <Select
              label={IMPORT_COPY.transferDestination}
              data-testid={`${testId}-select-${String(decision.index)}`}
              value={isNew ? NEW_PORTFOLIO : (chosen ?? "")}
              options={optionsFor(isNew ? "" : (chosen ?? ""))}
              onChange={(event) => {
                const value = event.target.value;
                const nextTyping = new Set(typing);
                if (value === NEW_PORTFOLIO) nextTyping.add(decision.index);
                else nextTyping.delete(decision.index);
                setTyping(nextTyping);
                answer(
                  decision.index,
                  value === "" ? undefined : value === NEW_PORTFOLIO ? "" : value,
                );
              }}
            />
            {isNew && (
              <Input
                label={IMPORT_COPY.transferNewPortfolioName}
                data-testid={`${testId}-name-${String(decision.index)}`}
                value={newName}
                maxLength={200}
                error={
                  portfolioNameSchema.safeParse(newName).success
                    ? undefined
                    : IMPORT_COPY.transferNewPortfolioNameInvalid
                }
                onChange={(event) => answer(decision.index, event.target.value)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
