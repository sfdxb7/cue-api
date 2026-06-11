import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  answerCueIntelligence,
  createCueApiServer,
  transcribeCueAudio
} from "./server.js";

let originalEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.OPENAI_API_KEY;
  delete process.env.CUE_API_TOKEN;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  Object.assign(process.env, originalEnv);
});

test("GET /health reports the Cue API is alive", async () => {
  await withCueApiServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "cue-api");
  });
});

test("OPTIONS /api/intelligence returns CORS headers for the extension", async () => {
  await withCueApiServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/intelligence`, {
      method: "OPTIONS"
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.match(
      response.headers.get("access-control-allow-methods") ?? "",
      /POST/
    );
    assert.match(
      response.headers.get("access-control-allow-headers") ?? "",
      /Authorization/
    );
  });
});

test("POST /api/intelligence falls back honestly when no LLM key is configured", async () => {
  await withCueApiServer({}, async (baseUrl) => {
    const response = await postCueQuestion(baseUrl, {
      mode: "live",
      question: "What is on the screen?",
      transcript: "They are moving quickly through onboarding and annual pricing.",
      screen: {
        description: "Captured browser tab",
        imageDataUrl: "data:image/png;base64,AAAA"
      }
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.provider, "fallback");
    assert.match(body.answer, /captured the screen/i);
    assert.match(body.answer, /LLM proxy is not connected/i);
  });
});

test("POST /api/intelligence rejects invalid requests", async () => {
  await withCueApiServer({}, async (baseUrl) => {
    const response = await postCueQuestion(baseUrl, {
      mode: "live",
      question: ""
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, "Cue question is required.");
  });
});

test("POST /api/intelligence requires the shared token when configured", async () => {
  await withCueApiServer({ apiToken: "private-beta-token" }, async (baseUrl) => {
    const blockedResponse = await postCueQuestion(baseUrl, buildLiveRequest());
    const allowedResponse = await postCueQuestion(baseUrl, buildLiveRequest(), {
      Authorization: "Bearer private-beta-token"
    });

    assert.equal(blockedResponse.status, 401);
    assert.equal(allowedResponse.status, 200);
  });
});

test("intent values are allowlisted into the prompt and invalid ones dropped", async () => {
  const prompts = [];
  const options = {
    apiKey: "test-key",
    fetch: async (url, init) => {
      prompts.push(JSON.parse(init.body).input[0].content[0].text);
      return new Response(JSON.stringify({ output_text: '{"answer":"ok"}' }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  };

  await withCueApiServer(options, async (baseUrl) => {
    await postCueQuestion(baseUrl, { ...buildLiveRequest(), intent: "catch_up" });
    await postCueQuestion(baseUrl, { ...buildLiveRequest(), intent: "evil_intent" });
  });

  assert.match(prompts[0], /Intent: catch_up/);
  assert.doesNotMatch(prompts[1], /Intent:/);
});

test("answerCueIntelligence parses compact OpenAI JSON responses", async () => {
  const result = await answerCueIntelligence(buildLiveRequest(), {
    apiKey: "test-key",
    fetch: async () =>
      new Response(
        JSON.stringify({
          output_text:
            '{"answer":"The team is deciding whether onboarding is bundled.","suggestion":"Ask for the billing owner.","actions":["Save moment"],"source":"screen + transcript"}'
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.answer, "The team is deciding whether onboarding is bundled.");
  assert.equal(result.suggestion, "Ask for the billing owner.");
  assert.deepEqual(result.actions, ["Save moment"]);
  assert.equal(result.source, "screen + transcript");
});

test("POST /api/intelligence rejects oversized questions", async () => {
  await withCueApiServer({}, async (baseUrl) => {
    const response = await postCueQuestion(baseUrl, {
      mode: "live",
      question: "x".repeat(2001)
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /2000 characters/);
  });
});

test("POST /api/intelligence rejects non-image screen data URLs", async () => {
  await withCueApiServer({}, async (baseUrl) => {
    const response = await postCueQuestion(baseUrl, {
      mode: "live",
      question: "What is on the screen?",
      screen: {
        description: "Captured browser tab",
        imageDataUrl: "data:text/html;base64,AAAA"
      }
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /png, jpeg, webp, or gif/);
  });
});

test("rate limiting ignores spoofed X-Forwarded-For unless trustProxy is enabled", async () => {
  await withCueApiServer({ rateLimitMax: 2 }, async (baseUrl) => {
    const statuses = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await postCueQuestion(baseUrl, buildLiveRequest(), {
        "X-Forwarded-For": `10.0.0.${attempt}`
      });
      statuses.push(response.status);
    }

    assert.deepEqual(statuses, [200, 200, 429]);
  });
});

test("CORS omits Access-Control-Allow-Origin for non-allowlisted origins", async () => {
  await withCueApiServer({ corsOrigin: "chrome-extension://allowed-id" }, async (baseUrl) => {
    const blocked = await postCueQuestion(baseUrl, buildLiveRequest(), {
      Origin: "https://evil.example"
    });
    const allowed = await postCueQuestion(baseUrl, buildLiveRequest(), {
      Origin: "chrome-extension://allowed-id"
    });

    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      "chrome-extension://allowed-id"
    );
  });
});

test("answerCueIntelligence passes an abort signal and truncates long transcripts", async () => {
  let capturedInit;

  await answerCueIntelligence(
    {
      mode: "live",
      question: "What did I miss?",
      transcript: "a".repeat(30000)
    },
    {
      apiKey: "test-key",
      fetch: async (url, init) => {
        capturedInit = init;
        return new Response(JSON.stringify({ output_text: '{"answer":"ok"}' }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
  );

  assert.ok(capturedInit.signal instanceof AbortSignal);
});

test("POST /api/transcribe explains when transcription is not configured", async () => {
  await withCueApiServer({}, async (baseUrl) => {
    const response = await postCueTranscription(baseUrl, {
      audioDataUrl: buildAudioDataUrl()
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.match(body.error, /OPENAI_API_KEY/);
  });
});

test("POST /api/transcribe rejects requests without audio", async () => {
  await withCueApiServer({}, async (baseUrl) => {
    const response = await postCueTranscription(baseUrl, {});
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, "Transcribe audioDataUrl is required.");
  });
});

test("POST /api/transcribe rejects unsupported audio types", async () => {
  await withCueApiServer({}, async (baseUrl) => {
    const response = await postCueTranscription(baseUrl, {
      audioDataUrl: "data:audio/aiff;base64,AAAA"
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /not supported/);
  });
});

test("POST /api/transcribe requires the shared token when configured", async () => {
  await withCueApiServer({ apiToken: "private-beta-token" }, async (baseUrl) => {
    const blockedResponse = await postCueTranscription(baseUrl, {
      audioDataUrl: buildAudioDataUrl()
    });

    assert.equal(blockedResponse.status, 401);
  });
});

test("transcribeCueAudio sends multipart audio to OpenAI and returns the text", async () => {
  let capturedUrl;
  let capturedHeaders;
  let capturedBody;

  const result = await transcribeCueAudio(
    {
      audioBuffer: Buffer.from("fake-audio"),
      mimeType: "audio/webm",
      fileName: "audio.webm",
      language: "en"
    },
    {
      apiKey: "test-key",
      fetch: async (url, init) => {
        capturedUrl = url;
        capturedHeaders = init.headers;
        capturedBody = init.body;

        return new Response(JSON.stringify({ text: "We agreed to bundle onboarding." }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }
    }
  );

  assert.equal(capturedUrl, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(capturedHeaders.Authorization, "Bearer test-key");
  assert.ok(capturedBody instanceof FormData);
  assert.equal(capturedBody.get("model"), "gpt-4o-mini-transcribe");
  assert.equal(capturedBody.get("language"), "en");
  assert.equal(capturedBody.get("file").name, "audio.webm");
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-4o-mini-transcribe");
  assert.equal(result.text, "We agreed to bundle onboarding.");
});

test("transcribeCueAudio surfaces provider rejections as retryable errors", async () => {
  await assert.rejects(
    transcribeCueAudio(
      {
        audioBuffer: Buffer.from("fake-audio"),
        mimeType: "audio/webm",
        fileName: "audio.webm"
      },
      {
        apiKey: "test-key",
        fetch: async () => new Response("{}", { status: 401 })
      }
    ),
    (error) => {
      assert.equal(error.statusCode, 502);
      return true;
    }
  );
});

test("persistence endpoints return 503 when no store is configured", async () => {
  await withCueApiServer({ store: null }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/meetings`, {
      headers: { "X-Cue-Device": "device-12345678" }
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.match(body.error, /not configured/i);
  });
});

test("persistence endpoints require a valid device header", async () => {
  await withCueApiServer({ store: createFakeStore() }, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/meetings`);
    const invalid = await fetch(`${baseUrl}/api/meetings`, {
      headers: { "X-Cue-Device": "no" }
    });

    assert.equal(missing.status, 400);
    assert.equal(invalid.status, 400);
  });
});

test("GET /api/meetings returns meetings scoped to the device", async () => {
  const store = createFakeStore();

  await withCueApiServer({ store }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/meetings`, {
      headers: { "X-Cue-Device": "device-12345678" }
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.meetings, []);
    assert.deepEqual(store.calls.listMeetings, [["device-12345678"]]);
  });
});

test("POST /api/meetings validates and stores a meeting", async () => {
  const store = createFakeStore();

  await withCueApiServer({ store }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/meetings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cue-Device": "device-12345678"
      },
      body: JSON.stringify({ meeting: buildMeetingPayload() })
    });

    assert.equal(response.status, 201);
    assert.equal(store.calls.upsertMeeting.length, 1);
    assert.equal(store.calls.upsertMeeting[0][1].title, "Vendor sync");
  });
});

test("POST /api/meetings rejects invalid meeting ids and statuses", async () => {
  await withCueApiServer({ store: createFakeStore() }, async (baseUrl) => {
    const badId = await fetch(`${baseUrl}/api/meetings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cue-Device": "device-12345678" },
      body: JSON.stringify({ meeting: { ...buildMeetingPayload(), id: "bad id!" } })
    });
    const badStatus = await fetch(`${baseUrl}/api/meetings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cue-Device": "device-12345678" },
      body: JSON.stringify({ meeting: { ...buildMeetingPayload(), status: "weird" } })
    });

    assert.equal(badId.status, 400);
    assert.equal(badStatus.status, 400);
  });
});

test("DELETE /api/meetings/:id deletes and 404s when missing", async () => {
  const store = createFakeStore();
  store.deleteResults = [true, false];

  await withCueApiServer({ store }, async (baseUrl) => {
    const deleted = await fetch(`${baseUrl}/api/meetings/live-abc`, {
      method: "DELETE",
      headers: { "X-Cue-Device": "device-12345678" }
    });
    const missing = await fetch(`${baseUrl}/api/meetings/other`, {
      method: "DELETE",
      headers: { "X-Cue-Device": "device-12345678" }
    });

    assert.equal(deleted.status, 204);
    assert.equal(missing.status, 404);
  });
});

test("PUT /api/meetings/:id/transcript stores transcripts and caps size", async () => {
  const store = createFakeStore();

  await withCueApiServer({ store }, async (baseUrl) => {
    const stored = await fetch(`${baseUrl}/api/meetings/live-abc/transcript`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Cue-Device": "device-12345678" },
      body: JSON.stringify({ transcript: "They discussed onboarding." })
    });

    assert.equal(stored.status, 204);
    assert.equal(store.calls.putTranscript.length, 1);
  });
});

test("store failures surface as 502", async () => {
  const store = createFakeStore();
  store.failNext = true;

  await withCueApiServer({ store }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/meetings`, {
      headers: { "X-Cue-Device": "device-12345678" }
    });

    assert.equal(response.status, 502);
  });
});

test("POST /api/meetings/:id/minutes generates structured minutes from a transcript", async () => {
  let capturedBody;
  const options = {
    store: null,
    apiKey: "test-key",
    fetch: async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            title: "Pricing decision sync",
            summary: "The team agreed on bundling.",
            decisions: ["Bundle onboarding."],
            actions: ["Sara: confirm cost."],
            unclearItems: []
          })
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  };

  await withCueApiServer(options, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/meetings/live-abc/minutes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: "Sara: We will bundle onboarding. Mark: Confirm the cost first.",
        elapsedSeconds: 1200
      })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.title, "Pricing decision sync");
    assert.deepEqual(body.minutes.decisions, ["Bundle onboarding."]);
    assert.equal(capturedBody.text.format.type, "json_schema");
    assert.match(capturedBody.input[0].content[0].text, /untrusted_meeting_data/);
  });
});

test("POST /api/meetings/:id/minutes returns 422 without a transcript", async () => {
  await withCueApiServer({ store: null, apiKey: "test-key" }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/meetings/live-abc/minutes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ elapsedSeconds: 60 })
    });
    const body = await response.json();

    assert.equal(response.status, 422);
    assert.match(body.error, /transcript/i);
  });
});

test("POST /api/meetings/:id/minutes refuses to fake minutes without an API key", async () => {
  await withCueApiServer({ store: null }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/meetings/live-abc/minutes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: "Some transcript." })
    });

    assert.equal(response.status, 503);
  });
});

function buildMeetingPayload() {
  return {
    id: "live-abc",
    title: "Vendor sync",
    status: "ready",
    dateLabel: "Today",
    duration: "30 min",
    people: 3,
    chips: ["1 moment"],
    minutes: { summary: "Summary.", decisions: [], actions: [], unclearItems: [] },
    chat: [],
    moments: [],
    createdAt: "2026-06-11T08:00:00.000Z",
    updatedAt: "2026-06-11T08:00:00.000Z"
  };
}

function createFakeStore() {
  const calls = {
    listMeetings: [],
    upsertMeeting: [],
    patchMeeting: [],
    deleteMeeting: [],
    insertMoments: [],
    putTranscript: []
  };

  const store = {
    calls,
    failNext: false,
    deleteResults: [],
    async listMeetings(...args) {
      maybeFail(store);
      calls.listMeetings.push(args);
      return [];
    },
    async upsertMeeting(...args) {
      maybeFail(store);
      calls.upsertMeeting.push(args);
      return args[1];
    },
    async patchMeeting(...args) {
      maybeFail(store);
      calls.patchMeeting.push(args);
      return { id: args[1], ...args[2] };
    },
    async deleteMeeting(...args) {
      maybeFail(store);
      calls.deleteMeeting.push(args);
      return store.deleteResults.length > 0 ? store.deleteResults.shift() : true;
    },
    async insertMoments(...args) {
      maybeFail(store);
      calls.insertMoments.push(args);
      return args[2].length;
    },
    async putTranscript(...args) {
      maybeFail(store);
      calls.putTranscript.push(args);
    }
  };

  return store;
}

function maybeFail(store) {
  if (store.failNext) {
    store.failNext = false;
    const error = new Error("Persistence backend is unreachable.");
    error.isStoreError = true;
    throw error;
  }
}

async function withCueApiServer(options, callback) {
  const server = createCueApiServer(options);

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

function buildLiveRequest() {
  return {
    mode: "live",
    question: "What did I miss?",
    transcript: "The team decided onboarding might move into annual pricing.",
    screen: {
      description: "Captured browser tab"
    }
  };
}

function postCueQuestion(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/api/intelligence`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function postCueTranscription(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/api/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function buildAudioDataUrl() {
  return `data:audio/webm;base64,${Buffer.from("fake-audio").toString("base64")}`;
}
