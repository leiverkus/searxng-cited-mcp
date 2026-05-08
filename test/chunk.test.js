import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, cosine } from "../index.js";

test("chunkText — empty input returns empty array", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   "), []);
});

test("chunkText — short text fits in a single chunk", () => {
  const chunks = chunkText("Hello world.", 500);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "Hello world.");
});

test("chunkText — long text is split into multiple chunks not exceeding size", () => {
  const sentence = "This is a sentence with a few words. ";
  const text = sentence.repeat(50); // ~1850 chars
  const chunks = chunkText(text, 200, 40);
  assert.ok(chunks.length > 1, "must split long input");
  for (const c of chunks) {
    assert.ok(c.length <= 240, `chunk too long: ${c.length}`);
  }
});

test("chunkText — hard-splits a single sentence longer than size", () => {
  const long = "A".repeat(1500);
  const chunks = chunkText(long, 300, 50);
  assert.ok(chunks.length >= 5, "single oversized sentence must be hard-split");
  for (const c of chunks) {
    assert.ok(c.length <= 300, `chunk too long: ${c.length}`);
  }
});

test("cosine — identical normalised vectors give 1", () => {
  const v = new Float32Array([1, 0, 0]);
  assert.equal(cosine(v, v), 1);
});

test("cosine — orthogonal vectors give 0", () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0, 1, 0]);
  assert.equal(cosine(a, b), 0);
});

test("cosine — opposite vectors give -1", () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([-1, 0, 0]);
  assert.equal(cosine(a, b), -1);
});
