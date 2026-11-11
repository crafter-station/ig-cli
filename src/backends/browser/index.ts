import { IgError } from "../../lib/errors.js";
import type { BackendFactoryDeps, SessionBackend } from "../index.js";

// Placeholder until the real backend lands.
export function createBrowserBackend(_deps: BackendFactoryDeps): SessionBackend {
  throw new IgError("NOT_IMPLEMENTED", "The browser backend is not implemented yet.");
}
