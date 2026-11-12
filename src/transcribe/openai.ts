// OpenAI's audio transcription API as a transcription engine. Plain HTTP with
// Node's own fetch, FormData and Blob: no SDK.
//
// Checked on 2026-11-12 against:
//   https://platform.openai.com/docs/api-reference/audio/createTranscription
//   https://developers.openai.com/api/docs/guides/speech-to-text
//     (where platform.openai.com/docs/guides/speech-to-text now redirects)
//   https://github.com/openai/openai-node/blob/master/src/resources/audio/transcriptions.ts
//     (generated from the official OpenAPI spec; the reference page itself
//     answers HTTP 403 to non-browser clients)
//
// What they say, and what this file relies on:
//   - POST https://api.openai.com/v1/audio/transcriptions, multipart/form-data,
//     fields `file`, `model`, `language` (ISO 639-1), `response_format`,
//     `temperature`, `timestamp_granularities[]`, `chunking_strategy`.
//   - "Files can be up to 25 MB. Supported input formats include flac, mp3,
//     mp4, mpeg, mpga, m4a, ogg, wav, and webm." The file part needs "an
//     extension-bearing filename and an appropriate content type".
//   - "The timestamp_granularities[] parameter is only supported for
//     whisper-1", and it needs `response_format=verbose_json`. The response is
//     { language, duration, text, segments?: [{ start, end, text,
//     avg_logprob, no_speech_prob, ... }] }.
//   - gpt-4o-transcribe and gpt-4o-mini-transcribe: "the only supported format
//     is json", which is text without timestamps. gpt-transcribe (the model the
//     guide now recommends) is documented as returning text and detected
//     languages only. None of them can feed the hook, so they are refused.
//   - gpt-4o-transcribe-diarize returns timed segments ({ start, end, text,
//     speaker }) with `response_format=diarized_json`, and needs
//     `chunking_strategy` for audio longer than 30 seconds. It reports no
//     language.
//   - whisper-1, the gpt-4o-* transcription models and the diarize model are
//     all marked deprecated, shutting down on 2027-02-26. Until OpenAI
//     documents timestamps for gpt-transcribe, whisper-1 is still the only
//     plain model that returns segments.
//   - Errors come as { error: { message, type, param, code } }.

import { openAsBlob, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { z } from "zod";
import type { TranscriptSegment } from "../core/types.js";
import { OPENAI_KEY_ENV } from "../lib/config.js";
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

export const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
/** "Files can be up to 25 MB." */
export const OPENAI_MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 5 * 60_000;
const MAX_PROVIDER_MESSAGE = 300;

/**
 * The docs say to treat a segment as silent when `no_speech_prob` is "higher
 * than 1.0" and `avg_logprob` is below -1. A probability never exceeds 1, so
 * that rule as written drops nothing; open-source Whisper uses 0.6. This sits
 * between the two and keeps the logprob condition, so only a segment the model
 * itself calls near-certain silence AND decoded with low confidence is dropped.
 * Real speech over music keeps a low no-speech probability and stays.
 */
const NO_SPEECH_PROB_MIN = 0.9;
const AVG_LOGPROB_MAX = -1;

export type OpenAiConfig = { openaiTranscribeModel: string };
export type OpenAiDeps = { fetch?: FetchLike };

type Mode = "verbose" | "diarized";

/** How to get timed segments out of a model, or null when the docs offer no way. */
function modeFor(model: string): Mode | null {
  if (model === "whisper-1") return "verbose";
  if (model.startsWith("gpt-4o-transcribe-diarize")) return "diarized";
  return null;
}

/** The API identifies the format from the filename and content type of the part. */
const CONTENT_TYPES: Record<string, string> = {
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".mpga": "audio/mpeg",
  ".mpeg": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
};

/**
 * verbose_json names the language in English ("spanish"), not with a code; the
 * docs only type it as a string. Names are Whisper's own. Anything outside this
 * table falls back to the caller's hint.
 */
const LANGUAGE_CODES: Record<string, string> = {
  afrikaans: "af",
  arabic: "ar",
  bengali: "bn",
  bulgarian: "bg",
  catalan: "ca",
  chinese: "zh",
  croatian: "hr",
  czech: "cs",
  danish: "da",
  dutch: "nl",
  english: "en",
  estonian: "et",
  finnish: "fi",
  french: "fr",
  galician: "gl",
  german: "de",
  greek: "el",
  hebrew: "he",
  hindi: "hi",
  hungarian: "hu",
  icelandic: "is",
  indonesian: "id",
  italian: "it",
  japanese: "ja",
  korean: "ko",
  latvian: "lv",
  lithuanian: "lt",
  malay: "ms",
  norwegian: "no",
  persian: "fa",
  polish: "pl",
  portuguese: "pt",
  romanian: "ro",
  russian: "ru",
  serbian: "sr",
  slovak: "sk",
  slovenian: "sl",
  spanish: "es",
  swahili: "sw",
  swedish: "sv",
  tagalog: "tl",
  tamil: "ta",
  thai: "th",
  turkish: "tr",
  ukrainian: "uk",
  urdu: "ur",
  vietnamese: "vi",
  welsh: "cy",
};

function isoLanguage(reported: string | null | undefined, hint: string | undefined): string | null {
  const value = (reported ?? "").trim().toLowerCase();
  const fromName = LANGUAGE_CODES[value];
  if (fromName) return fromName;
  // In case the API starts answering with the code itself.
  if (/^[a-z]{2}$/.test(value)) return value;
  return hint ?? null;
}

// z.object ignores unknown keys, so new fields from the API do not break this.
const VerboseSchema = z.object({
  text: z.string(),
  language: z.string().nullish(),
  segments: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        text: z.string(),
        no_speech_prob: z.number().nullish(),
        avg_logprob: z.number().nullish(),
      }),
    )
    .nullish(),
});

const DiarizedSchema = z.object({
  text: z.string(),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
});

const ErrorBodySchema = z.object({
  error: z.object({
    message: z.string().nullish(),
    type: z.string().nullish(),
    code: z.union([z.string(), z.number()]).nullish(),
  }),
});

const SET_KEY_HINT = `Set ${OPENAI_KEY_ENV} in the environment (https://platform.openai.com/api-keys), or use another engine: \`ig config set transcribeEngine whisper-cpp\`.`;

export function openaiAvailability(_cfg: OpenAiConfig, env: Env): EngineAvailability {
  const usable = Boolean(env[OPENAI_KEY_ENV]?.trim());
  return {
    name: "openai",
    usable,
    local: false,
    detail: `${OPENAI_KEY_ENV} is ${usable ? "set" : "not set"}`,
    hint: usable ? null : SET_KEY_HINT,
  };
}

/**
 * Removes the key, and anything shaped like one, from text that ends up in an
 * error. OpenAI's own 401 message echoes part of the key back.
 */
function scrub(text: string, key: string): string {
  return oneLine(text)
    .split(key)
    .join("[redacted]")
    .replace(/\bsk-[A-Za-z0-9_*.-]{6,}/g, "[redacted]");
}

function unexpected(what: string, cause?: unknown): IgError {
  return new IgError("UPSTREAM_CHANGED", `OpenAI answered with an unexpected body: ${what}.`, {
    hint: "The transcription API may have changed. Try another engine: `ig config set transcribeEngine whisper-cpp`.",
    cause,
  });
}

function clean(segments: { start: number; end: number; text: string }[]): TranscriptSegment[] {
  return segments
    .map((s) => ({ start: s.start, end: Math.max(s.end, s.start), text: s.text.trim() }))
    .filter((s) => s.text !== "");
}

function fromVerbose(body: unknown, model: string, hint: string | undefined): EngineResult {
  const parsed = VerboseSchema.safeParse(body);
  if (!parsed.success) throw unexpected("not a verbose_json transcription", parsed.error);
  const all = parsed.data.segments ?? [];
  const spoken = all.filter(
    (s) =>
      !((s.no_speech_prob ?? 0) > NO_SPEECH_PROB_MIN && (s.avg_logprob ?? 0) < AVG_LOGPROB_MAX),
  );
  const segments = clean(spoken);
  // When a silent segment was dropped, `text` still carries its words: rebuild
  // it so text and segments tell the same story.
  const text =
    spoken.length === all.length ? parsed.data.text.trim() : segments.map((s) => s.text).join(" ");
  if (text !== "" && all.length === 0) throw unexpected("text without segment timestamps");
  return { language: isoLanguage(parsed.data.language, hint), text, segments, model };
}

function fromDiarized(body: unknown, model: string, hint: string | undefined): EngineResult {
  const parsed = DiarizedSchema.safeParse(body);
  if (!parsed.success) throw unexpected("not a diarized_json transcription", parsed.error);
  return {
    language: hint ?? null,
    text: parsed.data.text.trim(),
    segments: clean(parsed.data.segments),
    model,
  };
}

function httpError(status: number, raw: string, model: string, key: string): IgError {
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // A proxy or gateway page; the status alone decides.
  }
  const parsed = ErrorBodySchema.safeParse(json);
  const error = parsed.success ? parsed.data.error : null;
  const code = error?.code == null ? null : scrub(String(error.code), key).slice(0, 80);
  const type = error?.type ? scrub(error.type, key).slice(0, 80) : null;
  const said = error?.message ? scrub(error.message, key).slice(0, MAX_PROVIDER_MESSAGE) : null;
  const details = { status, code, type };

  if (status === 401 || status === 403) {
    // The provider's message is left out on purpose: it quotes part of the key.
    return new IgError("AUTH_REQUIRED", `OpenAI rejected the API key (HTTP ${status}).`, {
      hint: `Check that ${OPENAI_KEY_ENV} holds a valid key with access to audio transcription.`,
      details,
    });
  }
  if (status === 429) {
    const quota = code === "insufficient_quota" || type === "insufficient_quota";
    return new IgError(
      "RATE_LIMITED",
      quota
        ? "The OpenAI account is out of quota (HTTP 429, insufficient_quota)."
        : "OpenAI is rate limiting this key (HTTP 429).",
      {
        hint: quota
          ? "Add credit or raise the limit at https://platform.openai.com/settings/organization/billing, or use the local engine: `ig config set transcribeEngine whisper-cpp`."
          : "Wait a minute before trying again, or use the local engine: `ig config set transcribeEngine whisper-cpp`.",
        details,
      },
    );
  }
  if (status >= 500) {
    return new IgError("NETWORK", `OpenAI failed with HTTP ${status}.`, {
      hint: "This is on OpenAI's side. Try again later; see https://status.openai.com.",
      details,
    });
  }
  const modelProblem = status === 404 || code === "model_not_found";
  return new IgError(
    "INVALID_INPUT",
    `OpenAI rejected the request (HTTP ${status})${said ? `: ${said}` : "."}`,
    {
      hint: modelProblem
        ? `The model "${model}" may not exist for this account. Try \`ig config set openaiTranscribeModel whisper-1\`.`
        : `The audio must be flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav or webm, at most ${OPENAI_MAX_BYTES / 1024 / 1024} MB.`,
      details,
    },
  );
}

export function createOpenAiEngine(cfg: OpenAiConfig, env: Env, deps: OpenAiDeps = {}): Engine {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));

  const transcribe = async (audioPath: string, opts: TranscribeOptions): Promise<EngineResult> => {
    const key = env[OPENAI_KEY_ENV]?.trim();
    if (!key) {
      throw new IgError("AUTH_REQUIRED", `${OPENAI_KEY_ENV} is not set.`, { hint: SET_KEY_HINT });
    }
    const model = cfg.openaiTranscribeModel;
    const mode = modeFor(model);
    if (!mode) {
      // Sending it anyway would either fail or return text with no times, and
      // the hook needs to know what is said in the opening seconds.
      throw new IgError(
        "UNSUPPORTED",
        `The OpenAI model "${oneLine(model)}" does not return segment timestamps.`,
        {
          hint: "Run `ig config set openaiTranscribeModel whisper-1`: it is the model OpenAI documents segment timestamps for.",
        },
      );
    }

    let size: number;
    try {
      size = statSync(audioPath).size;
    } catch (cause) {
      throw new IgError("INVALID_INPUT", `Cannot read the audio file: ${audioPath}`, { cause });
    }
    if (size > OPENAI_MAX_BYTES) {
      throw new IgError(
        "INVALID_INPUT",
        `The audio is ${(size / 1024 / 1024).toFixed(1)} MB; OpenAI accepts at most ${OPENAI_MAX_BYTES / 1024 / 1024} MB.`,
        {
          hint: "Use the local engine for long videos: `ig config set transcribeEngine whisper-cpp`.",
          details: { bytes: size, maxBytes: OPENAI_MAX_BYTES },
        },
      );
    }

    const language = opts.language?.trim().toLowerCase() || undefined;
    const ext = extname(audioPath).toLowerCase();
    const form = new FormData();
    form.append(
      "file",
      await openAsBlob(audioPath, { type: CONTENT_TYPES[ext] ?? "application/octet-stream" }),
      basename(audioPath),
    );
    form.append("model", model);
    if (language) form.append("language", language);
    if (mode === "verbose") {
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      // 0 is not "never vary": the model raises it by itself when a decode fails.
      form.append("temperature", "0");
    } else {
      form.append("response_format", "diarized_json");
      // Required above 30 seconds of audio, harmless below.
      form.append("chunking_strategy", "auto");
    }

    let status: number;
    let raw: string;
    try {
      const res = await doFetch(OPENAI_TRANSCRIBE_URL, {
        method: "POST",
        // No content-type: fetch writes the multipart boundary itself.
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = res.status;
      raw = await res.text();
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "TimeoutError";
      const why = scrub(cause instanceof Error ? cause.message : String(cause), key);
      throw new IgError(
        "NETWORK",
        timedOut
          ? `OpenAI did not answer within ${TIMEOUT_MS / 60_000} minutes.`
          : `Could not reach OpenAI: ${why.slice(0, MAX_PROVIDER_MESSAGE)}`,
        { hint: "Check the connection and try again." },
      );
    }

    if (status < 200 || status >= 300) throw httpError(status, raw, model, key);

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (cause) {
      throw unexpected("not JSON", cause);
    }
    return mode === "verbose"
      ? fromVerbose(body, model, language)
      : fromDiarized(body, model, language);
  };

  return {
    name: "openai",
    local: false,
    audioFormat: "flac",
    maxBytes: OPENAI_MAX_BYTES,
    transcribe,
  };
}
