# searxng-cited-mcp

An [MCP](https://modelcontextprotocol.io/) server that connects AI coding agents to a local [SearXNG](https://docs.searxng.org/) instance — with **structured, source-labelled citations** baked into every response.

Unlike generic search MCPs, this one is designed so the LLM can reference sources with `(hostname)` markers in its answer — e.g. `(example.com)` or `(en.wikipedia.org — Roman Empire)` when several results share the same domain — and produce a clean "Sources:" section at the end, similar to how Claude Code and Perplexity handle web search.

## Why?

Most search MCP servers return raw results and leave citation formatting to the model. This works poorly with smaller or open-weight models (Qwen, Llama, Mistral, etc.) — they often drop URLs, hallucinate links, or skip citations entirely.

**searxng-cited-mcp** solves this by:

- Returning results in a **pre-formatted layout with source-derived labels** the model can reference directly
- Appending a ready-made **Sources block** with markdown links
- Including an **instruction line** that tells the model how to cite
- **Semantically reranking** the top hits with a small local embedding model so the highest-scoring passages float to the top (Exa-style highlights)
- A **detection layer** that tags each result with `source_class`, `doi_detected`, `oa_url_heuristic`, and `content_type` — so the LLM can route to `paper-search-mcp` for Crossref/Unpaywall verification when there's a DOI, and avoid citing aggregators (`academia.edu`, `researchgate.net`) or pseudoscientific sources as primary references
- Running entirely **locally** — no API keys, no costs, no data leaving your machine

## Tools

| Tool | Description |
|------|-------------|
| `web_search` | General web search with category, language, time filter, and optional `engines` override |
| `news_search` | News search (defaults to past week), with optional `engines` |
| `science_search` | Academic sources (arXiv, Semantic Scholar, PubMed, Google Scholar, …) with optional `engines` |
| `fetch_url` | Fetch a URL and return it as readable plain text |

> **Renamed in 1.3.0.** The old names `cited_search`, `cited_news_search`, and
> `cited_science_search` remain registered as deprecated aliases pointing at
> the same handlers, so existing integrations keep working. Set
> `EXPOSE_LEGACY_TOOL_NAMES=false` to hide them, or just switch to the new
> names. Aliases will be removed in 2.0.0.

All search tools accept an optional **`engines`** parameter — a comma-separated list of SearXNG engine names (e.g. `"semantic_scholar,arxiv"` or `"google,bing"`) — to scope a single query without changing global config.

### Highlights

For each of the top-N hits the server fetches the page with Mozilla Readability, splits it into sentence-aware chunks, embeds query and chunks with `Xenova/all-MiniLM-L6-v2` (≈25 MB, runs on CPU, downloads on first use), and returns only the highest-scoring passages per result. Result order is reranked by best-passage cosine score, so the most relevant page wins even if SearXNG ranked it lower.

The model is loaded lazily and pre-warmed on startup. With Docker the cache is persisted in a named volume so cold-start cost is paid only once. Disable with `highlights: false` to fall back to raw extracted text.

### Output format

```
## Search results for: "Cohen Negev fortresses"

**(cambridge.org) The Iron Age Fortresses of the Negev** (2024-11-20) [google scholar] _(relevance: 0.812)_
_✓ Primary publisher_
DOI: 10.1179/abc.2009.0024
https://www.cambridge.org/core/journals/levant/article/123
Re-examination of the Cohen 1979 excavation reports from the central Negev fortresses…

<highlights source="(cambridge.org)">
- (0.812) The author argues for a 10th-century BCE attribution based on revised ceramic typology…
</highlights>

**(academia.edu) Cohen 1979 — Negev Fortresses (mirror)** _(relevance: 0.701)_
_⚠️ AGGREGATOR — not a primary source; look up the publisher DOI_
https://academia.edu/papers/123456
Full-text mirror of the original 1979 monograph chapter…

**(bible.ca) Negev Fortresses and the Exodus**
_⚠️⚠️ SUSPECT — apologetic / pseudoscientific source; do not cite_
https://bible.ca/exodus-negev
Claims the fortresses prove the biblical Exodus…

---
### Sources

- (cambridge.org) [The Iron Age Fortresses of the Negev](https://www.cambridge.org/core/journals/levant/article/123)
- (academia.edu) [Cohen 1979 — Negev Fortresses (mirror)](https://academia.edu/papers/123456) ⚠️ aggregator
- (bible.ca) [Negev Fortresses and the Exodus](https://bible.ca/exodus-negev) ⚠️⚠️ suspect
```

### Detection layer

Every search result is annotated with structured signals that the LLM can route on — without the server itself making any external API calls beyond SearXNG and the result URLs:

| Field | Values | Set by |
|---|---|---|
| `source_class` | `primary_publisher`, `academic_repository`, `preprint_server`, `aggregator`, `suspect`, `grey_lit_or_unknown` | Glob match of result hostname against [`domain-classes.yml`](domain-classes.yml) |
| `doi_detected` | `"10.xxx/yyy"` or absent | Regex over title + snippet + extracted full text (no Crossref call) |
| `doi_candidates` | array of strings (only if >1 DOI found) | same |
| `oa_url_heuristic` | `"likely"`, `"maybe"`, `"no"` | URL shape — `.pdf` / `/pdf/` / repo host etc. (no Unpaywall call) |
| `content_type` | e.g. `"application/pdf"`, `"text/html"` | HTTP response header |
| `content_extraction` | `"ok"`, `"failed_pdf"`, `"fetch_failed"` | Result of Readability / pdf-parse |

Results are reordered by class (primary > repository > unknown > aggregator > suspect) so the fetch budget hits the best sources first. Disable with `prioritize_primary: false`.

When `doi_detected` is set on a result, the consuming LLM should call `paper-search-mcp` (or equivalent) with that DOI to verify metadata against Crossref, rather than trusting snippet text. This division of labor keeps this server independent of `paper-search-mcp`, so the two tools cross-validate each other.

The domain lists in `domain-classes.yml` are right-anchor globs:
- `*.cambridge.org` matches `journals.cambridge.org`, `www.cambridge.org`, and `cambridge.org` itself
- `*.cambridge.org` does NOT match `cambridge.org.evil-aggregator.com`
- `*.ub.uni-*.de` matches `www.ub.uni-oldenburg.de`

Edit the file to extend; the loader reads it on every tool call (cached in memory).

When multiple results come from the same hostname, the label is disambiguated with a short title slug, e.g. `(en.wikipedia.org — Roman Empire)` vs `(en.wikipedia.org — Byzantine Empire)`. Leading `www.` is stripped, but subdomains are kept distinct (`en.wikipedia.org` ≠ `de.wikipedia.org`).

## Prerequisites

A running SearXNG instance with the **JSON API enabled** (`formats: [html, json]` in `settings.yml`).

The repo ships with a Docker Compose stack that brings up SearXNG and the MCP server together — see [Docker stack](#docker-stack) below. If you already run SearXNG elsewhere, point `SEARXNG_URL` at it and skip Compose.

## Docker stack

Spins up SearXNG and `searxng-cited-mcp` as two containers, sharing a private Docker network.

```bash
git clone https://github.com/leiverkus/searxng-cited-mcp.git
cd searxng-cited-mcp
cp .env.example .env
echo "SEARXNG_SECRET_KEY=$(openssl rand -hex 32)" >> .env
cp searxng-config/settings.yml.example searxng-config/settings.yml
sed -i.bak "s/REPLACE_WITH_RANDOM_HEX_STRING/$(openssl rand -hex 32)/" searxng-config/settings.yml && rm searxng-config/settings.yml.bak
docker compose up -d
```

After startup:

- SearXNG UI: <http://localhost:8888>
- MCP server (HTTP transport): <http://127.0.0.1:3333/mcp>

The pre-configured engines in `searxng-config/settings.yml.example` cover Google, Bing, DuckDuckGo, Brave, Wikipedia, Semantic Scholar, arXiv, PubMed, and Google Scholar. Two engines (CORE, Springer Nature) need a free API key — see the placeholders in the example file. The runtime `settings.yml` is gitignored so your secret_key and API keys never end up in a commit.

### Connecting clients

**HTTP transport (default in the compose stack)** — clients that speak Streamable HTTP can hit the MCP endpoint directly:

```json
{
  "mcpServers": {
    "searxng": {
      "url": "http://127.0.0.1:3333/mcp"
    }
  }
}
```

**stdio transport** — set `MCP_TRANSPORT=stdio` in `.env`, restart, then point clients at `docker exec`:

```json
{
  "mcpServers": {
    "searxng": {
      "command": "docker",
      "args": ["exec", "-i", "searxng-cited-mcp", "node", "index.js"]
    }
  }
}
```

### Remote deployment (Hetzner etc.)

The stack is portable — clone, set `.env`, `docker compose up -d`. To expose the MCP server beyond localhost, edit the `ports:` line in `docker-compose.yml` (currently bound to `127.0.0.1`) and put a reverse proxy with auth in front. Don't expose SearXNG itself publicly.

## Installation

```bash
git clone https://github.com/leiverkus/searxng-cited-mcp.git
cd searxng-cited-mcp
npm install
```

Or install globally:

```bash
npm install -g searxng-cited-mcp
```

## Configuration

### OpenCode

Add to your `opencode.json`:

```json
{
  "mcp": {
    "searxng": {
      "type": "local",
      "command": "node",
      "args": ["/path/to/searxng-cited-mcp/index.js"],
      "env": {
        "SEARXNG_URL": "http://localhost:8080",
        "SEARXNG_DEFAULT_LANG": "en"
      }
    }
  }
}
```

If installed globally via npm:

```json
{
  "mcp": {
    "searxng": {
      "type": "local",
      "command": "searxng-cited-mcp",
      "env": {
        "SEARXNG_URL": "http://localhost:8080"
      }
    }
  }
}
```

### Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "searxng": {
      "command": "node",
      "args": ["/path/to/searxng-cited-mcp/index.js"],
      "env": {
        "SEARXNG_URL": "http://localhost:8080"
      }
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "searxng": {
      "command": "npx",
      "args": ["-y", "searxng-cited-mcp"],
      "env": {
        "SEARXNG_URL": "http://localhost:8080"
      }
    }
  }
}
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARXNG_URL` | `http://localhost:8080` | Base URL of your SearXNG instance. Comma-separated list to enable failover (first reachable wins). |
| `SEARXNG_API_KEY` | _(empty)_ | Password for HTTP Basic auth (username is always `searxng`) |
| `SEARXNG_DEFAULT_LANG` | `en` | Default language for search queries (`en`, `de`, `fr`, etc.) |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http`. Use `http` for remote access via Streamable HTTP transport. |
| `MCP_HOST` | `127.0.0.1` | Bind host when `MCP_TRANSPORT=http` |
| `MCP_PORT` | `3333` | Bind port when `MCP_TRANSPORT=http` |
| `SEARXNG_TIMEOUT_MS` | `15000` | Timeout for the SearXNG query itself, in milliseconds. |
| `FETCH_URL_TIMEOUT_MS` | `8000` | Per-URL fetch timeout during bulk content enrichment. The standalone `fetch_url` tool keeps its own 15s timeout since you've explicitly chosen that URL. |
| `TOOL_BUDGET_MS` | `25000` | Hard wall-clock budget for a single search tool call. On overrun, in-flight URL fetches are aborted and surface as `fetchError: "budget exceeded"`; whichever fetches already completed are returned. Set a few seconds below your MCP client's request timeout. |
| `MAX_OUTPUT_CHARS` | `20000` | Hard cap on the tool response length. Tail result blocks are dropped first; the `### Sources` list and citation instruction are always preserved. |
| `EXPOSE_LEGACY_TOOL_NAMES` | `true` | When `false`, suppresses the deprecated `cited_search`, `cited_news_search`, `cited_science_search` aliases. |

## System prompt recommendation

The tool output already includes a citation instruction, but reinforcing it in your system prompt or custom command improves reliability with smaller models:

```
When using search results from SearXNG:
1. Cite each specific fact inline with [(label)](url) — a clickable markdown link
   whose visible text is "(label)" (the parenthesised identifier shown next to
   each result, e.g. a domain like "(example.org)" or a domain + short title
   slug like "(en.wikipedia.org — Roman Empire)") and whose target is the
   source URL.
   Example: "Thebes was founded around 3200 BCE [(britannica.com)](https://britannica.com/thebes)."
2. Take URLs from the Sources section of the tool output.
3. Only cite sources that are actually relevant to your answer.
4. When sources contradict each other, mention the disagreement.
```

Most markdown renderers (Claude Code, OpenCode, GitHub, anything CommonMark) display `[(label)](url)` as a clickable inline link with the parenthesised label as visible text. This gives the same visual effect as the chat citation chips in claude.ai without needing UI support — and the label itself already tells the reader where the citation points, even before clicking.

## How it works

1. Your AI agent calls `web_search` (or one of the specialized tools) with a query
2. The MCP server queries your local SearXNG instance via its JSON API
3. Results are formatted into a structured block with source-derived `(label)` markers and a ready-made Sources section
4. The model uses `(label)` markers in its response and copies relevant links into a Sources footer

The citation instruction is embedded in the tool output, so even models without specific citation training tend to follow the pattern.

## Compatibility

Tested with:

- **OpenCode** (with custom providers including Qwen, Llama, Mistral)
- **Claude Code** / Claude Desktop
- Any MCP-compatible client

Works with any SearXNG instance (self-hosted or public).

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
