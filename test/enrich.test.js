import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { enrichResultsWithContent } from "../index.js";

// Spins up a tiny HTTP server with two endpoints:
//   /fast  — replies immediately with a short HTML body
//   /slow  — sleeps `slowMs` before replying (used to force a budget overrun)
function startTestServer({ slowMs }) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      if (req.url === "/fast") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          "<html><body><article>" +
            "Fast endpoint reply with enough text to pass the Readability 200-char " +
            "minimum so the extractor doesn't fall back to regex. ".repeat(6) +
            "</article></body></html>"
        );
        return;
      }
      if (req.url === "/slow") {
        const timer = setTimeout(() => {
          if (res.writableEnded) return;
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<html><body>slow body</body></html>");
        }, slowMs);
        req.on("close", () => clearTimeout(timer));
        return;
      }
      res.writeHead(404).end();
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

test("enrichResultsWithContent — aborts hung fetch on budget overrun, lets fast fetch through", async () => {
  const srv = await startTestServer({ slowMs: 5000 });
  try {
    const results = [
      { title: "Fast", url: `${srv.baseUrl}/fast` },
      { title: "Slow", url: `${srv.baseUrl}/slow` },
    ];
    const t0 = Date.now();
    const out = await enrichResultsWithContent(results, {
      topN: 2,
      maxLength: 5000,
      query: "test",
      highlights: false, // skip embedder so the assertion stays focused on fetch budgeting
      budgetMs: 300,
      fetchTimeoutMs: 10000, // make sure the budget (not per-fetch timeout) is what fires
    });
    const elapsed = Date.now() - t0;

    assert.ok(
      elapsed < 2500,
      `should return shortly after the 300ms budget, took ${elapsed}ms`
    );

    const fast = out.find((r) => r.title === "Fast");
    const slow = out.find((r) => r.title === "Slow");

    assert.ok(fast.fullContent, "fast result should have fullContent");
    assert.ok(!slow.fullContent, "slow result must not have fullContent");
    assert.ok(slow.fetchError, "slow result should have a fetchError");
    assert.match(
      slow.fetchError,
      /budget exceeded/i,
      `slow fetchError should mention budget, got: ${slow.fetchError}`
    );
  } finally {
    await srv.close();
  }
});

test("enrichResultsWithContent — no budget overrun: both fetches succeed", async () => {
  const srv = await startTestServer({ slowMs: 50 });
  try {
    const results = [
      { title: "A", url: `${srv.baseUrl}/fast` },
      { title: "B", url: `${srv.baseUrl}/slow` },
    ];
    const out = await enrichResultsWithContent(results, {
      topN: 2,
      maxLength: 5000,
      query: "test",
      highlights: false,
      budgetMs: 5000,
      fetchTimeoutMs: 5000,
    });

    assert.ok(out[0].fullContent, "result A should have content");
    assert.ok(out[1].fullContent, "result B should have content");
    assert.ok(!out[0].fetchError);
    assert.ok(!out[1].fetchError);
  } finally {
    await srv.close();
  }
});
