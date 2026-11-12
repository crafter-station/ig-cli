import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IgError } from "../src/lib/errors.js";
import {
  createElevenLabsEngine,
  ELEVENLABS_MAX_BYTES,
  ELEVENLABS_STT_URL,
  elevenlabsAvailability,
  groupWords,
  type ScribeWord,
  toIso6391,
} from "../src/transcribe/elevenlabs.js";
import type { FetchLike } from "../src/transcribe/types.js";

// Only the size of "huge.flac" is faked: nobody wants a real 5 GB fixture.
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: (path: string, ...rest: unknown[]) => {
      const stat = (actual.statSync as (...args: unknown[]) => { size: number })(path, ...rest);
      if (String(path).endsWith("huge.flac")) return { ...stat, size: 5_000_000_001 };
      return stat;
    },
  };
});

const KEY = "sk_test_SECRET_abc123";
const cfg = { elevenlabsTranscribeModel: "scribe_v3" };
const env = { ELEVENLABS_API_KEY: KEY };
const AUDIO = Buffer.from("fLaC-not-really-audio");

let dir: string;
let audio: string;
let huge: string;
let empty: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ig-elevenlabs-"));
  audio = join(dir, "reel.flac");
  huge = join(dir, "huge.flac");
  empty = join(dir, "empty.flac");
  writeFileSync(audio, AUDIO);
  writeFileSync(huge, AUDIO);
  writeFileSync(empty, "");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const w = (text: string, start: number, end: number): ScribeWord => ({
  text,
  type: "word",
  start,
  end,
});
const sp = (text = " "): ScribeWord => ({ text, type: "spacing" });
const ev = (text: string, start: number, end: number): ScribeWord => ({
  text,
  type: "audio_event",
  start,
  end,
});

/** Words 0.3 s long, 0.1 s apart, with a spacing item between them. */
function say(sentence: string, from = 0): ScribeWord[] {
  const out: ScribeWord[] = [];
  let t = from;
  for (const [i, text] of sentence.split(" ").entries()) {
    if (i > 0) out.push(sp());
    out.push(w(text, t, Math.round((t + 0.3) * 10) / 10));
    t = Math.round((t + 0.4) * 10) / 10;
  }
  return out;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type Call = { url: string; init: Parameters<FetchLike>[1] };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, fetch };
}

async function failure(promise: Promise<unknown>): Promise<IgError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(IgError);
    const e = err as IgError;
    // Whatever went wrong, the key is never part of what the user sees.
    expect(JSON.stringify([e.message, e.hint, e.details])).not.toContain(KEY);
    return e;
  }
  throw new Error("expected the call to throw");
}

const failWith = (status: number, body: unknown, path = audio): Promise<IgError> => {
  const { fetch } = fakeFetch(() =>
    typeof body === "string" ? new Response(body, { status }) : json(body, status),
  );
  return failure(createElevenLabsEngine(cfg, env, { fetch }).transcribe(path, {}));
};

describe("groupWords", () => {
  it("returns nothing for no words", () => {
    expect(groupWords([])).toEqual([]);
    expect(groupWords([sp(), ev("(music)", 0, 4), sp()])).toEqual([]);
    expect(groupWords([w("  ", 0, 1)])).toEqual([]);
  });

  it("ends a segment after sentence punctuation", () => {
    const words = [...say("Hello there. How are you? Fine!"), sp(), ...say("Bye…", 3)];
    expect(groupWords(words)).toEqual([
      { start: 0, end: 0.7, text: "Hello there." },
      { start: 0.8, end: 1.9, text: "How are you?" },
      { start: 2, end: 2.3, text: "Fine!" },
      { start: 3, end: 3.3, text: "Bye…" },
    ]);
  });

  it("treats punctuation followed by a closing quote or bracket as a sentence end", () => {
    const segments = groupWords(say('He said "stop." (Really?) Then left'));
    expect(segments.map((s) => s.text)).toEqual(['He said "stop."', "(Really?)", "Then left"]);
  });

  it("keeps a detached closing quote with its sentence", () => {
    const words = [w("«Vale.", 0, 0.4), w("»", 0.4, 0.4), sp(), w("Sigo", 0.5, 0.8)];
    expect(groupWords(words).map((s) => s.text)).toEqual(["«Vale.»", "Sigo"]);
  });

  it("does not split on a dot inside a word", () => {
    expect(groupWords(say("It costs 3.5 dollars")).map((s) => s.text)).toEqual([
      "It costs 3.5 dollars",
    ]);
  });

  it("starts a new segment after a long silence", () => {
    const words = [...say("one two"), sp(), w("three", 1.6, 1.9), sp(), w("four", 2.6, 2.9)];
    expect(groupWords(words)).toEqual([
      { start: 0, end: 0.7, text: "one two" },
      { start: 1.6, end: 2.9, text: "three four" },
    ]);
  });

  it("breaks an overlong segment at the last comma", () => {
    // 4 s per word: "uno dos, tres" spans 12 s, the fourth word would make 16 s.
    const words = [
      w("uno", 0, 3.9),
      sp(),
      w("dos,", 4, 7.9),
      sp(),
      w("tres", 8, 11.9),
      sp(),
      w("cuatro", 12, 15.9),
    ];
    expect(groupWords(words)).toEqual([
      { start: 0, end: 7.9, text: "uno dos," },
      { start: 8, end: 15.9, text: "tres cuatro" },
    ]);
  });

  it("breaks an overlong segment at the word boundary without a comma", () => {
    const words = [w("uno", 0, 5.9), sp(), w("dos", 6, 11.9), sp(), w("tres", 12, 13)];
    expect(groupWords(words)).toEqual([
      { start: 0, end: 11.9, text: "uno dos" },
      { start: 12, end: 13, text: "tres" },
    ]);
  });

  it("keeps segments under about 200 characters when speech is fast", () => {
    // 60 ten-letter words in 6 s: far under 12 s, far over 200 characters.
    const words: ScribeWord[] = [];
    for (let i = 0; i < 60; i++) {
      if (i > 0) words.push(sp());
      words.push(w("abcdefghij", i * 0.1, i * 0.1 + 0.09));
    }
    const segments = groupWords(words);
    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) expect(s.text.length).toBeLessThanOrEqual(200);
    expect(segments.map((s) => s.text).join(" ")).toBe(Array(60).fill("abcdefghij").join(" "));
    expect(segments[0]?.start).toBe(0);
    expect(segments.at(-1)?.end).toBeCloseTo(5.99);
  });

  it("keeps a single word longer than the maximum", () => {
    expect(groupWords([w("a".repeat(250), 0, 20)])).toHaveLength(1);
  });

  it("drops audio events and takes no time from them", () => {
    const words = [
      ev("(music)", 0, 2),
      sp(),
      w("Hola", 2.1, 2.4),
      sp(),
      ev("(laughter)", 2.4, 2.6),
      sp(),
      w("mundo.", 2.7, 3),
      sp(),
      ev("(applause)", 3, 9),
    ];
    expect(groupWords(words)).toEqual([{ start: 2.1, end: 3, text: "Hola mundo." }]);
  });

  it("keeps ¿ and ¡ attached to the sentence they open", () => {
    const segments = groupWords(say("Hola. ¿Cómo estás? ¡Qué bien! Vamos"));
    expect(segments.map((s) => s.text)).toEqual(["Hola.", "¿Cómo estás?", "¡Qué bien!", "Vamos"]);
  });

  it("does not invent spaces in a language written without them", () => {
    const words = [
      w("こんにちは", 0, 0.5),
      w("世界", 0.5, 0.9),
      w("。", 0.9, 0.9),
      w("元気", 1, 1.3),
      w("ですか", 1.3, 1.6),
      w("？", 1.6, 1.6),
    ];
    expect(groupWords(words)).toEqual([
      { start: 0, end: 0.9, text: "こんにちは世界。" },
      { start: 1, end: 1.6, text: "元気ですか？" },
    ]);
    expect(groupWords([w("你好。", 0, 0.5), w("再见", 0.6, 1)]).map((s) => s.text)).toEqual([
      "你好。",
      "再见",
    ]);
  });

  it("collapses and trims whitespace", () => {
    const words = [sp("  "), w("uno", 0, 0.3), sp(" \n "), sp(" "), w("dos", 0.4, 0.7), sp("  ")];
    expect(groupWords(words)).toEqual([{ start: 0, end: 0.7, text: "uno dos" }]);
  });

  it("treats a missing type as a word and tolerates missing times", () => {
    const words: ScribeWord[] = [
      { text: "uno", start: 1, end: 1.3 },
      sp(),
      { text: "dos", type: "word", start: null, end: null },
    ];
    expect(groupWords(words)).toEqual([{ start: 1, end: 1.3, text: "uno dos" }]);
  });
});

describe("toIso6391", () => {
  it("maps ISO 639-3 to ISO 639-1 and keeps unknown codes lowercase", () => {
    expect(toIso6391("spa")).toBe("es");
    expect(toIso6391("ENG")).toBe("en");
    expect(toIso6391("es")).toBe("es");
    expect(toIso6391("pt-BR")).toBe("pt");
    expect(toIso6391("YUE")).toBe("yue");
    expect(toIso6391("")).toBeNull();
    expect(toIso6391(null)).toBeNull();
  });
});

describe("elevenlabsAvailability", () => {
  it("is usable when the key is set, without revealing it", () => {
    const a = elevenlabsAvailability(cfg, env);
    expect(a).toMatchObject({ name: "elevenlabs", usable: true, local: false, hint: null });
    expect(a.detail).toContain("ELEVENLABS_API_KEY is set");
    expect(JSON.stringify(a)).not.toContain(KEY);
    expect(JSON.stringify(a)).not.toContain(KEY.slice(0, 6));
  });

  it("is not usable without the key, or with a blank one", () => {
    for (const e of [{}, { ELEVENLABS_API_KEY: "" }, { ELEVENLABS_API_KEY: "   " }]) {
      const a = elevenlabsAvailability(cfg, e);
      expect(a.usable).toBe(false);
      expect(a.detail).toBe("ELEVENLABS_API_KEY is not set");
      expect(a.hint).toContain("ELEVENLABS_API_KEY");
    }
  });
});

describe("createElevenLabsEngine", () => {
  it("describes itself", () => {
    const engine = createElevenLabsEngine(cfg, env);
    expect(engine).toMatchObject({
      name: "elevenlabs",
      local: false,
      audioFormat: "flac",
      maxBytes: ELEVENLABS_MAX_BYTES,
    });
  });

  it("posts the file as multipart with speech-only options", async () => {
    const { calls, fetch } = fakeFetch(() =>
      json({ language_code: "spa", language_probability: 0.99, text: "", words: [] }),
    );
    await createElevenLabsEngine(cfg, env, { fetch }).transcribe(audio, { language: "ES" });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] as Call;
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(url).toBe(ELEVENLABS_STT_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["xi-api-key"]).toBe(KEY);
    // fetch must write the multipart boundary itself.
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain("content-type");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const form = init.body;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model_id")).toBe("scribe_v3");
    expect(form.get("language_code")).toBe("es");
    expect(form.get("tag_audio_events")).toBe("false");
    expect(form.get("diarize")).toBe("false");
    expect(form.get("timestamps_granularity")).toBe("word");
    const file = form.get("file") as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("reel.flac");
    expect(file.type).toBe("audio/flac");
    expect(Buffer.from(await file.arrayBuffer()).equals(AUDIO)).toBe(true);
  });

  it("omits language_code without a hint", async () => {
    const { calls, fetch } = fakeFetch(() => json({ language_code: "eng", text: "", words: [] }));
    await createElevenLabsEngine(cfg, env, { fetch }).transcribe(audio, {});
    expect(calls[0]?.init.body.has("language_code")).toBe(false);
  });

  it("maps the answer to segments, text, language and model", async () => {
    const { fetch } = fakeFetch(() =>
      json({
        language_code: "spa",
        language_probability: 0.98,
        text: "(música) ¿Qué tal? Todo bien.",
        words: [
          { text: "(música)", type: "audio_event", start: 0, end: 1.5, logprob: 0 },
          { text: " ", type: "spacing", start: 1.5, end: 1.6, logprob: 0 },
          { text: "¿Qué", type: "word", start: 1.6, end: 1.8, logprob: -0.1 },
          { text: " ", type: "spacing", start: 1.8, end: 1.9, logprob: 0 },
          { text: "tal?", type: "word", start: 1.9, end: 2.2, logprob: -0.1 },
          { text: " ", type: "spacing", start: 2.2, end: 2.3, logprob: 0 },
          { text: "Todo", type: "word", start: 2.3, end: 2.6, logprob: -0.1 },
          { text: " ", type: "spacing", start: 2.6, end: 2.7, logprob: 0 },
          { text: "bien.", type: "word", start: 2.7, end: 3.1, logprob: -0.1 },
        ],
      }),
    );
    const result = await createElevenLabsEngine(cfg, env, { fetch }).transcribe(audio, {});
    expect(result).toEqual({
      language: "es",
      text: "¿Qué tal? Todo bien.",
      segments: [
        { start: 1.6, end: 2.2, text: "¿Qué tal?" },
        { start: 2.3, end: 3.1, text: "Todo bien." },
      ],
      model: "scribe_v3",
    });
  });

  it("resolves empty for silence or music", async () => {
    const answers = [
      { language_code: "eng", language_probability: 0.1, text: "", words: [] },
      {
        language_code: null,
        text: "(music)",
        words: [{ text: "(music)", type: "audio_event", start: 0, end: 9 }],
      },
    ];
    for (const answer of answers) {
      const { fetch } = fakeFetch(() => json(answer));
      const result = await createElevenLabsEngine(cfg, env, { fetch }).transcribe(audio, {});
      expect(result.text).toBe("");
      expect(result.segments).toEqual([]);
      expect(result.model).toBe("scribe_v3");
    }
  });

  it("reads the multichannel variant", async () => {
    const { fetch } = fakeFetch(() =>
      json({
        transcripts: [
          { language_code: "en", text: "Hi.", channel_index: 0, words: [w("Hi.", 0, 0.4)] },
        ],
      }),
    );
    const result = await createElevenLabsEngine(cfg, env, { fetch }).transcribe(audio, {});
    expect(result).toMatchObject({ language: "en", text: "Hi." });
  });

  it("fails with AUTH_REQUIRED and no request when the key is missing", async () => {
    const { calls, fetch } = fakeFetch(() => json({}));
    const err = await failure(createElevenLabsEngine(cfg, {}, { fetch }).transcribe(audio, {}));
    expect(err.code).toBe("AUTH_REQUIRED");
    expect(err.hint).toContain("ELEVENLABS_API_KEY");
    expect(calls).toHaveLength(0);
  });

  it("rejects a file over the limit before any request", async () => {
    const { calls, fetch } = fakeFetch(() => json({}));
    const engine = createElevenLabsEngine(cfg, env, { fetch });
    const err = await failure(engine.transcribe(huge, {}));
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toContain("5 GB");
    expect(calls).toHaveLength(0);
  });

  it("rejects a missing or empty file before any request", async () => {
    const { calls, fetch } = fakeFetch(() => json({}));
    const engine = createElevenLabsEngine(cfg, env, { fetch });
    expect((await failure(engine.transcribe(join(dir, "nope.flac"), {}))).code).toBe(
      "INVALID_INPUT",
    );
    expect((await failure(engine.transcribe(empty, {}))).code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });

  it("maps a rejected key to AUTH_REQUIRED", async () => {
    const err = await failWith(401, {
      detail: { status: "invalid_api_key", message: `Invalid API key ${KEY}` },
    });
    expect(err.code).toBe("AUTH_REQUIRED");
    expect(err.message).toContain("[redacted]");
    expect(err.details).toMatchObject({ httpStatus: 401, providerStatus: "invalid_api_key" });
    expect((await failWith(403, { detail: { code: "forbidden", message: "No" } })).code).toBe(
      "AUTH_REQUIRED",
    );
  });

  it("says so when the key lacks the speech-to-text permission", async () => {
    const bodies: [number, unknown][] = [
      [
        401,
        {
          detail: {
            status: "missing_permissions",
            message:
              "The API key you used is missing the permission speech_to_text to execute this operation.",
          },
        },
      ],
      [
        403,
        {
          detail: {
            type: "authorization_error",
            code: "insufficient_permissions",
            status: "insufficient_permissions",
            message: "Not allowed.",
            request_id: "req_1",
          },
        },
      ],
      [401, { detail: { status: "unauthorized", message: "Missing permission speech_to_text" } }],
    ];
    for (const [status, body] of bodies) {
      const err = await failWith(status, body);
      expect(err.code).toBe("AUTH_REQUIRED");
      expect(err.message).toBe("The ElevenLabs API key lacks the Speech to Text permission.");
      expect(err.hint).toContain("Enable the Speech to Text permission for the key");
      expect(err.hint).toContain("ElevenLabs dashboard");
      expect(err.details?.providerStatus).toBe(
        (body as { detail: { status: string } }).detail.status,
      );
    }
  });

  it("maps 429 and quota statuses to RATE_LIMITED", async () => {
    const cases: [number, string][] = [
      [429, "rate_limit_exceeded"],
      [429, "concurrent_limit_exceeded"],
      [429, "system_busy"],
      // The quota answer has been seen with HTTP 401.
      [401, "quota_exceeded"],
      [402, "insufficient_credits"],
    ];
    for (const [status, providerStatus] of cases) {
      const err = await failWith(status, { detail: { status: providerStatus, message: "Slow." } });
      expect(err.code).toBe("RATE_LIMITED");
      expect(err.details).toMatchObject({ httpStatus: status, providerStatus });
      expect(err.hint).toBeTruthy();
    }
    expect((await failWith(429, "")).code).toBe("RATE_LIMITED");
  });

  it("maps a rejected file or parameter to INVALID_INPUT with the provider's message", async () => {
    const long = `bad\u001b[31m file\n${"x".repeat(500)}`;
    for (const status of [400, 413, 415, 422]) {
      const err = await failWith(status, { detail: { status: "invalid_audio", message: long } });
      expect(err.code).toBe("INVALID_INPUT");
      expect(err.message).toContain("bad file x");
      expect(err.message).not.toMatch(/[\u001b\n]/);
      expect(err.message.length).toBeLessThan(400);
      expect(err.details?.providerStatus).toBe("invalid_audio");
    }
  });

  it("reads a validation list in a 422", async () => {
    const err = await failWith(422, {
      detail: [{ loc: ["body", "model_id"], msg: "Field required", type: "missing" }],
    });
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toContain("model_id: Field required");
    expect(err.details?.providerStatus).toBe("missing");
  });

  it("maps 5xx to NETWORK", async () => {
    const err = await failWith(503, {
      detail: { status: "service_unavailable", message: "Maintenance." },
    });
    expect(err.code).toBe("NETWORK");
    expect(err.details?.providerStatus).toBe("service_unavailable");
    // An HTML error page is not quoted.
    const html = await failWith(502, "<html>Bad Gateway</html>");
    expect(html.code).toBe("NETWORK");
    expect(html.message).not.toContain("<html>");
    expect(html.details?.providerStatus).toBeNull();
  });

  it("maps a fetch rejection and a timeout to NETWORK", async () => {
    const refused: FetchLike = async () => {
      throw new TypeError(`fetch failed for key ${KEY}`);
    };
    const err = await failure(
      createElevenLabsEngine(cfg, env, { fetch: refused }).transcribe(audio, {}),
    );
    expect(err.code).toBe("NETWORK");
    expect(err.message).toContain("fetch failed");

    const slow: FetchLike = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const timeout = await failure(
      createElevenLabsEngine(cfg, env, { fetch: slow }).transcribe(audio, {}),
    );
    expect(timeout.code).toBe("NETWORK");
    expect(timeout.message).toContain("timed out");
  });

  it("maps a 200 with an unexpected body to UPSTREAM_CHANGED", async () => {
    const bodies: unknown[] = [
      { message: "queued", request_id: "r1" },
      { language_code: "en", text: "hi", words: "hi" },
      { transcripts: [] },
      "not json at all",
    ];
    for (const body of bodies) {
      const err = await failWith(200, body);
      expect(err.code).toBe("UPSTREAM_CHANGED");
      expect(err.details?.providerStatus).toBeNull();
    }
    expect((await failWith(404, { detail: { status: "not_found", message: "Gone" } })).code).toBe(
      "UPSTREAM_CHANGED",
    );
  });
});
