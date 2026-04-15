# searxng-cited-mcp

An [MCP](https://modelcontextprotocol.io/) server that connects AI coding agents to a local [SearXNG](https://docs.searxng.org/) instance — with **structured, numbered citations** baked into every response.

Unlike generic search MCPs, this one is designed so the LLM can reference sources with `[n]` markers in its answer and produce a clean "Sources:" section at the end, similar to how Claude Code and Perplexity handle web search.

## Why?

Most search MCP servers return raw results and leave citation formatting to the model. This works poorly with smaller or open-weight models (Qwen, Llama, Mistral, etc.) — they often drop URLs, hallucinate links, or skip citations entirely.

**searxng-cited-mcp** solves this by:

- Returning results in a **pre-formatted, numbered layout** the model can reference directly
- Appending a ready-made **Sources block** with markdown links
- Including an **instruction line** that tells the model how to cite
- Running entirely **locally** — no API keys, no costs, no data leaving your machine

## Tools

| Tool | Description |
|------|-------------|
| `cited_search` | General web search with category, language, and time filters |
| `cited_news_search` | News search (defaults to past week) |
| `cited_science_search` | Academic sources via Google Scholar, Semantic Scholar, etc. |
| `fetch_url` | Fetch a URL and return it as readable plain text |

### Output format

```
## Search results for: "archaeological survey methods"

**[1] Remote Sensing in Archaeology** (2024-11-20) [google scholar]
https://example.org/remote-sensing
A comprehensive review of satellite and drone-based survey methods…

**[2] Ground-Penetrating Radar: Best Practices**
https://example.org/gpr-guide
Practical guide to GPR data collection and interpretation…

---
### Sources

- [1] [Remote Sensing in Archaeology](https://example.org/remote-sensing)
- [2] [Ground-Penetrating Radar: Best Practices](https://example.org/gpr-guide)
```

## Prerequisites

A running SearXNG instance with the **JSON API enabled**.

Add to your SearXNG `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

### Quick start with Docker

```bash
docker run -d --name searxng -p 8080:8080 searxng/searxng:latest
```

Then enable the JSON format in the container's settings as described above.

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
| `SEARXNG_URL` | `http://localhost:8080` | Base URL of your SearXNG instance |
| `SEARXNG_API_KEY` | _(empty)_ | Password for HTTP Basic auth (username is always `searxng`) |
| `SEARXNG_DEFAULT_LANG` | `en` | Default language for search queries (`en`, `de`, `fr`, etc.) |

## System prompt recommendation

For best citation behavior, add this to your system prompt or custom command:

```
When using search results from SearXNG:
1. Reference sources with [n] markers in your text
2. Include a "Sources:" section at the end of your response
3. Only cite sources that are actually relevant to your answer
4. When sources contradict each other, mention the disagreement
```

## How it works

1. Your AI agent calls `cited_search` (or one of the specialized tools) with a query
2. The MCP server queries your local SearXNG instance via its JSON API
3. Results are formatted into a numbered, structured block with a ready-made Sources section
4. The model uses `[n]` markers in its response and copies relevant links into a Sources footer

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
