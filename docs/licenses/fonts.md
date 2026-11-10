# Vendored typefaces

The Kerdial design system specifies three typefaces. All three are vendored into
`web/public/fonts/` as self-hosted variable woff2 by `scripts/fetch-fonts.mjs`, which also
regenerates `web/src/styles/fonts.css`.

| Family         | Role                              | Copyright                                                                       | Licence  |
| -------------- | --------------------------------- | ------------------------------------------------------------------------------- | -------- |
| Gabarito       | display, large numerals           | Copyright 2023 The Gabarito Project Authors (https://github.com/naipefoundry/gabarito) | OFL-1.1 |
| Manrope        | UI and body                       | Copyright 2018 The Manrope Project Authors (https://github.com/sharanda/manrope)  | OFL-1.1  |
| JetBrains Mono | tickers, ISINs, timestamps        | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) | OFL-1.1 |

The licence text is in `OFL-1.1.txt`, identical for all three.

## Why these are vendored rather than loaded from a CDN

`api/src/security-headers.ts` sets `font-src 'self'`. A `fonts.gstatic.com` URL is blocked outright
at runtime, so the choice is to vendor them or to widen the CSP — and widening a policy that
currently names only `'self'` for fonts, to serve a purely cosmetic asset, is the wrong trade.
Self-hosting also keeps the PWA honest: a cached shell that cannot reach the CDN would otherwise
render in a fallback face.

Only the `latin` and `latin-ext` subsets ship. The UI is French, and `latin` alone omits the OE
ligature. `latin` is also the subset that carries **U+2212 MINUS SIGN**, which the design mandates
over a hyphen for every negative figure — so dropping it would silently break a design rule, not
merely a glyph.

Six files, ~127 KiB total. Variable fonts: one file per subset covers the whole weight axis.

## Relationship to the license gate

`tools/license-gate` scans **dependencies** — the `license` field of packages under `node_modules` —
against the allowed set (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause,
ISC, plus public-domain dedications). Vendored assets are not dependencies and are not in its scope,
so the gate neither passes nor fails on them. That is a scope boundary, not an exemption, and this
document exists so the fonts are reviewed rather than invisible.

OFL-1.1 is compatible with what that gate protects. Its obligations are: ship the copyright and
licence notice (this directory), do not sell the fonts on their own, and do not release a *modified*
version under a Reserved Font Name. None of the three declares a Reserved Font Name, and we ship the
files unmodified. Critically, OFL imposes **no source-disclosure obligation on software that merely
embeds the font**, which is the phase-2 closed-source-SaaS risk the gate exists to prevent.

## Replacing them

The design system's own readme records that these are **substitutions** — no font files were supplied
with the design system. If Kerdial licenses real typefaces, only `web/src/styles/fonts.css`, this document,
and the `--font-*` tokens in `web/src/styles/kerdial.css` change.
