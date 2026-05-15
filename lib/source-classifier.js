// Detection layer for SearXNG-Cited-MCP.
//
// Pure JS, zero external API calls. Extracts structured signals from search
// results so the consuming LLM can route to paper-search-mcp (Crossref /
// Unpaywall / Semantic Scholar) when a DOI is detected, and can avoid citing
// aggregator/suspect domains as primary sources.
//
// Public API:
//   detectDOI(text)               → string | null   (first plausible DOI)
//   detectDOICandidates(text)     → string[]        (deduped, trimmed)
//   classifyDomain(url, classes)  → SourceClass
//   oaUrlHeuristic(url, cls)      → "likely" | "maybe" | "no"
//   loadDomainClasses(path)       → DomainClassMap  (cached, sync)
//   enrichResultWithClassification(result, classes) → result
//   rankResults(results, opts)    → result[]
//   badgeFor(sourceClass)         → string          (display badge or "")
//
// SourceClass union:
//   "primary_publisher" | "academic_repository" | "preprint_server"
//   | "aggregator" | "suspect" | "grey_lit_or_unknown"

import fs from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";

// ---------- DOI detection ----------

const DOI_RE = /\b10\.\d{4,9}\/[-._;()\/:A-Za-z0-9]+\b/g;
const TRAIL_PUNCT_RE = /[.,;:)\]'"]+$/;

function isPlausibleDOI(s) {
  const slash = s.indexOf("/");
  // Non-empty suffix after the slash. The leading `\b10\.\d{4,9}\/` in the
  // regex already filters out look-alikes like "10.5 km", "1.0.5", or
  // "Section 10.3.1.2" (no slash, or wrong digit count). All-digit DOI
  // suffixes are legitimate (e.g. "10.1101/2024.01.15.575713" on bioRxiv),
  // so we deliberately do NOT require a letter in the suffix here.
  return slash > 0 && s.length > slash + 1;
}

export function detectDOICandidates(text) {
  if (!text || typeof text !== "string") return [];
  const matches = text.match(DOI_RE) || [];
  const out = [];
  const seen = new Set();
  for (const raw of matches) {
    const cleaned = raw.replace(TRAIL_PUNCT_RE, "");
    if (!isPlausibleDOI(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

export function detectDOI(text) {
  const all = detectDOICandidates(text);
  return all.length ? all[0] : null;
}

// Per-host URL-pattern inference: rebuild a DOI from a URL whose path
// encodes a registered Crossref identifier even when neither the snippet
// nor the URL itself spells out a "10.xxx/yyy" string. JSTOR is the first
// case — its stable IDs (article-level, pure numeric) are registered with
// Crossref under the 10.2307 prefix. Issue- and journal-level IDs
// (`i23396752`, `j23396750`) are deliberately skipped because they don't
// point at an article. No external API calls; pure string manipulation.
export function inferDOIFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host === "jstor.org" || host.endsWith(".jstor.org")) {
    // /stable/1356668, /stable/1356668?seq=1, /stable/pdf/1356668.pdf
    const m = u.pathname.match(/^\/stable\/(?:pdf\/)?(\d+)(?:\.pdf)?$/);
    if (m) return `10.2307/${m[1]}`;
  }
  return null;
}

// ---------- Domain classification ----------

export const SOURCE_CLASSES = [
  "primary_publisher",
  "academic_repository",
  "preprint_server",
  "aggregator",
  "suspect",
  "grey_lit_or_unknown",
];

// Priority for resolving multi-class matches. `suspect` first so a
// pseudoscientific host that happens to live on a university subdomain
// stays flagged.
const RESOLVE_ORDER = [
  "suspect",
  "primary_publisher",
  "academic_repository",
  "preprint_server",
  "aggregator",
];

const yamlSchema = z.object({
  classes: z.object({
    primary_publisher: z.array(z.string()).default([]),
    academic_repository: z.array(z.string()).default([]),
    preprint_server: z.array(z.string()).default([]),
    aggregator: z.array(z.string()).default([]),
    suspect: z.array(z.string()).default([]),
  }),
});

let cachedClasses = null;
let cachedPath = null;

export function loadDomainClasses(path) {
  if (cachedClasses && cachedPath === path) return cachedClasses;
  const raw = fs.readFileSync(path, "utf8");
  const parsed = yaml.load(raw);
  const result = yamlSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `Invalid domain-classes file at ${path}: ${issue.path.join(".")} — ${issue.message}`
    );
  }
  cachedClasses = result.data.classes;
  cachedPath = path;
  return cachedClasses;
}

// Reset cache (used by tests).
export function _resetDomainClassesCache() {
  cachedClasses = null;
  cachedPath = null;
}

function extractHost(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function escapeForRegex(s) {
  // Escape "*" too — the caller turns the escaped "\*" back into "[^.]*"
  // after escaping, so wildcards stay as wildcards and everything else is
  // literal.
  return s.replace(/[.+?^${}()|[\]\\*]/g, "\\$&");
}

function hostMatches(host, pattern) {
  const p = pattern.toLowerCase();
  if (!p.includes("*")) {
    // Bare patterns match the host and its "www." form — editing the YAML
    // shouldn't require both "bible.ca" and "www.bible.ca". Right-anchor
    // is preserved: "evil.bible.ca" still falls through.
    return host === p || host === "www." + p;
  }

  // Fast path for the common "*.publisher.org" shape — also matches the bare
  // "publisher.org" so we don't need both entries in the YAML.
  if (p.startsWith("*.") && !p.slice(2).includes("*")) {
    const suffix = p.slice(1);
    const bare = p.slice(2);
    return host === bare || host.endsWith(suffix);
  }

  // General wildcards: each "*" matches one host label (no dots), so
  // "*.ub.uni-*.de" matches "www.ub.uni-oldenburg.de" but "uni-*.evil.de"
  // can't be exploited to bypass right-anchoring.
  const re = new RegExp("^" + escapeForRegex(p).replace(/\\\*/g, "[^.]*") + "$");
  return re.test(host);
}

export function classifyDomain(url, classes) {
  const host = extractHost(url);
  if (!host || !classes) return "grey_lit_or_unknown";
  for (const cls of RESOLVE_ORDER) {
    const patterns = classes[cls];
    if (!patterns) continue;
    for (const p of patterns) {
      if (hostMatches(host, p)) return cls;
    }
  }
  return "grey_lit_or_unknown";
}

// ---------- OA URL heuristic ----------

// "pdfplus" is UChicago Journals' PDF-with-references viewer (still a PDF).
const OA_PATH_RE = /\/(pdf|pdfplus|oa|open-access|download|fulltext|articles?\/pdf)\//;
const PDF_TAIL_RE = /\.pdf(\?|#|$)/;

export function oaUrlHeuristic(url, sourceClass) {
  if (!url) return "no";
  const u = url.toLowerCase();
  if (PDF_TAIL_RE.test(u) || OA_PATH_RE.test(u)) return "likely";
  if (
    sourceClass === "academic_repository" ||
    sourceClass === "preprint_server"
  ) {
    return "maybe";
  }
  return "no";
}

// ---------- Result enrichment + ranking ----------

export function enrichResultWithClassification(result, classes) {
  if (!result || typeof result !== "object") return result;
  const sourceClass = classifyDomain(result.url, classes);
  // Include the URL in the haystack — publisher URLs commonly carry the
  // DOI in the path (e.g. tandfonline.com/doi/full/10.1080/...,
  // journals.uchicago.edu/doi/pdfplus/10.2307/...), and snippet text often
  // doesn't.
  const haystack = [result.title, result.content, result.snippet, result.url]
    .filter(Boolean)
    .join(" ");
  const dois = detectDOICandidates(haystack);

  const out = {
    ...result,
    source_class: sourceClass,
    oa_url_heuristic: oaUrlHeuristic(result.url, sourceClass),
  };
  if (dois.length > 0) {
    out.doi_detected = dois[0];
    if (dois.length > 1) out.doi_candidates = dois;
  } else {
    const inferred = inferDOIFromUrl(result.url);
    if (inferred) out.doi_detected = inferred;
  }
  return out;
}

// Re-runs DOI detection over a result's fullContent if we didn't catch one
// from title/snippet. Used after enrichResultsWithContent finishes fetching.
export function detectDOIInFullContent(result) {
  if (!result || result.doi_detected || !result.fullContent) return result;
  const dois = detectDOICandidates(result.fullContent);
  if (dois.length === 0) return result;
  const out = { ...result, doi_detected: dois[0] };
  if (dois.length > 1) out.doi_candidates = dois;
  return out;
}

const PRIORITY = {
  primary_publisher: 0,
  academic_repository: 1,
  preprint_server: 1,
  grey_lit_or_unknown: 2,
  aggregator: 3,
  suspect: 4,
};

export function rankResults(results, { prioritizePrimary = true } = {}) {
  if (!prioritizePrimary || !Array.isArray(results)) return results;
  return [...results]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const pa = PRIORITY[a.r.source_class] ?? 2;
      const pb = PRIORITY[b.r.source_class] ?? 2;
      if (pa !== pb) return pa - pb;
      return a.i - b.i; // stable within a class
    })
    .map(({ r }) => r);
}

// ---------- Result deduplication ----------

// Collapse duplicate results, preserving the first occurrence. When called
// after rankResults(), "first" means "highest-ranked" — so for a study found
// on both academia.edu (aggregator) and cambridge.org (primary publisher),
// the cambridge.org version is kept and the aggregator copy is dropped.
//
// Dedup keys, in order:
//   1. `doi_detected` — same DOI = same work, regardless of which host.
//   2. Canonical URL (host + pathname, lower-cased, trailing slash stripped)
//      — catches multi-engine repeats of the exact same page.
//
// Engines from collapsed duplicates are merged into the kept result so the
// LLM still sees how many independent engines surfaced the same work.
export function deduplicateResults(results) {
  if (!Array.isArray(results) || results.length === 0) return results;

  const seen = new Map(); // dedup-key → index in `out`
  const out = [];

  for (const r of results) {
    const keys = dedupKeysFor(r);
    let mergedIdx = -1;
    for (const key of keys) {
      if (seen.has(key)) {
        mergedIdx = seen.get(key);
        break;
      }
    }
    if (mergedIdx >= 0) {
      const kept = out[mergedIdx];
      out[mergedIdx] = mergeDuplicate(kept, r);
      // Register any additional keys (e.g. the duplicate had a DOI the kept
      // didn't) so later results dedup against the merged record.
      for (const key of dedupKeysFor(out[mergedIdx])) seen.set(key, mergedIdx);
      continue;
    }
    for (const key of keys) seen.set(key, out.length);
    out.push(r);
  }
  return out;
}

function dedupKeysFor(r) {
  const keys = [];
  if (r?.doi_detected) keys.push(`doi:${r.doi_detected.toLowerCase()}`);
  const canonical = canonicalUrl(r?.url);
  if (canonical) keys.push(`url:${canonical}`);
  return keys;
}

function canonicalUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

function mergeDuplicate(kept, dupe) {
  const merged = { ...kept };
  if (kept.engines || dupe.engines) {
    const seen = new Set();
    const list = [];
    for (const e of kept.engines || []) {
      if (!seen.has(e)) {
        seen.add(e);
        list.push(e);
      }
    }
    for (const e of dupe.engines || []) {
      if (!seen.has(e)) {
        seen.add(e);
        list.push(e);
      }
    }
    if (list.length) merged.engines = list;
  }
  // Backfill DOI if the kept result missed one but the duplicate caught it.
  if (!merged.doi_detected && dupe.doi_detected) {
    merged.doi_detected = dupe.doi_detected;
  }
  return merged;
}

// ---------- Display badges ----------

export function badgeFor(sourceClass) {
  switch (sourceClass) {
    case "aggregator":
      return "⚠️ AGGREGATOR — not a primary source; look up the publisher DOI";
    case "suspect":
      return "⚠️⚠️ SUSPECT — apologetic / pseudoscientific source; do not cite";
    case "primary_publisher":
      return "✓ Primary publisher";
    case "preprint_server":
      return "ℹ Preprint — not yet peer-reviewed";
    default:
      return "";
  }
}
