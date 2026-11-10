import type { ReactNode } from "react";
import { GlobalWriteActions } from "./GlobalWriteActions.js";

/**
 * The header every destination renders: title, one-line
 * subtitle, date-range selector, contextual actions, and **always** the two
 * global write actions.
 *
 * Those last two are the reason this is one component rather than a shared
 * layout convention. FR-97 binds "Nouvel instrument" and "Nouvelle
 * transaction" to *every* destination; before this they lived in the shell's
 * top bar, which satisfied the requirement by accident of position. Making the
 * header their single owner turns FR-97 into a structural property —
 * `page-header.test.tsx` walks the route list and asserts it, rather than
 * six independent renderings each having remembered.
 *
 * The two write actions come from `GlobalWriteActions`, shared with the detail
 * views — which have headings of their own and are not nav destinations, and
 * which were therefore left without them. See that component for why that was
 * wrong.
 *
 * ## What is deliberately not here
 *
 * The design's header also carries a **portfolio selector**. This app has no
 * global portfolio scope: Aperçu is tenant-wide by construction, and a single
 * portfolio is a destination (`/portfolios/$portfolioId`) rather than a filter
 * over the others. A selector in the chrome would imply a scope the reads do
 * not have.
 */
export interface PageHeaderProps {
  readonly title: string;
  /** One line. Descriptive, never advice. */
  readonly subtitle: string;
  /** The date-range control, where the screen has one. */
  readonly range?: ReactNode;
  /** Screen-specific actions, rendered before the two global ones. */
  readonly actions?: ReactNode;
}

export function PageHeader({ title, subtitle, range, actions }: PageHeaderProps) {
  return (
    <header className="k-pagehead" data-testid="page-header">
      <div className="k-pagehead-titles">
        <h1 className="k-pagehead-title">{title}</h1>
        <p className="k-pagehead-subtitle">{subtitle}</p>
      </div>

      <div className="k-pagehead-actions">
        {range}
        {actions}
        <GlobalWriteActions />
      </div>
    </header>
  );
}
