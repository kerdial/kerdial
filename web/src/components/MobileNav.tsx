import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Link } from "@tanstack/react-router";
import { NAV_SECTIONS } from "../nav-items.js";
import { AccountMenu } from "./AccountMenu.js";
import { Icon } from "./ui/Icon.js";
import { SHELL_COPY } from "../lib/copy/shell.js";

/**
 * The `<640px` drawer, opened from `MobileTabBar`'s "Plus" tab
 * (UR-25): a full-screen
 * Radix `Dialog` containing **every** destination,
 * grouped by section — the tab bar itself only ever holds the four
 * highest-frequency ones (`MOBILE_TAB_ITEMS`), so the drawer is what keeps
 * all six mobile-reachable (AC30/AC31 parity).
 *
 * `data-testid="mobile-nav-trigger"` (this component's `Dialog.Trigger`) /
 * `data-testid="mobile-nav"` (the drawer's own `<nav>`) are preserved
 * exactly — `nav-helpers.ts`'s `navigateViaNav` and every e2e spec that
 * drives the mobile nav read these two testids unmodified.
 *
 * Radix `Dialog` in its default modal mode `aria-hide`s everything outside
 * `Dialog.Content` while open — that's what keeps an unscoped
 * `page.getByRole("link", { name })` from hitting Playwright's strict-mode
 * violation against `MobileTabBar`'s own same-named links underneath, and
 * is asserted directly (not merely assumed) by
 * `web/e2e/nav-drawer-aria-hidden.spec.ts`, red-confirmed by temporarily
 * setting `modal={false}` here.
 */
export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          data-testid="mobile-nav-trigger"
          aria-label={SHELL_COPY.openNavMenu}
          className="k-tabbar-item"
        >
          <Icon name="menu" size="md" />
          <span>{SHELL_COPY.moreNav}</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content aria-describedby={undefined} className="k-navdrawer">
          <Dialog.Title className="micro-label">{SHELL_COPY.navigation}</Dialog.Title>
          <nav
            data-testid="mobile-nav"
            aria-label={SHELL_COPY.primaryNav}
            className="k-navdrawer-sections"
          >
            {NAV_SECTIONS.map((section) => (
              <div key={section.id} className="k-rail-section">
                <span className="micro-label k-rail-section-label">{section.label}</span>
                {section.items.map((item) =>
                  item.disabledReason === undefined ? (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={() => setOpen(false)}
                      className="k-rail-item"
                      activeProps={{ className: "active" }}
                    >
                      <Icon name={item.icon} size="sm" />
                      {item.label}
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
                      {item.label}
                    </span>
                  ),
                )}
              </div>
            ))}
          </nav>

          {/* The rail's account footer has no equivalent below 640px — the rail
              itself is not rendered there — so it lives in this drawer too.
              AC89 binds logout to *every* width, and `AppShell.test.tsx`
              asserts it at both. */}
          <div className="k-navdrawer-foot">
            <AccountMenu />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
