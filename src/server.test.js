import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { answerCueIntelligence, createCueApiServer } from "./server.js";

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
