import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectDOI,
  detectDOICandidates,
  classifyDomain,
  oaUrlHeuristic,
  loadDomainClasses,
  enrichResultWithClassification,
  rankResults,
  badgeFor,
  inferDOIFromUrl,
  _resetDomainClassesCache,
} from "../lib/source-classifier.js";

const REPO_YAML = new URL("../domain-classes.yml", import.meta.url);

// ----- detectDOI --------------------------------------------------------

test("detectDOI — catches a canonical DOI in plain text", () => {
  assert.equal(
    detectDOI("see Cohen, Tel Aviv 36 (2009): 41–47, doi:10.1179/abc.2009.0024 for details"),
    "10.1179/abc.2009.0024"
  );
});

test("detectDOI — catches DOI with long suffix and digits", () => {
  assert.equal(
    detectDOI("doi 10.1080/00758914.2024.123456"),
    "10.1080/00758914.2024.123456"
  );
});

test("detectDOI — trims trailing punctuation", () => {
  assert.equal(
    detectDOI("see 10.1179/abc.2009.0024."),
    "10.1179/abc.2009.0024"
  );
  assert.equal(detectDOI("(10.1179/abc.2009.0024)"), "10.1179/abc.2009.0024");
});

test("detectDOI — rejects false positives that look DOI-ish", () => {
  // Distance "10.5 km" — no slash, can't match anyway.
  assert.equal(detectDOI("10.5 km"), null);
  // Version "1.0.5" — starts with "1.0", not "10.".
  assert.equal(detectDOI("Apartheid 1.0.5"), null);
  // Section numbering "10.3.1.2" — has no slash, so the regex itself rejects it.
  assert.equal(detectDOI("Section 10.3.1.2 covers this"), null);
  // "10.1023456" — no slash, regex rejects.
  assert.equal(detectDOI("identifier 10.1023456 elsewhere"), null);
});

test("detectDOI — accepts all-digit DOI suffix (e.g. bioRxiv style)", () => {
  // bioRxiv DOIs look like "10.1101/2024.01.15.575713" — all digits in
  // the suffix. These are legitimate and must not be filtered out.
  assert.equal(
    detectDOI("preprint at 10.1101/2024.01.15.575713 for details"),
    "10.1101/2024.01.15.575713"
  );
});

test("detectDOICandidates — dedup + ordered list when multiple present", () => {
  const text =
    "First reference 10.1179/abc.2009.0024 then a second 10.1080/00758914.2024.x123 " +
    "and a repeat of 10.1179/abc.2009.0024.";
  const dois = detectDOICandidates(text);
  assert.deepEqual(dois, [
    "10.1179/abc.2009.0024",
    "10.1080/00758914.2024.x123",
  ]);
});

test("detectDOI — null/empty input is safe", () => {
  assert.equal(detectDOI(""), null);
  assert.equal(detectDOI(null), null);
  assert.equal(detectDOI(undefined), null);
  assert.deepEqual(detectDOICandidates(""), []);
});

// ----- classifyDomain ---------------------------------------------------

const classes = {
  primary_publisher: ["*.cambridge.org", "journals.plos.org"],
  academic_repository: ["zenon.dainst.org", "*.ub.uni-*.de"],
  preprint_server: ["arxiv.org"],
  aggregator: ["academia.edu", "*.academia.edu", "books.google.com"],
  suspect: ["bible.ca"],
};

test("classifyDomain — wildcard subdomain matches both bare and prefixed hosts", () => {
  assert.equal(
    classifyDomain("https://www.cambridge.org/foo", classes),
    "primary_publisher"
  );
  assert.equal(
    classifyDomain("https://journals.cambridge.org/x", classes),
    "primary_publisher"
  );
  assert.equal(
    classifyDomain("https://cambridge.org/y", classes),
    "primary_publisher"
  );
});

test("classifyDomain — right-anchor: spoofed domain in path does NOT match", () => {
  assert.equal(
    classifyDomain("https://cambridge.org.fake-aggregator.com/x", classes),
    "grey_lit_or_unknown"
  );
});

test("classifyDomain — multi-wildcard middle pattern", () => {
  assert.equal(
    classifyDomain("https://www.ub.uni-oldenburg.de/foo", classes),
    "academic_repository"
  );
});

test("classifyDomain — exact-match host without wildcard", () => {
  assert.equal(
    classifyDomain("https://academia.edu/papers/123", classes),
    "aggregator"
  );
  assert.equal(
    classifyDomain("https://www.academia.edu/papers/123", classes),
    "aggregator"
  );
});

test("classifyDomain — bare hostname pattern also matches its www. form", () => {
  // YAML entry "biblewalks.com" should catch "www.biblewalks.com" too —
  // otherwise the YAML editor would have to remember to add both. Right-
  // anchor is still preserved: "mirror.biblewalks.com" does NOT match.
  const minimal = { ...classes, suspect: ["biblewalks.com"] };
  assert.equal(
    classifyDomain("https://www.biblewalks.com/foo", minimal),
    "suspect"
  );
  assert.equal(
    classifyDomain("https://biblewalks.com/foo", minimal),
    "suspect"
  );
  assert.equal(
    classifyDomain("https://mirror.biblewalks.com/foo", minimal),
    "grey_lit_or_unknown"
  );
});

test("classifyDomain — preprint server", () => {
  assert.equal(classifyDomain("https://arxiv.org/abs/2401.12345", classes), "preprint_server");
});

test("classifyDomain — suspect wins over other matches", () => {
  const overlap = {
    ...classes,
    primary_publisher: ["bible.ca", ...classes.primary_publisher],
  };
  // If bible.ca were also marked primary, suspect still wins per RESOLVE_ORDER.
  assert.equal(classifyDomain("https://bible.ca/x", overlap), "suspect");
});

test("classifyDomain — unknown domain → grey_lit_or_unknown", () => {
  assert.equal(
    classifyDomain("https://random-blog.example/post", classes),
    "grey_lit_or_unknown"
  );
});

test("classifyDomain — malformed URL → grey_lit_or_unknown", () => {
  assert.equal(classifyDomain("not a url", classes), "grey_lit_or_unknown");
  assert.equal(classifyDomain("", classes), "grey_lit_or_unknown");
  assert.equal(classifyDomain(null, classes), "grey_lit_or_unknown");
});

// ----- oaUrlHeuristic ---------------------------------------------------

test("oaUrlHeuristic — .pdf and /pdf/ paths are likely", () => {
  assert.equal(oaUrlHeuristic("https://example.org/article.pdf"), "likely");
  assert.equal(
    oaUrlHeuristic("https://example.org/article.pdf?download=1"),
    "likely"
  );
  assert.equal(
    oaUrlHeuristic("https://example.org/pdf/123", "primary_publisher"),
    "likely"
  );
  assert.equal(
    oaUrlHeuristic("https://example.org/open-access/article", "primary_publisher"),
    "likely"
  );
  // UChicago Journals "pdfplus" viewer — still a PDF.
  assert.equal(
    oaUrlHeuristic(
      "https://www.journals.uchicago.edu/doi/pdfplus/10.2307/1356668",
      "primary_publisher"
    ),
    "likely"
  );
});

test("oaUrlHeuristic — repository hosts default to maybe", () => {
  assert.equal(
    oaUrlHeuristic("https://zenodo.org/record/123", "academic_repository"),
    "maybe"
  );
  assert.equal(
    oaUrlHeuristic("https://arxiv.org/abs/2401.0", "preprint_server"),
    "maybe"
  );
});

test("oaUrlHeuristic — publishers without OA path → no", () => {
  assert.equal(
    oaUrlHeuristic("https://journals.cambridge.org/x", "primary_publisher"),
    "no"
  );
});

test("oaUrlHeuristic — aggregators / suspect / unknown → no", () => {
  assert.equal(
    oaUrlHeuristic("https://academia.edu/papers/x", "aggregator"),
    "no"
  );
  assert.equal(oaUrlHeuristic("https://bible.ca/x", "suspect"), "no");
  assert.equal(oaUrlHeuristic("https://example.com/x", "grey_lit_or_unknown"), "no");
});

// ----- loadDomainClasses -----------------------------------------------

test("loadDomainClasses — bundled YAML loads cleanly with expected classes", () => {
  _resetDomainClassesCache();
  const loaded = loadDomainClasses(REPO_YAML);
  assert.ok(Array.isArray(loaded.primary_publisher));
  assert.ok(loaded.primary_publisher.includes("*.cambridge.org"));
  assert.ok(loaded.aggregator.includes("academia.edu"));
  assert.ok(loaded.suspect.includes("bible.ca"));
});

test("loadDomainClasses — invalid schema throws with informative message", () => {
  _resetDomainClassesCache();
  const tmp = path.join(os.tmpdir(), `bad-classes-${Date.now()}.yml`);
  fs.writeFileSync(tmp, "classes:\n  primary_publisher: not-a-list\n");
  try {
    assert.throws(
      () => loadDomainClasses(tmp),
      /Invalid domain-classes file/
    );
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("loadDomainClasses — missing keys default to empty arrays", () => {
  _resetDomainClassesCache();
  const tmp = path.join(os.tmpdir(), `partial-classes-${Date.now()}.yml`);
  fs.writeFileSync(tmp, "classes:\n  primary_publisher:\n    - example.org\n");
  try {
    const loaded = loadDomainClasses(tmp);
    assert.deepEqual(loaded.primary_publisher, ["example.org"]);
    assert.deepEqual(loaded.aggregator, []);
    assert.deepEqual(loaded.suspect, []);
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ----- inferDOIFromUrl --------------------------------------------------

test("inferDOIFromUrl — JSTOR article stable ID → 10.2307/N", () => {
  assert.equal(
    inferDOIFromUrl("https://www.jstor.org/stable/1356668"),
    "10.2307/1356668"
  );
  // /stable/pdf/N.pdf form (the PDF download URL on JSTOR)
  assert.equal(
    inferDOIFromUrl("https://www.jstor.org/stable/pdf/1356668.pdf"),
    "10.2307/1356668"
  );
});

test("inferDOIFromUrl — JSTOR issue/journal stable IDs are skipped", () => {
  // /stable/i23396752 is an issue identifier, not an article — must not be
  // converted to a fake article DOI.
  assert.equal(
    inferDOIFromUrl("https://www.jstor.org/stable/i23396752"),
    null
  );
});

test("inferDOIFromUrl — non-JSTOR hosts return null", () => {
  assert.equal(
    inferDOIFromUrl("https://www.cambridge.org/core/journals/x/article/y"),
    null
  );
  assert.equal(inferDOIFromUrl("not a url"), null);
  assert.equal(inferDOIFromUrl(null), null);
  assert.equal(inferDOIFromUrl(""), null);
});

test("enrichResultWithClassification — falls back to URL-inferred DOI for JSTOR", () => {
  const enriched = enrichResultWithClassification(
    {
      title: "Cohen — Iron Age fortresses",
      url: "https://www.jstor.org/stable/1356668",
      content: "Snippet text without any DOI mentioned.",
    },
    classes
  );
  assert.equal(enriched.doi_detected, "10.2307/1356668");
});

// ----- enrichResultWithClassification ----------------------------------

test("enrichResultWithClassification — sets source_class, doi_detected, oa_url_heuristic", () => {
  const enriched = enrichResultWithClassification(
    {
      title: "Negev fortresses",
      url: "https://www.cambridge.org/core/journals/levant/article/123",
      content: "Cohen et al., Tel Aviv 36 (2009), doi:10.1179/abc.2009.0024",
    },
    classes
  );
  assert.equal(enriched.source_class, "primary_publisher");
  assert.equal(enriched.doi_detected, "10.1179/abc.2009.0024");
  assert.equal(enriched.oa_url_heuristic, "no");
});

test("enrichResultWithClassification — aggregator + no DOI in snippet", () => {
  const enriched = enrichResultWithClassification(
    {
      title: "Cohen Negev",
      url: "https://academia.edu/papers/12345",
      content: "Free download of Cohen 1979 monograph...",
    },
    classes
  );
  assert.equal(enriched.source_class, "aggregator");
  assert.equal(enriched.doi_detected, undefined);
});

test("enrichResultWithClassification — multiple DOIs → doi_candidates set", () => {
  const enriched = enrichResultWithClassification(
    {
      title: "Review",
      url: "https://example.org",
      content: "Compare 10.1179/abc.2009.0024 with 10.1080/00758914.2024.x99",
    },
    classes
  );
  assert.equal(enriched.doi_detected, "10.1179/abc.2009.0024");
  assert.deepEqual(enriched.doi_candidates, [
    "10.1179/abc.2009.0024",
    "10.1080/00758914.2024.x99",
  ]);
});

// ----- rankResults -----------------------------------------------------

test("rankResults — promotes primary, demotes aggregator/suspect, stable within class", () => {
  const input = [
    { id: 1, source_class: "aggregator" },
    { id: 2, source_class: "primary_publisher" },
    { id: 3, source_class: "suspect" },
    { id: 4, source_class: "academic_repository" },
    { id: 5, source_class: "primary_publisher" },
    { id: 6, source_class: "grey_lit_or_unknown" },
  ];
  const out = rankResults(input);
  assert.deepEqual(
    out.map((r) => r.id),
    [2, 5, 4, 6, 1, 3]
  );
});

test("rankResults — passthrough when prioritizePrimary=false", () => {
  const input = [
    { id: 1, source_class: "aggregator" },
    { id: 2, source_class: "primary_publisher" },
  ];
  assert.deepEqual(rankResults(input, { prioritizePrimary: false }), input);
});

// ----- badgeFor --------------------------------------------------------

test("badgeFor — aggregator and suspect produce visible warning text", () => {
  assert.match(badgeFor("aggregator"), /AGGREGATOR/);
  assert.match(badgeFor("suspect"), /SUSPECT/);
  assert.match(badgeFor("primary_publisher"), /Primary publisher/);
  assert.equal(badgeFor("grey_lit_or_unknown"), "");
  assert.equal(badgeFor(undefined), "");
});
