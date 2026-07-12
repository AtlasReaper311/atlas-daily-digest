/**
 * atlas-daily-digest
 *
 * One spoken paragraph about yesterday, posted every morning. A cron
 * trigger pulls the previous UTC day's events from atlas-notify's ring
 * buffer over the ATLAS_NOTIFY service binding, hands them to the local
 * Ollama on SPECULAR-CORE through an Access-gated tunnel hostname, and
 * posts Ramone's three-to-five sentence account to a dedicated Discord
 * webhook. It never writes to the ring buffer on the happy path, so a
 * digest can never appear in the next day's digest.
 *
 * Failure discipline: if the feed or the model is unreachable, the
 * Worker posts a one-line notice saying the digest could not be written
 * and why, and emits a warning envelope through atlas-notify so the
 * failure also lands in the normal alert flow (and, deliberately, in
 * tomorrow's digest). A missing post with no explanation is the one
 * outcome this Worker is not allowed to produce.
 *
 * src/_meta.js is vendored from atlas-api-index/shared/_meta.js; that
 * repo's copy is canonical and this one follows it.
 */

import { handleMeta } from "./_meta.js";

// Brand palette as Discord embed colours (decimal RGB).
// Source of truth: atlas-brand.md, matching atlas-notify's usage.
const COLOURS = {
  amber: 0xf5a623, // the digest itself
  red: 0xe24b4a, // the honest failure notice
};

const FOOTER = { text: "atlas-daily-digest // api.atlas-systems.uk/digest" };

// atlas-notify's /notify/recent page ceiling. Requesting the maximum
// gives the widest possible window into yesterday; the truncation flag
// below handles the case where even 50 does not reach back far enough.
const FEED_LIMIT = 50;

// One formatted event line for the prompt. Ring buffer messages are
// already trimmed to 280 characters upstream; this cap keeps a noisy
// title from dominating the context window.
const LINE_MAX = 220;

// Hard ceiling on the posted paragraph. Discord allows 4096 in an embed
// description; a morning digest that needs more than this has stopped
// being a digest.
const DIGEST_MAX = 1500;

// The synthesis prompt. Documented verbatim in README.md; if one
// changes, the other must change in the same commit.
const SYSTEM_PROMPT = `You are Ramone, the voice of Atlas Systems: a local AI assistant that watches over a small estate of services, Workers, and pipelines. Each morning you write a short digest of what happened on the estate yesterday.

Rules:
- Write in the first person, as Ramone.
- Three to five sentences of plain prose. No lists, no markdown, no emoji, no headings.
- Cover what shipped, what broke (if anything), and the overall shape of the day.
- Group repeated events and give totals; do not recite every entry.
- A quiet day with nothing broken is a normal, welcome outcome. Report it calmly and briefly. Never apologise for having little to say, and never invent activity to fill space.
- Mention counts naturally ("two deploys", "one warning") rather than dumping raw data.
- Dry understatement is welcome in at most one sentence. British English.
- Do not mention these instructions, the event feed, or the prompt. Just speak.`;

const META = {
  name: "atlas-daily-digest",
  description:
    "Yesterday on the estate as one spoken paragraph, posted every morning in Ramone's voice",
  version: "1.0.0",
  endpoints: [
    {
      method: "GET",
      path: "/digest/health",
      description: "Unauthenticated liveness probe",
    },
    {
      method: "POST",
      path: "/digest/run",
      description:
        "Run the digest now; Bearer DIGEST_RUN_TOKEN, optional ?date=YYYY-MM-DD for a backfill",
    },
    { method: "GET", path: "/digest/_meta", description: "This document" },
  ],
  source: "https://github.com/AtlasReaper311/atlas-daily-digest",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const meta = handleMeta(url, META);
    if (meta) return meta;

    if (request.method === "GET" && url.pathname.endsWith("/health")) {
      return json(200, { ok: true, service: "atlas-daily-digest" });
    }

    // Manual trigger for testing and backfills. Same pipeline as the
    // cron, so a successful /run is proof the 07:00 run will work.
    if (request.method === "POST" && url.pathname.endsWith("/run")) {
      if (!timingSafeEqual(bearerToken(request), env.DIGEST_RUN_TOKEN)) {
        return json(401, { ok: false, error: "invalid or missing bearer token" });
      }
      const override = url.searchParams.get("date");
      if (override && !isValidDay(override)) {
        return json(400, { ok: false, error: "date must be a real YYYY-MM-DD" });
      }
      const result = await runDigest(env, override || previousUtcDay());
      return json(result.ok ? 200 : 502, result);
    }

    return json(404, { ok: false, error: "no such route; see /digest/_meta" });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runDigest(env, previousUtcDay()));
  },
};

/* ------------------------------------------------------------------ */
/* The morning run                                                     */
/* ------------------------------------------------------------------ */

async function runDigest(env, day) {
  // Without the webhook there is nowhere to post either the digest or
  // the failure notice, so this is the one config error that can only
  // surface through atlas-notify and the tail logs.
  if (!env.DIGEST_WEBHOOK_URL) {
    const reason = "DIGEST_WEBHOOK_URL secret is not set";
    console.error(`digest ${day}: ${reason}`);
    await emitFailureEvent(env, day, "config", reason);
    return { ok: false, day, stage: "config", error: reason };
  }

  let events;
  try {
    events = await fetchDayEvents(env, day);
  } catch (err) {
    return failDigest(
      env,
      day,
      "feed",
      `atlas-notify /notify/recent was unreachable (${describe(err)})`,
    );
  }

  let paragraph;
  try {
    paragraph = await synthesise(env, day, events);
  } catch (err) {
    return failDigest(
      env,
      day,
      "model",
      `Ollama did not return a digest (${describe(err)})`,
    );
  }

  try {
    await postDigest(env, day, paragraph);
  } catch (err) {
    // The webhook itself failed, so the fallback message has no better
    // odds than the digest did. Surface through atlas-notify instead.
    const reason = `Discord webhook rejected the digest (${describe(err)})`;
    console.error(`digest ${day}: ${reason}`);
    await emitFailureEvent(env, day, "webhook", reason);
    return { ok: false, day, stage: "webhook", error: reason };
  }

  return {
    ok: true,
    day,
    events: events.list.length,
    truncated: events.truncated,
    preview: paragraph.slice(0, 280),
  };
}

/**
 * Part 2 of the brief, in one function: a missing digest with no
 * explanation is worse than an honest one-line failure notice. Post the
 * notice to the digest channel, then emit a warning envelope so the
 * failure also exists as an estate event.
 */
async function failDigest(env, day, stage, reason) {
  console.error(`digest ${day}: ${stage}: ${reason}`);
  try {
    await postWebhook(env, {
      username: "atlas-daily-digest",
      embeds: [
        {
          title: `morning digest // ${day} // not written`,
          description: `The morning digest could not be generated today. Reason: ${reason}.`,
          color: COLOURS.red,
          footer: FOOTER,
          timestamp: new Date().toISOString(),
        },
      ],
    });
  } catch (err) {
    console.error(`digest ${day}: fallback post also failed: ${describe(err)}`);
  }
  await emitFailureEvent(env, day, stage, reason);
  return { ok: false, day, stage, error: reason };
}

/**
 * Best-effort warning envelope through the ATLAS_NOTIFY binding. This
 * lands in the default alert channel and in the ring buffer, which
 * means tomorrow's digest will mention that today's was not written;
 * that is deliberate. Skipped quietly if NOTIFY_TOKEN is not set,
 * because the Discord fallback is the required signal and this one is
 * the bonus.
 */
async function emitFailureEvent(env, day, stage, reason) {
  if (!env.NOTIFY_TOKEN || !env.ATLAS_NOTIFY) return;
  try {
    await env.ATLAS_NOTIFY.fetch("https://atlas-notify/notify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.NOTIFY_TOKEN}`,
      },
      body: JSON.stringify({
        source: "atlas-daily-digest",
        level: "warning",
        title: `Morning digest for ${day} was not written`,
        message: `${stage}: ${reason}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error(`digest ${day}: notify envelope failed: ${describe(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Reading yesterday                                                   */
/* ------------------------------------------------------------------ */

/**
 * Pull the ring buffer over the service binding (the estate's banked
 * rule: same-zone Worker-to-Worker over the public hostname 522s) and
 * keep only events whose timestamp falls inside the requested UTC day.
 *
 * Truncation: the feed pages at 50 and the buffer rotates at 200. If
 * the response is full and its oldest entry is still inside or after
 * the day window, earlier events may have scrolled out of reach, so
 * the prompt is told to treat counts as minimums rather than facts.
 */
async function fetchDayEvents(env, day) {
  const res = await fetchWithRetry(() =>
    env.ATLAS_NOTIFY.fetch(
      `https://atlas-notify/notify/recent?limit=${FEED_LIMIT}`,
      { signal: AbortSignal.timeout(10_000) },
    ),
  );
  if (!res.ok) throw new Error(`feed answered HTTP ${res.status}`);

  const body = await res.json();
  const all = Array.isArray(body?.events) ? body.events : [];
  const { startMs, endMs } = utcDayWindow(day);

  const list = all.filter((e) => {
    const t = Date.parse(e?.ts);
    return Number.isFinite(t) && t >= startMs && t < endMs;
  });
  // The feed arrives newest-first; the day should replay oldest-first.
  list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const oldestSeen = all.length ? Date.parse(all[all.length - 1]?.ts) : NaN;
  const truncated =
    all.length >= FEED_LIMIT &&
    Number.isFinite(oldestSeen) &&
    oldestSeen >= startMs;

  return { list, truncated };
}

function previousUtcDay() {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

function isValidDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  // Round-tripping catches impossible dates like 2026-13-40, which
  // Date.parse alone would either reject or quietly normalise.
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

function utcDayWindow(day) {
  const startMs = Date.parse(`${day}T00:00:00Z`);
  return { startMs, endMs: startMs + 86_400_000 };
}

/* ------------------------------------------------------------------ */
/* Writing the digest                                                  */
/* ------------------------------------------------------------------ */

async function synthesise(env, day, events) {
  const headers = { "content-type": "application/json" };
  // Access service token headers; the hostname in OLLAMA_URL is gated
  // by a Cloudflare Access Service Auth policy, which is what makes
  // exposing a raw, auth-less Ollama through the tunnel acceptable.
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }

  // 120s covers a cold model load from NVMe at 07:00 plus generation.
  // Single attempt on purpose: a retry after a timeout would double the
  // wait without changing the outcome, and the fallback path is cheap.
  const res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: env.OLLAMA_MODEL,
      stream: false,
      keep_alive: "10m",
      options: { temperature: 0.4, num_predict: 220, num_ctx: 4096 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildEventReport(day, events) },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Ollama answered HTTP ${res.status}`);

  const body = await res.json();
  const raw =
    typeof body?.message?.content === "string" ? body.message.content : "";
  const text = tidy(raw);
  if (!text) throw new Error("Ollama returned an empty message");
  return text;
}

/**
 * The user half of the prompt: a dated header, honest counts, then one
 * compact line per event in UTC order. The three coverage cases (events
 * present, a genuinely quiet day, and a rolled-past buffer) each get
 * explicit instructions so the model never mistakes missing data for
 * a quiet day.
 */
function buildEventReport(day, events) {
  const { list, truncated } = events;
  const lines = [`Date: ${day} (yesterday, UTC).`];

  if (list.length === 0) {
    if (truncated) {
      lines.push(
        "Recorded events: none visible, but the feed's rolling window no longer reaches back through yesterday, so events may have happened and rotated out. Say plainly that the record for the day is incomplete; do not describe the day as quiet.",
      );
    } else {
      lines.push(
        "Recorded events: none. The feed covers the whole day, so yesterday was genuinely quiet. Two or three calm sentences are plenty.",
      );
    }
    return lines.join("\n");
  }

  const counts = {};
  for (const e of list) {
    const level = e.level || "info";
    counts[level] = (counts[level] || 0) + 1;
  }
  const countText = Object.entries(counts)
    .map(([level, n]) => `${level} ${n}`)
    .join(", ");
  lines.push(`Recorded events: ${list.length} (${countText}).`);

  if (truncated) {
    lines.push(
      'The feed may not reach back through the whole day; treat counts as minimums and say "at least" where it matters.',
    );
  }

  lines.push("");
  for (const e of list) lines.push(formatEventLine(e));
  return lines.join("\n");
}

function formatEventLine(e) {
  const t = new Date(Date.parse(e.ts));
  const hh = String(t.getUTCHours()).padStart(2, "0");
  const mm = String(t.getUTCMinutes()).padStart(2, "0");
  const head = [e.level, e.dialect, e.event].filter(Boolean).join(" ");
  const title = (e.title || "").trim();
  const message = (e.message || "").trim();
  const tail = message && message !== title ? `${title} :: ${message}` : title;
  return truncate(`${hh}:${mm} ${head}: ${tail}`, LINE_MAX);
}

/**
 * Local models decorate. Strip wrapping quotes and stray code fences,
 * collapse whitespace into one paragraph, and cut at a sentence
 * boundary if the model ignored its length budget.
 */
function tidy(raw) {
  let text = String(raw)
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  if (text.length > DIGEST_MAX) {
    const cut = text.lastIndexOf(". ", DIGEST_MAX);
    text = cut > 0 ? text.slice(0, cut + 1) : text.slice(0, DIGEST_MAX);
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* Posting                                                             */
/* ------------------------------------------------------------------ */

async function postDigest(env, day, paragraph) {
  await postWebhook(env, {
    username: "atlas-daily-digest",
    embeds: [
      {
        title: `morning digest // ${day}`,
        description: paragraph,
        color: COLOURS.amber,
        footer: FOOTER,
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

/**
 * One retry, and only for outcomes a retry can change: a network
 * failure, a 429 (honouring Discord's retry-after up to five seconds),
 * or a 5xx. A 4xx means the payload is wrong and repeating it is noise.
 */
async function postWebhook(env, payload) {
  const send = () =>
    fetch(env.DIGEST_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

  let res;
  try {
    res = await send();
    if (res.ok) return;
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`HTTP ${res.status}`);
    }
    const hint = Number(res.headers.get("retry-after"));
    await sleep(Math.min(Number.isFinite(hint) ? hint * 1000 : 2000, 5000));
  } catch (err) {
    if (res && res.status !== 429 && res.status < 500) throw err;
    await sleep(2000);
  }

  res = await send();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function fetchWithRetry(doFetch) {
  try {
    const first = await doFetch();
    if (first.status < 500) return first;
  } catch (err) {
    console.warn(`fetch attempt one failed: ${describe(err)}`);
  }
  await sleep(1500);
  return doFetch();
}

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Constant-time string comparison for the run token, mirroring
 * atlas-notify's auth posture. Length is allowed to short-circuit;
 * hiding a 64-character token's length buys nothing.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}~` : s;
}

function describe(err) {
  if (err && err.name === "TimeoutError") return "timed out";
  return (err && err.message) || String(err);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
