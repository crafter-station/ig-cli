import { IgError } from "../../lib/errors.js";
import type { BackendFactoryDeps, SessionBackend } from "../index.js";

// Placeholder until the real backend lands.
export function createHikerBackend(_deps: BackendFactoryDeps): SessionBackend {
  throw new IgError("NOT_IMPLEMENTED", "The hiker backend is not implemented yet.");
}
