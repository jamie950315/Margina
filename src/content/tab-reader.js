import { readPageContext } from "./page-reader.js";
import { locateQuote } from "./reading-tools.js";
import { createLongReader } from "./long-reader.js";

// Isolated-world entrypoint: reading another tab must not open its sidebar.
globalThis.__safaiReadPage = () => readPageContext();
globalThis.__safaiLocateQuote = (source) => {
  try { return locateQuote(source); }
  catch { return { ok: false }; }
};

// Re-injection must not replace an in-flight full-document snapshot.
if (!globalThis.__safaiPrepareLong) {
  const reader = createLongReader();
  globalThis.__safaiPrepareLong = (options) => reader.prepare(options);
  globalThis.__safaiReadLongBatch = (options) => reader.readBatch(options);
  globalThis.__safaiValidateLong = (options) => reader.validate(options);
  globalThis.__safaiReleaseLong = (options) => reader.release(options);
}
