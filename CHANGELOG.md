# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.4.1] - 2026-05-15

### Added

- **Result deduplication.** Multi-engine SearXNG aggregation often returns
  the same work several times — different hosts (publisher + JSTOR mirror
  + academia.edu copy), or the exact same URL surfaced by both Google and
  DuckDuckGo. Duplicates are now collapsed in a single pass after ranking:
    - **Primary key:** `doi_detected` — three results pointing at
      `10.2307/1356668` from cambridge.org, academia.edu, and JSTOR
      collapse to one. Because dedup runs after `prioritize_primary`, the
      kept record is always the highest-classed source.
    - **Fallback key:** canonical URL (`host` + `pathname`, lower-cased,
      trailing slash stripped, query string ignored) — catches
      tracking-param repeats like `?utm=ddg` vs no-query.
    - **Engine merge:** the kept record's `engines` array is the union of
      all engines that found any of the duplicates, so the LLM still sees
      how many independent engines surfaced the same work.
  Opt out per call with `deduplicate: false`. Live measurement on the
  "Cohen Negev fortresses" query went from 41 raw results with 3× UChicago
  + 2× JSTOR + 2× TandFonline of the same work, to a clean top-10 with
  four distinct DOIs.

## [1.4.0] - 2026-05-15

### Added

- **Detection layer.** Every result from `web_search`, `news_search`, and
  `science_search` is now annotated with structured signals so the
  consuming LLM can decide whether a paper-search-mcp Crossref/Unpaywall
  round-trip is needed:
    - `source_class`: `primary_publisher` | `academic_repository` |
      `preprint_server` | `aggregator` | `suspect` | `grey_lit_or_unknown`
    - `doi_detected` / `doi_candidates[]`: DOIs found in title/snippet/full
      text by pure regex — no Crossref call. bioRxiv-style all-digit
      suffixes are accepted.
    - `oa_url_heuristic`: `likely` | `maybe` | `no`, derived from URL
      shape alone (no Unpaywall call).
    - `content_type` / `content_extraction`: HTTP Content-Type and a
      status — `ok` | `failed_pdf` | `fetch_failed`.
  This layer makes **no external API calls** beyond SearXNG and the result
  URLs themselves. DOI resolution intentionally stays in paper-search-mcp
  to keep tool independence intact for cross-validation.
- **Domain classification config.** Domain lists live in
  [`domain-classes.yml`](domain-classes.yml) at the repo root. Right-anchor
  glob matching (`*.cambridge.org` matches `journals.cambridge.org` and
  `cambridge.org` but not `cambridge.org.evil.com`). Edit the file to
  extend — no code change required.
- **PDF text extraction.** `fetchUrlContent` now routes
  `application/pdf` responses (and `.pdf` URLs) through `pdf-parse`
  instead of feeding the binary into Readability and getting an empty
  string. Failures surface as `content_extraction: "failed_pdf"`.
- **Aggregator / suspect markers.** `formatCitedResults` emits a visible
  badge (`⚠️ AGGREGATOR — not a primary source`, `⚠️⚠️ SUSPECT —
  apologetic / pseudoscientific source`) directly in the per-result block
  and in the Sources list, so the LLM reads the classification in its
  normal reading path rather than only as a JSON field.
- **`prioritize_primary` parameter** (default `true`) on all three search
  tools. Reorders results by source class: primary publishers and
  academic repositories first, aggregators and suspect domains last.
  This shapes which results get the limited fetch/enrichment budget.
  Set `false` to keep SearXNG's native ordering.

### Changed

- Tool descriptions extended to document the new detection fields, so
  LLMs see them in MCP tool discovery and can route on them.
- Internal: `fetchUrlContent` return shape changed from `string` to
  `{ text, contentType, extractionStatus }`. Callers updated.
- DOI haystack now also includes the result URL — publisher URLs
  commonly carry the DOI in the path (`tandfonline.com/doi/full/...`,
  `journals.uchicago.edu/doi/pdfplus/...`) while the snippet text does
  not. Increased real-world detection rate from 0/10 to 6/10 on
  archaeology queries in informal testing.
- Bare hostname patterns in `domain-classes.yml` now also match the
  `www.` form automatically. `bible.ca` in the YAML catches
  `www.bible.ca` without needing a separate `*.bible.ca` entry. Right-
  anchor is preserved: `mirror.bible.ca` still falls through.
- OA URL heuristic recognises `/pdfplus/` (UChicago Journals' PDF-
  with-references viewer) as `likely` alongside `/pdf/`.
- JSTOR `/stable/<numeric-id>` and `/stable/pdf/<numeric-id>.pdf` URLs
  are converted to the equivalent `10.2307/<id>` DOI via pure URL
  rewriting (JSTOR's Crossref prefix is `10.2307`). Issue- and
  journal-level stable IDs (`i...`, `j...`) are intentionally skipped.
  Still no external API call.

### Dependencies

- Added: `js-yaml` (loads `domain-classes.yml`), `pdf-parse` (PDF text
  extraction), `zod` is now an explicit dependency (was transitive via
  `@modelcontextprotocol/sdk`).

## [1.3.0] - 2026-05-15

### Changed

- **Tools renamed** to drop the redundant `cited_` prefix. The MCP host
  already prefixes the server name (`searxng-cited`), so the old
  `cited_search` was exposed to clients as `searxng-cited_cited_search` —
  the doubled `cited_` confused LLMs into hallucinating non-existent
  variants like `searxng-cited_search`. New names:
    - `cited_search` → `web_search`
    - `cited_news_search` → `news_search`
    - `cited_science_search` → `science_search`
  The old names remain registered as deprecated aliases (same handlers,
  same schemas, description prefixed with `[deprecated, use <new>]`) so
  existing integrations keep working. Set
  `EXPOSE_LEGACY_TOOL_NAMES=false` to hide them. Aliases will be removed
  in 2.0.0.
- Tool descriptions rewritten to start with an explicit
  "Use this tool when…" line, so the LLM can triage between the three
  search tools from the first sentence.
- Default `fetch_top_n` for `web_search` lowered from 10 → 5; default
  `content_max_length` for all three search tools lowered to 2500
  (was 4000 for general, 3000 for news/science). Cuts typical response
  size roughly in half, reducing the chance of MCP-client output
  truncation.
- Per-URL fetch timeout default during bulk enrichment lowered from 15s
  to 8s. The standalone `fetch_url` tool keeps its 15s timeout since
  users invoke it on a specific URL they've chosen.

### Added

- **Wall-clock budget for tool calls.** A new `TOOL_BUDGET_MS` env var
  (default 25000) caps the total time `enrichResultsWithContent` will
  spend. When the deadline fires, in-flight URL fetches are aborted via
  `AbortController` and surface as `fetchError: "budget exceeded"`;
  fetches that already completed are returned. Semantic reranking is
  skipped if the budget is already gone. Prevents the MCP client from
  timing the whole call out (the previous failure mode that surfaced
  as `MCP error -32001`).
- **Output size cap.** `MAX_OUTPUT_CHARS` (default 20000) trims the
  per-result section when the total response would exceed the cap;
  the `### Sources` block and citation instruction are always preserved
  in full, since citations are more valuable than full-body text.
  A trailing `_… output truncated …_` notice is appended.
- New env vars: `SEARXNG_TIMEOUT_MS`, `FETCH_URL_TIMEOUT_MS`,
  `TOOL_BUDGET_MS`, `MAX_OUTPUT_CHARS`, `EXPOSE_LEGACY_TOOL_NAMES` —
  all optional, all documented in `.env.example`.
- `enrichResultsWithContent` is now exported from `index.js` (was
  module-internal) so it can be unit-tested directly.
- 5 new tests: budget-overrun abort behavior, no-overrun happy path,
  output truncation preserves Sources block, `maxChars=0` disables
  the cap.

### Fixed

- The hardcoded 15s SearXNG timeout (called out in
  `POLISH-NEXT-SESSION.md`) is now configurable via `SEARXNG_TIMEOUT_MS`.

## [1.2.2] - 2026-05-13

### Added

- Wolfram Alpha engine enabled in `searxng-config/settings.yml.example`
  (`engine: wolframalpha_noapi`, shortcut `wolf`, categories
  `[general, science]`, weight `1.5`). No API key required — uses the
  HTML-scraper variant. Useful for computational/factual queries
  (integrals, physical constants, unit conversions) returned as infobox
  hits alongside the regular result list. Shortcut is `wolf` rather than
  the canonical `wa` because `wa` is already claimed by another default
  engine and SearXNG rejects ambiguous shortcuts at startup.

## [1.2.1] - 2026-05-12

### Changed

- `searxng-config/settings.yml` is now **gitignored** and bootstrapped from a
  committed `searxng-config/settings.yml.example`. The runtime file holds the
  Granian `secret_key` and optional engine API keys (CORE, Springer Nature)
  and must not be committed. Existing checkouts: copy the example over,
  generate a secret with `openssl rand -hex 32`, then fill in any API keys.
- Documented in the README's Docker-stack quickstart that the `ultrasecretkey`
  placeholder is **only** substituted by the official `searxng/searxng` image
  when it creates `settings.yml` itself (entrypoint `else` branch). For a
  volume-mounted file the substitution never runs — the example uses an
  explicit `REPLACE_WITH_RANDOM_HEX_STRING` placeholder instead and the
  quickstart fills it in via `sed`.

## [1.2.0] - 2026-05-11

### Changed

- **Citation labels are now source-derived instead of plain numbers.** The
  former `[1]`, `[2]`, … markers have been replaced with `(hostname)` labels
  in round brackets, e.g. `(example.com)`. When several results share the
  same hostname, a short title slug is appended to disambiguate, e.g.
  `(en.wikipedia.org — Roman Empire)`. The new format is consistent across
  the result header, the `<highlights source="…">` block, the `### Sources`
  list, and the inline-citation instruction the LLM sees.
- Hostname normalisation: leading `www.` is stripped, but subdomains are
  kept distinct (`en.wikipedia.org` ≠ `de.wikipedia.org`).
- LLM citation instruction now asks for `[(label)](url)` markdown links
  (round brackets around the visible label, square brackets as the
  markdown-link wrapper) rather than `[[n]](url)`.

### Added

- `buildCitationLabels(results)` and `sanitizeSlug(title)` exports in
  `index.js` for reuse and testing. Slug sanitisation removes
  markdown-breaking characters (`[`, `]`, `(`, `)`, backticks, pipes,
  newlines) and caps length at 40 characters with word-boundary truncation
  and a trailing ellipsis.
- 14 new tests covering hostname normalisation, subdomain handling, slug
  disambiguation, collision suffixes (`#2`, `#3`), path-segment fallback
  for empty titles, and malformed/missing URLs.

## [1.1.0] - 2026-05-08

### Added

- `engines` parameter on all three search tools — pass through to SearXNG's
  `engines=` query param to scope a query to specific engines (e.g.
  `semantic_scholar,arxiv` or `google,bing`).
- Multi-instance failover: `SEARXNG_URL` accepts a comma-separated list of
  base URLs. `querySearXNG()` tries them in order and logs per-instance
  failures to stderr before raising.
- HTTP transport via `MCP_TRANSPORT=http` (alias `sse`), backed by the SDK's
  `StreamableHTTPServerTransport` in stateless mode. Configurable via
  `MCP_HOST` (default `127.0.0.1`) and `MCP_PORT` (default `3333`). Endpoint:
  `POST/GET /mcp`.
- Docker Compose stack (`docker-compose.yml` + `Dockerfile`) running SearXNG
  and `searxng-cited-mcp` together, with a named volume for the
  `@xenova/transformers` model cache so it persists across restarts.
- `searxng-config/settings.yml` — pre-configured engines for general web
  search and academic sources (arXiv, Semantic Scholar, PubMed, Google
  Scholar, Wikipedia, Brave, plus standard web engines).
- `.env.example` and `.dockerignore` for the Compose workflow.
- Per-request `transport.onerror` logging when running on HTTP transport.

### Fixed

- HTTP transport: subsequent requests after the first returned 500 with an
  empty body. Root cause: `StreamableHTTPServerTransport` in stateless mode
  cannot be reused across requests. Refactored to create a fresh `McpServer`
  + transport per request, matching the SDK's stateless example.

### Changed

- Citation instruction now asks the model to use `[[n]](url)` (a markdown
  link with the bracketed number as link text) rather than a plain `[n]`.
  This renders as a clickable inline citation in any markdown client, giving
  the same effect as chat-style citation chips without needing UI support.
- Base image is `node:20-slim` rather than Alpine: `onnxruntime-node` (used
  by `@xenova/transformers` for embeddings) ships glibc-linked native
  bindings and won't load on musl/Alpine.

## [1.0.0] - 2026-04-15

### Added

- Initial release
- `cited_search` tool — general web search with numbered citations
- `cited_news_search` tool — news-specific search with time filters
- `cited_science_search` tool — academic search via Google Scholar, Semantic Scholar, etc.
- `fetch_url` tool — fetch and convert web pages to plain text
- Structured citation output with `[n]` markers and Sources section
- Semantic highlight extraction: top results are fetched with Readability,
  chunked, embedded with `Xenova/all-MiniLM-L6-v2`, cosine-ranked, and
  returned as the most relevant passages per result rather than full page
  text. Result order is also reranked by best-passage score.
- HTTP Basic auth support for protected SearXNG instances
- Configurable default language
