import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConversationMessages,
  buildChatGptHandoff,
  MAX_SAVED_CONVERSATION_CHARS,
  MAX_SAVED_CONVERSATION_MESSAGE_CHARS,
  normalizeConversationStore,
  SAVED_CONVERSATION_LIMIT,
  upsertConversation,
} from "../src/core/conversation.js";

test("corrupted conversation stores fail visibly instead of becoming empty history", () => {
  for (const store of [null, "broken", { conversations: "broken" }, { conversations: [{ id: "x", messages: null }] }]) {
    assert.throws(() => normalizeConversationStore(store), /對話紀錄/);
  }
  assert.deepEqual(normalizeConversationStore(), { activeConversationId: null, conversations: [] });
});

test("buildConversationMessages keeps prior turns and adds the current request", () => {
  const history = [
    { role: "user", content: "first" },
    { role: "assistant", content: "answer" },
  ];

  const messages = buildConversationMessages({ history, userContent: "second" });

  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /不可信/);
  assert.deepEqual(messages.slice(1), [
    ...history,
    { role: "user", content: "second" },
  ]);
});

test("buildChatGptHandoff preserves structured fields and mentions image attachments", () => {
  const handoff = buildChatGptHandoff({
    payload: {
      user_request: "檢查版面",
      selected_text: "立即購買",
    },
    attachmentCount: 2,
  });

  assert.match(handoff, /"selected_text": "立即購買"/);
  assert.match(handoff, /2 張截圖/);
  assert.doesNotMatch(handoff, /base64/);
});

test("normalizeConversationStore keeps valid text-only conversations in newest-first order", () => {
  const store = normalizeConversationStore({
    activeConversationId: "older",
    conversations: [
      {
        id: "older",
        updatedAt: 10,
        title: "舊對話",
        messages: [
          { role: "user", content: "第一個問題" },
          { role: "assistant", content: "第一個回答" },
          { role: "system", content: "不能帶入歷史對話" },
        ],
      },
      {
        id: "newer",
        updatedAt: 20,
        title: "新對話",
        messages: [{ role: "user", content: "最新問題" }],
      },
    ],
  });

  assert.deepEqual(store, {
    activeConversationId: "older",
    conversations: [
      {
        id: "newer",
        title: "新對話",
        updatedAt: 20,
        messages: [{ role: "user", content: "最新問題" }],
      },
      {
        id: "older",
        title: "舊對話",
        updatedAt: 10,
        messages: [
          { role: "user", content: "第一個問題" },
          { role: "assistant", content: "第一個回答" },
        ],
      },
    ],
  });
});

test("upsertConversation places the current chat first and retains only the latest 25 chats", () => {
  const existing = Array.from({ length: SAVED_CONVERSATION_LIMIT }, (_, index) => ({
    id: `chat-${index}`,
    title: `對話 ${index}`,
    updatedAt: index,
    messages: [{ role: "user", content: `問題 ${index}` }],
  }));

  const store = upsertConversation(
    { activeConversationId: "chat-0", conversations: existing },
    {
      id: "current",
      updatedAt: 100,
      messages: [
        { role: "user", content: "新的問題" },
        { role: "assistant", content: "新的回答" },
      ],
    },
  );

  assert.equal(store.activeConversationId, "current");
  assert.equal(store.conversations.length, SAVED_CONVERSATION_LIMIT);
  assert.equal(store.conversations[0].id, "current");
  assert.equal(store.conversations.at(-1).id, "chat-1");
  assert.equal(store.conversations[0].title, "新的問題");
});

test("normalizeConversationStore bounds saved text so one chat cannot exhaust local storage", () => {
  const longText = "a".repeat(MAX_SAVED_CONVERSATION_MESSAGE_CHARS * 2);
  const store = normalizeConversationStore({
    conversations: [
      {
        id: "large-chat",
        title: "長對話",
        updatedAt: 1,
        messages: [
          { role: "user", content: longText },
          { role: "assistant", content: longText },
          { role: "user", content: longText },
        ],
      },
    ],
  });

  const messages = store.conversations[0].messages;
  assert.ok(messages.every((message) => message.content.length <= MAX_SAVED_CONVERSATION_MESSAGE_CHARS));
  assert.ok(
    messages.reduce((total, message) => total + message.content.length, 0) <=
      MAX_SAVED_CONVERSATION_CHARS,
  );
  assert.match(messages.at(-1).content, /…$/);
});
