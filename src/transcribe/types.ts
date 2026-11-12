// The contract every transcription engine implements. `src/core/transcribe.ts`
// owns audio extraction, engine selection, the hook and storage; an engine only
// turns one audio file into timed text.

import type { TranscriptSegment } from "../core/types.js";

export const ENGINE_NAMES = ["whisper-cpp", "openai", "elevenlabs"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export type TranscribeOptions = {
  /** ISO 639-1 hint such as "es". Without it the engine detects the language. */
  language?: string;
};

export type EngineResult = {
  /** ISO 639-1 code when the engine reports one, lowercase. */
  language: string | null;
  /** The whole transcript, trimmed. Empty when nothing is said. */
  text: string;
  /** In order, times in seconds from the start of the audio, text trimmed, no empty segments. */
  segments: TranscriptSegment[];
  /** Model that produced it, e.g. "whisper-1" or "ggml-small.bin". */
  model: string | null;
};

export type Engine = {
  name: EngineName;
  /** False when the audio leaves this machine. */
  local: boolean;
  /** Container the engine wants its audio in. Always mono 16 kHz. */
  audioFormat: "wav" | "flac";
  /** Largest upload the provider accepts, in bytes. Null when there is no limit. */
  maxBytes: number | null;
  /**
   * Transcribes one audio file. Silence or music without speech resolves with
   * empty `text` and no segments; it is not an error. Failures throw `IgError`:
   * AUTH_REQUIRED (missing or rejected key), RATE_LIMITED (429 or quota),
   * NETWORK (unreachable, timeout, 5xx), UPSTREAM_CHANGED (unexpected response
   * shape), BACKEND_UNAVAILABLE (binary or model missing), INVALID_INPUT (the
   * provider rejected the file or a parameter).
   */
  transcribe: (audioPath: string, opts: TranscribeOptions) => Promise<EngineResult>;
};

/** Whether an engine can be used right now, for `ig doctor` and engine selection. */
export type EngineAvailability = {
  name: EngineName;
  usable: boolean;
  local: boolean;
  /** What was found: a path, a model, "OPENAI_API_KEY is set". Never a secret. */
  detail: string;
  /** How to make it usable. Null when it already is. */
  hint: string | null;
};

/** `fetch`, narrowed to what the HTTP engines use, so tests can replace it. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: FormData; signal?: AbortSignal },
) => Promise<Response>;

export type Env = Record<string, string | undefined>;
