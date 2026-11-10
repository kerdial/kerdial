import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { logout } from "../lib/api-client.js";
import { authQueryOptions } from "../lib/queries.js";
import { Icon } from "./ui/Icon.js";
import { SHELL_COPY } from "../lib/copy/shell.js";

/**
 * The rail's footer: who is signed in, and the way out.
 *
 * The design puts **avatar, name and base currency** here. This app has none of
 * the three as such:
 *
 * - there is no display name — `GET /auth/me` returns `{ tenantId, userId,
 *   email, baseCurrency, isInstanceAdmin }`, so the email *is* the identity
 *   and the avatar is its initial;
 * - **base currency is exposed, and rendered** (`account-base-currency`
 *   below). This comment used to say the opposite — that no endpoint returned
 *   it and the slot was left out rather than filled with a guess — which
 *   stopped being true, when `GET /auth/me` gained the field and this
 *   component started rendering it straight off the response. Corrected here
 *   (`account-setup` I-11) rather than left as a note that contradicts the
 *   code twenty lines below it. The rule it stated still holds: the code comes
 *   from the read, never from a hardcoded "EUR".
 *
 * **The two navigation entries** (`account-setup` FR-409/FR-420, UR-70,
 * LD-2): « Mon compte » always, « Utilisateurs » only when
 * `me.data?.isInstanceAdmin === true`. They live here — a `role="menuitem"`
 * each — and deliberately not in `nav-items.ts`: neither is a destination of
 * the product, they are the account's own settings.
 *
 * `logout` keeps the mutation semantics it had in `AppShell` verbatim —
 * `networkMode: "always"` so an offline logout rejects immediately instead of
 * being queued and replayed on reconnect (AC4), the global-401 exemption, and
 * the unconditional `onSettled` redirect. This is a move, not a rewrite.
 */
export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // `enabled: false` — this reads the cache and never fetches.
  //
  // The router guard already populates `["auth","me"]` via `ensureQueryData`
  // before any authenticated route renders, so there is nothing here to fetch.
  // Letting it fetch is actively harmful: `main.tsx` routes a 401 from *any*
  // query to `/login`, so giving this query a live observer put a second,
  // independent trigger on that path — one that fires on refetch, in the
  // chrome, on every authenticated screen. The rail is not the right place to
  // discover that a session ended.
  //
  // The account name is display-only, and the honest fallback for "not in
  // cache" is the neutral label below.
  const me = useQuery({ ...authQueryOptions(), enabled: false });

  const logoutMutation = useMutation({
    mutationFn: logout,
    networkMode: "always",
    meta: { skipGlobal401: true },
    onSettled: () => {
      queryClient.clear();
      void navigate({ to: "/login" });
    },
  });

  const email = me.data?.email;
  // The sidebar footer's base currency — straight off the
  // response, never a hardcoded "EUR" (which would be right for every current
  // user and silently wrong for the first one who is not — the same failure
  // mode that dropped the cash tile).
  const baseCurrency = me.data?.baseCurrency;
  const initial = email === undefined ? "?" : email.slice(0, 1).toUpperCase();

  return (
    <div className="k-account">
      <button
        type="button"
        className="k-account-trigger"
        // The accessible name must not depend on the breakpoint.
        //
        // The only *visible* text in this button is `.k-account-email`, and
        // `components.css`'s `@media (max-width: 1023px)` hides its wrapper
        // (`.k-account-identity`) so the rail collapses to glyphs. The avatar
        // that remains is `aria-hidden`, so below 1024px this button had **no
        // accessible name at all** — unreachable by name for a screen reader,
        // and for `getByRole`. That is why four e2e specs failed only on the
        // `iPhone 14` project: the collapsed-rail widths (641-1023px) had the
        // same hole and nothing was asserting there.
        //
        // `aria-label` fixes it at every width and changes nothing above
        // 1024px, where this is already the computed name.
        aria-label={email ?? SHELL_COPY.account}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="k-account-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="k-account-identity">
          <span className="k-account-email">{email ?? SHELL_COPY.account}</span>
          {baseCurrency !== undefined && (
            <span data-testid="account-base-currency" className="k-account-sub k-mono">
              {baseCurrency}
            </span>
          )}
        </span>
        <Icon name={open ? "chevron-down" : "chevron-up"} size="xs" />
      </button>

      {open ? (
        <div role="menu" className="k-account-menu">
          <Link
            to="/account"
            role="menuitem"
            data-testid="account-link"
            className="k-account-menu-item"
            onClick={() => setOpen(false)}
          >
            <Icon name="user" size="sm" />
            {SHELL_COPY.myAccount}
          </Link>

          {/* UR-70, and the reason the test is `queryByTestId(...) === null`
              rather than `not.toBeVisible()`: a non-admin's DOM contains no
              trace of this entry. `undefined` — the cache-miss state this
              `enabled: false` query genuinely has — renders nothing either;
              the comparison is `=== true`, so "not known yet" fails closed,
              exactly like a known non-admin. */}
          {me.data?.isInstanceAdmin === true ? (
            <Link
              to="/admin/users"
              role="menuitem"
              data-testid="admin-users-link"
              className="k-account-menu-item"
              onClick={() => setOpen(false)}
            >
              <Icon name="users" size="sm" />
              {SHELL_COPY.users}
            </Link>
          ) : null}

          <button
            type="button"
            role="menuitem"
            data-testid="logout-button"
            className="k-account-menu-item"
            onClick={() => logoutMutation.mutate()}
          >
            <Icon name="log-out" size="sm" />
            {SHELL_COPY.logout}
          </button>
        </div>
      ) : null}
    </div>
  );
}
