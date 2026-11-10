/**
 * `html-escape.ts` — security review, MEDIUM.
 *
 * ECharts assigns a tooltip formatter's string return via `innerHTML`
 * (`TooltipHTMLContent`, the default `renderMode: "html"`), so every value a
 * formatter interpolates is a markup sink. Most of what the two chart
 * surfaces interpolate is closed-map labels and `figure-format` output — but
 * `displayName` is 200 free characters on a SHARED instrument catalogue, so
 * one tenant's `<style>` would render live in another tenant's origin the
 * moment it is picked as a benchmark. The CSP contains the blast radius
 * (`script-src 'self'`), not the injection.
 *
 * Escape at the interpolation point, always, even for values that are
 * currently safe by construction: the guarantee has to survive the next
 * person adding a field to the tooltip. `formatPerformanceTooltip` and
 * `formatSparklineTooltip`'s tests feed hostile strings through and assert
 * the output carries no raw markup.
 */
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}
