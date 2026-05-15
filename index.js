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
 * DAO SearXNG MCP Server
 *
 * An MCP server that queries a local (or remote) SearXNG instance and returns
 * search results with source-labelled, structured citations and a per-result
 * detection layer (DOI / source class / OA / content-type). Designed for AI
 * coding and research agents (OpenCode, Claude Code, etc.) so the LLM can
 * reference sources with (label) markers — domain-derived identifiers like
 * `(example.com)` or `(en.wikipedia.org — Roman Empire)` — and produce a
 * "Sources:" section at the end of its response.
 *
 * Sibling project: dao-paper-search-mcp (Crossref / Unpaywall / Semantic
 * Scholar verification of the DOIs surfaced here).
 *
 * Environment variables:
 *   SEARXNG_URL              – Base URL of SearXNG instance, or comma-separated list
 *                              of URLs to try in order (default: http://localhost:8080)
 *   SEARXNG_API_KEY          – Optional HTTP Basic auth password (username is always "searxng")
 *   SEARXNG_DEFAULT_LANG     – Default search language (default: en)
 *   SEARXNG_TIMEOUT_MS       – Timeout for the SearXNG query itself (default: 15000)
 *   FETCH_URL_TIMEOUT_MS     – Per-URL fetch timeout when extracting page content (default: 8000)
 *   TOOL_BUDGET_MS           – Hard wall-clock budget for an entire search tool call.
 *                              On overrun, partial results are returned with a
 *                              "budget exceeded" marker on the unfinished fetches (default: 25000)
 *   MAX_OUTPUT_CHARS         – Hard cap on tool response length. Sources list is
 *                              always preserved; per-result blocks are trimmed
 *                              with a truncation notice (default: 20000)
 *   EXPOSE_LEGACY_TOOL_NAMES – When "false", suppresses the deprecated tool
 *                              aliases (cited_search, cited_news_search,
 *                              cited_science_search). Default: enabled.
 *   MCP_TRANSPORT            – "stdio" (default) or "http" for remote access via Streamable HTTP
 *   MCP_HOST                 – Bind host for http transport (default: 127.0.0.1)
 *   MCP_PORT                 – Bind port for http transport (default: 3333)
 */

import { createServer } from "node:http";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import {
  loadDomainClasses,
  enrichResultWithClassification,
  detectDOIInFullContent,
  rankResults,
  deduplicateResults,
  badgeFor,
} from "./lib/source-classifier.js";

const DOMAIN_CLASSES_PATH = new URL("./domain-classes.yml", import.meta.url);

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

// Numeric env vars: parse with sensible defaults; reject NaN / non-positive values.
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const SEARXNG_TIMEOUT_MS = intEnv("SEARXNG_TIMEOUT_MS", 15000);
const FETCH_URL_TIMEOUT_MS = intEnv("FETCH_URL_TIMEOUT_MS", 8000);
const TOOL_BUDGET_MS = intEnv("TOOL_BUDGET_MS", 25000);
const MAX_OUTPUT_CHARS = intEnv("MAX_OUTPUT_CHARS", 20000);
const EXPOSE_LEGACY_TOOL_NAMES = process.env.EXPOSE_LEGACY_TOOL_NAMES !== "false";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build human-readable citation labels for a result list.
 *
 * Rules:
 *   - Base label is the URL hostname (lowercased, leading `www.` stripped;
 *     subdomains are kept so `en.wikipedia.org` ≠ `de.wikipedia.org`).
 *   - If the hostname appears only once → label is just the hostname.
 *   - If it appears multiple times → label is `hostname — slug`, where slug
 *     is a sanitised, length-capped variant of the title (or the first path
 *     segment as fallback).
 *   - Collisions within the same hostname get a `#2`, `#3`, … suffix.
 *   - Labels never contain `[` `]` `(` `)` so they remain safe inside both
 *     standalone `(label)` markers and `[(label)](url)` Markdown links.
 *
 * Returns an array of label strings aligned with `results`.
 */
export function buildCitationLabels(results) {
  const hostnames = results.map((r) => {
    try {
      return new URL(r.url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "unknown";
    }
  });
  const hostCounts = new Map();
  for (const h of hostnames) hostCounts.set(h, (hostCounts.get(h) || 0) + 1);

  const seen = new Map();
  return results.map((r, i) => {
    const host = hostnames[i];
    if (hostCounts.get(host) === 1) return host;
    const slug = sanitizeSlug(r.title) || firstPathSegment(r.url) || "";
    const base = slug ? `${host} — ${slug}` : host;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} #${n}`;
  });
}

export function sanitizeSlug(title) {
  if (!title) return "";
  let s = String(title).replace(/[\[\]()`|\n\r]/g, "").replace(/\s+/g, " ").trim();
  if (s.length > 40) {
    const cut = s.slice(0, 40);
    const lastSpace = cut.lastIndexOf(" ");
    s = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + "…";
  }
  return s;
}

function firstPathSegment(url) {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean)[0];
    return seg ? sanitizeSlug(decodeURIComponent(seg)) : "";
  } catch {
    return "";
  }
}

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
        signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS),
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
 * Format results into a cited text block that the LLM can reference directly.
 *
 * Citation labels are derived from the source URL hostname (with a short
 * title slug appended when multiple results share the same hostname), e.g.
 * `(example.com)` or `(en.wikipedia.org — Roman Empire)`.
 *
 * Output structure:
 *   ## Search results for: "query"
 *
 *   **(example.com) Title** (date) [engines]
 *   URL
 *   Snippet…
 *   > Full content (if fetched)
 *
 *   ---
 *   ### Sources
 *   - (example.com) [Title](URL)
 */
export function formatCitedResults(results, query, opts = {}) {
  if (!results || results.length === 0) {
    return `No results found for "${query}".`;
  }

  const maxChars = opts.maxChars ?? MAX_OUTPUT_CHARS;
  const labels = buildCitationLabels(results);
  const header = `## Search results for: "${query}"\n`;

  // Build each result's block independently so we can drop whole blocks
  // from the tail when the total exceeds maxChars.
  const blocks = results.map((r, i) => {
    const label = labels[i];
    const title = r.title || "(no title)";
    const url = r.url || "";
    const snippet = r.content || r.snippet || "";
    const publishedDate = r.publishedDate ? ` (${r.publishedDate})` : "";
    const engine = r.engines ? ` [${r.engines.join(", ")}]` : "";

    const scoreTag =
      typeof r.bestScore === "number"
        ? ` _(relevance: ${r.bestScore.toFixed(3)})_`
        : "";

    const lines = [];
    lines.push(`**(${label}) ${title}**${publishedDate}${engine}${scoreTag}`);
    const badge = badgeFor(r.source_class);
    if (badge) lines.push(`_${badge}_`);
    if (r.doi_detected) lines.push(`DOI: ${r.doi_detected}`);
    lines.push(`${url}`);
    if (snippet) lines.push(`${snippet}`);

    if (r.highlights && r.highlights.length) {
      lines.push("");
      lines.push(`<highlights source="(${label})">`);
      r.highlights.forEach((h, k) => {
        lines.push(`- (${h.score.toFixed(3)}) ${h.text}`);
        if (k < r.highlights.length - 1) lines.push("");
      });
      lines.push(`</highlights>`);
    } else if (r.fullContent) {
      // Highlights step skipped (embedder unavailable) → fall back to full content.
      lines.push("");
      lines.push(`<content source="(${label})">`);
      lines.push(r.fullContent);
      lines.push(`</content>`);
    } else if (r.fetchError) {
      lines.push(`_(content fetch failed: ${r.fetchError})_`);
    }
    return lines.join("\n");
  });

  // Sources block — never dropped; citations matter more than full body text.
  const sourcesLines = ["---", "### Sources", ""];
  results.forEach((r, i) => {
    const label = labels[i];
    const title = r.title || "(no title)";
    const url = r.url || "";
    const mark =
      r.source_class === "aggregator"
        ? " ⚠️ aggregator"
        : r.source_class === "suspect"
        ? " ⚠️⚠️ suspect"
        : "";
    sourcesLines.push(`- (${label}) [${title}](${url})${mark}`);
  });
  sourcesLines.push("");
  sourcesLines.push(
    "_Cite each specific fact inline as a clickable markdown link: `[(label)](url)` — " +
      "where `label` is the parenthesised identifier shown next to each result above " +
      "(domain name, sometimes with a short title slug). " +
      'E.g. "The Late Bronze Age collapse began around 1200 BCE ' +
      "[(example.org)](https://example.org/lba).\" Take the URL from the matching " +
      "Sources entry above. Answer naturally; only cite when quoting a specific claim._"
  );
  const sourcesText = sourcesLines.join("\n");

  const joinAll = (kept, truncated) =>
    [
      header,
      kept.join("\n\n"),
      truncated
        ? "\n_… output truncated; lower `fetch_top_n`, `content_max_length` or `highlight_top_k` to scope further._\n"
        : "",
      sourcesText,
    ]
      .filter(Boolean)
      .join("\n");

  // Fast path: no cap or already small enough.
  const full = joinAll(blocks, false);
  if (!maxChars || full.length <= maxChars) return full;

  // Trim blocks from the tail until the total fits. Always keep the sources
  // block intact. If even the first block would overflow, slice it.
  const overheadBudget = header.length + sourcesText.length + 200; // truncation notice + separators
  const bodyBudget = maxChars - overheadBudget;

  const kept = [];
  let used = 0;
  for (const b of blocks) {
    const cost = b.length + 2; // block + "\n\n" separator
    if (used + cost > bodyBudget) break;
    kept.push(b);
    used += cost;
  }
  if (kept.length === 0 && blocks.length > 0) {
    const slice = blocks[0].slice(0, Math.max(0, bodyBudget));
    kept.push(slice);
  }

  return joinAll(kept, true);
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

// Compose multiple AbortSignals into one. Falls back to a manual combiner
// on Node 18 (AbortSignal.any landed in Node 20.3). The returned signal
// aborts as soon as any input signal aborts.
function anySignal(signals) {
  const valid = signals.filter(Boolean);
  if (!valid.length) return undefined;
  if (typeof AbortSignal.any === "function") return AbortSignal.any(valid);
  const controller = new AbortController();
  for (const s of valid) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Fetch a URL and return readable plain text. Uses Mozilla Readability
 * (the engine behind Firefox Reader Mode) for HTML, with a regex-based
 * fallback. Plain text and JSON are returned as-is.
 *
 * Accepts either a positional `maxLength` (legacy signature) or an options
 * object `{ maxLength, signal, timeoutMs }`. The composed signal aborts when
 * either the caller's `signal` or a per-fetch `AbortSignal.timeout(timeoutMs)`
 * fires.
 */
async function fetchUrlContent(url, opts = {}) {
  // Legacy positional signature: fetchUrlContent(url, 15000)
  if (typeof opts === "number") opts = { maxLength: opts };
  const maxLength = opts.maxLength ?? 15000;
  const timeoutMs = opts.timeoutMs ?? FETCH_URL_TIMEOUT_MS;
  const signal = anySignal([opts.signal, AbortSignal.timeout(timeoutMs)]);

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; DAO-SearXNG-MCP/1.5; +https://github.com/leiverkus/dao-searxng-mcp)",
      Accept: "text/html,application/xhtml+xml,text/plain,application/pdf",
    },
    redirect: "follow",
    signal,
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} when fetching ${url}`);
  }

  const contentType = (resp.headers.get("content-type") || "").toLowerCase();

  // PDF — buffer the body and hand to pdf-parse. Lazy-import keeps the cost
  // off the cold path of tools that never see a PDF.
  if (contentType.includes("application/pdf") || /\.pdf(\?|#|$)/.test(url.toLowerCase())) {
    try {
      const buf = Buffer.from(await resp.arrayBuffer());
      const { default: pdfParse } = await import("pdf-parse");
      const parsed = await pdfParse(buf);
      const text = (parsed.text || "").replace(/\n{3,}/g, "\n\n").trim();
      if (!text) {
        return { text: "", contentType, extractionStatus: "failed_pdf" };
      }
      return { text: text.slice(0, maxLength), contentType, extractionStatus: "ok" };
    } catch (err) {
      return {
        text: "",
        contentType,
        extractionStatus: "failed_pdf",
        error: (err?.message || String(err)).slice(0, 120),
      };
    }
  }

  const raw = await resp.text();

  if (
    contentType.includes("text/plain") ||
    contentType.includes("application/json")
  ) {
    return { text: raw.slice(0, maxLength), contentType, extractionStatus: "ok" };
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

  return {
    text: extracted.slice(0, maxLength),
    contentType,
    extractionStatus: "ok",
  };
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
 *
 * The whole operation is bounded by `budgetMs` wall-clock. When the budget
 * is reached, any still-running fetches are aborted and surface as
 * `fetchError: "budget exceeded"`; if the budget is already gone before the
 * reranking step, reranking is skipped and snippets are used instead.
 */
export async function enrichResultsWithContent(
  results,
  {
    topN,
    maxLength,
    query,
    highlights = true,
    highlightTopK = 3,
    chunkSize = 500,
    budgetMs = TOOL_BUDGET_MS,
    fetchTimeoutMs = FETCH_URL_TIMEOUT_MS,
  }
) {
  if (!results.length || topN <= 0) return results;

  const top = results.slice(0, topN);

  const deadlineController = new AbortController();
  const timer = setTimeout(
    () => deadlineController.abort(new Error("budget exceeded")),
    Math.max(1, budgetMs)
  );

  let fetched;
  try {
    fetched = await Promise.allSettled(
      top.map((r) =>
        fetchUrlContent(r.url, {
          maxLength,
          signal: deadlineController.signal,
          timeoutMs: fetchTimeoutMs,
        })
      )
    );
  } finally {
    clearTimeout(timer);
  }

  const budgetGone = deadlineController.signal.aborted;

  let out = results.map((r, i) => {
    if (i >= topN) return r;
    const f = fetched[i];
    if (f.status === "fulfilled" && f.value) {
      const { text, contentType, extractionStatus } = f.value;
      const enriched = {
        ...r,
        content_type: contentType || undefined,
        content_extraction: extractionStatus,
      };
      if (text) enriched.fullContent = text;
      // Re-run DOI detection on the extracted full text if we didn't catch
      // one from title/snippet — DOIs often only appear in the article body.
      return detectDOIInFullContent(enriched);
    }
    const rawReason =
      f.status === "rejected"
        ? f.reason?.message || String(f.reason)
        : "empty";
    // Abort signals surface as "aborted" or "The operation was aborted" depending
    // on platform; map them to a clearer label when the budget is the cause.
    const reason =
      budgetGone && /abort/i.test(rawReason) ? "budget exceeded" : rawReason;
    return {
      ...r,
      fetchError: reason.slice(0, 120),
      content_extraction: "fetch_failed",
    };
  });

  // Skip semantic rerank if the budget is already gone — embedding adds another
  // 0.5–2s and we'd rather return what we have than blow further past the deadline.
  if (highlights && query && !budgetGone) {
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
    name: "dao-searxng",
    version: "1.5.0",
  });

  registerTools(server);
  return server;
}

function registerTools(server) {
// Shared parameter fragments. Defining them as plain values lets us reuse the
// exact same Zod nodes across the new name and the deprecated alias for each
// search tool without re-allocating.

const langDescDefault = `Language code, e.g. 'en', 'de', 'fr' (default: ${DEFAULT_LANG})`;

// Classification + ranking + dedup pass applied to every SearXNG response
// before content enrichment. Loads domain-classes.yml (cached) and tags each
// result with `source_class`, `doi_detected`, `oa_url_heuristic`. Reorders
// so primary-publisher and academic-repository hits get the fetch budget
// first; dedup runs after ranking so when an aggregator and a primary
// publisher share the same DOI, the primary version is the one kept.
const applyDetectionLayer = (results, { prioritizePrimary, deduplicate } = {}) => {
  const classes = loadDomainClasses(DOMAIN_CLASSES_PATH);
  const classified = results.map((r) =>
    enrichResultWithClassification(r, classes)
  );
  const ranked = rankResults(classified, { prioritizePrimary });
  return deduplicate === false ? ranked : deduplicateResults(ranked);
};

const sharedSearchSchema = {
  engines: z
    .string()
    .optional()
    .describe(
      "Comma-separated SearXNG engines, e.g. 'google,bing' or 'semantic_scholar,arxiv'. Overrides category-default engines when set."
    ),
  language: z.string().optional().describe(langDescDefault),
  time_range: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe("Filter results by time range"),
  fetch_content: z
    .boolean()
    .optional()
    .describe(
      "Fetch and extract full page content for the top results (default: true). Set false to get only snippets."
    ),
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
  prioritize_primary: z
    .boolean()
    .optional()
    .describe(
      "Reorder results so primary-publisher and academic-repository hits come first; aggregator and suspect hits are pushed to the bottom (default: true). Set false to keep SearXNG's native ordering."
    ),
  deduplicate: z
    .boolean()
    .optional()
    .describe(
      "Collapse duplicate results that refer to the same work: same DOI (across different hosts) or same canonical URL (multi-engine repeats). Engines from collapsed duplicates are merged. Runs after `prioritize_primary`, so when a publisher and an aggregator share a DOI, the publisher version is kept. Default: true."
    ),
};

// --- Tool: web_search (was cited_search) ----------------------------------

const webSearchSchema = {
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
  engines: sharedSearchSchema.engines,
  language: sharedSearchSchema.language,
  time_range: sharedSearchSchema.time_range,
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
  fetch_content: sharedSearchSchema.fetch_content,
  fetch_top_n: z
    .number()
    .min(0)
    .max(10)
    .optional()
    .describe(
      "How many top results to enrich with page content (default: 5)"
    ),
  content_max_length: z
    .number()
    .min(500)
    .max(20000)
    .optional()
    .describe("Per-result content character cap (default: 2500)"),
  highlights: sharedSearchSchema.highlights,
  highlight_top_k: sharedSearchSchema.highlight_top_k,
  prioritize_primary: sharedSearchSchema.prioritize_primary,
  deduplicate: sharedSearchSchema.deduplicate,
};

const webSearchDesc = `Use this tool for general web searches (websites, blogs, documentation, encyclopedias).
Top results are fetched via SearXNG, extracted with Readability, and semantically reranked
against the query — returning the most relevant passages ("highlights") rather than full pages.
Cite sources with (label) markers when quoting specific facts.

Every result carries detection signals you can route on:
  - source_class: primary_publisher | academic_repository | preprint_server | aggregator | suspect | grey_lit_or_unknown
  - doi_detected: first DOI found in title/snippet/full text (string), plus doi_candidates[] if multiple
  - oa_url_heuristic: "likely" | "maybe" | "no" — open-access guess from the URL alone (no Unpaywall call)
  - content_type / content_extraction: HTTP Content-Type + "ok" | "failed_pdf" | "fetch_failed"
Aggregator and suspect results are visibly ⚠️-marked. Duplicate results referring to the
same work (same DOI across hosts, or same canonical URL across engines) are collapsed by
default; opt out with deduplicate=false. When doi_detected is set, prefer calling
paper-search-mcp (Crossref / Unpaywall) to verify metadata rather than trusting snippet
text. No external API calls are made by this tool beyond SearXNG and the result URLs.`;

const webSearchHandler = async (args) => {
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
    results = applyDetectionLayer(results, {
      prioritizePrimary: args.prioritize_primary !== false,
      deduplicate: args.deduplicate !== false,
    });
    const fetchContent = args.fetch_content !== false;
    if (fetchContent) {
      results = await enrichResultsWithContent(results, {
        topN: args.fetch_top_n ?? 5,
        maxLength: args.content_max_length ?? 2500,
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
};

server.tool("web_search", webSearchDesc, webSearchSchema, webSearchHandler);

// --- Tool: news_search (was cited_news_search) ----------------------------

const newsSearchSchema = {
  query: z.string().describe("News search query"),
  engines: z
    .string()
    .optional()
    .describe(
      "Comma-separated SearXNG engines, e.g. 'reuters,bbc'. Overrides default news engines when set."
    ),
  language: sharedSearchSchema.language,
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
  fetch_content: sharedSearchSchema.fetch_content,
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
    .describe("Per-result content character cap (default: 2500)"),
  highlights: sharedSearchSchema.highlights,
  highlight_top_k: sharedSearchSchema.highlight_top_k,
  prioritize_primary: sharedSearchSchema.prioritize_primary,
  deduplicate: sharedSearchSchema.deduplicate,
};

const newsSearchDesc = `Use this tool when the user asks about recent events, news, or current affairs.
Results include publication dates, (label)-style citations, and (by default) extracted article
text for the top results. Defaults to the last week; pass time_range to widen or narrow.

Every result also carries detection signals: source_class, doi_detected (rare for news but
present when an article references a paper), oa_url_heuristic, content_type. Aggregator
and suspect domains are visibly ⚠️-marked.`;

const newsSearchHandler = async (args) => {
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
    results = applyDetectionLayer(results, {
      prioritizePrimary: args.prioritize_primary !== false,
      deduplicate: args.deduplicate !== false,
    });
    const fetchContent = args.fetch_content !== false;
    if (fetchContent) {
      results = await enrichResultsWithContent(results, {
        topN: args.fetch_top_n ?? 3,
        maxLength: args.content_max_length ?? 2500,
        query: args.query,
        highlights: args.highlights !== false,
        highlightTopK: args.highlight_top_k ?? 3,
      });
    }

    const text = formatCitedResults(results, args.query);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `News search error: ${err.message}` }],
      isError: true,
    };
  }
};

server.tool("news_search", newsSearchDesc, newsSearchSchema, newsSearchHandler);

// --- Tool: science_search (was cited_science_search) ----------------------

const scienceSearchSchema = {
  query: z.string().describe("Academic search query"),
  engines: z
    .string()
    .optional()
    .describe(
      "Comma-separated SearXNG engines, e.g. 'semantic_scholar,arxiv,pubmed,google_scholar'. Overrides default science engines when set."
    ),
  language: z.string().optional().describe("Language code (default: en)"),
  time_range: sharedSearchSchema.time_range,
  max_results: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum number of results (default: 10)"),
  fetch_content: sharedSearchSchema.fetch_content,
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
    .describe("Per-result content character cap (default: 2500)"),
  highlights: sharedSearchSchema.highlights,
  highlight_top_k: sharedSearchSchema.highlight_top_k,
  prioritize_primary: sharedSearchSchema.prioritize_primary,
  deduplicate: sharedSearchSchema.deduplicate,
};

const scienceSearchDesc = `Use this tool for academic literature, peer-reviewed papers, and preprints
(Google Scholar, Semantic Scholar, arXiv, PubMed, etc.). Ideal for literature review and
citing scholarly sources. Results include (label)-style citations and (by default) extracted
abstract/landing-page text. PDFs are parsed via pdf-parse when reachable.

Every result carries detection signals:
  - source_class: primary_publisher | academic_repository | preprint_server | aggregator | suspect | grey_lit_or_unknown
  - doi_detected: first DOI found in title/snippet/full text (use this to call paper-search-mcp for Crossref/Unpaywall verification)
  - oa_url_heuristic: "likely" | "maybe" | "no" (URL-based, no Unpaywall round-trip)
  - content_type, content_extraction: "ok" | "failed_pdf" | "fetch_failed"

Aggregator hits (academia.edu, researchgate.net, scribd.com, books.google.com, …) are
⚠️-marked: treat them as leads, not as primary sources — the real DOI lives on the
publisher domain. Suspect domains (creationist / pseudoscientific) are ⚠️⚠️-marked and
must not be cited as scholarly sources.

Duplicate results referring to the same work (same DOI across different hosts, or same
canonical URL across multiple engines) are collapsed by default — when an aggregator
mirror and the publisher's primary copy share a DOI, the publisher version is the one
kept. Opt out with deduplicate=false if you need the raw aggregated SearXNG result set.

No external API calls are made by this tool beyond SearXNG and the result URLs themselves
— DOI resolution belongs in paper-search-mcp to keep tool independence intact for
cross-validation.`;

const scienceSearchHandler = async (args) => {
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
    results = applyDetectionLayer(results, {
      prioritizePrimary: args.prioritize_primary !== false,
      deduplicate: args.deduplicate !== false,
    });
    const fetchContent = args.fetch_content !== false;
    if (fetchContent) {
      results = await enrichResultsWithContent(results, {
        topN: args.fetch_top_n ?? 3,
        maxLength: args.content_max_length ?? 2500,
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
};

server.tool(
  "science_search",
  scienceSearchDesc,
  scienceSearchSchema,
  scienceSearchHandler
);

// --- Deprecated aliases (will be removed in 2.0.0) ------------------------
// Same handlers, same schemas, just the old names. The description starts
// with the deprecation marker so LLMs prefer the new names when both are
// listed. Set EXPOSE_LEGACY_TOOL_NAMES=false to suppress.

if (EXPOSE_LEGACY_TOOL_NAMES) {
  server.tool(
    "cited_search",
    `[deprecated, use web_search] ${webSearchDesc}`,
    webSearchSchema,
    webSearchHandler
  );
  server.tool(
    "cited_news_search",
    `[deprecated, use news_search] ${newsSearchDesc}`,
    newsSearchSchema,
    newsSearchHandler
  );
  server.tool(
    "cited_science_search",
    `[deprecated, use science_search] ${scienceSearchDesc}`,
    scienceSearchSchema,
    scienceSearchHandler
  );
}

// --- Tool: fetch_url -------------------------------------------------------
// Users invoke this on a specific URL they care about, so we keep the older
// 15s per-request timeout (vs the tighter 8s default used in bulk enrichment).

server.tool(
  "fetch_url",
  `Use this tool to read the full content of a single specific URL — for example
to follow up on a search result, or to retrieve a page the user linked. Returns
readable plain text via Mozilla Readability with a regex fallback.`,
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
      const result = await fetchUrlContent(args.url, {
        maxLength: args.max_length || 15000,
        timeoutMs: 15000,
      });
      const { text, contentType, extractionStatus } = result;
      const note =
        extractionStatus === "failed_pdf"
          ? `\n\n_(Content-Type: ${contentType || "application/pdf"} — PDF text extraction failed.)_`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `## Content from ${args.url}\n\n${text}${note}`,
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
  entrypointPath.endsWith("/dao-searxng-mcp"); // npm bin shim

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
      `[http] dao-searxng-mcp listening on http://${host}:${port}/mcp\n`
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
