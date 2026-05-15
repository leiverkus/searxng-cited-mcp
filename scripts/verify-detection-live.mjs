// End-to-end verification against a live SearXNG instance.
// Calls SearXNG directly (same JSON contract index.js uses), feeds results
// through the detection layer, and prints both the per-result detection
// fields and the LLM-facing formatted text.
//
// Run:
//   SEARXNG_URL=http://localhost:8888 node scripts/verify-detection-live.mjs "Cohen Negev fortresses"

import {
  loadDomainClasses,
  enrichResultWithClassification,
  rankResults,
} from "../lib/source-classifier.js";
import { formatCitedResults } from "../index.js";

const SEARXNG_URL = (process.env.SEARXNG_URL || "http://localhost:8888").replace(/\/+$/, "");
const query = process.argv.slice(2).join(" ") || "Cohen Negev fortresses";

const DOMAIN_CLASSES_PATH = new URL("../domain-classes.yml", import.meta.url);

console.log(`# Live verification — query "${query}"\n`);
console.log(`SearXNG: ${SEARXNG_URL}`);

const params = new URLSearchParams({
  q: query,
  format: "json",
  language: "en",
  categories: "general",
});

const t0 = Date.now();
const resp = await fetch(`${SEARXNG_URL}/search?${params}`, {
  headers: {
    // SearXNG by default rejects empty/MCP-style UAs; mimic a browser.
    "User-Agent": "Mozilla/5.0 (verification driver)",
  },
});
if (!resp.ok) {
  console.error(`SearXNG returned HTTP ${resp.status}`);
  process.exit(1);
}
const data = await resp.json();
const elapsed = Date.now() - t0;
console.log(`SearXNG returned ${data.results?.length ?? 0} results in ${elapsed}ms\n`);

const classes = loadDomainClasses(DOMAIN_CLASSES_PATH);
const classified = (data.results || []).map((r) =>
  enrichResultWithClassification(r, classes)
);
const ranked = rankResults(classified).slice(0, 10);

const classCount = {};
for (const r of ranked) classCount[r.source_class] = (classCount[r.source_class] || 0) + 1;
console.log(`Top-10 class distribution: ${JSON.stringify(classCount)}\n`);

const dois = ranked.filter((r) => r.doi_detected).map((r) => ({
  doi: r.doi_detected,
  host: new URL(r.url).hostname,
}));
console.log(`DOIs detected in top-10: ${dois.length}`);
for (const d of dois) console.log(`  - ${d.doi}  (on ${d.host})`);
console.log("");

console.log("## Per-result detection fields\n");
for (const r of ranked) {
  console.log(`- ${new URL(r.url).hostname}`);
  console.log(`    source_class:     ${r.source_class}`);
  console.log(`    doi_detected:     ${r.doi_detected ?? "(none)"}`);
  console.log(`    oa_url_heuristic: ${r.oa_url_heuristic}`);
}

console.log("\n## Formatted text output (LLM-facing)\n");
console.log("```");
console.log(formatCitedResults(ranked, query));
console.log("```");
