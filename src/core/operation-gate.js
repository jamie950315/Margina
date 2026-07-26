export class OperationGate {
  #sequence = 0;
  #current = null;

  get kind() {
    return this.#current?.kind ?? null;
  }

  begin(kind) {
    if (this.#current) return null;
    const operation = Object.freeze({ id: ++this.#sequence, kind });
    this.#current = operation;
    return operation;
  }

  isCurrent(operation) {
    return Boolean(operation && this.#current?.id === operation.id);
  }

  end(operation) {
    if (this.isCurrent(operation)) this.#current = null;
  }

  invalidate() {
    this.#sequence += 1;
    this.#current = null;
  }
}
