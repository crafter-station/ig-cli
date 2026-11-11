// The only place that talks HTTP to HikerAPI.
//
// Contract, from the provider's documentation (hiker-doc.readthedocs.io,
// "Response Codes", and the OpenAPI document in test/fixtures/hiker):
//   - Auth is the `x-access-key` header.
//   - Billed: 200, 400, 403 and 404. Free: 401, 402, 410, 429, 5xx and
//     /sys/balance.
//   - 403 means "the account, comment or media is private", not a bad key.
//   - 429 is the plan's own per-second limit.
//
// One call here is exactly one upstream request and one `gate.before()`.
// Nothing is retried: a retry is a second billed request the caller did not
// ask for, and after a 429 it is the wrong reflex anyway.

import type { Gate } from "../../core/gate.js";
import { HIKER_KEY_ENV } from "../../lib/config.js";
import { IgError } from "../../lib/errors.js";
import { upstreamChanged } from "./normalize.js";

export const HIKER_BASE_URL = "https://api.hikerapi.com";
export const HIKER_SIGNUP_URL = "https://hikerapi.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const EXCERPT_CHARS = 120;

export type HikerRequest = {
  /** Path only, e.g. "/v1/user/by/username". It is what error messages name. */
  path: string;
  query?: Record<string, string | undefined>;
  /** Message for a 404, written by us. */
  notFound: string;
  /**
   * Message for a 403 when the endpoint reads a target that can be private.
   * Left out for account endpoints, where a 403 can only be about the key.
   */
  privateTarget?: string;
};

export type HikerClientDeps = {
  gate: Gate;
  /** Read on every request so the key is never copied into long-lived state. */
  key: () => string | undefined;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  log?: (message: string) => void;
};

export function missingKeyError(): IgError {
  return new IgError("AUTH_REQUIRED", `The hiker backend needs ${HIKER_KEY_ENV}.`, {
    hint: `Get a key at ${HIKER_SIGNUP_URL} and set the ${HIKER_KEY_ENV} environment variable. Or use \`--backend browser\`.`,
  });
}

/**
 * A short, single-line, printable excerpt of an upstream body for `details`.
 * Upstream text is third-party input: it never goes into `message` or `hint`.
 */
export function excerpt(body: string, secret?: string): string {
  let out = body;
  if (secret) out = out.split(secret).join("[key]");
  out = out
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > EXCERPT_CHARS ? `${out.slice(0, EXCERPT_CHARS)}...` : out;
}

export class HikerClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly deps: HikerClientDeps) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.baseUrl = deps.baseUrl ?? HIKER_BASE_URL;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** One GET. Returns the parsed JSON body of a 2xx, or throws an IgError. */
  async get(request: HikerRequest): Promise<unknown> {
    const key = this.deps.key();
    if (!key) throw missingKeyError();

    const url = new URL(request.path, this.baseUrl);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }

    await this.deps.gate.before();
    this.deps.log?.(`hiker: GET ${request.path}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let body: string;
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { "x-access-key": key, accept: "application/json" },
        signal: controller.signal,
      });
      status = response.status;
      body = await response.text();
    } catch (cause) {
      const timedOut = controller.signal.aborted;
      // The cause is deliberately dropped: some fetch errors echo the request.
      throw new IgError(
        "NETWORK",
        timedOut
          ? `HikerAPI ${request.path} did not answer within ${Math.round(this.timeoutMs / 1000)}s.`
          : `Could not reach HikerAPI for ${request.path}.`,
        {
          hint: "Check the connection and run the command again. It was not retried automatically.",
          details: {
            endpoint: request.path,
            timedOut,
            reason: cause instanceof Error ? cause.name : "unknown",
          },
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if (status >= 200 && status < 300) {
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw upstreamChanged(request.path, "the body is not JSON");
      }
    }
    throw this.failure(request, status, excerpt(body, key));
  }

  private failure(request: HikerRequest, status: number, upstream: string): IgError {
    const endpoint = request.path;
    const details = { endpoint, status, upstream };

    if (status === 429) {
      // Halts the backend and throws. HikerAPI does not bill a 429.
      this.deps.gate.block("RATE_LIMITED", `HikerAPI answered HTTP 429 on ${endpoint}`);
    }
    if (status === 401 || (status === 403 && request.privateTarget === undefined)) {
      return new IgError("AUTH_REQUIRED", `HikerAPI rejected the access key (HTTP ${status}).`, {
        hint: `Check ${HIKER_KEY_ENV}: copy the key again from ${HIKER_SIGNUP_URL}, then run \`ig auth login hiker\`.`,
        details,
      });
    }
    if (status === 403) {
      // Documented meaning of 403 on a data endpoint. It is billed.
      return new IgError("NOT_FOUND", request.privateTarget as string, {
        hint: "HikerAPI only serves public data. The key is fine; this target is private.",
        details: { ...details, reason: "private" },
      });
    }
    if (status === 402) {
      return new IgError(
        "BACKEND_UNAVAILABLE",
        "The HikerAPI account is out of credit (HTTP 402).",
        {
          hint: `Top up at ${HIKER_SIGNUP_URL}, or use \`--backend browser\`.`,
          details,
        },
      );
    }
    if (status === 404) {
      return new IgError("NOT_FOUND", request.notFound, { details });
    }
    if (status === 410) {
      return upstreamChangedWith(endpoint, "the endpoint was retired (HTTP 410)", details);
    }
    if (status === 400 || status === 422) {
      return upstreamChangedWith(endpoint, `the request was refused (HTTP ${status})`, details);
    }
    if (status === 408 || status >= 500) {
      return new IgError("NETWORK", `HikerAPI failed on ${endpoint} (HTTP ${status}).`, {
        hint: "This is on the provider's side and is not billed. Try again later; it was not retried automatically.",
        details,
      });
    }
    return upstreamChangedWith(endpoint, `unexpected HTTP ${status}`, details);
  }
}

function upstreamChangedWith(
  endpoint: string,
  problem: string,
  details: Record<string, unknown>,
): IgError {
  const base = upstreamChanged(endpoint, problem);
  return new IgError(base.code, base.message, {
    hint: base.hint,
    details: { ...details, problem },
  });
}
