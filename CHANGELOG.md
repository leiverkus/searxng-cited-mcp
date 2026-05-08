# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
