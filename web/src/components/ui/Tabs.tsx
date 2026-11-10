import type { ReactNode } from "react";

/**
 * The tab strip used by the portfolio workspace, Positions and the ledger.
 *
 * `render` lets a consumer decide what a tab *is* — this app navigates with
 * TanStack Router `<Link>`s where a tab maps to a route search param, and a
 * component that hard-coded `<button onClick>` would force those call sites to
 * choose between the design's appearance and the router's behaviour. The
 * default renders a button, so the simple case stays simple.
 */
export interface TabItem {
  readonly key: string;
  readonly label: string;
  readonly count?: number;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  readonly active: string;
  readonly label: string;
  readonly onSelect?: (key: string) => void;
  readonly render?: (item: TabItem, props: { active: boolean; className: string }) => ReactNode;
}

export function Tabs({ items, active, label, onSelect, render }: TabsProps) {
  return (
    <div role="tablist" aria-label={label} className="k-tabs">
      {items.map((item) => {
        const isActive = item.key === active;
        const className = "k-tab";
        const content = (
          <>
            {item.label}
            {item.count !== undefined ? <span className="k-tab-count">{item.count}</span> : null}
          </>
        );

        if (render !== undefined) {
          return (
            <span key={item.key} data-selected={isActive}>
              {render(item, { active: isActive, className })}
            </span>
          );
        }

        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-selected={isActive}
            className={className}
            onClick={() => onSelect?.(item.key)}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
