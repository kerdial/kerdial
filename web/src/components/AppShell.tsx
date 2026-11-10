import type { ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { PrimaryNav } from "./PrimaryNav.js";
import { MobileTabBar } from "./MobileTabBar.js";

/**
 * The single responsive shell every authenticated route renders inside
 * (`router.tsx`'s `authenticatedRoute`) — one implementation for every
 * viewport, not a desktop shell and a separate
 * mobile shell.
 *
 * Also the single `Tooltip.Provider` every `<Figure>` (T-43,
 * `components/Figure.tsx`) needs — deliberately one instance here rather
 * than one per `<Figure>` (security review), so that T-45's
 * virtualised holdings table's many figures share one coordinated hover
 * delay instead of each cell timing independently.
 *
 * UR-25: the layout below changes
 * from a single header row to `header + (rail | content)` with the bottom
 * tab bar on `<640px` — `PrimaryNav`/`MobileTabBar` each decide internally
 * whether they render anything for the current viewport (see their own doc
 * comments), so this component does not itself branch on breakpoint.
 *
 * ADR-0009 Stage 1 (`AR-21`/`AR-22`): the logout mutation UR-25 moved here
 * verbatim (a standing rule of the UI revamp listed "no change to `AppShell`'s logout/purge
 * logic" as off-limits for every UR task, and Stage 1 had not yet landed
 * when UR-25 was built — see this file's own git history) is now **simplified, not
 * modified in place**: there is no more Cache-Storage purge to run
 * (`session-cache.ts`'s own doc comment), and no more `logout=incomplete`
 * outcome to distinguish (`vite.config.ts`'s `/api/v1/**` `NetworkOnly` rule
 * means no response is ever cached, so `purgeSessionCaches`'s
 * `cachePurged`-based honesty check has nothing left to report on either)
 * — `onSettled` below unconditionally navigates to `/login` regardless of
 * how the mutation ended.
 *
 * MEDIUM-1 (security review): `queryClient.clear()`
 * is a **distinct, still-necessary** step Stage 1's retirement does not
 * touch — the same one `LoginRoute.tsx`'s own doc comment explains for the
 * login path. Stage 1's simplification here dropped it by mistake: without
 * it, an explicit logout leaves every `gcTime: Infinity` query
 * (`["auth","me"]` among them) readable in memory, so a browser Back after
 * logout re-enters the authenticated shell painting the previous user's
 * figures until the first 401 refetch lands and `main.tsx`'s global handler
 * clears it for you. `clear()` here is the same plain synchronous in-memory
 * eviction `LoginRoute.tsx` already documents as unable to reintroduce
 * BLOCKER-1's Cache-Storage/IndexedDB deadlock.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={200}>
      <div className="k-shell">
        <PrimaryNav />
        <div className="k-shell-column">
          <main className="k-shell-main">{children}</main>
        </div>
        <MobileTabBar />
      </div>
    </Tooltip.Provider>
  );
}
