#!/usr/bin/env node

// MCP servers communicate over stdio: stdout MUST be pure JSON-RPC.
// Any sub-dependency (jsdom, readability, onnxruntime, transformers download
// progress, …) that calls console.log/warn would corrupt the stream and
// trigger "Internal Server Error" on the client side. Redirect all console
// output to stderr before importing anything else.
for (const m of ["log", "info", "warn", "error", "debug"]) {
  const prefix = `[${m}] `;
  console[m] = (...args) => {
    process.stderr.write(
      prefix + args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n"
    );
  };
}

/**
 * SearXNG Cited MCP Server
 *
 * An MCP server that queries a local (or remote) SearXNG instance and returns
 * search results with numbered, structured citations. Designed for AI coding
 * agents (OpenCode, Claude Code, etc.) so the LLM can reference sources with
 * [n] markers and produce a "Sources:" section at the end of its response.
 *
 * Environment variables:
 *   SEARXNG_URL          – Base URL of SearXNG instance, or comma-separated list
 *                          of URLs to try in order (default: http://localhost:8080)
 *   SEARXNG_API_KEY      – Optional HTTP Basic auth password (username is always "searxng")
 *   SEARXNG_DEFAULT_LANG – Default search language (default: en)
 *   MCP_TRANSPORT        – "stdio" (default) or "http" for remote access via Streamable HTTP
 *   MCP_HOST             – Bind host for http transport (default: 127.0.0.1)
 *   MCP_PORT             – Bind port for http transport (default: 3333)
 */

import { createServer } from "node:http";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// SEARXNG_URL may contain a single base URL or a comma-separated list of URLs.
// They are tried in order; the first one that responds wins. This lets users
// configure a local instance with one or more public fallbacks.
const SEARXNG_URLS = (process.env.SEARXNG_URL || "http://localhost:8080")
  .split(",")
  .map((u) => u.trim().replace(/\/+$/, ""))
  .filter(Boolean);
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
  engines,
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
  if (engines) params.set("engines", engines);
  if (language) params.set("language", language);
  if (timeRange) params.set("time_range", timeRange);
  if (maxResults) params.set("number_of_results", String(maxResults));

  const errors = [];
  for (const base of SEARXNG_URLS) {
    const url = `${base}/search?${params}`;
    try {
      const resp = await fetch(url, {
        headers: buildHeaders(),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        const msg = `${base} → ${resp.status}: ${body.slice(0, 200)}`;
        process.stderr.write(`[searxng] ${msg}\n`);
        errors.push(msg);
        continue;
      }
      return resp.json();
    } catch (err) {
      const msg = `${base} → ${err.message || String(err)}`;
      process.stderr.write(`[searxng] ${msg}\n`);
      errors.push(msg);
    }
  }

  throw new Error(
    `All ${SEARXNG_URLS.length} SearXNG instance(s) failed:\n  - ${errors.join("\n  - ")}`
  );
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
 *   > Full content (if fetched)
 *
 *   ---
 *   ### Sources
 *   - [1] [Title](URL)
 */
export function formatCitedResults(results, query) {
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

    const scoreTag =
      typeof r.bestScore === "number"
        ? ` _(relevance: ${r.bestScore.toFixed(3)})_`
        : "";
    lines.push(`**[${n}] ${title}**${publishedDate}${engine}${scoreTag}`);
    lines.push(`${url}`);
    if (snippet) lines.push(`${snippet}`);

    if (r.highlights && r.highlights.length) {
      lines.push("");
      lines.push(`<highlights source="[${n}]">`);
      r.highlights.forEach((h, k) => {
        lines.push(`- (${h.score.toFixed(3)}) ${h.text}`);
        if (k < r.highlights.length - 1) lines.push("");
      });
      lines.push(`</highlights>`);
    } else if (r.fullContent) {
      // Highlights step skipped (embedder unavailable) — fall back to full content.
      lines.push("");
      lines.push(`<content source="[${n}]">`);
      lines.push(r.fullContent);
      lines.push(`</content>`);
    } else if (r.fetchError) {
      lines.push(`_(content fetch failed: ${r.fetchError})_`);
    }
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
    "_Cite each specific fact inline as a clickable markdown link: `[[n]](url)` — " +
      'e.g. "The Late Bronze Age collapse began around 1200 BCE ' +
      "[[1]](https://example.org/lba).\" Take the URL from the matching " +
      "Sources entry above. Answer naturally; only cite when quoting a specific claim._"
  );

  return lines.join("\n");
}

/**
 * Fallback HTML → text extractor used when Readability fails or returns
 * nothing usable (e.g. for non-article pages, very short pages, or pages
 * JSDOM can't parse cleanly).
 */
export function stripHtmlToText(raw) {
  return raw
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch a URL and return readable plain text. Uses Mozilla Readability
 * (the engine behind Firefox Reader Mode) for HTML, with a regex-based
 * fallback. Plain text and JSON are returned as-is.
 */
async function fetchUrlContent(url, maxLength = 15000) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; SearXNG-Cited-MCP/1.0; +https://github.com/leiverkus/searxng-cited-mcp)",
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

  let extracted = "";
  try {
    const dom = new JSDOM(raw, { url });
    const article = new Readability(dom.window.document).parse();
    if (article?.textContent) {
      const title = article.title ? `# ${article.title}\n\n` : "";
      const byline = article.byline ? `_${article.byline}_\n\n` : "";
      extracted = (title + byline + article.textContent)
        .replace(/\s+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
  } catch {
    // fall through to regex stripper
  }

  if (!extracted || extracted.length < 200) {
    extracted = stripHtmlToText(raw);
  }

  return extracted.slice(0, maxLength);
}

// ---------------------------------------------------------------------------
// Semantic highlight extraction (Exa-style)
//
// Pipeline: chunk fetched content → embed query + chunks with a small local
// model → cosine-rank chunks → return top-K passages per result and rerank
// the result list by best chunk score.
// ---------------------------------------------------------------------------

/**
 * Split text into sentence-aware chunks of roughly `size` characters with
 * `overlap` characters of context between neighbours.
 */
export function chunkText(text, size = 500, overlap = 80) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= size) return cleaned ? [cleaned] : [];

  // Split into sentences first; fall back to hard-split if a sentence is huge.
  const sentences = cleaned.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [
    cleaned,
  ];

  const chunks = [];
  let buf = "";
  for (const s of sentences) {
    const piece = s.length > size ? s : s.trim();
    if (piece.length > size) {
      if (buf) {
        chunks.push(buf.trim());
        buf = "";
      }
      // Hard-split oversized sentence with overlap.
      for (let i = 0; i < piece.length; i += size - overlap) {
        chunks.push(piece.slice(i, i + size));
      }
      continue;
    }
    if ((buf + " " + piece).trim().length > size) {
      chunks.push(buf.trim());
      // Carry the tail of the last chunk as overlap context.
      buf = buf.length > overlap ? buf.slice(-overlap) + " " + piece : piece;
    } else {
      buf = buf ? buf + " " + piece : piece;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

/**
 * Lazy-loaded singleton embedder. Uses Xenova/all-MiniLM-L6-v2 (≈25 MB,
 * 384-dim, runs on CPU). The first call downloads and caches the model;
 * subsequent calls reuse the in-process pipeline.
 */
let embedderPromise = null;
function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      // Suppress noisy ONNX warnings on stderr that would corrupt MCP stdio.
      const { pipeline, env } = await import("@xenova/transformers");
      env.allowLocalModels = true;
      return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        quantized: true,
      });
    })().catch((err) => {
      // Reset so a later call can retry (e.g. transient network issue on cold start).
      embedderPromise = null;
      throw err;
    });
  }
  return embedderPromise;
}

/**
 * Embed a list of texts and return an array of normalised Float32Array vectors.
 */
async function embedTexts(texts) {
  const embedder = await getEmbedder();
  const out = await embedder(texts, { pooling: "mean", normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const n = out.dims.length === 2 ? out.dims[0] : 1;
  const vecs = [];
  for (let i = 0; i < n; i++) {
    vecs.push(out.data.slice(i * dim, (i + 1) * dim));
  }
  return vecs;
}

export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are L2-normalised → cosine == dot product
}

/**
 * For a list of fetched results, extract the top-K most query-relevant
 * passages from each, score the result by its best passage, and reorder the
 * list. Results without content are kept at their original SearXNG rank
 * after the reranked block.
 *
 * Returns the (possibly reordered) results array; each enriched result gets
 * `highlights: [{text, score}]` and `bestScore`.
 */
async function rankAndExtractHighlights(query, results, { topK, chunkSize }) {
  const enriched = results.filter((r) => r.fullContent);
  const rest = results.filter((r) => !r.fullContent);
  if (!enriched.length) return results;

  const allChunks = [];
  const ownerIdx = []; // chunk → result index in `enriched`
  enriched.forEach((r, i) => {
    const chunks = chunkText(r.fullContent, chunkSize, 80);
    if (!chunks.length) return;
    chunks.forEach((c) => {
      allChunks.push(c);
      ownerIdx.push(i);
    });
  });
  if (!allChunks.length) return results;

  const [queryVec, ...chunkVecs] = await embedTexts([query, ...allChunks]);
  const scored = allChunks.map((text, i) => ({
    text,
    score: cosine(queryVec, chunkVecs[i]),
    owner: ownerIdx[i],
  }));

  // Group scored chunks per result, keep top-K each, set bestScore.
  for (let i = 0; i < enriched.length; i++) {
    const own = scored
      .filter((s) => s.owner === i)
      .sort((a, b) => b.score - a.score);
    enriched[i].highlights = own.slice(0, topK).map(({ text, score }) => ({
      text,
      score: Number(score.toFixed(4)),
    }));
    enriched[i].bestScore = own[0]?.score ?? 0;
    // fullContent is no longer needed for output — drop to save tokens.
    delete enriched[i].fullContent;
  }

  enriched.sort((a, b) => (b.bestScore ?? 0) - (a.bestScore ?? 0));
  return [...enriched, ...rest];
}

/**
 * Enrich the top N search results with extracted page content, then —
 * if a query is provided and highlights are enabled — rerank them
 * semantically and replace the full content with the top-K passages.
 *
 * Failures per URL are recorded on the result but never abort the batch.
 */
async function enrichResultsWithContent(
  results,
  { topN, maxLength, query, highlights = true, highlightTopK = 3, chunkSize = 500 }
) {
  if (!results.length || topN <= 0) return results;

  const top = results.slice(0, topN);
  const fetched = await Promise.allSettled(
    top.map((r) => fetchUrlContent(r.url, maxLength))
  );

  let out = results.map((r, i) => {
    if (i >= topN) return r;
    const f = fetched[i];
    if (f.status === "fulfilled" && f.value) {
      return { ...r, fullContent: f.value };
    }
    const reason =
      f.status === "rejected"
        ? f.reason?.message || String(f.reason)
        : "empty";
    return { ...r, fetchError: reason.slice(0, 120) };
  });

  if (highlights && query) {
    try {
      out = await rankAndExtractHighlights(query, out, {
        topK: highlightTopK,
        chunkSize,
      });
    } catch (err) {
      // Embedder failure (e.g. no network on cold start) → keep full content.
      out = out.map((r) =>
        r.fullContent ? { ...r, highlightError: err.message?.slice(0, 120) } : r
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

// HTTP mode (stateless) requires a fresh McpServer + transport per request,
// per the SDK's stateless example. stdio mode reuses a single instance.
function createMcpServer() {
  const server = new McpServer({
    name: "searxng-cited",
    version: "1.1.0",
  });

  registerTools(server);
  return server;
}

function registerTools(server) {
// --- Tool: cited_search ---------------------------------------------------

server.tool(
  "cited_search",
  `Web search via a local SearXNG instance. Top results are fetched, extracted with
Readability, and semantically reranked against the query — returning the most relevant
passages ("highlights") rather than full pages. Cite sources with [n] when quoting
specific facts; for the response itself, prioritise the user's question and context.`,
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
    engines: z
      .string()
      .optional()
      .describe(
        "Comma-separated SearXNG engines, e.g. 'google,bing' or 'semantic_scholar,arxiv'. Overrides category-default engines when set."
      ),
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
    fetch_content: z
      .boolean()
      .optional()
      .describe(
        "Fetch and extract full page content for the top results (default: true). Set false to get only snippets."
      ),
    fetch_top_n: z
      .number()
      .min(0)
      .max(10)
      .optional()
      .describe("How many top results to enrich with page content (default: 10)"),
    content_max_length: z
      .number()
      .min(500)
      .max(20000)
      .optional()
      .describe("Per-result content character cap (default: 4000)"),
    highlights: z
      .boolean()
      .optional()
      .describe(
        "Semantically rerank fetched content and return top passages instead of full text (default: true). Set false for raw extracted content."
      ),
    highlight_top_k: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .describe("Top passages per result (default: 3)"),
  },
  async (args) => {
    try {
      const data = await querySearXNG({
        query: args.query,
        categories: args.categories || "general",
        engines: args.engines,
        language: args.language || DEFAULT_LANG,
        timeRange: args.time_range,
        page: args.page || 1,
        maxResults: args.max_results || 10,
      });

      let results = data.results || [];
      const fetchContent = args.fetch_content !== false;
      if (fetchContent) {
        results = await enrichResultsWithContent(results, {
          topN: args.fetch_top_n ?? 10,
          maxLength: args.content_max_length ?? 4000,
          query: args.query,
          highlights: args.highlights !== false,
          highlightTopK: args.highlight_top_k ?? 3,
        });
      }

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
  `Search recent news via SearXNG. Results include publication dates, numbered citations,
and (by default) extracted article text for the top results.`,
  {
    query: z.string().describe("News search query"),
    engines: z
      .string()
      .optional()
      .describe(
        "Comma-separated SearXNG engines, e.g. 'reuters,bbc'. Overrides default news engines when set."
      ),
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
    fetch_content: z
      .boolean()
      .optional()
      .describe("Fetch and extract article text for the top results (default: true)"),
    fetch_top_n: z
      .number()
      .min(0)
      .max(10)
      .optional()
      .describe("How many top results to enrich (default: 3)"),
    content_max_length: z
      .number()
      .min(500)
      .max(20000)
      .optional()
      .describe("Per-result content character cap (default: 3000)"),
    highlights: z
      .boolean()
      .optional()
      .describe("Semantic rerank + top passages (default: true)"),
    highlight_top_k: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .describe("Top passages per result (default: 3)"),
  },
  async (args) => {
    try {
      const data = await querySearXNG({
        query: args.query,
        categories: "news",
        engines: args.engines,
        language: args.language || DEFAULT_LANG,
        timeRange: args.time_range || "week",
        maxResults: args.max_results || 10,
      });

      let results = data.results || [];
      const fetchContent = args.fetch_content !== false;
      if (fetchContent) {
        results = await enrichResultsWithContent(results, {
          topN: args.fetch_top_n ?? 3,
          maxLength: args.content_max_length ?? 3000,
          query: args.query,
          highlights: args.highlights !== false,
          highlightTopK: args.highlight_top_k ?? 3,
        });
      }

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
  `Search academic sources (Google Scholar, Semantic Scholar, arXiv, etc.) via SearXNG.
Ideal for literature review. Results include numbered citations and (by default)
extracted abstract/landing-page text for the top results. Note: PDF URLs and
paywalled journal pages may fail to extract — the snippet remains available.`,
  {
    query: z.string().describe("Academic search query"),
    engines: z
      .string()
      .optional()
      .describe(
        "Comma-separated SearXNG engines, e.g. 'semantic_scholar,arxiv,pubmed,google_scholar'. Overrides default science engines when set."
      ),
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
    fetch_content: z
      .boolean()
      .optional()
      .describe("Fetch and extract content for top results (default: true)"),
    fetch_top_n: z
      .number()
      .min(0)
      .max(10)
      .optional()
      .describe("How many top results to enrich (default: 3)"),
    content_max_length: z
      .number()
      .min(500)
      .max(20000)
      .optional()
      .describe("Per-result content character cap (default: 3000)"),
    highlights: z
      .boolean()
      .optional()
      .describe("Semantic rerank + top passages (default: true)"),
    highlight_top_k: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .describe("Top passages per result (default: 3)"),
  },
  async (args) => {
    try {
      const data = await querySearXNG({
        query: args.query,
        categories: "science",
        engines: args.engines,
        language: args.language || "en",
        timeRange: args.time_range,
        maxResults: args.max_results || 10,
      });

      let results = data.results || [];
      const fetchContent = args.fetch_content !== false;
      if (fetchContent) {
        results = await enrichResultsWithContent(results, {
          topN: args.fetch_top_n ?? 3,
          maxLength: args.content_max_length ?? 3000,
          query: args.query,
          highlights: args.highlights !== false,
          highlightTopK: args.highlight_top_k ?? 3,
        });
      }

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

} // end registerTools

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Skip the boot block when this file is imported as a library (e.g. from tests).
// `import.meta.url` matches argv[1] only when run as the entrypoint.
const entrypointPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isMainModule =
  import.meta.url === `file://${entrypointPath}` ||
  entrypointPath.endsWith("/searxng-cited-mcp"); // npm bin shim

if (isMainModule) {

const transportKind = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();

if (transportKind === "stdio") {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
} else if (transportKind === "http" || transportKind === "sse") {
  // Stateless Streamable HTTP: per the SDK's stateless example, both the
  // McpServer and the transport are recreated per request. Tool registration
  // is cheap; recreating avoids state pollution between requests.
  // `transportKind === "sse"` is accepted as an alias since the underlying
  // transport supports SSE streaming on the same endpoint.
  const host = process.env.MCP_HOST || "127.0.0.1";
  const port = Number(process.env.MCP_PORT || 3333);

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found. MCP endpoint is POST/GET /mcp\n");
      return;
    }

    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      mcpServer.close().catch(() => {});
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      process.stderr.write(`[http] request error: ${err?.message || err}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          })
        );
      } else {
        res.end();
      }
    }
  });

  httpServer.listen(port, host, () => {
    process.stderr.write(
      `[http] searxng-cited-mcp listening on http://${host}:${port}/mcp\n`
    );
  });
} else {
  process.stderr.write(
    `[error] Unknown MCP_TRANSPORT="${transportKind}". Use "stdio" or "http".\n`
  );
  process.exit(1);
}

// Pre-warm the embedder so the first user query doesn't pay the 5-15s
// model-load tax (which can blow past the MCP client timeout). Errors are
// silently swallowed: if pre-warming fails, the first real call retries.
getEmbedder().catch((err) => {
  process.stderr.write(`[prewarm] embedder load failed: ${err.message}\n`);
});

} // end isMainModule guard
