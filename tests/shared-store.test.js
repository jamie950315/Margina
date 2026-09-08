import test from "node:test";
import assert from "node:assert/strict";
import { createSharedStore } from "../src/core/shared-store.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(initial = {}) {
  let data = structuredClone(initial);
  let fail = false;
  const storage = {
    async get(key) {
      const snapshot = structuredClone({ [key]: data[key] });
      await tick();
      return snapshot;
    },
    async set(values) {
      await tick();
      if (fail) { fail = false; throw new Error("storage unavailable"); }
      data = { ...data, ...structuredClone(values) };
    },
  };
  return { store: createSharedStore(storage), failNext: () => { fail = true; } };
}
const message = (content) => ({ role: "user", content });

test("simultaneous settings patches preserve independent fields", async () => {
  const { store } = fixture();
  await Promise.all([
    store.patchSettings({ baseUrl: "https://example.com/v1", model: "new-model" }),
    store.patchSettings({ includePage: false }),
  ]);
  assert.deepEqual(await store.readSettings(), {
    ...DEFAULT_SETTINGS, baseUrl: "https://example.com/v1", model: "new-model", includePage: false,
  });
});

test("simultaneous provider edits reject stale expected values without replacing the newer edit", async () => {
  const { store } = fixture();
  const results = await Promise.allSettled([
    store.patchSettings({ model: "first" }, { model: DEFAULT_SETTINGS.model }),
    store.patchSettings({ model: "second" }, { model: DEFAULT_SETTINGS.model }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].reason.code, "SETTINGS_CONFLICT");
  assert.equal((await store.readSettings()).model, "first");
  await store.patchSettings({ model: "first" }, { model: DEFAULT_SETTINGS.model });
});

test("simultaneous independent conversations are both retained", async () => {
  const { store } = fixture();
  await Promise.all([
    store.appendConversation("a", [message("one")]),
    store.appendConversation("b", [message("two")]),
  ]);
  const saved = await store.readConversations();
  assert.deepEqual(new Set(saved.conversations.map(({ id }) => id)), new Set(["a", "b"]));
});

test("simultaneous appends to one conversation retain both new turns and its original title", async () => {
  const { store } = fixture();
  await store.appendConversation("a", [message("original")]);
  await Promise.all([
    store.appendConversation("a", [message("one")]),
    store.appendConversation("a", [{ role: "assistant", content: "two" }]),
  ]);
  const [saved] = (await store.readConversations()).conversations;
  assert.equal(saved.title, "original");
  assert.deepEqual(saved.messages.map(({ content }) => content), ["original", "one", "two"]);
});

test("selection preserves conversations written by another panel", async () => {
  const { store } = fixture();
  await store.appendConversation("a", [message("original")]);
  await Promise.all([
    store.appendConversation("b", [message("new")]),
    store.selectConversation("a"),
  ]);
  const saved = await store.readConversations();
  assert.equal(saved.activeConversationId, "a");
  assert.equal(saved.conversations.length, 2);
  assert.equal((await store.selectConversation(null)).activeConversationId, null);
  await assert.rejects(store.selectConversation("missing"), /對話/);
});

test("storage failure rejects its caller while the next queued mutation still succeeds", async () => {
  const { store, failNext } = fixture();
  failNext();
  const results = await Promise.allSettled([
    store.patchSettings({ model: "failed" }),
    store.patchSettings({ includePage: false }),
  ]);
  assert.match(results[0].reason.message, /storage unavailable/);
  assert.equal(results[1].status, "fulfilled");
  assert.equal((await store.readSettings()).model, DEFAULT_SETTINGS.model);
  assert.equal((await store.readSettings()).includePage, false);
});

test("invalid mutations and corrupt storage fail without replacing data", async () => {
  const { store } = fixture();
  for (const patch of [null, [], { arbitrary: true }, { stream: "yes" }, { mode: "other" }]) {
    await assert.rejects(store.patchSettings(patch));
  }
  for (const messages of [[], null, [message(5)], [{ role: "system", content: "bad" }]]) {
    await assert.rejects(store.appendConversation("a", messages));
  }
  await assert.rejects(store.appendConversation("", [message("bad")]));
  assert.equal((await store.readConversations()).conversations.length, 0);
  const corrupt = fixture({ settings: null, conversations: null }).store;
  await assert.rejects(corrupt.patchSettings({ model: "new" }));
  await assert.rejects(corrupt.appendConversation("a", [message("new")]));
});

test("appends preserve existing message and conversation limits", async () => {
  const { store } = fixture();
  for (let index = 0; index < 26; index += 1) {
    await store.appendConversation(`chat-${index}`, [message("x".repeat(40_000))]);
  }
  const saved = await store.readConversations();
  assert.equal(saved.conversations.length, 25);
  assert.ok(saved.conversations.every(({ messages }) => messages[0].content.length <= 12_000));
});

test("post-commit permission cleanup completes before the next settings mutation", async () => {
  const { store } = fixture();
  const events = [];
  await Promise.all([
    store.patchSettings({ model: "first" }, {}, async (previous, next) => {
      assert.equal(previous.model, DEFAULT_SETTINGS.model);
      assert.equal(next.model, "first");
      await tick();
      events.push("first cleanup");
    }),
    store.patchSettings({ model: "second" }, {}, async (previous) => {
      assert.equal(previous.model, "first");
      events.push("second cleanup");
    }),
  ]);
  assert.deepEqual(events, ["first cleanup", "second cleanup"]);
});

test("oversized incoming appends fail before writing", async () => {
  const { store } = fixture();
  await assert.rejects(store.appendConversation("a".repeat(129), [message("text")]));
  await assert.rejects(store.appendConversation("a", Array.from({ length: 101 }, () => message("text"))));
  await assert.rejects(store.appendConversation("a", [message("x".repeat(200_001))]));
  assert.equal((await store.readConversations()).conversations.length, 0);
});
