import { gzipSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `check-sparkline-chunk.ts` — UR-29 (NFR-21), **since generalised to every
 * chart surface**. Asserts, against a real production
 * build (`pnpm --filter @kerdial/web build` first), four properties of the
 * charting library:
 *
 * 1. it lives in exactly **one** emitted chunk;
 * 2. that chunk is not the entry chunk and is not referenced from
 *    `index.html` at all — i.e. it is not in the eagerly-loaded graph;
 * 3. **both** `React.lazy` boundaries that use it are emitted as their own
 *    chunks and both reference that one shared chunk — so the library is
 *    genuinely shared, not duplicated per surface;
 * 4. it stays under the gzip budget below.
 *
 * **What the generalisation changed, and why the script's name did not.** It
 * added a second chart surface (`PerformanceChart.tsx`, the performance
 * screen's base-100 chart; since deleted, the watchlist drawdown chart now
 * being the other boundary) beside the sparkline, and every surface reaches
 * `echarts` through the single `EchartsCanvas.tsx` entry module (see that file for why one
 * shared entry beat a two-file allowlist on the source-text gate). Rollup
 * therefore hoists the library into a **shared** chunk that neither lazy
 * boundary is named after — so this script can no longer look for a chunk
 * whose filename starts with `InstrumentPriceSparkline-`. It finds the chart
 * chunk by content instead, which is what it always actually cared about.
 * The `pnpm check:sparkline-chunk` script name is left alone deliberately:
 * `api/src/ci-gating.test.ts` compares this repo's gate set between
 * `scripts/verify.sh` and `ci.yml` by script name, and renaming a gate is a
 * change in three files for no gain in what is checked.
 *
 * **The budget number, corrected against measurement.** The original budget
 * was **120 KB gzip**, an estimate made without building.
 * Measured on echarts 6.1.0, three ways — `vite build`'s own reported gzip
 * first, then this script's `zlib.gzipSync` at its default level (which is
 * why the two differ by a few KB; this gate uses its own column):
 *
 * | Variant                                         | raw       | gzip (vite) | gzip (here) |
 * |-------------------------------------------------|-----------|-------------|-------------|
 * | `echarts/core` + Line + Grid + Tooltip + Canvas  | 498.7 KB  | 170.9 KB    | 166.9 KB    |
 * | same, without `TooltipComponent`                 | 471.7 KB  | 161.3 KB    | —           |
 * | careless `import "echarts"` (full bundle)        | 1131.2 KB | 379.6 KB    | 371.6 KB    |
 *
 * So 120 KB was never reachable with the component set UR-29 itself
 * mandates — echarts' floor here is ~161 KB gzip before any choice of ours.
 * The budget is **180 KB gzip** (measured 166.9 + headroom) with the user's
 * explicit lock, and it still does the job a budget exists for: the
 * full-bundle import measures 371.6 KB here, more than twice the gate, so a
 * careless `import "echarts"` fails it immediately (red-confirmed, both
 * directions). The second surface spends none of that headroom: it registers no new echarts
 * component (`EchartsCanvas.tsx`'s `use([...])` is the sparkline's own four),
 * which is exactly why the second surface renders its legend in DOM rather
 * than through `LegendComponent`.
 *
 * The accepted precache consequence — every user pays the chunk
 * at service-worker install, including users who never open an instrument —
 * is therefore ~167 KB gzip, not ~120 KB. Recorded rather than papered over.
 */

const BUDGET_GZIP_BYTES = 180 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "web", "dist");
const assetsDir = join(distDir, "assets");

/** Substrings that betray the charting library's presence in a chunk. */
const CHART_LIBRARY_MARKERS = ["echarts", "zrender"] as const;

/**
 * The `React.lazy` boundaries that pull the chart chunk in. Every one must
 * exist as its own chunk — a collapsed boundary (someone importing a chart
 * surface statically) is the regression this list catches, and it is not
 * visible from the library's own chunk.
 *
 * **Three since the watchlist cycle** (NFR-38): `WatchlistAnalysisPanel.tsx`
 * mounts the drawdown chart (FR-360) through a further `React.lazy`
 * boundary, and reaches the *existing* `InstrumentPriceSparkline` boundary
 * for its per-instrument detail chart (FR-358) — the same module
 * `InstrumentDetailView.tsx` already lazy-loads, which is why that boundary's
 * chunk count stays at one. (The cycle shipped a fourth, the rebased-to-100
 * comparison, FR-359; it was withdrawn on 2026-09-11 when
 * the analysis became per-instrument, and its name left this list with the
 * file.) Naming the boundary here is what makes "every lazy boundary shares
 * the one chart chunk" a measurement rather than a claim: without it, a
 * watchlist chart that duplicated the library into its own chunk would still
 * be caught by check 1, but one that quietly stopped being lazy would not.
 */
const LAZY_CHART_BOUNDARY_PREFIXES = [
  "InstrumentPriceSparkline-",
  "WatchlistDrawdownChart-",
] as const;

function fail(message: string): never {
  console.error(`check-sparkline-chunk: ${message}`);
  process.exit(1);
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

if (!existsSync(assetsDir)) {
  fail(
    `no build output at ${assetsDir} — run \`pnpm --filter @kerdial/web build\` first. ` +
      `This check is only meaningful against a real production build.`,
  );
}

const jsFiles = readdirSync(assetsDir).filter((file) => file.endsWith(".js"));

// Cardinality guard, the same one the source-text gates carry: "no chunk
// contains echarts" is also what an empty/mis-resolved directory reports.
if (jsFiles.length < 3) {
  fail(
    `expected at least three JS chunks in ${assetsDir} (an entry chunk, the shared chart chunk and the lazy boundaries), found ${String(jsFiles.length)}: ${jsFiles.join(", ")}`,
  );
}

const contents = new Map(
  jsFiles.map((file) => [file, readFileSync(join(assetsDir, file), "utf8")] as const),
);

// 1. Exactly one chunk carries the library. More than one means it was
//    duplicated per surface instead of shared; none means the walk is broken
//    (or someone deleted the charts).
const chartChunks = jsFiles.filter((file) =>
  CHART_LIBRARY_MARKERS.some((marker) => (contents.get(file) ?? "").includes(marker)),
);
if (chartChunks.length !== 1) {
  fail(
    `expected exactly one chunk containing ${CHART_LIBRARY_MARKERS.join("/")}, found ${String(chartChunks.length)}: ${chartChunks.join(", ") || "none"}. ` +
      `More than one means the library was duplicated instead of shared through EchartsCanvas.tsx; none means it left the build entirely.`,
  );
}

const chartChunk = chartChunks[0]!;
const chartSource = contents.get(chartChunk)!;

// 2. It is not in the eagerly-loaded graph: `index.html` references the entry
//    chunk (and modulepreloads every chunk statically reachable from it), so
//    the chart chunk appearing there at all means it is no longer lazy.
const indexHtmlPath = join(distDir, "index.html");
if (!existsSync(indexHtmlPath)) fail(`no ${indexHtmlPath} — is this a real production build?`);
const indexHtml = readFileSync(indexHtmlPath, "utf8");
if (indexHtml.includes(chartChunk)) {
  fail(
    `${chartChunk} is referenced from index.html — the chart library is in the eager graph (entry chunk or a modulepreload), not behind a React.lazy boundary.`,
  );
}

// 3. Every lazy boundary exists and each points at that one shared chunk.
for (const prefix of LAZY_CHART_BOUNDARY_PREFIXES) {
  const matches = jsFiles.filter((file) => file.startsWith(prefix));
  if (matches.length !== 1) {
    fail(
      `expected exactly one \`${prefix}*.js\` chunk (its React.lazy boundary), found ${String(matches.length)}: ${matches.join(", ") || "none"}`,
    );
  }
  const boundary = matches[0]!;
  if (!(contents.get(boundary) ?? "").includes(chartChunk)) {
    fail(
      `${boundary} does not reference ${chartChunk} — that surface is not loading the shared chart entry, so the library is reaching it some other way.`,
    );
  }
}

const rawBytes = Buffer.byteLength(chartSource);
const gzipBytes = gzipSync(Buffer.from(chartSource)).byteLength;

console.log(
  `check-sparkline-chunk: ${chartChunk} — raw ${kib(rawBytes)}, gzip ${kib(gzipBytes)} (budget ${kib(BUDGET_GZIP_BYTES)}).`,
);
console.log(
  `check-sparkline-chunk: the chart library appears in that chunk only; ${String(jsFiles.length - 1)} other chunk(s) are clean, and all ${String(LAZY_CHART_BOUNDARY_PREFIXES.length)} lazy boundaries (${LAZY_CHART_BOUNDARY_PREFIXES.join(", ")}) share it.`,
);

if (gzipBytes > BUDGET_GZIP_BYTES) {
  fail(
    `gzip ${kib(gzipBytes)} exceeds the ${kib(BUDGET_GZIP_BYTES)} budget. Either the import stopped being tree-shaken (\`import "echarts"\` measures ~379.6 KB gzip) or a new chart component was added to \`EchartsCanvas.tsx\`'s \`use([...])\` list. Widening the budget is a decision, not a fix.`,
  );
}
