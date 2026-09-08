export class ContextFreshness {
  #revision = -1;
  #fresh = false;

  get revision() {
    return this.#revision;
  }

  get isFresh() {
    return this.#fresh;
  }

  markFresh(revision) {
    assertRevision(revision);
    if (revision < this.#revision) return;
    this.#revision = revision;
    this.#fresh = true;
  }

  invalidate(revision) {
    if (revision === undefined) {
      this.#fresh = false;
      return;
    }
    assertRevision(revision);
    if (revision <= this.#revision) return;
    this.#revision = revision;
    this.#fresh = false;
  }
}

function assertRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("頁面內容版本無效，請重新擷取");
  }
}
