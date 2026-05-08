import { test } from "node:test";
import assert from "node:assert/strict";
import { stripHtmlToText } from "../index.js";

test("stripHtmlToText — strips tags and collapses whitespace", () => {
  const out = stripHtmlToText("<p>Hello <b>world</b></p>\n\n<p>Bye.</p>");
  assert.equal(out, "Hello world Bye.");
});

test("stripHtmlToText — removes script and style content entirely", () => {
  const html = `
    <html>
      <head><style>body { color: red; }</style></head>
      <body>
        <script>alert('xss');</script>
        <p>visible</p>
      </body>
    </html>`;
  const out = stripHtmlToText(html);
  assert.ok(!out.includes("alert"), "script body must be removed");
  assert.ok(!out.includes("color: red"), "style body must be removed");
  assert.ok(out.includes("visible"));
});

test("stripHtmlToText — strips chrome (nav, footer, header, aside, form)", () => {
  const html = `
    <header>NAVIGATION_TOP</header>
    <nav>NAV_LINKS</nav>
    <main><p>real content here</p></main>
    <aside>SIDEBAR_AD</aside>
    <form>SEARCH_BOX</form>
    <footer>FOOTER_LEGAL</footer>`;
  const out = stripHtmlToText(html);
  for (const noise of [
    "NAVIGATION_TOP",
    "NAV_LINKS",
    "SIDEBAR_AD",
    "SEARCH_BOX",
    "FOOTER_LEGAL",
  ]) {
    assert.ok(!out.includes(noise), `should strip ${noise}`);
  }
  assert.ok(out.includes("real content here"));
});

test("stripHtmlToText — decodes common HTML entities", () => {
  const out = stripHtmlToText("Tom &amp; Jerry &lt;3 &quot;cheese&quot;&nbsp;is good");
  assert.ok(out.includes("Tom & Jerry"));
  assert.ok(out.includes("<3"));
  assert.ok(out.includes('"cheese"'));
  assert.ok(out.includes("is good"));
});
