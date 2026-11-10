import { useEffect, useRef } from "react";
import { LineChart, ScatterChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { init, use, type EChartsCoreOption, type ECharts } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

/**
 * `EchartsCanvas.tsx` — **the app's single ECharts entry point**
 * (UR-29/NFR-21, since generalised to a second chart).
 *
 * NFR-21's "exactly one chart surface" was originally enforced by pointing
 * `echarts-sole-importer.test.ts` at `InstrumentPriceSparkline.tsx`, the only
 * chart there was. A second surface now exists — the performance screen's
 * value-series chart with its benchmark overlay — and that gate offered two
 * ways out: widen it to a two-file allowlist, or keep it at exactly one file
 * by making the two surfaces share one entry. **This is the second**, and it
 * is the stronger of the two: the allowlist version would have let the
 * `use([...])` component registration drift apart between the surfaces (two
 * lists, two bundle footprints, one budget), whereas one entry file makes the
 * registered component set structurally shared. The gate itself is unchanged
 * in kind — still "exactly one file under `web/src` imports echarts" — only
 * the file it names moved here.
 *
 * **The registered set is deliberately still the sparkline's own.**
 * `LineChart`, `ScatterChart` (the trade markers), `CanvasRenderer`,
 * `GridComponent`, `TooltipComponent` — exactly what the sparkline already
 * pulled, so it adds no bytes to the chart chunk
 * (`scripts/check-sparkline-chunk.ts`' budget has ~10 KB of headroom, which
 * a `LegendComponent` could plausibly have eaten). The performance chart's
 * legend is therefore ordinary DOM beside the canvas, not an echarts legend,
 * and its axes come from `GridComponent`, which is already here.
 *
 * **Lazy, from both call sites.** Neither surface imports this module
 * statically: `InstrumentDetailView.tsx` and `PerformanceView.tsx` each reach
 * it through a `React.lazy` boundary, so Rollup keeps the library out of the
 * entry chunk. `scripts/check-sparkline-chunk.ts` asserts that against a real
 * production build.
 *
 * This component owns the imperative half only — mount, `setOption`, dispose,
 * and (2026-09-09) an optional drag-to-select-range gesture. Every option
 * object is built by a pure function in the surface that owns it
 * (`buildSparklineOption`, `buildDrawdownChartOption`), which is what keeps
 * the chart options unit-testable without a canvas.
 */
use([LineChart, ScatterChart, CanvasRenderer, GridComponent, TooltipComponent]);

/**
 * Re-exported so the two chart surfaces can type their own option builders
 * without importing `echarts` themselves — a bare
 * `import type { EChartsCoreOption } from "echarts/core"` emits nothing at
 * runtime but is still an echarts import in source text, which is exactly
 * what `echarts-sole-importer.test.ts` reads.
 */
export type { EChartsCoreOption };

/**
 * Pixels of pointer movement before a press-and-hold is treated as a drag
 * rather than a click — below this, `pointerup` lets the click through to
 * ECharts' own `mousemove|click` tooltip trigger untouched (nothing here
 * calls `preventDefault`/`stopPropagation`), so a plain tap still reads a
 * point's price exactly as it did before this gesture existed.
 */
const DRAG_SELECT_THRESHOLD_PX = 4;

export interface EchartsCanvasProps {
  /** Built by the calling surface's own pure option builder. */
  readonly option: EChartsCoreOption;
  readonly testId: string;
  readonly className?: string;
  /**
   * Instrument-detail identity/chart edit (2026-09-09) — "select the period
   * directly on the chart". Called once, on `pointerup`, after a genuine drag
   * (see {@link DRAG_SELECT_THRESHOLD_PX}) — never on a plain click, which
   * stays the tooltip's own gesture. The two indices are the nearest
   * **category-axis** data indices under the drag's start/end pixels, resolved
   * via `chart.convertFromPixel` (a core ECharts instance method — no
   * additional `use([...])` registration, so this costs the chart chunk
   * nothing: no `Brush`/`Toolbox`/`DataZoom` component was added for it),
   * ordered ascending regardless of drag direction.
   *
   * Deliberately **not** echarts' own `dataZoom`: both chart surfaces already
   * filter their series data before it ever reaches `buildSparklineOption`
   * (`InstrumentPriceSparkline.tsx`'s `sliceStart`/`sliceEnd`), so a second,
   * echarts-native zoom state would be a second source of truth for "what
   * range is showing" that the surface would have to keep synchronised with
   * its own. A plain pixel-to-index conversion needs no such state.
   *
   * Optional: a surface with no category x-axis, or no on-chart selection
   * need, simply omits it — `PerformanceView.tsx`'s chart does not pass one.
   */
  readonly onRangeSelect?: (startIndex: number, endIndex: number) => void;
}

export function EchartsCanvas({ option, testId, className, onRangeSelect }: EchartsCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startClientX: number; dragging: boolean } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const chart = chartRef.current ?? init(container);
    chartRef.current = chart;
    chart.setOption(option);
    return () => {
      chart.dispose();
      chartRef.current = null;
    };
  }, [option]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || onRangeSelect === undefined) return;
    // A `const` copy, not the destructured prop itself: TypeScript does not
    // carry the `undefined`-narrowing above into the nested `function`
    // declarations below (closures over a possibly-reassigned binding), but
    // it does carry a `const`'s own narrowed type.
    const handleRangeSelect = onRangeSelect;

    function indexAtClientX(clientX: number): number | undefined {
      const chart = chartRef.current;
      if (chart === null || container === null) return undefined;
      const x = clientX - container.getBoundingClientRect().left;
      // Category axis: `convertFromPixel` resolves to the nearest data index
      // directly, not a category value — exactly the index this surface's
      // `sliceStart`/`sliceEnd` already track.
      const value: unknown = chart.convertFromPixel({ xAxisIndex: 0 }, x);
      return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
    }

    function removeOverlay() {
      overlayRef.current?.remove();
      overlayRef.current = null;
    }

    function onPointerDown(event: PointerEvent) {
      if (event.button !== 0) return;
      dragRef.current = { startClientX: event.clientX, dragging: false };
    }

    function onPointerMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (drag === null || container === null) return;
      const delta = Math.abs(event.clientX - drag.startClientX);
      if (!drag.dragging) {
        if (delta < DRAG_SELECT_THRESHOLD_PX) return;
        drag.dragging = true;
      }

      const rect = container.getBoundingClientRect();
      const fromX = Math.min(drag.startClientX, event.clientX) - rect.left;
      const toX = Math.max(drag.startClientX, event.clientX) - rect.left;

      let overlay = overlayRef.current;
      if (overlay === null) {
        overlay = document.createElement("div");
        overlay.className = "k-inst-chart-select-overlay";
        container.appendChild(overlay);
        overlayRef.current = overlay;
      }
      overlay.style.left = `${Math.max(0, fromX)}px`;
      overlay.style.width = `${Math.max(0, toX - fromX)}px`;
    }

    function onPointerUp(event: PointerEvent) {
      const drag = dragRef.current;
      dragRef.current = null;
      removeOverlay();
      if (drag === null || !drag.dragging) return;

      const startIndex = indexAtClientX(drag.startClientX);
      const endIndex = indexAtClientX(event.clientX);
      if (startIndex === undefined || endIndex === undefined) return;
      handleRangeSelect(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex));
    }

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerUp);
    return () => {
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerUp);
      removeOverlay();
    };
  }, [onRangeSelect]);

  return <div ref={containerRef} data-testid={testId} className={className} />;
}
