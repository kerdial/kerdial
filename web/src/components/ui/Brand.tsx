import { SHELL_COPY } from "../../lib/copy/shell.js";

/**
 * The Kerdial lockup.
 *
 * **The artwork is a placeholder.** The design system's own readme is explicit
 * that no brand assets were supplied with it, and these marks are its
 * proposal — a teal squircle with four ascending bars, the last apricot.
 * Everything here references `/brand/logo-mark.svg`, so replacing that file
 * (and rerunning `scripts/build-brand-icons.sh`) propagates without touching a
 * call site.
 *
 * ## Why the wordmark is text, not `logo.svg`
 *
 * The bundled `logo.svg` draws "Kerdial" with an SVG `<text>` element in
 * Gabarito. An SVG loaded through `<img>` is an isolated document with no
 * access to the page's fonts, so that wordmark would silently render in
 * whatever the system fallback is — a visible brand defect that looks like a
 * rendering bug. Rendering the mark as an image and the name as real text in
 * `--font-display` fixes that, and incidentally makes the product name
 * selectable, translatable and legible to a screen reader.
 *
 * `logo.svg` stays vendored for the cases that genuinely need a single flat
 * image (an OG card, an email footer) rather than being deleted as unused.
 */
export interface BrandProps {
  /** `full` is the mark plus the wordmark; `mark` is the squircle alone, for narrow rails and mobile. */
  readonly variant?: "full" | "mark";
  readonly size?: number;
}

export function Brand({ variant = "full", size = 28 }: BrandProps) {
  return (
    <span className="k-brand" data-variant={variant}>
      <img
        src="/brand/logo-mark.svg"
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        className="k-brand-mark"
      />
      {variant === "full" ? (
        <span className="k-brand-word">{SHELL_COPY.brandName}</span>
      ) : (
        <span className="k-visually-hidden">{SHELL_COPY.brandName}</span>
      )}
    </span>
  );
}
