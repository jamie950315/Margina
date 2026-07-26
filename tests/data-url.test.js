import test from "node:test";
import assert from "node:assert/strict";

import { dataUrlToBlob } from "../src/core/data-url.js";

test("dataUrlToBlob decodes a base64 PNG without asynchronous fetch", async () => {
  const blob = dataUrlToBlob("data:image/png;base64,iVBORw0KGgo=");

  assert.equal(blob.type, "image/png");
  assert.deepEqual(
    Array.from(new Uint8Array(await blob.arrayBuffer())),
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
});

test("dataUrlToBlob decodes URL-encoded text payloads", async () => {
  const blob = dataUrlToBlob("data:text/plain;charset=utf-8,hello%20Safari");

  assert.equal(blob.type, "text/plain");
  assert.equal(await blob.text(), "hello Safari");
});

test("dataUrlToBlob rejects non-data URLs", () => {
  assert.throws(() => dataUrlToBlob("https://example.com/image.png"), /data URL/);
});
