import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import worker from "../src/index.js";

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const originalAbortSignalTimeout = AbortSignal.timeout;
let logs;
let timeoutDurations;

function makeEnv(notifyStatus) {
  const notifyCalls = [];
  const env = {
    DIGEST_WEBHOOK_URL: "https://discord.invalid/digest",
    NOTIFY_TOKEN: "test-notify-token",
    OLLAMA_URL: "https://ollama.invalid",
    OLLAMA_MODEL: "test-model",
    ATLAS_NOTIFY: {
      async fetch(input, init = {}) {
        const url = new URL(typeof input === "string" ? input : input.url);
        const method = init.method ?? "GET";
        notifyCalls.push({ path: url.pathname, method });
        if (url.pathname.endsWith("/recent")) {
          return Response.json({ events: [] });
        }
        return new Response(null, { status: notifyStatus });
      },
    },
  };
  return { env, notifyCalls };
}

async function runScheduled(env) {
  const pending = [];
  worker.scheduled({}, env, { waitUntil: (promise) => pending.push(promise) });
  assert.equal(pending.length, 1);
  await pending[0];
}

beforeEach(() => {
  logs = [];
  timeoutDurations = [];
  AbortSignal.timeout = (duration) => {
    timeoutDurations.push(duration);
    return originalAbortSignalTimeout(duration);
  };
  console.error = (...parts) => logs.push(parts.join(" "));
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "ollama.invalid") {
      throw new Error("simulated model timeout");
    }
    if (url.hostname === "discord.invalid") {
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected outbound host");
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  AbortSignal.timeout = originalAbortSignalTimeout;
});

test("logs when Atlas Notify rejects a digest failure event", async () => {
  const { env, notifyCalls } = makeEnv(503);
  await runScheduled(env);
  assert.ok(notifyCalls.some((call) => call.method === "POST"));
  assert.ok(logs.some((line) => line.includes("notify envelope answered HTTP 503")));
});

test("does not report an error when Atlas Notify accepts a digest failure event", async () => {
  const { env, notifyCalls } = makeEnv(200);
  await runScheduled(env);
  assert.ok(notifyCalls.some((call) => call.method === "POST"));
  assert.ok(!logs.some((line) => line.includes("notify envelope answered HTTP")));
});


test("streams Ollama text and posts only a completed reply", async () => {
  const { env } = makeEnv(200);
  let chatRequest;
  let postedDigest;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "ollama.invalid") {
      chatRequest = JSON.parse(init.body);
      const body = [
        JSON.stringify({ message: { content: "A quiet" }, done: false }),
        JSON.stringify({ message: { content: " day." }, done: false }),
        JSON.stringify({ message: { content: "" }, done: true }),
        "",
      ].join("\n");
      const splitAt = Math.floor(body.length / 2);
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(body.slice(0, splitAt)));
            controller.enqueue(encoder.encode(body.slice(splitAt)));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }
    if (url.hostname === "discord.invalid") {
      postedDigest = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected outbound host");
  };

  await runScheduled(env);

  assert.equal(chatRequest.stream, true);
  assert.equal(postedDigest.embeds[0].description, "A quiet day.");
});

test("does not post partial text when Ollama ends without its done marker", async () => {
  const { env } = makeEnv(200);
  let postedNotice;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "ollama.invalid") {
      const body =
        JSON.stringify({
          message: { content: "Partial words that must not be spoken." },
          done: false,
        }) + "\n";
      return new Response(body, {
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    if (url.hostname === "discord.invalid") {
      postedNotice = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected outbound host");
  };

  await runScheduled(env);

  assert.match(postedNotice.embeds[0].title, /not written/);
  assert.doesNotMatch(
    postedNotice.embeds[0].description,
    /Partial words that must not be spoken/,
  );
  assert.ok(logs.some((line) => line.includes("stream ended before completion")));
});

test("gives one Ollama request a bounded three-minute timeout", async () => {
  const { env } = makeEnv(200);
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "ollama.invalid") {
      return Response.json({ message: { content: "A quiet day." } });
    }
    if (url.hostname === "discord.invalid") {
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected outbound host");
  };

  await runScheduled(env);

  assert.ok(timeoutDurations.includes(180_000));
  assert.ok(!timeoutDurations.includes(120_000));
});

