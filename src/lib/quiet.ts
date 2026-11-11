// Must be the first import of the entry point.
//
// `node:sqlite` emits an ExperimentalWarning on load. It goes to stderr, so it
// never corrupts machine output, but it is noise on every single invocation.
// Only that one warning is dropped; every other warning still surfaces.
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.includes("SQLite is an experimental feature")) return;
  (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
