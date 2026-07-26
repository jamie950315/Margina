import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConversationMessages,
  buildChatGptHandoff,
} from "../src/core/conversation.js";

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
