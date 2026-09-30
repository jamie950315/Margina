import test from "node:test";
import assert from "node:assert/strict";
import { handleConversationPageKey } from "../src/background/conversation-page-key.js";

const api = { runtime: { id: "extension" }, tabs: { get: async () => ({ id: 7, url: "https://example.com/watch?v=A#part" }) } };
const sender = { id: "extension", frameId: 0, url: "https://example.com/watch?v=A#part", tab: { id: 7, url: "https://example.com/watch?v=A#part" } };

test("page keys survive reloads and distinguish query/hash pages without returning URLs", async () => {
  const request = { type: "GET_CONVERSATION_PAGE_KEY", url: sender.url };
  const first = await handleConversationPageKey(request, sender, api);
  assert.equal(first.ok, true);
  assert.match(first.pageKey, /^page:[a-f0-9]{64}$/);
  assert.deepEqual(await handleConversationPageKey(request, sender, api), first);
  for (const url of ["https://example.com/watch?v=B#part", "https://example.com/watch?v=A#other"]) {
    const changed = await handleConversationPageKey({ ...request, url }, { ...sender, url, tab: { id: 7, url } },
      { ...api, tabs: { get: async () => ({ id: 7, url }) } });
    assert.equal(changed.ok, true);
    assert.notEqual(changed.pageKey, first.pageKey);
  }
  assert.doesNotMatch(JSON.stringify(first), /example|watch|part|v=A/);
});

test("page key requests reject foreign senders, private tabs and stale navigation", async () => {
  const request = { type: "GET_CONVERSATION_PAGE_KEY", url: sender.url };
  for (const invalid of [{}, { ...sender, id: "other" }, { ...sender, frameId: 1 },
    { ...sender, tab: { ...sender.tab, incognito: true } }, { ...sender, url: "https://other.example/" }]) {
    assert.equal((await handleConversationPageKey(request, invalid, api)).ok, false);
  }
  assert.equal((await handleConversationPageKey(request, sender,
    { ...api, tabs: { get: async () => ({ id: 7, url: "https://example.com/new" }) } })).ok, false);
  assert.equal(handleConversationPageKey({ type: "OTHER" }, sender, api), undefined);
});
