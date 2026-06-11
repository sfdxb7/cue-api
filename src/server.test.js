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
