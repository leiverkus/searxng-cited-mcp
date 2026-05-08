import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCitedResults } from "../index.js";

test("formatCitedResults — empty results", () => {
  const out = formatCitedResults([], "anything");
  assert.match(out, /No results found for "anything"/);
});

test("formatCitedResults — basic structure: header, numbered hits, sources block, instruction", () => {
  const out = formatCitedResults(
    [
      { title: "First", url: "https://example.org/a", content: "snippet a" },
      { title: "Second", url: "https://example.org/b", content: "snippet b" },
    ],
    "test query"
  );

  assert.match(out, /## Search results for: "test query"/);
  assert.match(out, /\*\*\[1\] First\*\*/);
  assert.match(out, /\*\*\[2\] Second\*\*/);
  assert.match(out, /https:\/\/example\.org\/a/);
  assert.match(out, /### Sources/);
  assert.match(out, /- \[1\] \[First\]\(https:\/\/example\.org\/a\)/);
  // Citation instruction must guide the model to produce inline [[n]](url) links
  assert.match(out, /\[\[n\]\]\(url\)/);
});

test("formatCitedResults — handles missing fields without throwing", () => {
  const out = formatCitedResults([{}], "x");
  assert.match(out, /\(no title\)/);
  assert.match(out, /### Sources/);
});

test("formatCitedResults — preserves special characters in titles", () => {
  const out = formatCitedResults(
    [{ title: "Foo & Bar [draft]", url: "https://example.org" }],
    "q"
  );
  assert.ok(
    out.includes("Foo & Bar [draft]"),
    "title with brackets and ampersand must round-trip"
  );
});

test("formatCitedResults — emits highlights block when result has highlights", () => {
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
  assert.match(out, /<highlights source="\[1\]">/);
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
  assert.match(out, /<content source="\[1\]">/);
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
