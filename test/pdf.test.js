import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { enrichResultsWithContent } from "../index.js";

// Minimal end-to-end test: serve `application/pdf` with a body that pdf-parse
// cannot decode, and assert that the result is marked `failed_pdf` instead of
// silently coming back empty. The success path (real PDF → extracted text) is
// validated manually via smoke test against a known publisher URL — embedding
// a valid PDF fixture in the repo is intentionally out of scope for unit tests.

function startTestServer({ body, contentType }) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.writeHead(200, { "content-type": contentType });
      res.end(body);
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

test("fetchUrlContent (via enrich) — garbage application/pdf body → content_extraction=failed_pdf", async () => {
  const srv = await startTestServer({
    body: Buffer.from("not a real pdf"),
    contentType: "application/pdf",
  });
  try {
    const out = await enrichResultsWithContent(
      [{ title: "Doc", url: `${srv.baseUrl}/whatever` }],
      {
        topN: 1,
        maxLength: 5000,
        query: "test",
        highlights: false,
        budgetMs: 8000,
        fetchTimeoutMs: 5000,
      }
    );
    assert.equal(out[0].content_extraction, "failed_pdf");
    assert.equal(out[0].content_type, "application/pdf");
    assert.ok(!out[0].fullContent, "no fullContent when extraction failed");
  } finally {
    await srv.close();
  }
});

test("fetchUrlContent (via enrich) — html response → content_extraction=ok and content_type set", async () => {
  const html =
    "<html><body><article>" +
    "Standard html body with enough words to clear the Readability 200-char minimum. ".repeat(
      6
    ) +
    "</article></body></html>";
  const srv = await startTestServer({
    body: html,
    contentType: "text/html; charset=utf-8",
  });
  try {
    const out = await enrichResultsWithContent(
      [{ title: "Doc", url: `${srv.baseUrl}/page` }],
      {
        topN: 1,
        maxLength: 5000,
        query: "test",
        highlights: false,
        budgetMs: 8000,
        fetchTimeoutMs: 5000,
      }
    );
    assert.equal(out[0].content_extraction, "ok");
    assert.match(out[0].content_type, /text\/html/);
    assert.ok(out[0].fullContent, "fullContent should be set on success");
  } finally {
    await srv.close();
  }
});
