import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const openAiResponsesUrl = "https://api.openai.com/v1/responses";
const openAiTranscriptionsUrl = "https://api.openai.com/v1/audio/transcriptions";
const defaultOpenAiModel = "gpt-5-mini";
const defaultTranscriptionModel = "gpt-4o-mini-transcribe";
const audioExtensionsByMimeType = new Map([
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/mp4", "mp4"],
  ["audio/m4a", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/flac", "flac"],
  ["video/webm", "webm"],
  ["video/mp4", "mp4"]
]);
const defaultMaxBodyBytes = 15 * 1024 * 1024;
const defaultRateLimitMax = 30;
const defaultRateLimitWindowMs = 60 * 1000;
const validActions = new Set(["Save moment", "Draft reply"]);

export function createCueApiServer(options = {}) {
  const rateLimiter = createRateLimiter(options);

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const corsHeaders = buildCorsHeaders(request, options);

    if (request.method === "OPTIONS") {
      writeHeaders(response, corsHeaders);
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(
        response,
        200,
        {
          ok: true,
          service: "cue-api",
          version: "0.1.0"
        },
        corsHeaders
      );
      return;
    }

    if (url.pathname !== "/api/intelligence" && url.pathname !== "/api/transcribe") {
      sendJson(response, 404, { error: "Not found." }, corsHeaders);
      return;
    }

    if (request.method !== "POST") {
      sendJson(
        response,
        405,
        { error: "Method not allowed." },
        corsHeaders,
        { Allow: "POST, OPTIONS" }
      );
      return;
    }

    if (!isAuthorized(request, options)) {
      sendJson(response, 401, { error: "Unauthorized." }, corsHeaders);
      return;
    }

    const rateLimit = rateLimiter.check(getClientKey(request));

    if (!rateLimit.allowed) {
      sendJson(
        response,
        429,
        { error: "Too many requests." },
        corsHeaders,
        { "Retry-After": String(rateLimit.retryAfterSeconds) }
      );
      return;
    }

    try {
      const body = await readJsonBody(request, getMaxBodyBytes(options));

      if (url.pathname === "/api/transcribe") {
        const transcribeRequest = validateTranscribeRequest(body);
        const result = await transcribeCueAudio(transcribeRequest, options);

        sendJson(response, 200, result, corsHeaders);
        return;
      }

      const cueRequest = validateCueRequest(body);
      const result = await answerCueIntelligence(cueRequest, options);

      sendJson(response, 200, result, corsHeaders);
    } catch (error) {
      if (isHttpError(error)) {
        sendJson(response, error.statusCode, { error: error.message }, corsHeaders);
        return;
      }

      console.error("Cue API request failed", error);
      sendJson(response, 500, { error: "Cue intelligence failed." }, corsHeaders);
    }
  });
}

export async function answerCueIntelligence(request, options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (!apiKey || typeof fetchImpl !== "function") {
    return fallbackCueIntelligence(request);
  }

  try {
    const response = await fetchImpl(openAiResponsesUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model ?? process.env.OPENAI_MODEL ?? defaultOpenAiModel,
        input: [
          {
            role: "user",
            content: buildOpenAiContent(request)
          }
        ]
      })
    });

    if (!response.ok) {
      return fallbackCueIntelligence(request);
    }

    const payload = await response.json();
    const outputText = extractOpenAiOutputText(payload);

    if (!outputText) {
      return fallbackCueIntelligence(request);
    }

    return parseCueResponse(outputText, request);
  } catch {
    return fallbackCueIntelligence(request);
  }
}

export async function transcribeCueAudio(request, options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (!apiKey || typeof fetchImpl !== "function") {
    throw createHttpError(
      503,
      "Transcription is not configured. Set OPENAI_API_KEY on the Cue API service."
    );
  }

  const model =
    options.transcriptionModel ??
    process.env.OPENAI_TRANSCRIPTION_MODEL ??
    defaultTranscriptionModel;
  const formData = new FormData();

  formData.append(
    "file",
    new Blob([request.audioBuffer], { type: request.mimeType }),
    request.fileName
  );
  formData.append("model", model);

  if (request.language) {
    formData.append("language", request.language);
  }

  if (request.prompt) {
    formData.append("prompt", request.prompt);
  }

  let response;

  try {
    response = await fetchImpl(openAiTranscriptionsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: formData
    });
  } catch {
    throw createHttpError(502, "Transcription request failed.");
  }

  if (!response.ok) {
    throw createHttpError(502, "Transcription provider rejected the request.");
  }

  const payload = await response.json();
  const text = getString(isRecord(payload) ? payload.text : undefined);

  if (text === undefined) {
    throw createHttpError(502, "Transcription provider returned no text.");
  }

  return {
    provider: "openai",
    model,
    text
  };
}

function validateTranscribeRequest(value) {
  if (!isRecord(value)) {
    throw createHttpError(400, "Transcribe request must be a JSON object.");
  }

  const audioDataUrl = getString(value.audioDataUrl);

  if (!audioDataUrl) {
    throw createHttpError(400, "Transcribe audioDataUrl is required.");
  }

  const dataUrlMatch = audioDataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);

  if (!dataUrlMatch) {
    throw createHttpError(400, "Transcribe audioDataUrl must be a base64 data URL.");
  }

  const mimeType = dataUrlMatch[1].toLowerCase();
  const extension = audioExtensionsByMimeType.get(mimeType);

  if (!extension) {
    throw createHttpError(
      400,
      `Transcribe audio type ${mimeType} is not supported. Use webm, ogg, wav, mp3, mp4, m4a, or flac audio.`
    );
  }

  const audioBuffer = Buffer.from(dataUrlMatch[2].replace(/\s/g, ""), "base64");

  if (audioBuffer.byteLength === 0) {
    throw createHttpError(400, "Transcribe audio is empty.");
  }

  return {
    audioBuffer,
    mimeType,
    fileName: `audio.${extension}`,
    language: getString(value.language),
    prompt: getString(value.prompt)
  };
}

function buildOpenAiContent(request) {
  const content = [
    {
      type: "input_text",
      text: buildCuePrompt(request)
    }
  ];

  if (request.screen?.imageDataUrl) {
    content.push({
      type: "input_image",
      image_url: request.screen.imageDataUrl
    });
  }

  return content;
}

function buildCuePrompt(request) {
  const context =
    request.mode === "live"
      ? {
          screen: request.screen?.description ?? "No screen description provided.",
          transcript: request.transcript ?? "No transcript provided."
        }
      : {
          meetingTitle: request.meeting?.title,
          minutes: request.meeting?.minutes,
          moments: request.meeting?.moments,
          transcriptSeed: request.meeting?.chat
        };

  return [
    "You are Cue, an attention recovery copilot for busy professionals in meetings.",
    "Answer as a concise in-meeting assistant. Help the user recover context, sound prepared, and decide what to ask next.",
    "Return valid compact JSON only with these optional fields: answer, suggestion, actions, source.",
    'Use actions only from this set: "Save moment", "Draft reply".',
    "Never invent a decision that is not supported by the provided screen, transcript, minutes, or moments.",
    "",
    `Mode: ${request.mode}`,
    `Question: ${request.question}`,
    `Context JSON: ${JSON.stringify(context)}`
  ].join("\n");
}

function parseCueResponse(outputText, request) {
  const parsedJson = parseJsonObject(outputText);
  const fallbackResponse = fallbackCueIntelligence(request);

  if (!parsedJson) {
    return {
      ...fallbackResponse,
      provider: "openai",
      answer: outputText
    };
  }

  return {
    provider: "openai",
    contextLabel: request.mode === "live" ? "Cue - screen + transcript" : "Cue - meeting memory",
    answer: getString(parsedJson.answer) ?? outputText,
    suggestion: getString(parsedJson.suggestion),
    actions: getActions(parsedJson.actions),
    source: getString(parsedJson.source) ?? fallbackResponse.source
  };
}

function fallbackCueIntelligence(request) {
  if (request.mode === "meeting" && request.meeting) {
    return buildMeetingFallback(request.meeting, request.question);
  }

  return buildLiveFallback(request);
}

function buildLiveFallback(request) {
  const normalizedQuestion = request.question.toLowerCase();
  const contextLabel = "Cue - screen + transcript";

  if (request.screen?.imageDataUrl) {
    return {
      provider: "fallback",
      contextLabel,
      answer:
        "I captured the screen, but the LLM proxy is not connected yet, so I should not pretend to read this slide. Set OPENAI_API_KEY on the Cue API service or configure VITE_CUE_PROXY_URL to get a real screen answer.",
      suggestion:
        "Keep the panel open and connect the Cue API to an LLM before asking about the slide.",
      actions: ["Save moment"]
    };
  }

  if (normalizedQuestion.includes("draft") || normalizedQuestion.includes("say")) {
    return {
      provider: "fallback",
      contextLabel,
      answer:
        "Try: I want to make sure I understand the decision. Are we bundling onboarding into annual pricing, or treating it separately?",
      actions: ["Save moment"]
    };
  }

  if (normalizedQuestion.includes("screen")) {
    return {
      provider: "fallback",
      contextLabel,
      answer:
        "The shared slide is comparing monthly and annual pricing. The unresolved point is whether onboarding is part of the annual package.",
      suggestion: "Ask about the onboarding assumption before the team moves past this slide.",
      actions: ["Save moment", "Draft reply"]
    };
  }

  if (isMomentCapturePrompt(normalizedQuestion)) {
    return {
      provider: "fallback",
      contextLabel,
      answer:
        "Captured this moment and tagged it as Screen capture, Pricing, and Unclear. It will appear in Moments with the screenshot and transcript context."
    };
  }

  return {
    provider: "fallback",
    contextLabel,
    answer:
      "In the last few minutes, the team moved from discount wording to onboarding. The useful question is whether onboarding is bundled or billed separately.",
    suggestion: 'Ask: "Are we treating onboarding as bundled, or is it a separate line item?"',
    actions: ["Save moment", "Draft reply"]
  };
}

function buildMeetingFallback(meeting, question) {
  const normalizedQuestion = question.toLowerCase();
  const minutes = isRecord(meeting.minutes) ? meeting.minutes : {};
  const decisions = getStringList(minutes.decisions);
  const actions = getStringList(minutes.actions);
  const unclearItems = getStringList(minutes.unclearItems);
  const summary = getString(minutes.summary) ?? "This meeting has saved context.";
  let answer;

  if (normalizedQuestion.includes("decision") || normalizedQuestion.includes("decide")) {
    answer = `Decisions: ${decisions.join(" ") || "No decisions were recorded yet."}`;
  } else if (normalizedQuestion.includes("follow") || normalizedQuestion.includes("action")) {
    answer = `Follow-ups: ${actions.join(" ") || "No follow-ups were recorded yet."}`;
  } else if (normalizedQuestion.includes("unclear") || normalizedQuestion.includes("confus")) {
    answer = `Still unclear: ${unclearItems.join(" ") || "No unclear items were recorded yet."}`;
  } else if (normalizedQuestion.includes("moment") || normalizedQuestion.includes("screen")) {
    const momentTitles = Array.isArray(meeting.moments)
      ? meeting.moments.map((moment) => moment?.title).filter(Boolean)
      : [];
    answer = `Key moments: ${momentTitles.join("; ") || "No moments were recorded yet."}`;
  } else {
    answer = `${summary} The strongest reference points are ${
      decisions[0] ?? "the saved decisions"
    } and ${actions[0] ?? "the saved follow-ups"}.`;
  }

  return {
    provider: "fallback",
    contextLabel: "Cue - meeting memory",
    answer,
    source: "Source: meeting minutes + transcript"
  };
}

function isMomentCapturePrompt(prompt) {
  return prompt.includes("save moment") || prompt.includes("capture");
}

function validateCueRequest(value) {
  if (!isRecord(value)) {
    throw createHttpError(400, "Cue request must be a JSON object.");
  }

  if (value.mode !== "live" && value.mode !== "meeting") {
    throw createHttpError(400, "Cue mode must be live or meeting.");
  }

  const question = getString(value.question);

  if (!question) {
    throw createHttpError(400, "Cue question is required.");
  }

  return {
    ...value,
    mode: value.mode,
    question,
    transcript: getString(value.transcript),
    screen: normalizeScreen(value.screen),
    meeting: isRecord(value.meeting) ? value.meeting : undefined
  };
}

function normalizeScreen(value) {
  if (!isRecord(value)) {
    return undefined;
  }

  const description = getString(value.description) ?? "Captured browser tab";
  const imageDataUrl = getString(value.imageDataUrl);
  const capturedAt = getString(value.capturedAt);

  return {
    description,
    ...(imageDataUrl ? { imageDataUrl } : {}),
    ...(capturedAt ? { capturedAt } : {})
  };
}

function createRateLimiter(options) {
  const buckets = new Map();
  const maxRequests = getPositiveNumber(
    options.rateLimitMax ?? process.env.RATE_LIMIT_MAX,
    defaultRateLimitMax
  );
  const windowMs = getPositiveNumber(
    options.rateLimitWindowMs ?? process.env.RATE_LIMIT_WINDOW_MS,
    defaultRateLimitWindowMs
  );

  return {
    check(key) {
      const now = Date.now();
      const bucket = buckets.get(key);

      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, {
          count: 1,
          resetAt: now + windowMs
        });

        return { allowed: true };
      }

      if (bucket.count >= maxRequests) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000)
        };
      }

      bucket.count += 1;
      return { allowed: true };
    }
  };
}

async function readJsonBody(request, maxBodyBytes) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > maxBodyBytes) {
      throw createHttpError(413, "Cue request is too large.");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw createHttpError(400, "Cue request body is required.");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw createHttpError(400, "Cue request body must be valid JSON.");
  }
}

function buildCorsHeaders(request, options) {
  const configuredOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN ?? "*";
  const requestOrigin = getHeaderValue(request, "origin");
  const allowOrigin = resolveCorsOrigin(configuredOrigin, requestOrigin);
  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Cue-Token",
    "Access-Control-Max-Age": "86400"
  };

  if (configuredOrigin !== "*") {
    headers.Vary = "Origin";
  }

  return headers;
}

function resolveCorsOrigin(configuredOrigin, requestOrigin) {
  if (configuredOrigin === "*") {
    return "*";
  }

  const allowedOrigins = configuredOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  return allowedOrigins[0] ?? "*";
}

function isAuthorized(request, options) {
  const apiToken = options.apiToken ?? process.env.CUE_API_TOKEN;

  if (!apiToken) {
    return true;
  }

  const authorization = getHeaderValue(request, "authorization");
  const cueToken = getHeaderValue(request, "x-cue-token");

  return authorization === `Bearer ${apiToken}` || cueToken === apiToken;
}

function getClientKey(request) {
  const forwardedFor = getHeaderValue(request, "x-forwarded-for");

  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  return request.socket.remoteAddress ?? "unknown";
}

function sendJson(response, statusCode, body, corsHeaders, extraHeaders = {}) {
  writeHeaders(response, {
    ...corsHeaders,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders
  });
  response.writeHead(statusCode);
  response.end(JSON.stringify(body));
}

function writeHeaders(response, headers) {
  for (const [key, value] of Object.entries(headers)) {
    if (value) {
      response.setHeader(key, value);
    }
  }
}

function getMaxBodyBytes(options) {
  return getPositiveNumber(options.maxBodyBytes ?? process.env.MAX_BODY_BYTES, defaultMaxBodyBytes);
}

function getPositiveNumber(value, fallback) {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;

  return error;
}

function isHttpError(error) {
  return Boolean(error && typeof error.statusCode === "number");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getHeaderValue(request, headerName) {
  const value = request.headers[headerName];

  if (Array.isArray(value)) {
    return value[0];
  }

  return typeof value === "string" ? value : undefined;
}

function parseJsonObject(outputText) {
  const trimmedOutput = outputText.trim();
  const fenceMatch = trimmedOutput.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonCandidate = fenceMatch?.[1] ?? trimmedOutput;
  const objectStart = jsonCandidate.indexOf("{");
  const objectEnd = jsonCandidate.lastIndexOf("}");

  if (objectStart === -1 || objectEnd === -1 || objectEnd <= objectStart) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonCandidate.slice(objectStart, objectEnd + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractOpenAiOutputText(payload) {
  if (!isRecord(payload)) {
    return null;
  }

  const outputText = payload.output_text;

  if (typeof outputText === "string" && outputText.trim()) {
    return outputText;
  }

  if (!Array.isArray(payload.output)) {
    return null;
  }

  const textParts = [];

  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const contentItem of item.content) {
      if (!isRecord(contentItem)) {
        continue;
      }

      if (typeof contentItem.text === "string" && contentItem.text.trim()) {
        textParts.push(contentItem.text);
      }
    }
  }

  return textParts.length > 0 ? textParts.join("\n") : null;
}

function getString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function getActions(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const actions = value.filter((action) => validActions.has(action));

  return actions.length > 0 ? actions : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createCueApiServer();

  server.listen(port, "0.0.0.0", () => {
    console.log(`Cue API listening on port ${port}`);
  });
}
