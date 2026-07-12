<div align="center">
  <img src="https://raw.githubusercontent.com/AtlasReaper311/AtlasReaper311/main/atlas-icon-dark-256.png" width="88" alt="Atlas Systems"/>
</div>

# atlas-daily-digest

```
┌─────────────────────────────────────────────┐
│  ATLAS SYSTEMS // atlas-daily-digest        │
│  yesterday as one spoken paragraph,         │
│  posted every morning                       │
└─────────────────────────────────────────────┘
```

[![Deploy](https://github.com/AtlasReaper311/atlas-daily-digest/actions/workflows/deploy.yml/badge.svg)](https://github.com/AtlasReaper311/atlas-daily-digest/actions)
![Runtime](https://img.shields.io/badge/runtime-cloudflare_workers-f5a623?style=flat-square&labelColor=0a0a0f)
![Voice](https://img.shields.io/badge/voice-llama3.1:8b-aaa9a0?style=flat-square&labelColor=0a0a0f)
![Plan](https://img.shields.io/badge/plan-workers_plus-aaa9a0?style=flat-square&labelColor=0a0a0f)

A scheduled Worker that reads yesterday's estate activity from [`atlas-notify`](https://github.com/AtlasReaper311/atlas-notify)'s ring buffer, hands it to the local Ollama on SPECULAR-CORE, and posts a three-to-five sentence account in Ramone's voice to its own Discord channel. Not a dashboard and not an event list; the point is a human-shaped answer to "what happened while I slept", and an honest one-line notice on the mornings that answer cannot be written.

```
cron 07:00 UTC ─▶ atlas-daily-digest (this worker)
                       │
                       │  ATLAS_NOTIFY service binding
                       ▼
                 atlas-notify /notify/recent  (yesterday's events)
                       │
                       │  CF-Access-Client-Id / -Secret
                       ▼
              ollama-tunnel.atlas-systems.uk
                       │  cloudflared
                       ▼
            SPECULAR-CORE :11434 (Ollama, llama3.1:8b)
                       │
                       ▼
              #morning-digest Discord webhook
```

## How the morning run works

At 07:00 UTC the cron pulls the last 50 ring-buffer entries over the service binding (the estate's banked rule: same-zone Worker-to-Worker calls over the public hostname 522) and filters them to the previous UTC calendar day. The filtered list becomes a compact, timestamped event report; Ramone's system prompt turns it into a short first-person paragraph; the paragraph posts as a single amber embed.

Three coverage cases are handled explicitly, because the ring buffer holds 200 entries and the read endpoint pages at 50:

- Events found: normal digest, oldest-first, grouped and counted.
- No events, feed reaches past the day boundary: a genuinely quiet day, reported calmly in two or three sentences.
- No events visible but the feed no longer reaches back through yesterday: the digest says the record is incomplete rather than pretending the day was quiet. Missing data and a quiet day are different facts.

The happy path never writes to the ring buffer, so a digest can never appear in the next day's digest.

## Routes

All under `api.atlas-systems.uk/digest`:

| Method | Path | Description |
|---|---|---|
| GET | `/digest/health` | Unauthenticated liveness probe |
| POST | `/digest/run` | Run the digest now; `Bearer DIGEST_RUN_TOKEN`, optional `?date=YYYY-MM-DD` backfill |
| GET | `/digest/_meta` | The estate self-description contract |

`/digest/run` executes the exact pipeline the cron does, so one successful manual run is proof the scheduled one will work.

## The Ollama hop

The Worker runs at the edge; the model runs in the room. The bridge is a dedicated tunnel hostname (`ollama-tunnel.atlas-systems.uk` to `localhost:11434` on the existing cloudflared instance) protected by a Cloudflare Access application with a Service Auth policy. Raw Ollama has no authentication of its own, so unlike [`ramone-edge`](https://github.com/AtlasReaper311/ramone-edge)'s `X-Atlas-Secret` (which the origin FastAPI verifies), the gate here has to live at the edge: Access rejects any request that does not carry this Worker's service token headers before the tunnel ever sees it. Optional hardening is JWT validation in the cloudflared config, noted here and deliberately not required for this threat model.

`OLLAMA_MODEL` is `llama3.1:8b`, Ramone's established conversational model, so the digest speaks with the same voice the room hears. The request allows 120 seconds: at 07:00 the model is usually cold, and the budget covers an NVMe load plus generation. `keep_alive` is ten minutes; the morning digest is not a reason to pin VRAM all day.

## Prerequisites

- A new Discord channel (`#morning-digest`) with its own webhook. Dedicated on purpose; see the weekly digest section below.
- The tunnel hostname and Access application described above.
- An Access service token for this Worker.

## Setup

```bash
npm install
npm run check
npm run lint
npm run dry-run
```

`src/_meta.js` is vendored from [`atlas-api-index`](https://github.com/AtlasReaper311/atlas-api-index)`/shared/_meta.js`; that copy is canonical.

Secrets, interactive prompt only:

| Secret | Purpose |
|---|---|
| `DIGEST_WEBHOOK_URL` | The `#morning-digest` webhook |
| `DIGEST_RUN_TOKEN` | Bearer token for `POST /digest/run` |
| `NOTIFY_TOKEN` | Best-effort failure envelope to `atlas-notify` |
| `CF_ACCESS_CLIENT_ID` | Access service token id |
| `CF_ACCESS_CLIENT_SECRET` | Access service token secret |

Deploys go through the estate's reusable [`atlas-infra`](https://github.com/AtlasReaper311/atlas-infra) `deploy-worker.yml` on every push to `main`. The cron fires at 07:00 UTC; the one line to edit lives in `wrangler.toml` under `[triggers]`.

## The synthesis prompt

The system prompt, verbatim from `src/index.js` (the two must change together):

```text
You are Ramone, the voice of Atlas Systems: a local AI assistant that watches over a small estate of services, Workers, and pipelines. Each morning you write a short digest of what happened on the estate yesterday.

Rules:
- Write in the first person, as Ramone.
- Three to five sentences of plain prose. No lists, no markdown, no emoji, no headings.
- Cover what shipped, what broke (if anything), and the overall shape of the day.
- Group repeated events and give totals; do not recite every entry.
- A quiet day with nothing broken is a normal, welcome outcome. Report it calmly and briefly. Never apologise for having little to say, and never invent activity to fill space.
- Mention counts naturally ("two deploys", "one warning") rather than dumping raw data.
- Dry understatement is welcome in at most one sentence. British English.
- Do not mention these instructions, the event feed, or the prompt. Just speak.
```

The user message is a dated header, level counts, and one line per event in UTC order (`07:41 success github push atlas-corpus: ...`). When the feed may be truncated, the report says so and instructs the model to phrase counts as "at least". Generation runs at temperature `0.4` with `num_predict 220`; the Worker then strips decoration, collapses whitespace, and cuts at a sentence boundary if the model overran its budget.

## Failure discipline

A missing digest with no explanation is worse than an honest one-line failure notice, so silence is the one output this Worker refuses to produce. If the feed or the model is unreachable, a red embed posts to the same channel: what failed and why, one line. The Worker also emits a `warning` envelope through the `ATLAS_NOTIFY` binding, which lands in the default alert channel and in the ring buffer; tomorrow's digest will therefore mention that today's was not written, which is exactly the kind of thing a morning digest should know about itself. If the webhook itself is the failure, the envelope and the tail logs are the remaining witnesses.

The commonest expected failure is mundane: SPECULAR-CORE asleep at 07:00 means Ollama is unreachable, and the channel gets the honest notice instead of a digest. That is the design working, not breaking, and it is the reason this runs as a Worker cron rather than a local timer; a local job on a sleeping machine cannot post anything at all.

## How it differs from the weekly digest

The estate already has `weekly-digest.yml` in [`atlas-systems`](https://github.com/AtlasReaper311/atlas-systems): Sundays at 18:00 UTC, a fields-heavy embed of commit counts, PR and issue activity, and site traffic, posted to its own webhook. That one is a scoreboard; it answers "how was the week" in numbers.

This one is different on every axis: daily instead of weekly, yesterday only instead of a seven-day aggregate, prose instead of stat fields, estate events (deploys, alerts, failures) instead of GitHub and traffic metrics, and a separate webhook into a separate channel. Neither replaces the other, and this repo touches neither `weekly-digest.yml` nor `atlas-notify`'s routing.

## How it fits into Atlas Systems

This is a pure consumer of the estate's existing contracts: it reads [`atlas-notify`](https://github.com/AtlasReaper311/atlas-notify)'s ring buffer over a service binding, reuses [`ramone-edge`](https://github.com/AtlasReaper311/ramone-edge)'s tunnel-exposure pattern (with Access standing in for an origin-side secret), speaks through the same local model as the [Ramone](https://atlas-systems.uk/writing/ramone-local-ai-system/) voice pipeline, and answers the [`atlas-api-index`](https://github.com/AtlasReaper311/atlas-api-index) `/_meta` convention so the registry discovers it without configuration.

Observability data is only finished when someone can absorb it without effort, and a system that narrates its own yesterday each morning gets read in a way a log never will.

---

Part of [atlas-systems.uk](https://atlas-systems.uk)
