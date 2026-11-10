import { Link } from "@tanstack/react-router";
import { NAV_SECTIONS } from "../nav-items.js";
import { AccountMenu } from "./AccountMenu.js";
import { Brand } from "./ui/Brand.js";
import { Icon } from "./ui/Icon.js";
import { SHELL_COPY } from "../lib/copy/shell.js";

/**
 * The persistent rail — 248px, white, items grouped under micro-labels.
 *
 * The rail renders **the six shipped destinations under the two shipped
 * headings**. The design's three-group, eight-entry information architecture
 * needs Performance and Price & valuation to exist first, and adding a nav
 * entry to a route that does not exist is precisely the "honest-disabled"
 * state `nav-items.ts` was built around — and which is currently empty
 * because `PendingNavPath` is `never`, not because a test says so
 * (`nav-items.test.ts` did, until it was deleted). That work is still open.
 *
 * ## Three tiers, not two
 *
 * Below 640px the rail is not rendered at all (`PrimaryNav` returns null) and
 * the mobile tab bar takes over. Between 640 and 1024px it compacts to
 * icon-only at `--sidebar-width-collapsed`, with the label still in the
 * accessibility tree via a visually-hidden span — the token set anticipated
 * this tier, and `responsive-nav.spec.ts` asserts it. It expands to
 * icon-plus-label at 1024px and up.
 *
 * The kerdial-skin rewrite dropped the middle tier and shipped one 248px rail
 * at every width; the e2e suite caught it. Restored here.
 *
 * There is **no dark/light switch**: the token set
 * ships a light ramp only, and authoring a dark ramp for every colour, chart
 * series and asset-class token is a design job (D4).
 *
 * Every item's icon comes from `nav-items.ts`, the same place its label and
 * route come from, so the rail and the mobile surfaces cannot drift.
 */
export function SideNav() {
  return (
    <nav data-testid="primary-nav" aria-label={SHELL_COPY.primaryNav} className="k-rail">
      <div className="k-rail-brand">
        <Brand />
      </div>

      <div className="k-rail-sections">
        {NAV_SECTIONS.map((section) => (
          <div key={section.id} className="k-rail-section">
            <span className="micro-label k-rail-section-label">{section.label}</span>
            {section.items.map((item) =>
              item.disabledReason === undefined ? (
                <Link
                  key={item.to}
                  to={item.to}
                  className="k-rail-item"
                  activeProps={{ className: "active" }}
                >
                  <Icon name={item.icon} size="sm" />
                  <span data-testid="nav-label-visible" className="k-rail-label">
                    {item.label}
                  </span>
                  <span data-testid="nav-label-sr-only" className="k-rail-label-sr">
                    {item.label}
                  </span>
                </Link>
              ) : (
                <span
                  key={item.to}
                  role="link"
                  aria-disabled="true"
                  tabIndex={-1}
                  title={item.disabledReason}
                  className="k-rail-item k-rail-item-disabled"
                >
                  <Icon name={item.icon} size="sm" />
                  <span data-testid="nav-label-visible" className="k-rail-label">
                    {item.label}
                  </span>
                  <span data-testid="nav-label-sr-only" className="k-rail-label-sr">
                    {item.label}
                  </span>
                </span>
              ),
            )}
          </div>
        ))}
      </div>

      <div className="k-rail-foot">
        <AccountMenu />
      </div>
    </nav>
  );
}
