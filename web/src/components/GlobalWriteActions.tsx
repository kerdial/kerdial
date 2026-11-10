import { NewInstrumentButton } from "./NewInstrumentButton.js";
import { NewTransactionButton } from "./NewTransactionButton.js";
import { QuickSearch } from "./QuickSearch.js";

/**
 * The three controls that must be reachable from everywhere: quick navigation,
 * "Nouvel instrument", "Nouvelle transaction".
 *
 * FR-97 words the requirement as "every navigation destination", and it was read
 * narrowly — `PageHeader` owns them, `PageHeader` is on the six. The e2e
 * suite disagreed, loudly: fifteen specs click `new-transaction-button` from
 * the portfolio and instrument **detail** views, which are not nav
 * destinations and so had lost the buttons entirely. The design is on the
 * suite's side — its handoff says *every* page header carries them.
 *
 * So they live here rather than inline in `PageHeader`, and any screen with a
 * heading of its own renders this next to it. One component, so a third screen
 * with a custom header cannot quietly ship without them, and
 * `page-header.test.tsx` checks the detail views too.
 */
export function GlobalWriteActions() {
  return (
    <>
      <QuickSearch />
      <NewInstrumentButton />
      <NewTransactionButton />
    </>
  );
}
