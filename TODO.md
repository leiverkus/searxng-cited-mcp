# Roadmap

Open items for future releases. Items shipped in v1.1.0–v1.4.0 are listed
in [CHANGELOG.md](CHANGELOG.md).

## Detection-layer follow-ups (post-1.4.0)

- [ ] Hot-reload `domain-classes.yml` when the file mtime changes, so
      tuning the list in production doesn't require restarting the server
- [ ] Optional `oa_status` enrichment: if `doi_detected` is set and the
      consumer opts in, surface a Unpaywall hint inline. Today the briefing
      keeps this strictly in paper-search-mcp's domain — reconsider only if
      cross-tool routing becomes too noisy in practice.
- [ ] Track per-class hit rates over real queries so the YAML can be
      pruned/extended with evidence

## Adoption

- [ ] Publish to npm registry — `npx searxng-cited-mcp` should just work
      (the `bin` field in `package.json` is already correct)
- [ ] Publish a Docker image to GHCR / Docker Hub so the Compose stack
      doesn't need a local build
- [ ] Submit to [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
      and [PulseMCP](https://pulsemcp.com)
- [ ] Create a `smithery.yaml` manifest for [Smithery](https://smithery.ai)
- [ ] GitHub Actions CI: run `npm test` on push + PR; build the Docker image
      on tags

## Robustness

- [x] `SEARXNG_TIMEOUT` env var (currently 15s hardcoded for `fetch_url`
      and SearXNG queries) — shipped in 1.3.0 as `SEARXNG_TIMEOUT_MS`,
      plus the new `FETCH_URL_TIMEOUT_MS` (bulk fetch timeout) and
      `TOOL_BUDGET_MS` (overall tool-call deadline with partial-result
      return on overrun).
- [ ] Retry with backoff for transient SearXNG failures (503, timeouts) —
      complementary to the multi-instance failover already in place
- [ ] Sanitize query strings (strip control characters, enforce a sensible
      max length)
- [ ] Character-encoding detection in `fetchUrlContent` (some pages are
      ISO-8859-1 and currently get mangled)
- [ ] Result deduplication: SearXNG sometimes returns the same URL from
      multiple engines. Dedupe by URL and merge `engines` lists.
- [ ] Integration test gated behind `SEARXNG_TEST_URL` env var that hits a
      real SearXNG instance and asserts the JSON contract

## Features

- [ ] Expose SearXNG's `safesearch` parameter (0/1/2) on the search tools
- [ ] Auto-suppress `categories` when `engines` is set, so a strict engine
      override is actually strict (currently the science category leaks
      sibling engines into the result set)
- [ ] LRU cache for repeated identical queries (15-minute TTL) to take load
      off the SearXNG instance
- [ ] `images` category: return a formatted gallery with alt text where
      available rather than just thumbnail URLs
- [ ] Configurable citation format — default `[[n]](url)` markdown link is
      now in v1.1; a `CITATION_STYLE=author` (`[Author, Year]`) variant
      could be useful for academic workflows
- [ ] MCP Resources: expose the SearXNG engine list and category map so
      clients can discover what's available
