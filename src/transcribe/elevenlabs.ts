// ElevenLabs speech-to-text (Scribe) as a transcription engine. The API answers
// with word-level timestamps, not sentences, so `groupWords` builds the
// sentence-like segments the rest of the CLI stores.
//
// Checked against the official documentation (November 2026):
//   https://elevenlabs.io/docs/api-reference/speech-to-text/convert
//     POST https://api.elevenlabs.io/v1/speech-to-text, multipart/form-data,
//     header `xi-api-key`. Fields used here: `model_id` (required), `file`,
//     `language_code` (ISO 639-1 or 639-3; omitted = detected),
//     `tag_audio_events`, `diarize`, `timestamps_granularity` (word|character).
//     200 body: { language_code, language_probability, text,
//     words: [{ text, type: word|spacing|audio_event, start, end, logprob }] },
//     or { transcripts: [that, per channel] } when `use_multi_channel` is set,
//     which this engine never sets.
//   https://elevenlabs.io/docs/overview/capabilities/speech-to-text
//     audio/flac is accepted; a file must be under 5 GB and 15 hours.
//   https://elevenlabs.io/docs/overview/models
//     `scribe_v3` is the recommended model for recorded audio, `scribe_v2`
//     remains available, `scribe_v1` is deprecated.
//   https://elevenlabs.io/docs/eleven-api/resources/errors
//     Error body: { detail: { type, code, message, status, request_id } }.
//     `status` is the legacy name of `code`. A 422 from the framework carries
//     `detail` as a list of { loc, msg, type } instead.
//
// The detected `language_code` is documented as "e.g. 'eng'" (ISO 639-3) while
// the example response shows "en", so both forms are accepted and mapped to
// ISO 639-1. The statuses `missing_permissions` and `quota_exceeded` are what
// the API has been seen to answer (with HTTP 401); the error reference lists
// `insufficient_permissions` (403) and `insufficient_credits` (402). All four
// are recognised.

import { openAsBlob, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { z } from "zod";
import type { TranscriptSegment } from "../core/types.js";
import { ELEVENLABS_KEY_ENV } from "../lib/config.js";
import { IgError } from "../lib/errors.js";
import { oneLine } from "../lib/output.js";
import type {
  Engine,
  EngineAvailability,
  EngineResult,
  Env,
  FetchLike,
  TranscribeOptions,
} from "./types.js";

export const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
/** "Under 5.0 GB" in the docs; read as decimal so the check is never too lenient. */
export const ELEVENLABS_MAX_BYTES = 5_000_000_000;

const REQUEST_TIMEOUT_MS = 5 * 60_000;
const MESSAGE_MAX_CHARS = 300;

/** Silence longer than this before a word starts a new segment. */
const GAP_SECONDS = 0.8;
const MAX_SEGMENT_SECONDS = 12;
const MAX_SEGMENT_CHARS = 200;

type ElevenLabsConfig = { elevenlabsTranscribeModel: string };

/** One item of the API's `words` array. Only `word` items carry usable times. */
export type ScribeWord = {
  text: string;
  /** "word", "spacing" or "audio_event". Missing counts as "word". */
  type?: string | null;
  start?: number | null;
  end?: number | null;
};

type Unit = { lead: string; text: string; start: number; end: number };

const CLOSERS = "\"'”’»›)\\]}）］｝」』】〉》";
const SENTENCE_END = new RegExp(`[.!?…。！？｡‼⁇⁈⁉][${CLOSERS}]*$`, "u");
const CLAUSE_END = new RegExp(`[,;:，、；：][${CLOSERS}]*$`, "u");
/** A token made only of closing punctuation, e.g. a quote the API split off. */
const ONLY_CLOSING = new RegExp(`^[${CLOSERS}.!?…。！？｡,;:，、；：]+$`, "u");

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

function joinUnits(units: Unit[]): string {
  return collapse(units.map((u, i) => (i === 0 ? u.text : u.lead + u.text)).join(""));
}

/**
 * Groups word-level output into sentence-like segments. Spacing comes from the
 * API's own `spacing` items and is never invented, so languages written
 * without spaces come out right. Audio events such as "(music)" are dropped.
 */
export function groupWords(words: readonly ScribeWord[]): TranscriptSegment[] {
  const units: Unit[] = [];
  let lead = "";
  let clock = 0;
  for (const word of words) {
    const type = word.type ?? "word";
    if (type === "spacing") {
      lead += word.text;
      continue;
    }
    if (type !== "word") continue;
    if (word.text.trim() === "") {
      lead += word.text;
      continue;
    }
    // A word without times is placed where the previous one ended.
    const start = typeof word.start === "number" ? word.start : clock;
    const end = typeof word.end === "number" ? Math.max(word.end, start) : start;
    clock = end;
    units.push({ lead, text: word.text, start, end });
    lead = "";
  }

  const segments: TranscriptSegment[] = [];
  let current: Unit[] = [];
  const flush = (count = current.length): void => {
    const taken = current.slice(0, count);
    current = current.slice(count);
    const first = taken[0];
    const last = taken[taken.length - 1];
    const text = joinUnits(taken);
    if (first && last && text) segments.push({ start: first.start, end: last.end, text });
  };
  const tooLong = (next: Unit): boolean => {
    const first = current[0];
    if (!first) return false;
    return (
      next.end - first.start > MAX_SEGMENT_SECONDS ||
      joinUnits([...current, next]).length > MAX_SEGMENT_CHARS
    );
  };

  for (const unit of units) {
    const last = current[current.length - 1];
    // Closing punctuation the API split into its own token stays with its sentence.
    if (last && !ONLY_CLOSING.test(unit.text)) {
      // The sentence check waits for the next word so that a detached closing
      // quote is not orphaned. ¿ and ¡ are part of the word that follows them,
      // so they open the next segment and never end this one.
      // Tested on the joined text: the last token may be that detached quote.
      const sentenceEnded = SENTENCE_END.test(joinUnits(current));
      if (sentenceEnded || unit.start - last.end > GAP_SECONDS) flush();
      // Too long: cut at the last comma, or at this word boundary without one.
      while (current.length > 0 && tooLong(unit)) {
        const comma = current.findLastIndex((u) => CLAUSE_END.test(u.text));
        flush(comma === -1 ? current.length : comma + 1);
      }
    }
    current.push(unit);
  }
  flush();
  return segments;
}

/** ISO 639-3 (and the old bibliographic 639-2 forms) to ISO 639-1. */
const ISO_639_1: Record<string, string> = {
  afr: "af",
  ara: "ar",
  aym: "ay",
  ben: "bn",
  bul: "bg",
  cat: "ca",
  ces: "cs",
  cze: "cs",
  cym: "cy",
  wel: "cy",
  dan: "da",
  deu: "de",
  ger: "de",
  ell: "el",
  gre: "el",
  eng: "en",
  spa: "es",
  est: "et",
  eus: "eu",
  baq: "eu",
  fas: "fa",
  per: "fa",
  fin: "fi",
  fra: "fr",
  fre: "fr",
  gle: "ga",
  glg: "gl",
  grn: "gn",
  guj: "gu",
  heb: "he",
  hin: "hi",
  hrv: "hr",
  hun: "hu",
  hye: "hy",
  ind: "id",
  isl: "is",
  ita: "it",
  jpn: "ja",
  kan: "kn",
  kat: "ka",
  kor: "ko",
  lat: "la",
  lav: "lv",
  lit: "lt",
  mal: "ml",
  mar: "mr",
  msa: "ms",
  zsm: "ms",
  may: "ms",
  nld: "nl",
  dut: "nl",
  nor: "no",
  nob: "nb",
  pan: "pa",
  pol: "pl",
  por: "pt",
  que: "qu",
  ron: "ro",
  rum: "ro",
  rus: "ru",
  slk: "sk",
  slv: "sl",
  srp: "sr",
  swa: "sw",
  swe: "sv",
  tam: "ta",
  tel: "te",
  tgl: "tl",
  tha: "th",
  tur: "tr",
  ukr: "uk",
  urd: "ur",
  vie: "vi",
  zho: "zh",
  chi: "zh",
  cmn: "zh",
};

/** "spa" -> "es", "ES" -> "es", "pt-BR" -> "pt". An unknown code is kept, lowercased. */
export function toIso6391(code: string | null | undefined): string | null {
  const raw = (code ?? "").trim().toLowerCase();
  if (!raw) return null;
  const primary = raw.split(/[-_]/)[0] ?? raw;
  if (primary.length === 2) return primary;
  return ISO_639_1[primary] ?? raw;
}

const WordSchema = z.object({
  text: z.string(),
  type: z.string().nullish(),
  start: z.number().nullish(),
  end: z.number().nullish(),
});
const ChunkSchema = z.object({
  language_code: z.string().nullish(),
  words: z.array(WordSchema),
});

/** The single transcript, or the first of the per-channel variant (mono audio has one channel). */
function transcriptOf(body: unknown): unknown {
  const transcripts = (body as { transcripts?: unknown } | null | undefined)?.transcripts;
  return Array.isArray(transcripts) ? transcripts[0] : body;
}

const CONTENT_TYPES: Record<string, string> = {
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".webm": "audio/webm",
};

const keyFrom = (env: Env): string => (env[ELEVENLABS_KEY_ENV] ?? "").trim();

const KEY_HINT = `Set ${ELEVENLABS_KEY_ENV} to an ElevenLabs API key that has the Speech to Text permission.`;
const PERMISSION_HINT = `Enable the Speech to Text permission for the key in the ElevenLabs dashboard (Developers > API Keys > edit the key), or create a key that has it and set ${ELEVENLABS_KEY_ENV}.`;
const OTHER_ENGINE_HINT =
  "or use another engine for now (config key transcribeEngine: whisper-cpp or openai).";

const PERMISSION_STATUSES = new Set(["missing_permissions", "insufficient_permissions"]);
const CREDIT_STATUSES = new Set(["quota_exceeded", "insufficient_credits"]);
const RATE_STATUSES = new Set([
  "rate_limit_exceeded",
  "concurrent_limit_exceeded",
  "too_many_concurrent_requests",
  "system_busy",
]);

type ProviderError = { status: string | null; message: string; requestId: string | null };

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** Reads the three shapes `detail` comes in: an object, a validation list, a string. */
function parseErrorBody(body: string): ProviderError {
  let detail: unknown;
  try {
    const json: unknown = JSON.parse(body);
    detail = json !== null && typeof json === "object" ? (json as { detail?: unknown }).detail : "";
  } catch {
    // Not JSON (a proxy's HTML page, say): too noisy to quote.
    return { status: null, message: "", requestId: null };
  }
  if (typeof detail === "string") return { status: null, message: detail, requestId: null };
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => {
      const row = (item ?? {}) as { loc?: unknown; msg?: unknown };
      const where = Array.isArray(row.loc) ? row.loc.filter((p) => p !== "body").join(".") : "";
      const msg = str(row.msg) ?? "";
      return where && msg ? `${where}: ${msg}` : msg;
    });
    const first = (detail[0] ?? {}) as { type?: unknown };
    return { status: str(first.type), message: parts.filter(Boolean).join("; "), requestId: null };
  }
  if (detail !== null && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    return {
      status: str(d.status) ?? str(d.code),
      message: str(d.message) ?? "",
      requestId: str(d.request_id),
    };
  }
  return { status: null, message: "", requestId: null };
}

/** Provider text is third-party: one line, bounded, and never able to echo the key. */
function quote(text: string, key: string): string {
  const clean = oneLine(key ? text.split(key).join("[redacted]") : text);
  return clean.length > MESSAGE_MAX_CHARS ? `${clean.slice(0, MESSAGE_MAX_CHARS - 1)}…` : clean;
}

function httpError(httpStatus: number, body: string, key: string): IgError {
  const parsed = parseErrorBody(body);
  const said = quote(parsed.message, key);
  const providerStatus = parsed.status ? quote(parsed.status, key) : null;
  const details = { httpStatus, providerStatus, requestId: parsed.requestId };
  const suffix = said ? `: ${said}` : ".";
  const status = (parsed.status ?? "").toLowerCase();

  if (
    PERMISSION_STATUSES.has(status) ||
    ((httpStatus === 401 || httpStatus === 403) && /permission/i.test(parsed.message))
  ) {
    return new IgError(
      "AUTH_REQUIRED",
      "The ElevenLabs API key lacks the Speech to Text permission.",
      {
        hint: PERMISSION_HINT,
        details,
      },
    );
  }
  // The quota answer has come with HTTP 401, so it is checked before the key errors.
  if (CREDIT_STATUSES.has(status) || httpStatus === 402) {
    return new IgError("RATE_LIMITED", `The ElevenLabs account is out of credits${suffix}`, {
      hint: `Add credits or wait for the plan to renew, ${OTHER_ENGINE_HINT}`,
      details,
    });
  }
  if (RATE_STATUSES.has(status) || httpStatus === 429) {
    return new IgError("RATE_LIMITED", `ElevenLabs is rate limiting this key${suffix}`, {
      hint: `Wait a few minutes before transcribing again, ${OTHER_ENGINE_HINT}`,
      details,
    });
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return new IgError(
      "AUTH_REQUIRED",
      `ElevenLabs rejected the API key (HTTP ${httpStatus})${suffix}`,
      {
        hint: KEY_HINT,
        details,
      },
    );
  }
  if (httpStatus >= 500) {
    return new IgError("NETWORK", `ElevenLabs answered HTTP ${httpStatus}${suffix}`, {
      hint: "This is on ElevenLabs' side. Try again in a few minutes.",
      details,
    });
  }
  if ([400, 413, 415, 422].includes(httpStatus)) {
    return new IgError(
      "INVALID_INPUT",
      `ElevenLabs rejected the request (HTTP ${httpStatus})${suffix}`,
      {
        hint: "Check the audio file, the language code and the config key elevenlabsTranscribeModel.",
        details,
      },
    );
  }
  return new IgError("UPSTREAM_CHANGED", `ElevenLabs answered HTTP ${httpStatus}${suffix}`, {
    hint: "The speech-to-text API may have changed. Update ig-cli or use another engine.",
    details,
  });
}

export function elevenlabsAvailability(cfg: ElevenLabsConfig, env: Env): EngineAvailability {
  const usable = keyFrom(env) !== "";
  return {
    name: "elevenlabs",
    usable,
    local: false,
    detail: usable
      ? `${ELEVENLABS_KEY_ENV} is set (model ${cfg.elevenlabsTranscribeModel})`
      : `${ELEVENLABS_KEY_ENV} is not set`,
    hint: usable ? null : KEY_HINT,
  };
}

export function createElevenLabsEngine(
  cfg: ElevenLabsConfig,
  env: Env,
  deps: { fetch?: FetchLike } = {},
): Engine {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const model = cfg.elevenlabsTranscribeModel;

  const transcribe = async (audioPath: string, opts: TranscribeOptions): Promise<EngineResult> => {
    const key = keyFrom(env);
    if (!key) {
      throw new IgError("AUTH_REQUIRED", `${ELEVENLABS_KEY_ENV} is not set.`, { hint: KEY_HINT });
    }

    let size: number;
    try {
      size = statSync(audioPath).size;
    } catch (err) {
      throw new IgError("INVALID_INPUT", `Cannot read the audio file ${audioPath}.`, {
        cause: err,
      });
    }
    if (size === 0) throw new IgError("INVALID_INPUT", `The audio file ${audioPath} is empty.`);
    if (size > ELEVENLABS_MAX_BYTES) {
      throw new IgError(
        "INVALID_INPUT",
        `The audio file is ${size} bytes; ElevenLabs accepts at most ${ELEVENLABS_MAX_BYTES} (5 GB).`,
        { hint: "Transcribe a shorter video, or use the local whisper-cpp engine." },
      );
    }

    const form = new FormData();
    form.set("model_id", model);
    // Speech only: no "(music)" tags, no speaker labels.
    form.set("tag_audio_events", "false");
    form.set("diarize", "false");
    form.set("timestamps_granularity", "word");
    const language = opts.language?.trim().toLowerCase();
    if (language) form.set("language_code", language);
    // A Blob backed by the file, so a large upload is not read into memory first.
    const type = CONTENT_TYPES[extname(audioPath).toLowerCase()] ?? "application/octet-stream";
    form.set("file", await openAsBlob(audioPath, { type }), basename(audioPath));

    let res: Response;
    try {
      res = await doFetch(ELEVENLABS_STT_URL, {
        method: "POST",
        // No content-type: fetch writes the multipart boundary itself.
        headers: { "xi-api-key": key, accept: "application/json" },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      const why = timedOut
        ? `timed out after ${REQUEST_TIMEOUT_MS / 1000} s`
        : `failed: ${quote(err instanceof Error ? err.message : String(err), key)}`;
      throw new IgError("NETWORK", `The request to ElevenLabs ${why}.`, {
        hint: "Check the connection and try again.",
        details: { providerStatus: null },
      });
    }

    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""), key);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const parsed = ChunkSchema.safeParse(transcriptOf(body));
    if (!parsed.success) {
      throw new IgError("UPSTREAM_CHANGED", "ElevenLabs answered with an unexpected body.", {
        hint: "The speech-to-text API may have changed. Update ig-cli or use another engine.",
        details: {
          httpStatus: res.status,
          providerStatus: null,
          issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`),
        },
      });
    }

    const segments = groupWords(parsed.data.words);
    return {
      language: toIso6391(parsed.data.language_code),
      // Built from the segments, not from the API's `text`, so audio events never leak in.
      text: segments.map((s) => s.text).join(" "),
      segments,
      model,
    };
  };

  return {
    name: "elevenlabs",
    local: false,
    audioFormat: "flac",
    maxBytes: ELEVENLABS_MAX_BYTES,
    transcribe,
  };
}
