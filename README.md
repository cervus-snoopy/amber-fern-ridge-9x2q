# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/cervus-snoopy/amber-fern-ridge-9x2q/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/cervus-snoopy/amber-fern-ridge-9x2q/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast static-site generator for the make.fun `site-generator-speed-01`
bounty, written from scratch in JavaScript (Node 22, no dependencies).

## Entry

- `main.ts` — driver (provided): reads the cases, calls `run(input)` from
  `./solve.js`, writes `answers.json`.
- `solve.js` — the whole generator: front-matter parsing and refusal
  checks, slug/permalink assignment, a Markdown subset renderer (headings,
  paragraphs, lists, fences, blockquotes, setext headings, thematic breaks,
  inline code/emphasis/strong/links), a template engine (`{{ }}`,
  `{{{ }}}`, `{% for %}`, `{% if %}`, `{% include %}`), collections,
  tags, pagination, static files, and the build report.
- `package.json`, `LICENSE` — entry metadata.

## Design (speed)

The generator is implemented from the bounty README only. The hot paths
are written to avoid repeated work:

- Inline Markdown is rendered in one pass with a single native regex
  scan jumping from mark to mark; HTML escaping is integrated into that
  pass, so text is never scanned twice.
- Templates are parsed once per case into a small AST and rendered with
  reusable loop frames (no per-iteration allocation).
- Slugs are cached per run; lookups use `Map`/`Set`; strings are built
  with array + `join`; word counting is a manual scan with no allocation.
- Each `run(input)` is independent: no caching between cases, no clock,
  environment, random, or file access.

## Verification

- `node verify.mjs` — all three practice cases match the reference
  output byte-for-byte (`ALL MATCH`).
- `bash bench.sh` — about 2x faster than the `makefun-site` 1.0.0
  baseline on the same machine (see the benchmark report).
