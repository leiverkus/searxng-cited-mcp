#!/usr/bin/env node

/**
 * SearXNG Cited MCP Server
 *
 * An MCP server that queries a local (or remote) SearXNG instance and returns
 * search results with numbered, structured citations. Designed for AI coding
 * agents (OpenCode, Claude Code, etc.) so the LLM can reference sources with
 * [n] markers and produce a "Sources:" section at the end of its response.
 *
 * Environment variables:
 *   SEARXNG_URL          – Base URL of SearXNG instance (default: http://localhost:8080)
 *   SEARXNG_API_KEY      – Optional HTTP Basic auth password (username is always "searxng")
 *   SEARXNG_DEFAULT_LANG – Default search language (default: en)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SEARXNG_URL = (process.env.SEARXNG_URL || "http://localhost:8080").replace(
  /\/+$/,
  ""
);
const SEARXNG_API_KEY = process.env.SEARXNG_API_KEY || "";
const DEFAULT_LANG = process.env.SEARXNG_DEFAULT_LANG || "en";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHeaders() {
  const headers = { Accept: "application/json" };
  if (SEARXNG_API_KEY) {
    const cred = Buffer.from(`searxng:${SEARXNG_API_KEY}`).toString("base64");
    headers["Authorization"] = `Basic ${cred}`;
  }
  return headers;
}

/**
 * Query the SearXNG JSON API and return the raw response object.
 */
async function querySearXNG({
  query,
  categories,
  language,
  timeRange,
  page,
  maxResults,
}) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    pageno: String(page || 1),
  });
  if (categories) params.set("categories", categories);
  if (language) params.set("language", language);
  if (timeRange) params.set("time_range", timeRange);
  if (maxResults) params.set("number_of_results", String(maxResults));

  const url = `${SEARXNG_URL}/search?${params}`;
  const resp = await fetch(url, { headers: buildHeaders() });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`SearXNG returned ${resp.status}: ${body.slice(0, 300)}`);
  }

  return resp.json();
}

/**
 * Format results into a numbered, cited text block that the LLM can
 * reference directly.
 *
 * Output structure:
 *   ## Search results for: "query"
 *
 *   **[1] Title** (date) [engines]
 *   URL
 *   Snippet…
 *
 *   ---
 *   ### Sources
 *   - [1] [Title](URL)
 */
function formatCitedResults(results, query) {
  if (!results || results.length === 0) {
    return `No results found for "${query}".`;
  }

  const lines = [`## Search results for: "${query}"\n`];

  results.forEach((r, i) => {
    const n = i + 1;
    const title = r.title || "(no title)";
    const url = r.url || "";
    const snippet = r.content || r.snippet || "";
    const publishedDate = r.publishedDate ? ` (${r.publishedDate})` : "";
    const engine = r.engines ? ` [${r.engines.join(", ")}]` : "";

    lines.push(`**[${n}] ${title}**${publishedDate}${engine}`);
    lines.push(`${url}`);
    if (snippet) lines.push(`${snippet}`);
    lines.push("");
  });

  // Dedicated sources block for easy copy-paste citation
  lines.push("---");
  lines.push("### Sources");
  lines.push("");
  results.forEach((r, i) => {
    const n = i + 1;
    const title = r.title || "(no title)";
    const url = r.url || "";
    lines.push(`- [${n}] [${title}](${url})`);
  });

  lines.push("");
  lines.push(
    '_Use [n] markers in your response to cite these sources. ' +
      'Include a "Sources:" section at the end with the relevant links._'
  );

  return lines.join("\n");
}

/**
 * Fetch a URL and convert it to readable plain text.
 */
async function fetchUrlContent(url, maxLength = 15000) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "SearXNG-Cited-MCP/1.0",
      Accept: "text/html,application/xhtml+xml,text/plain",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} when fetching ${url}`);
  }

  const contentType = resp.headers.get("content-type") || "";
  const raw = await resp.text();

  if (
    contentType.includes("text/plain") ||
    contentType.includes("application/json")
  ) {
    return raw.slice(0, maxLength);
  }

  // Basic HTML → text: strip tags, collapse whitespace
  const text = raw
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return text.slice(0, maxLength);
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "searxng-cited",
  version: "1.0.0",
});

// --- Tool: cited_search ---------------------------------------------------

server.tool(
  "cited_search",
  `Search the web via a local SearXNG instance and return results with numbered citations.
Use [n] markers in your response to reference the sources.
Always include a "Sources:" section at the end with the relevant links.`,
  {
    query: z.string().describe("Search query"),
    categories: z
      .enum([
        "general",
        "news",
        "science",
        "it",
        "images",
        "videos",
        "files",
        "map",
      ])
      .optional()
      .describe("SearXNG category (default: general)"),
    language: z
      .string()
      .optional()
      .describe(
        `Language code, e.g. 'en', 'de', 'fr' (default: ${DEFAULT_LANG})`
      ),
    time_range: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe("Filter results by time range"),
    max_results: z
      .number()
      .min(1)
      .max(30)
      .optional()
      .describe("Maximum number of results (default: 10)"),
    page: z
      .number()
      .min(1)
      .optional()
      .describe("Page number for pagination (default: 1)"),
  },
  async (args) => {
    try {
      const data = await querySearXNG({
        query: args.query,
        categories: args.categories || "general",
        language: args.language || DEFAULT_LANG,
        timeRange: args.time_range,
        page: args.page || 1,
        maxResults: args.max_results || 10,
      });

      const results = data.results || [];
      const text = formatCitedResults(results, args.query);

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Search error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool: cited_news_search -----------------------------------------------

server.tool(
  "cited_news_search",
  `Search recent news via SearXNG. Results include publication dates and numbered citations.`,
  {
    query: z.string().describe("News search query"),
    language: z
      .string()
      .optional()
      .describe(`Language code (default: ${DEFAULT_LANG})`),
    time_range: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe("Time filter (default: week)"),
    max_results: z
      .number()
      .min(1)
      .max(20)
      .optional()
      .describe("Maximum number of results (default: 10)"),
  },
  async (args) => {
    try {
      const data = await querySearXNG({
        query: args.query,
        categories: "news",
        language: args.language || DEFAULT_LANG,
        timeRange: args.time_range || "week",
        maxResults: args.max_results || 10,
      });

      const results = data.results || [];
      const text = formatCitedResults(results, args.query);

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `News search error: ${err.message}` },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool: cited_science_search --------------------------------------------

server.tool(
  "cited_science_search",
  `Search academic sources (Google Scholar, Semantic Scholar, etc.) via SearXNG.
Ideal for literature review. Results include numbered citations.`,
  {
    query: z.string().describe("Academic search query"),
    language: z
      .string()
      .optional()
      .describe("Language code (default: en)"),
    time_range: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe("Time filter"),
    max_results: z
      .number()
      .min(1)
      .max(20)
      .optional()
      .describe("Maximum number of results (default: 10)"),
  },
  async (args) => {
    try {
      const data = await querySearXNG({
        query: args.query,
        categories: "science",
        language: args.language || "en",
        timeRange: args.time_range,
        maxResults: args.max_results || 10,
      });

      const results = data.results || [];
      const text = formatCitedResults(results, args.query);

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Science search error: ${err.message}` },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool: fetch_url -------------------------------------------------------

server.tool(
  "fetch_url",
  `Fetch the content of a URL and return it as readable plain text.
Useful for reading the full content of a search result.`,
  {
    url: z.string().url().describe("URL of the web page to fetch"),
    max_length: z
      .number()
      .min(1000)
      .max(50000)
      .optional()
      .describe("Maximum text length in characters (default: 15000)"),
  },
  async (args) => {
    try {
      const text = await fetchUrlContent(args.url, args.max_length || 15000);
      return {
        content: [
          {
            type: "text",
            text: `## Content from ${args.url}\n\n${text}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Fetch error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
