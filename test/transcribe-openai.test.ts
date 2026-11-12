import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IgError } from "../src/lib/errors.js";
import {
  createOpenAiEngine,
  OPENAI_MAX_BYTES,
  OPENAI_TRANSCRIBE_URL,
  openaiAvailability,
} from "../src/transcribe/openai.js";
import type { FetchLike } from "../src/transcribe/types.js";

const KEY = "sk-proj-TESTKEY1234567890abcdef";
const env = { OPENAI_API_KEY: KEY };
const whisper = { openaiTranscribeModel: "whisper-1" };

let dir: string;
let audio: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ig-openai-"));
  audio = join(dir, "clip.flac");
  writeFileSync(audio, new Uint8Array([0x66, 0x4c, 0x61, 0x43, 1, 2, 3, 4]));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Call = { url: string; init: Parameters<FetchLike>[1] };

function fake(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const apiError = (status: number, error: Record<string, unknown>) => json({ error }, status);

const seg = (start: number, end: number, text: string, over: Record<string, unknown> = {}) => ({
  id: 0,
  seek: 0,
  start,
  end,
  text,
  tokens: [1, 2],
  temperature: 0,
  avg_logprob: -0.2,
  compression_ratio: 1.1,
  no_speech_prob: 0.01,
  ...over,
});

const verbose = (over: Record<string, unknown> = {}) => ({
  task: "transcribe",
  language: "spanish",
  duration: 6.2,
  text: " Hola a todos. Hoy vamos a cocinar. ",
  segments: [seg(0, 2.5, " Hola a todos."), seg(2.5, 6.2, " Hoy vamos a cocinar. ")],
  usage: { type: "duration", seconds: 7 },
  ...over,
});

async function failure(promise: Promise<unknown>): Promise<IgError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(IgError);
    return err as IgError;
  }
  throw new Error("expected a rejection");
}

/** Everything a caller could print from an error. */
const visible = (err: IgError) =>
  JSON.stringify([err.message, err.hint ?? "", err.details ?? {}, String(err.cause ?? "")]);

describe("openaiAvailability", () => {
  it("is usable when the key is set, without revealing it", () => {
    const a = openaiAvailability(whisper, env);
    expect(a).toEqual({
      name: "openai",
      usable: true,
      local: false,
      detail: "OPENAI_API_KEY is set",
      hint: null,
    });
    expect(JSON.stringify(a)).not.toContain(KEY.slice(0, 6));
  });

  it("is not usable without the key, or with a blank one", () => {
    for (const e of [{}, { OPENAI_API_KEY: "" }, { OPENAI_API_KEY: "  " }]) {
      const a = openaiAvailability(whisper, e);
      expect(a.usable).toBe(false);
      expect(a.detail).toBe("OPENAI_API_KEY is not set");
      expect(a.hint).toContain("OPENAI_API_KEY");
    }
  });
});

describe("createOpenAiEngine", () => {
  it("describes itself", () => {
    const engine = createOpenAiEngine(whisper, env);
    expect(engine.name).toBe("openai");
    expect(engine.local).toBe(false);
    expect(engine.audioFormat).toBe("flac");
    expect(engine.maxBytes).toBe(25 * 1024 * 1024);
    expect(engine.maxBytes).toBe(OPENAI_MAX_BYTES);
  });

  it("posts the file and the fields for segment timestamps", async () => {
    const { calls, fetch } = fake(() => json(verbose()));
    await createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, { language: "ES" });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] as Call;
    expect(url).toBe(OPENAI_TRANSCRIBE_URL);
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe(`Bearer ${KEY}`);
    // fetch must write the multipart boundary itself.
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain("content-type");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const form = init.body;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["segment"]);
    expect(form.get("temperature")).toBe("0");
    expect(form.get("language")).toBe("es");

    const file = form.get("file") as File;
    expect(file.name).toBe("clip.flac");
    expect(file.type).toBe("audio/flac");
    expect(file.size).toBe(8);
    expect(Array.from(new Uint8Array(await file.arrayBuffer())).slice(0, 4)).toEqual([
      0x66, 0x4c, 0x61, 0x43,
    ]);
  });

  it("sends no language when there is no hint", async () => {
    const { calls, fetch } = fake(() => json(verbose()));
    await createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {});
    expect((calls[0] as Call).init.body.has("language")).toBe(false);
  });

  it("maps the response: trimmed text, language name to ISO, the model sent", async () => {
    const { fetch } = fake(() => json(verbose()));
    const result = await createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {});
    expect(result).toEqual({
      language: "es",
      text: "Hola a todos. Hoy vamos a cocinar.",
      segments: [
        { start: 0, end: 2.5, text: "Hola a todos." },
        { start: 2.5, end: 6.2, text: "Hoy vamos a cocinar." },
      ],
      model: "whisper-1",
    });
  });

  it("resolves the language: known name, code, else the hint, else null", async () => {
    const lang = async (reported: unknown, hint?: string) => {
      const { fetch } = fake(() => json(verbose({ language: reported })));
      const r = await createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {
        language: hint,
      });
      return r.language;
    };
    expect(await lang("English")).toBe("en");
    expect(await lang("portuguese", "es")).toBe("pt");
    expect(await lang("pt")).toBe("pt");
    expect(await lang("klingon", "es")).toBe("es");
    expect(await lang("klingon")).toBeNull();
    expect(await lang(undefined, "fr")).toBe("fr");
    expect(await lang(null)).toBeNull();
  });

  it("drops empty segments", async () => {
    const { fetch } = fake(() =>
      json(verbose({ segments: [seg(0, 1, "  "), seg(1, 2, " Hola "), seg(2, 3, "")] })),
    );
    const result = await createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {});
    expect(result.segments).toEqual([{ start: 1, end: 2, text: "Hola" }]);
  });

  it("treats silence as an empty transcript, not an error", async () => {
    for (const body of [
      verbose({ text: "", segments: [] }),
      verbose({ text: "  ", segments: undefined }),
      { text: "" },
    ]) {
      const { fetch } = fake(() => json(body));
      const result = await createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {
        language: "es",
      });
      expect(result.text).toBe("");
      expect(result.segments).toEqual([]);
      expect(result.model).toBe("whisper-1");
    }
  });

  it("drops a segment the API marks as near-certain silence, and its words", async () => {
    const { fetch } = fake(() =>
      json(
        verbose({
          text: " Hola a todos. Gracias por ver el video.",
          segments: [
            seg(0, 2, " Hola a todos."),
            seg(2, 30, " Gracias por ver el video.", { no_speech_prob: 0.97, avg_logprob: -1.4 }),
          ],
        }),
      ),
    );
    const result = await createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {});
    expect(result.segments).toEqual([{ start: 0, end: 2, text: "Hola a todos." }]);
    expect(result.text).toBe("Hola a todos.");
  });

  it("keeps a segment when only one of the two silence signals is present", async () => {
    const { fetch } = fake(() =>
      json(
        verbose({
          text: "uno dos",
          segments: [
            seg(0, 1, "uno", { no_speech_prob: 0.97, avg_logprob: -0.3 }),
            seg(1, 2, "dos", { no_speech_prob: 0.2, avg_logprob: -1.6 }),
          ],
        }),
      ),
    );
    const result = await createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {});
    expect(result.segments.map((s) => s.text)).toEqual(["uno", "dos"]);
    expect(result.text).toBe("uno dos");
  });

  it("uses diarized_json for the diarize model, which has its own timestamps", async () => {
    const { calls, fetch } = fake(() =>
      json({
        task: "transcribe",
        duration: 4,
        text: " Hola. Qué tal. ",
        segments: [
          {
            type: "transcript.text.segment",
            id: "a",
            speaker: "A",
            start: 0,
            end: 1,
            text: " Hola.",
          },
          {
            type: "transcript.text.segment",
            id: "b",
            speaker: "B",
            start: 1,
            end: 4,
            text: " Qué tal. ",
          },
        ],
      }),
    );
    const engine = createOpenAiEngine({ openaiTranscribeModel: "gpt-4o-transcribe-diarize" }, env, {
      fetch,
    });
    const result = await engine.transcribe(audio, { language: "es" });

    const form = (calls[0] as Call).init.body;
    expect(form.get("model")).toBe("gpt-4o-transcribe-diarize");
    expect(form.get("response_format")).toBe("diarized_json");
    expect(form.get("chunking_strategy")).toBe("auto");
    expect(form.has("timestamp_granularities[]")).toBe(false);
    expect(result).toEqual({
      language: "es",
      text: "Hola. Qué tal.",
      segments: [
        { start: 0, end: 1, text: "Hola." },
        { start: 1, end: 4, text: "Qué tal." },
      ],
      model: "gpt-4o-transcribe-diarize",
    });
  });

  it("refuses a model without segment timestamps before any request", async () => {
    for (const model of ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-transcribe"]) {
      const { calls, fetch } = fake(() => json(verbose()));
      const err = await failure(
        createOpenAiEngine({ openaiTranscribeModel: model }, env, { fetch }).transcribe(audio, {}),
      );
      expect(err.code).toBe("UNSUPPORTED");
      expect(err.message).toContain(model);
      expect(err.hint).toContain("ig config set openaiTranscribeModel whisper-1");
      expect(calls).toHaveLength(0);
    }
  });

  it("needs the key before any request", async () => {
    for (const e of [{}, { OPENAI_API_KEY: " " }]) {
      const { calls, fetch } = fake(() => json(verbose()));
      const err = await failure(createOpenAiEngine(whisper, e, { fetch }).transcribe(audio, {}));
      expect(err.code).toBe("AUTH_REQUIRED");
      expect(err.hint).toContain("OPENAI_API_KEY");
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses a file over the limit before any request", async () => {
    const big = join(dir, "big.flac");
    writeFileSync(big, "");
    truncateSync(big, OPENAI_MAX_BYTES + 1);
    const { calls, fetch } = fake(() => json(verbose()));
    const err = await failure(createOpenAiEngine(whisper, env, { fetch }).transcribe(big, {}));
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toContain("25 MB");
    expect(calls).toHaveLength(0);
  });

  it("reports a missing file as invalid input", async () => {
    const { calls, fetch } = fake(() => json(verbose()));
    const err = await failure(
      createOpenAiEngine(whisper, env, { fetch }).transcribe(join(dir, "nope.flac"), {}),
    );
    expect(err.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });

  it("maps 401 and 403 to AUTH_REQUIRED without the provider's echo of the key", async () => {
    for (const status of [401, 403]) {
      const { fetch } = fake(() =>
        apiError(status, {
          message: `Incorrect API key provided: ${KEY.slice(0, 10)}*******cdef. You can find your API key at https://platform.openai.com/account/api-keys.`,
          type: "invalid_request_error",
          code: "invalid_api_key",
        }),
      );
      const err = await failure(createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {}));
      expect(err.code).toBe("AUTH_REQUIRED");
      expect(err.hint).toContain("OPENAI_API_KEY");
      expect(visible(err)).not.toContain("sk-");
    }
  });

  it("maps 429 to RATE_LIMITED and names billing when the quota ran out", async () => {
    const limited = fake(() =>
      apiError(429, {
        message: "Rate limit reached",
        type: "requests",
        code: "rate_limit_exceeded",
      }),
    );
    const a = await failure(
      createOpenAiEngine(whisper, env, { fetch: limited.fetch }).transcribe(audio, {}),
    );
    expect(a.code).toBe("RATE_LIMITED");
    expect(`${a.message} ${a.hint}`).not.toMatch(/quota|billing/i);

    const broke = fake(() =>
      apiError(429, {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      }),
    );
    const b = await failure(
      createOpenAiEngine(whisper, env, { fetch: broke.fetch }).transcribe(audio, {}),
    );
    expect(b.code).toBe("RATE_LIMITED");
    expect(b.message).toMatch(/quota/i);
    expect(b.hint).toMatch(/billing/i);
  });

  it("maps 400, 413 and 415 to INVALID_INPUT with the provider's message, cleaned", async () => {
    for (const status of [400, 413, 415]) {
      const { fetch } = fake(() =>
        apiError(status, {
          message: `Invalid file format.\n\x1b[31mSupported\x1b[0m formats: flac ${KEY} ${"x".repeat(900)}`,
          type: "invalid_request_error",
          code: null,
        }),
      );
      const err = await failure(createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {}));
      expect(err.code).toBe("INVALID_INPUT");
      expect(err.message).toContain("Invalid file format. Supported formats: flac");
      expect(err.message).not.toMatch(/[\n\x1b]/);
      expect(err.message.length).toBeLessThan(400);
      expect(visible(err)).not.toContain(KEY);
      expect(err.details).toMatchObject({ status });
    }
  });

  it("survives an error body that is not JSON", async () => {
    const { fetch } = fake(
      () => new Response("<html>Request Entity Too Large</html>", { status: 413 }),
    );
    const err = await failure(createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {}));
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toContain("HTTP 413");
  });

  it("maps 5xx to NETWORK", async () => {
    for (const status of [500, 502, 503]) {
      const { fetch } = fake(() =>
        apiError(status, { message: "The server had an error", type: "server_error", code: null }),
      );
      const err = await failure(createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {}));
      expect(err.code).toBe("NETWORK");
      expect(err.message).toContain(String(status));
    }
  });

  it("maps a fetch rejection to NETWORK without leaking the key", async () => {
    const { fetch } = fake(() => {
      throw new TypeError(`fetch failed for Bearer ${KEY}`);
    });
    const err = await failure(createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {}));
    expect(err.code).toBe("NETWORK");
    expect(err.message).toContain("fetch failed");
    expect(visible(err)).not.toContain(KEY);
  });

  it("maps a timeout to NETWORK", async () => {
    const { fetch } = fake(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const err = await failure(createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {}));
    expect(err.code).toBe("NETWORK");
    expect(err.message).toMatch(/did not answer within 5 minutes/);
  });

  it("maps a 200 with an unexpected body to UPSTREAM_CHANGED", async () => {
    const bodies: (() => Response)[] = [
      () => new Response("Hola a todos.", { status: 200 }),
      () => json({ segments: [] }),
      () => json(verbose({ segments: [{ start: "0", end: 1, text: "Hola" }] })),
      // Text but no timestamps: useless for the hook, and not what was asked for.
      () => json({ text: "Hola a todos." }),
      () => json(null),
    ];
    for (const respond of bodies) {
      const { fetch } = fake(respond);
      const err = await failure(createOpenAiEngine(whisper, env, { fetch }).transcribe(audio, {}));
      expect(err.code).toBe("UPSTREAM_CHANGED");
      expect(visible(err)).not.toContain(KEY);
    }
  });
});
