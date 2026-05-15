// Dry-run verification of the detection layer with synthetic SearXNG-shaped
// results. Exercises classification + DOI detection + ranking + formatting,
// without depending on a live SearXNG instance or network access.
//
// Run from the repo root:
//   node scripts/verify-detection-dry-run.mjs

import {
  loadDomainClasses,
  enrichResultWithClassification,
  rankResults,
} from "../lib/source-classifier.js";
import { formatCitedResults } from "../index.js";

const DOMAIN_CLASSES_PATH = new URL("../domain-classes.yml", import.meta.url);

// Synthetic results — same shape SearXNG would hand back via its JSON API.
// Hand-crafted to cover every class the layer should distinguish.
const synthetic = [
  {
    title: "Negev fortresses revisited — Cohen 1979 reappraised",
    url: "https://academia.edu/papers/56789/Cohen-Negev",
    content:
      "Free PDF mirror of Cohen 1979 chapter, cf. publisher edition at doi:10.1179/abc.2009.0024.",
    engines: ["google"],
  },
  {
    title: "Iron-Age fortresses of the central Negev",
    url: "https://www.cambridge.org/core/journals/levant/article/iron-age-fortresses",
    content:
      "Levant 47, no. 2 (2015): 145–178. DOI 10.1080/00758914.2015.123456. Re-examination of...",
    engines: ["google scholar"],
  },
  {
    title: "Negev forts and the Exodus route",
    url: "https://bible.ca/exodus-negev-forts.html",
    content: "These fortresses prove the biblical narrative of the Israelite Exodus...",
    engines: ["google"],
  },
  {
    title: "Cohen 1979 — full text (Open Access)",
    url: "https://zenodo.org/record/123456/files/cohen-negev.pdf",
    content: "Open-access reprint of Cohen 1979 hosted on Zenodo.",
    engines: ["base"],
  },
  {
    title: "arXiv preprint: Magnetometry of Iron Age sites",
    url: "https://arxiv.org/abs/2401.12345",
    content: "Preprint on geophysical survey methods at Iron Age fortresses.",
    engines: ["arxiv"],
  },
  {
    title: "Random blog post about Negev archaeology",
    url: "https://some-random-blog.example.com/negev-forts",
    content: "My weekend trip to the Negev archaeological sites...",
    engines: ["google"],
  },
];

console.log("# Detection-layer dry-run\n");
console.log(`Input results: ${synthetic.length}\n`);

const classes = loadDomainClasses(DOMAIN_CLASSES_PATH);
console.log(
  `Loaded domain classes from ${DOMAIN_CLASSES_PATH.pathname}: ` +
    `${classes.primary_publisher.length} primary, ` +
    `${classes.academic_repository.length} repository, ` +
    `${classes.preprint_server.length} preprint, ` +
    `${classes.aggregator.length} aggregator, ` +
    `${classes.suspect.length} suspect\n`
);

const classified = synthetic.map((r) => enrichResultWithClassification(r, classes));
const ranked = rankResults(classified);

console.log("## Per-result detection fields (after classify + rank)\n");
for (const r of ranked) {
  console.log(`- ${new URL(r.url).hostname}`);
  console.log(`    source_class:      ${r.source_class}`);
  console.log(`    doi_detected:      ${r.doi_detected ?? "(none)"}`);
  if (r.doi_candidates) {
    console.log(`    doi_candidates:    ${JSON.stringify(r.doi_candidates)}`);
  }
  console.log(`    oa_url_heuristic:  ${r.oa_url_heuristic}`);
}

console.log("\n## Formatted text output (what the LLM actually reads)\n");
console.log("```");
console.log(formatCitedResults(ranked, "Cohen Negev fortresses"));
console.log("```");
