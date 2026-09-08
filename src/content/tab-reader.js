import { readPageContext } from "./page-reader.js";
import { locateQuote } from "./reading-tools.js";

// Isolated-world entrypoint: reading another tab must not open its sidebar.
globalThis.__safaiReadPage = () => readPageContext();
globalThis.__safaiLocateQuote = (source) => {
  try { return locateQuote(source); }
  catch { return { ok: false }; }
};
