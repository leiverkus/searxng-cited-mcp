import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatCitedResults,
  buildCitationLabels,
  sanitizeSlug,
} from "../index.js";

test("formatCitedResults — empty results", () => {
  const out = formatCitedResults([], "anything");
  assert.match(out, /No results found for "anything"/);
});

test("formatCitedResults — basic structure: header, labeled hits, sources block, instruction", () => {
  // Two results from the same hostname → labels disambiguated by title slug.
  const out = formatCitedResults(
    [
      { title: "First", url: "https://example.org/a", content: "snippet a" },
      { title: "Second", url: "https://example.org/b", content: "snippet b" },
    ],
    "test query"
  );

  assert.match(out, /## Search results for: "test query"/);
  assert.match(out, /\*\*\(example\.org — First\) First\*\*/);
  assert.match(out, /\*\*\(example\.org — Second\) Second\*\*/);
  assert.match(out, /https:\/\/example\.org\/a/);
  assert.match(out, /### Sources/);
  assert.match(
    out,
    /- \(example\.org — First\) \[First\]\(https:\/\/example\.org\/a\)/
  );
  // Citation instruction must guide the model to produce inline [(label)](url) links
  assert.match(out, /\[\(label\)\]\(url\)/);
});

test("formatCitedResults — single result per hostname uses hostname only", () => {
  const out = formatCitedResults(
    [
      { title: "Alpha", url: "https://alpha.com/x", content: "a" },
      { title: "Beta", url: "https://beta.io/y", content: "b" },
    ],
    "q"
  );
  assert.match(out, /\*\*\(alpha\.com\) Alpha\*\*/);
  assert.match(out, /\*\*\(beta\.io\) Beta\*\*/);
  assert.match(out, /- \(alpha\.com\) \[Alpha\]\(https:\/\/alpha\.com\/x\)/);
});

test("formatCitedResults — handles missing fields without throwing", () => {
  const out = formatCitedResults([{}], "x");
  assert.match(out, /\(no title\)/);
  assert.match(out, /\(unknown\)/); // fallback label for missing URL
  assert.match(out, /### Sources/);
});

test("formatCitedResults — preserves special characters in titles", () => {
  const out = formatCitedResults(
    [{ title: "Foo & Bar [draft]", url: "https://example.org" }],
    "q"
  );
  assert.ok(
    out.includes("Foo & Bar [draft]"),
    "title with brackets and ampersand must round-trip into the displayed text"
  );
});

test("formatCitedResults — emits highlights block with label reference", () => {
  const out = formatCitedResults(
    [
      {
        title: "Doc",
        url: "https://example.org",
        content: "snippet",
        highlights: [
          { score: 0.812, text: "key passage one" },
          { score: 0.647, text: "key passage two" },
        ],
      },
    ],
    "q"
  );
  assert.match(out, /<highlights source="\(example\.org\)">/);
  assert.match(out, /\(0\.812\) key passage one/);
  assert.match(out, /<\/highlights>/);
});

test("formatCitedResults — falls back to fullContent when no highlights", () => {
  const out = formatCitedResults(
    [
      {
        title: "Doc",
        url: "https://example.org",
        content: "snippet",
        fullContent: "the full extracted body of the page",
      },
    ],
    "q"
  );
  assert.match(out, /<content source="\(example\.org\)">/);
  assert.match(out, /the full extracted body of the page/);
});

test("formatCitedResults — surfaces fetchError when fetch failed", () => {
  const out = formatCitedResults(
    [
      {
        title: "Doc",
        url: "https://example.org",
        content: "snippet",
        fetchError: "HTTP 403",
      },
    ],
    "q"
  );
  assert.match(out, /content fetch failed: HTTP 403/);
});

test("formatCitedResults — shows engines and bestScore tags when present", () => {
  const out = formatCitedResults(
    [
      {
        title: "Doc",
        url: "https://example.org",
        content: "snippet",
        engines: ["google", "bing"],
        bestScore: 0.7654,
      },
    ],
    "q"
  );
  assert.match(out, /\[google, bing\]/);
  assert.match(out, /relevance: 0\.765/);
});

// -- buildCitationLabels --------------------------------------------------

test("buildCitationLabels — strips leading www.", () => {
  const labels = buildCitationLabels([
    { title: "T", url: "https://www.foo.com/x" },
  ]);
  assert.deepEqual(labels, ["foo.com"]);
});

test("buildCitationLabels — keeps subdomains distinct", () => {
  const labels = buildCitationLabels([
    { title: "EN", url: "https://en.wikipedia.org/wiki/Rome" },
    { title: "DE", url: "https://de.wikipedia.org/wiki/Rom" },
  ]);
  assert.deepEqual(labels, ["en.wikipedia.org", "de.wikipedia.org"]);
});

test("buildCitationLabels — disambiguates same hostname with title slug", () => {
  const labels = buildCitationLabels([
    { title: "Article One", url: "https://example.com/1" },
    { title: "Article Two", url: "https://example.com/2" },
  ]);
  assert.deepEqual(labels, [
    "example.com — Article One",
    "example.com — Article Two",
  ]);
});

test("buildCitationLabels — collision suffix when titles are identical", () => {
  const labels = buildCitationLabels([
    { title: "Same", url: "https://example.com/a" },
    { title: "Same", url: "https://example.com/b" },
  ]);
  assert.deepEqual(labels, [
    "example.com — Same",
    "example.com — Same #2",
  ]);
});

test("buildCitationLabels — falls back to path segment when title is empty", () => {
  const labels = buildCitationLabels([
    { title: "", url: "https://example.com/docs/intro" },
    { title: "Other", url: "https://example.com/about" },
  ]);
  // Two results for example.com so disambiguation is required; the first has
  // no title so it falls back to the first path segment ("docs").
  assert.deepEqual(labels, [
    "example.com — docs",
    "example.com — Other",
  ]);
});

test("buildCitationLabels — handles malformed/missing URLs", () => {
  const labels = buildCitationLabels([
    { title: "Lost", url: "" },
    { title: "Also lost", url: undefined },
  ]);
  // Both fall into the "unknown" bucket → disambiguated by slug.
  assert.deepEqual(labels, [
    "unknown — Lost",
    "unknown — Also lost",
  ]);
});

// -- sanitizeSlug ----------------------------------------------------------

test("sanitizeSlug — strips markdown-breaking characters", () => {
  assert.equal(sanitizeSlug("Foo [draft] (v2)"), "Foo draft v2");
  assert.equal(sanitizeSlug("With `code` and | pipe"), "With code and pipe");
});

test("sanitizeSlug — truncates long titles at word boundary with ellipsis", () => {
  const long =
    "This is a fairly long article title that definitely exceeds forty characters somewhere";
  const out = sanitizeSlug(long);
  assert.ok(out.length <= 41, `too long: ${out.length} chars: "${out}"`);
  assert.ok(out.endsWith("…"), "should end with ellipsis when truncated");
  assert.ok(!out.includes("definitely"), "should cut before the overflow word");
});

test("sanitizeSlug — empty or nullish input returns empty string", () => {
  assert.equal(sanitizeSlug(""), "");
  assert.equal(sanitizeSlug(undefined), "");
  assert.equal(sanitizeSlug(null), "");
});

// -- maxChars truncation -------------------------------------------------

test("formatCitedResults — drops tail blocks when total exceeds maxChars but keeps Sources", () => {
  // Five results, each with a long fullContent that would push the output over the cap.
  const big = "X".repeat(2000);
  const results = Array.from({ length: 5 }, (_, i) => ({
    title: `Doc ${i + 1}`,
    url: `https://example${i + 1}.com/page`,
    content: "snippet",
    fullContent: big,
  }));

  const out = formatCitedResults(results, "stress test", { maxChars: 4000 });

  assert.ok(
    out.length <= 4000 + 600, // generous overhead allowance for truncation notice
    `output should respect maxChars budget, got ${out.length}`
  );
  assert.match(out, /output truncated/);
  // Sources block must be present in full — citations are non-negotiable.
  assert.match(out, /### Sources/);
  for (let i = 1; i <= 5; i++) {
    assert.match(
      out,
      new RegExp(`\\(example${i}\\.com\\) \\[Doc ${i}\\]`),
      `source entry for Doc ${i} must survive truncation`
    );
  }
  // Citation instruction must still be present so the LLM knows how to cite.
  assert.match(out, /\[\(label\)\]\(url\)/);
});

test("formatCitedResults — maxChars 0 / unset disables the cap (passthrough)", () => {
  const big = "Y".repeat(50000);
  const out = formatCitedResults(
    [{ title: "Doc", url: "https://example.org", fullContent: big }],
    "q",
    { maxChars: 0 }
  );
  // No truncation marker, full content survives.
  assert.doesNotMatch(out, /output truncated/);
  assert.ok(out.length > 50000, "full content must round-trip when cap disabled");
});
