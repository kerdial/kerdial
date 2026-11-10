import { useOnlineStatus } from "../hooks/use-online-status.js";
import { SHELL_COPY } from "../lib/copy/shell.js";

/**
 * ADR-0009 Stage 1 (`AR-22`): offline becomes **app-shell-only**. Before this
 * change, `vite.config.ts`'s `GET /api/v1/**` `NetworkFirst` rule meant a
 * previously-fetched overview/holdings response really could still be served
 * from Cache Storage while offline, so this banner named a specific
 * "données du <timestamp>" reading to go with it (the former "offline is read-only, last-known-state" design). `AR-20` makes
 * `/api/v1/**` `NetworkOnly` for every method — there is no cached response
 * left for any screen to fall back to — so this banner no longer promises a
 * specific reading is available: it only states that the app is offline.
 * Whatever a screen happens to still show (in-memory state from before the
 * connection dropped) is incidental, not a guarantee this component makes.
 */
export function OfflineBanner() {
  const online = useOnlineStatus();

  if (online) return null;

  return (
    <div role="status" data-testid="offline-banner" className="k-offline-banner">
      {SHELL_COPY.offline}
    </div>
  );
}
