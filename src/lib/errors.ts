// One error type for the whole CLI. Every failure an agent can see has a stable
// `code`, a human `message`, and a `hint` naming the command that fixes it.

export const EXIT = {
  OK: 0,
  /** Unexpected failure: bug, network down, upstream changed shape. */
  SYSTEM: 1,
  /** The caller got something wrong: bad flag, unknown niche, invalid input. */
  USER: 2,
  /** A backend needs credentials or a login it does not have. */
  AUTH: 3,
  /** Instagram or a provider pushed back, or a local budget ran out. Do not retry. */
  BLOCKED: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const ERROR_CODES = {
  INVALID_INPUT: EXIT.USER,
  INVALID_FIELDS: EXIT.USER,
  NOT_FOUND: EXIT.USER,
  ALREADY_EXISTS: EXIT.USER,
  NOT_IMPLEMENTED: EXIT.USER,
  UNSUPPORTED: EXIT.USER,
  FRESH_ENOUGH: EXIT.USER,
  AUTH_REQUIRED: EXIT.AUTH,
  BACKEND_UNAVAILABLE: EXIT.AUTH,
  HALTED: EXIT.BLOCKED,
  RATE_LIMITED: EXIT.BLOCKED,
  CHECKPOINT: EXIT.BLOCKED,
  BUDGET_EXHAUSTED: EXIT.BLOCKED,
  UPSTREAM_CHANGED: EXIT.SYSTEM,
  NETWORK: EXIT.SYSTEM,
  DOWNLOAD_FAILED: EXIT.SYSTEM,
  ANALYSIS_FAILED: EXIT.SYSTEM,
  INTERNAL: EXIT.SYSTEM,
} as const satisfies Record<string, ExitCode>;

export type ErrorCode = keyof typeof ERROR_CODES;

export class IgError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "IgError";
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  get exitCode(): ExitCode {
    return ERROR_CODES[this.code];
  }
}

export function toIgError(err: unknown): IgError {
  if (err instanceof IgError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new IgError("INTERNAL", message, { cause: err });
}
