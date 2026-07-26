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
    const nextRevision = Number.isFinite(Number(revision))
      ? Number(revision)
      : this.#revision + 1;
    if (nextRevision < this.#revision) return;
    this.#revision = nextRevision;
    this.#fresh = true;
  }

  invalidate(revision) {
    const nextRevision = Number.isFinite(Number(revision))
      ? Number(revision)
      : this.#revision + 1;
    if (nextRevision <= this.#revision) return;
    this.#revision = nextRevision;
    this.#fresh = false;
  }
}
