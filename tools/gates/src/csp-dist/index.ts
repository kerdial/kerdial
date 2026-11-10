import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `SH-22` (two things must be verified against the **real** `web/dist`;
 * FR-4/FR-8, AC-7) — the build-time CSP verification gate.
 *
 * The CSP this project ships (FR-4) is **enforced from day one and cited from a
 * prior security review, not re-derived**. That makes the danger asymmetric: a
 * directive that is too narrow for what the build actually emits does not fail a
 * test, it blanks the deployed app in a browser. And the artifacts it must match
 * are *generated* — a Tailwind utility, a Vite plugin default, or a workbox
 * version bump can introduce a `data:` background or a remote runtime import
 * without a single line of this repo's own source changing.
 *
 * So this gate reads the **built output** and reports anything the policy would
 * block. It is deliberately a separate CLI over `web/dist` rather than a unit
 * test: `web/dist` is a gitignored build artifact, and a test that silently
 * skipped when it was absent would be a gate that passes hardest exactly when
 * nothing was checked. CI builds, then runs this.
 *
 * **What it must never do is widen the policy.** A needed widening is flagged
 * back to the analyst, not made quietly by the developer. This gate therefore
 * only ever reports; every finding is a question for a human, and the two
 * verification items it exists for
 * (**U4**, **V1**) each block a requirement (FR-8/AC-7 and the CSP rollout
 * respectively) when they fail.
 */

/** The directive set FR-4 cites, kept here as data so a finding can name the exact directive it violates. */
export const CITED_CSP_DIRECTIVES = {
  defaultSrc: "default-src 'self'",
  scriptSrc: "script-src 'self'",
  workerSrc: "worker-src 'self'",
  manifestSrc: "manifest-src 'self'",
  connectSrc: "connect-src 'self'",
  imgSrc: "img-src 'self'",
  fontSrc: "font-src 'self'",
  styleSrc: "style-src 'self' 'unsafe-inline'",
  frameAncestors: "frame-ancestors 'none'",
  baseUri: "base-uri 'none'",
  objectSrc: "object-src 'none'",
  formAction: "form-action 'self'",
} as const;

export interface CspFinding {
  /** `U4-n` / `V1-n` (the two verification items) or `CSP-n` (a directive the built output would violate). */
  readonly id: string;
  /** Dist-relative path, or `"(dist)"` for a finding about the tree itself. */
  readonly file: string;
  /** The CSP directive or design item this endangers. */
  readonly directive: string;
  readonly detail: string;
}

/**
 * Absolute URLs that may legitimately appear as **text** inside the service
 * worker or the workbox runtime — a documentation link inside a warning
 * message. Nothing here is ever fetched, and the list is a closed allowlist
 * precisely so a genuinely new remote origin cannot hide among them: an
 * unexpected absolute URL in the SW is reported for a human to classify rather
 * than pattern-matched away.
 */
const SW_TEXT_URL_ALLOWLIST: readonly string[] = ["https://bit.ly/wb-precache"];

/**
 * Absolute URLs that may legitimately appear in the application bundle. All of
 * these are XML/SVG/MathML **namespace identifiers** (arguments to
 * `createElementNS`, never network requests), JSON-Schema `$schema` ids, or
 * documentation links inside library error messages. Same closed-list rationale
 * as above: `connect-src 'self'`/`img-src 'self'` would block a real remote
 * fetch, so an unrecognised host must reach a human.
 */
const BUNDLE_TEXT_URL_ALLOWLIST: readonly string[] = [
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/XML/1998/namespace",
  "http://json-schema.org/draft-04/schema",
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft/2020-12/schema",
  "https://react.dev/errors/",
  "https://github.com/MikeMcl/decimal.js",
  // Library doc/licence links in minified banners and error strings —
  // zrender's (echarts') `/* … LICENSE … */` header in the sparkline chunk
  // is the case that prompted this entry. Deliberately a **broad host
  // prefix**, chosen by the owner over the specific LICENSE path: matching is
  // `startsWith` (see `unexpectedAbsoluteUrls` below), so this allows *every*
  // github.com URL, including a real `fetch()` to one. That is the accepted
  // cost of not re-classifying each new dependency's banner link; it does mean
  // this gate can no longer report that host. Narrow it to full paths if a
  // bundle ever legitimately needs to talk to github.com.
  "https://github.com/",
  "https://tailwindcss.com",
  // TanStack Router's fallback when `window.origin` is unavailable (SSR/tests);
  // used to construct a `URL` for parsing, never to fetch.
  "http://localhost",
];

const ABSOLUTE_URL_PATTERN = /https?:\/\/[^\s"'`)\\]+/g;

/**
 * A `data:` URI, in any position (CSS `url()`, an HTML attribute, a JS string).
 *
 * **The MIME type is required, and that is not incidental strictness.** A bare
 * `data:` match is worthless against a *minified* bundle: `data:` is one of the
 * most common property keys in this app's dependencies (React's form state,
 * TanStack Query's `{data: …}`, floating-ui's `{data: {…}}`), and an earlier
 * version of this pattern reported 36 of them as CSP violations on the real
 * build. So the shapes matched are the ones that are unambiguously a URI:
 * `data:<type>/<subtype>`, the typeless `data:,` and `data:;base64,` forms, and
 * anything inside a CSS `url(...)`.
 */
const DATA_URI_PATTERNS: readonly RegExp[] = [
  /data:([a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9!#$&^_.+-]+)/g,
  /data:(\s*;\s*base64\s*,)/g,
  /data:(,)/g,
  /url\(\s*["']?(data:)/g,
];

export interface DistFile {
  /** Dist-relative path, POSIX-style. */
  readonly path: string;
  readonly contents: string;
}

const TEXT_EXTENSIONS = [".js", ".mjs", ".css", ".html", ".webmanifest", ".json", ".map", ".svg"];

function isTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** Reads every text file in the built tree, recursively. Binary assets (icons, images) are skipped by extension. */
export function readDistFiles(distDir: string): DistFile[] {
  const files: DistFile[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!isTextFile(entry)) continue;
      files.push({
        path: relative(distDir, full).split("\\").join("/"),
        contents: readFileSync(full, "utf8"),
      });
    }
  }
  walk(distDir);
  return files;
}

function findingsForDataUris(files: readonly DistFile[]): CspFinding[] {
  const findings: CspFinding[] = [];
  for (const file of files) {
    // `.map` files embed the *sources*, not the shipped bytes; a `data:` inside a
    // source map is never loaded by a browser as a resource.
    if (file.path.endsWith(".map")) continue;
    const seen = new Set<number>();
    for (const pattern of DATA_URI_PATTERNS) {
      for (const match of file.contents.matchAll(pattern)) {
        // The CSS-`url()` pattern's match starts before `data:`; index the
        // finding on the URI itself so the four patterns cannot double-report one
        // occurrence.
        const uriIndex = file.contents.indexOf("data:", match.index);
        if (seen.has(uriIndex)) continue;
        seen.add(uriIndex);
        const mime = match[1] ?? "";
        const isImage = mime.startsWith("image/");
        const isFont = mime.startsWith("font/") || mime.startsWith("application/font");
        // Any other type — or the typeless forms — still matters: the policy has
        // no `data:` source in any directive, so nothing may load one.
        findings.push({
          id: isImage ? "V1-1" : isFont ? "V1-2" : "V1-3",
          file: file.path,
          directive: isImage
            ? CITED_CSP_DIRECTIVES.imgSrc
            : isFont
              ? CITED_CSP_DIRECTIVES.fontSrc
              : CITED_CSP_DIRECTIVES.defaultSrc,
          detail:
            `the built output contains a \`data:${mime}\` URI, which the cited policy has no source for. ` +
            `V1: a needed widening is flagged back to the analyst, never applied here. ` +
            `Context: ${context(file.contents, uriIndex)}`,
        });
      }
    }
  }
  return findings;
}

function context(contents: string, index: number): string {
  const start = Math.max(0, index - 40);
  return JSON.stringify(contents.slice(start, index + 60));
}

function unexpectedAbsoluteUrls(
  file: DistFile,
  allowlist: readonly string[],
): { url: string; index: number }[] {
  const unexpected: { url: string; index: number }[] = [];
  for (const match of file.contents.matchAll(ABSOLUTE_URL_PATTERN)) {
    const url = match[0];
    if (allowlist.some((allowed) => url.startsWith(allowed))) continue;
    // A URL whose **host** is a template placeholder is constructed at runtime
    // from local values, not a fixed remote origin — zod's IPv6 format check
    // (`new URL(\`http://[${value}]\`)`) is the real case, and it parses rather
    // than fetches. Reported findings must be actionable, and "the host is a
    // `${}`" is not an origin anyone can allowlist or block. A placeholder later
    // in the *path* (`https://api.example.test/${id}`) still has a concrete host
    // and is still reported.
    const host = url.slice(url.indexOf("//") + 2);
    if (host.startsWith("${") || host.startsWith("[${")) continue;
    unexpected.push({ url, index: match.index });
  }
  return unexpected;
}

/** Every `{url:"..."}` entry of the `precacheAndRoute([...])` manifest workbox's `generateSW` emits. */
export function precacheEntries(swContents: string): string[] {
  const manifest = /precacheAndRoute\(\s*\[(.*?)\]\s*,/s.exec(swContents);
  if (manifest === null) return [];
  return [...(manifest[1] ?? "").matchAll(/url\s*:\s*"([^"]*)"/g)].map((match) => match[1] ?? "");
}

/** The module ids the `generateSW` prologue's `define([...])` loads — the workbox runtime chunk. */
export function swDefineDependencies(swContents: string): string[] {
  const define = /\bdefine\(\s*\[([^\]]*)\]/.exec(swContents);
  if (define === null) return [];
  return [...(define[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((match) => match[1] ?? "");
}

function findingsForServiceWorker(distDir: string, files: readonly DistFile[]): CspFinding[] {
  const findings: CspFinding[] = [];
  const sw = files.find((file) => file.path === "sw.js");
  if (sw === undefined) {
    return [
      {
        id: "U4-0",
        file: "(dist)",
        directive: CITED_CSP_DIRECTIVES.workerSrc,
        detail:
          "no `sw.js` in the built output. The PWA (`generateSW`) is expected to emit one; its absence " +
          "means either the build is incomplete or the PWA was dropped — both need a human, since FR-8 " +
          "sends the CSP on `/sw.js` itself.",
      },
    ];
  }

  const dependencies = swDefineDependencies(sw.contents);
  if (dependencies.length === 0) {
    findings.push({
      id: "U4-1",
      file: "sw.js",
      directive: CITED_CSP_DIRECTIVES.scriptSrc,
      detail:
        "could not find the `define([...])` prologue that loads the workbox runtime chunk. U4 is about " +
        "*where that chunk comes from*, so a shape this gate cannot read must be re-verified by hand " +
        "rather than assumed same-origin.",
    });
  }
  for (const dependency of dependencies) {
    if (/^(https?:)?\/\//.test(dependency)) {
      findings.push({
        id: "U4-1",
        file: "sw.js",
        directive: CITED_CSP_DIRECTIVES.scriptSrc,
        detail:
          `the service worker loads its workbox runtime from \`${dependency}\` — a remote origin. ` +
          "U4 blocks FR-8/AC-7: `script-src 'self'` would break the service worker, so this must be " +
          "flagged back, not shipped.",
      });
      continue;
    }
    // Relative, as expected — and the file it names must actually be in the tree,
    // or the SW fails to boot for a reason CSP would be blamed for.
    const candidate = dependency.replace(/^\.\//, "");
    const resolved = candidate.endsWith(".js") ? candidate : `${candidate}.js`;
    if (!existsSync(join(distDir, resolved))) {
      findings.push({
        id: "U4-1",
        file: "sw.js",
        directive: CITED_CSP_DIRECTIVES.scriptSrc,
        detail: `the service worker loads \`${dependency}\`, but \`${resolved}\` is not in the built output.`,
      });
    }
  }

  for (const entry of precacheEntries(sw.contents)) {
    if (/^(https?:)?\/\//.test(entry)) {
      findings.push({
        id: "U4-3",
        file: "sw.js",
        directive: CITED_CSP_DIRECTIVES.connectSrc,
        detail:
          `the precache manifest contains the cross-origin entry \`${entry}\`. The SW's precache ` +
          "fetches must be same-origin (U4), or `connect-src 'self'` blocks them at install time.",
      });
    }
  }

  const workboxRuntime = files.filter((file) => /^workbox-[^/]*\.js$/.test(file.path));
  for (const file of [sw, ...workboxRuntime]) {
    for (const { url, index } of unexpectedAbsoluteUrls(file, SW_TEXT_URL_ALLOWLIST)) {
      findings.push({
        id: "U4-2",
        file: file.path,
        directive: CITED_CSP_DIRECTIVES.connectSrc,
        detail:
          `unrecognised absolute URL \`${url}\` in the service-worker layer. If it is fetched, U4 fails ` +
          "and FR-8/AC-7 block; if it is inert text (a doc link in a warning), add it to this gate's " +
          `allowlist with that reason. Context: ${context(file.contents, index)}`,
      });
    }
  }

  return findings;
}

function findingsForIndexHtml(files: readonly DistFile[]): CspFinding[] {
  const html = files.find((file) => file.path === "index.html");
  if (html === undefined) {
    return [
      {
        id: "CSP-0",
        file: "(dist)",
        directive: CITED_CSP_DIRECTIVES.defaultSrc,
        detail:
          "no `index.html` in the built output — the SPA shell FR-1 serves and FR-4 applies to.",
      },
    ];
  }
  const findings: CspFinding[] = [];
  const contents = html.contents;

  // `script-src 'self'` carries no `'unsafe-inline'`, so an inline script would
  // be blocked outright — a blank app, not a degraded one.
  for (const match of contents.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attributes = match[1] ?? "";
    const body = (match[2] ?? "").trim();
    if (!/\bsrc\s*=/.test(attributes) && body !== "") {
      findings.push({
        id: "CSP-1",
        file: html.path,
        directive: CITED_CSP_DIRECTIVES.scriptSrc,
        detail:
          "the shell contains an inline `<script>`. The cited policy has no `'unsafe-inline'` and no " +
          `nonce for scripts, so this would be blocked. Context: ${JSON.stringify(body.slice(0, 80))}`,
      });
    }
  }

  for (const match of contents.matchAll(/\son[a-z]+\s*=\s*["']/g)) {
    findings.push({
      id: "CSP-1",
      file: html.path,
      directive: CITED_CSP_DIRECTIVES.scriptSrc,
      detail: `the shell contains an inline event-handler attribute (${match[0].trim()}), which \`script-src 'self'\` blocks.`,
    });
  }

  // FR-4 is explicit that the policy is a *header*: the service worker's
  // execution context never sees a `<meta>` CSP, so one here would be both
  // ineffective for the SW and a second, intersecting policy for the page.
  if (/<meta[^>]+http-equiv\s*=\s*["']content-security-policy["']/i.test(contents)) {
    findings.push({
      id: "CSP-3",
      file: html.path,
      directive: "FR-4 (header, never a <meta> tag)",
      detail:
        'the shell carries a `<meta http-equiv="Content-Security-Policy">`. FR-4 requires the header ' +
        "form; a meta tag is invisible to the service worker's context and would intersect with the " +
        "header the app sends.",
    });
  }

  for (const match of contents.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const url = match[1] ?? "";
    if (/^(https?:)?\/\//.test(url)) {
      findings.push({
        id: "CSP-5",
        file: html.path,
        directive: CITED_CSP_DIRECTIVES.defaultSrc,
        detail: `the shell references the cross-origin resource \`${url}\`; every cited directive is \`'self'\`-only.`,
      });
    }
  }

  return findings;
}

function findingsForManifest(files: readonly DistFile[]): CspFinding[] {
  const manifest = files.find((file) => file.path.endsWith(".webmanifest"));
  if (manifest === undefined) return [];
  const findings: CspFinding[] = [];
  const parsed: unknown = JSON.parse(manifest.contents);
  const icons =
    typeof parsed === "object" && parsed !== null && "icons" in parsed
      ? (parsed as { icons?: unknown }).icons
      : undefined;
  const sources = Array.isArray(icons)
    ? icons.map((icon: unknown) =>
        typeof icon === "object" && icon !== null && "src" in icon
          ? String((icon as { src?: unknown }).src)
          : "",
      )
    : [];
  for (const source of sources) {
    if (/^(https?:)?\/\//.test(source)) {
      findings.push({
        id: "CSP-4",
        file: manifest.path,
        directive: CITED_CSP_DIRECTIVES.imgSrc,
        detail: `the web app manifest points at the cross-origin icon \`${source}\`, which \`img-src 'self'\` blocks.`,
      });
    }
  }
  return findings;
}

function findingsForBundle(files: readonly DistFile[]): CspFinding[] {
  const findings: CspFinding[] = [];
  const bundle = files.filter(
    (file) =>
      (file.path.endsWith(".js") || file.path.endsWith(".css")) &&
      !/^workbox-[^/]*\.js$/.test(file.path) &&
      file.path !== "sw.js",
  );

  for (const file of bundle) {
    // `script-src 'self'` without `'unsafe-eval'`: a bundle that reaches for
    // `eval`/`new Function` at runtime would throw in the browser.
    for (const pattern of [/\beval\s*\(/g, /\bnew\s+Function\s*\(/g]) {
      for (const match of file.contents.matchAll(pattern)) {
        findings.push({
          id: "CSP-2",
          file: file.path,
          directive: CITED_CSP_DIRECTIVES.scriptSrc,
          detail:
            `the built bundle calls \`${match[0].trim()}\`. The cited policy omits \`'unsafe-eval'\` ` +
            `(the review verified it was not needed), so this must be re-checked before the CSP ships. ` +
            `Context: ${context(file.contents, match.index)}`,
        });
      }
    }

    for (const { url, index } of unexpectedAbsoluteUrls(file, BUNDLE_TEXT_URL_ALLOWLIST)) {
      findings.push({
        id: "CSP-6",
        file: file.path,
        directive: CITED_CSP_DIRECTIVES.connectSrc,
        detail:
          `unrecognised absolute URL \`${url}\` in the built bundle. If the app fetches/loads it, the ` +
          "cited `'self'`-only directives block it and the policy needs a human decision; if it is inert " +
          `text (a namespace id, a doc link), add it to this gate's allowlist with that reason. Context: ${context(file.contents, index)}`,
      });
    }
  }

  return findings;
}

export interface CspGateResult {
  readonly distDir: string;
  readonly filesScanned: number;
  readonly findings: readonly CspFinding[];
  /** Human-readable list of what was actually checked, so a green run is evidence rather than silence. */
  readonly checksRun: readonly string[];
}

export const CHECKS_RUN: readonly string[] = [
  "U4-1 the service worker's workbox runtime chunk is loaded same-origin and exists in the tree",
  "U4-2 no unrecognised absolute URL in `sw.js` or the workbox runtime",
  "U4-3 every precache-manifest entry is same-origin (relative)",
  "V1-1/V1-2/V1-3 no `data:` image, font, or other URI anywhere in the shipped output",
  "CSP-1 no inline `<script>` and no inline event-handler attribute in the shell",
  "CSP-2 no `eval(`/`new Function(` in the built bundle",
  "CSP-3 no `<meta http-equiv=Content-Security-Policy>` in the shell (FR-4 requires the header form)",
  "CSP-4 the web app manifest's icons are same-origin",
  "CSP-5 the shell references no cross-origin script/style/manifest",
  "CSP-6 no unrecognised absolute URL in the built bundle",
];

/** Runs every check against a built `web/dist` tree. Throws if the tree is absent — a missing build must never read as a pass. */
export function scanBuiltDist(distDir: string): CspGateResult {
  if (!existsSync(join(distDir, "index.html"))) {
    throw new Error(
      `csp-dist-gate: no built SPA at ${distDir} (no index.html). Build the web app first ` +
        `(\`pnpm --filter @kerdial/web run build\`). Refusing to report a pass for an unbuilt tree — ` +
        `the whole point of this gate is that it reads the real generated output.`,
    );
  }
  const files = readDistFiles(distDir);
  return {
    distDir,
    filesScanned: files.length,
    checksRun: CHECKS_RUN,
    findings: [
      ...findingsForServiceWorker(distDir, files),
      ...findingsForDataUris(files),
      ...findingsForIndexHtml(files),
      ...findingsForManifest(files),
      ...findingsForBundle(files),
    ],
  };
}

export function formatFindings(findings: readonly CspFinding[]): string {
  return findings
    .map(
      (finding) =>
        `  [${finding.id}] ${finding.file}\n      directive: ${finding.directive}\n      ${finding.detail}`,
    )
    .join("\n\n");
}
