import test from "node:test";
import assert from "node:assert/strict";

import { OperationGate } from "../src/core/operation-gate.js";

test("OperationGate allows only one asynchronous user operation at a time", () => {
  const gate = new OperationGate();
  const first = gate.begin("api");

  assert.equal(gate.begin("api"), null);
  assert.equal(gate.isCurrent(first), true);
  assert.equal(gate.kind, "api");

  gate.end(first);
  assert.equal(gate.kind, null);
  assert.notEqual(gate.begin("capture"), null);
});

test("OperationGate invalidates late results after a new conversation", () => {
  const gate = new OperationGate();
  const oldOperation = gate.begin("api");

  gate.invalidate();

  assert.equal(gate.isCurrent(oldOperation), false);
  assert.equal(gate.kind, null);
});
