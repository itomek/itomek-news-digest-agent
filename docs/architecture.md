# News Digest Agent — Architecture

This document is the canonical design reference for the News Digest Agent. Every implementation issue links to a section here (`§n`). When behavior diverges from this document, update the section in the same PR.

Companion documents:
- [`CLAUDE.md`](../CLAUDE.md) — Claude Code tool-use guidance (focused on *how* to work in this repo, not the system design)
- [`README.md`](../README.md) — user-facing overview, setup, operations

---

## §1 System overview

The News Digest Agent is a single-user, audio-first news aggregator. It runs 24/7 on an AMD Strix Halo workstation (Ubuntu 24.04, 128 GB RAM). A scheduled agent scrapes curated sources, summarizes them with a local LLM (Lemonade Server), and publishes digests to Supabase. The user consumes digests via a mobile web app that reads them aloud with the browser's Web Speech API.

Design invariants:

1. **The LLM is the summarizer.** No separate summarization module. Output quality is tuned through prompts, not code.
2. **Tools are pure functions.** Each `@tool` performs one narrow operation. The agent's reasoning orchestrates them.
3. **Config is data.** Topic definitions live in Supabase, not source.
4. **Local first, cloud for storage.** Inference is local; only digests and logs traverse the network.
5. **Single user.** No multi-tenant concerns. Auth is one email allowlist.

```
                      ┌───────────────────────────────────┐
                      │     NewsDigestAgent(Agent,         │
                      │                  DatabaseMixin)    │
                      │                                    │
┌─────────────┐       │  ┌──────────┐   ┌──────────────┐  │       ┌──────────┐
│  Web Sources │──────▶│  │ @tool    │──▶│ Lemonade     │  │──────▶│ Supabase │
│  (RSS, HTML) │       │  │ scrapers │   │ Server (LLM) │  │       │ (REST)   │
└─────────────┘       │  └──────────┘   └──────────────┘  │       └──────────┘
                      │        │                           │
                      │        ▼                           │
                      │  ┌──────────────┐                  │
                      │  │ DatabaseMixin │                  │
                      │  │ (SQLite)      │                  │
                      │  └──────────────┘                  │
                      └───────────────────────────────────┘
                                   ▲
                                   │
                      ┌────────────────────┐
                      │ APScheduler + systemd│
                      └────────────────────┘
```

---

## §1.5 The local-first stack: GAIA + Lemonade + Strix Halo

Everything that reasons about your news runs on one AMD workstation under your
desk. No inference request, no article text, and no prompt ever leaves the
machine. The only thing that crosses the network is the finished digest on its
way to storage — and the logs that say it happened.

That's not an accident of deployment; it's the whole point. Three layers make it
work:

- 🧠 **GAIA** — *the agent framework.* A GAIA `Agent` reasons over a topic, calls
  `@tool` scrapers, reads what comes back, and decides when the digest is done.
- ⚡ **Lemonade** — *the inference runtime.* GAIA talks to Lemonade Server over a
  standard OpenAI-compatible API on `localhost`; it serves the models that write
  every digest and power source curation.
- 🔴 **Strix Halo** — *the silicon.* 128 GB unified memory lets a heavy model stay
  resident across runs — no reload, no cloud.

```mermaid
flowchart TB
    subgraph HOST["🔴 AMD Strix Halo workstation · Ubuntu 24.04 · 128 GB · 24/7"]
        direction TB
        G["🧠 GAIA — the agent<br/>reasons, calls @tool scrapers,<br/>decides when the digest is done"]
        L["⚡ Lemonade Server — inference runtime<br/>OpenAI-compatible API on localhost<br/>writes every summary"]
        S["🔴 Strix Halo silicon<br/>128 GB unified memory keeps a heavy<br/>model resident — no reload, no cloud"]
        G ==>|"every completion"| L
        L ==>|"tokens generated on"| S
    end
    HOST ==>|"only digests + logs leave the box"| SB[("Supabase")]
    style HOST fill:#f6f8fa,stroke:#888
    style G fill:#f3fff0,stroke:#393
    style L fill:#fff7e6,stroke:#d80
    style S fill:#ffecec,stroke:#d33
```

**What this buys you:** your reading habits and source list never become someone
else's training data or telemetry; there's no per-token bill and no rate limit;
and the round trip is a loopback call, not an internet hop. The cloud's only job
is to hold the output — `digests` and `system_logs` in Supabase — so you can read
the result from your phone.

> Measured throughput — model id, tokens/sec, and per-digest wall-clock on this
> host — belongs here once captured from a real run.
> *(placeholder: run `python -m news_digest "…"` and record the actual numbers
> rather than estimating.)*

### Two model tiers, three jobs

Lemonade serves two locally-resident model tiers, picked per task. Everything
below runs on the Strix Halo GPU — no LLM call leaves the box.

| Activity | Model tier | Config key | Where |
|---|---|---|---|
| **Generate the digest** — the reasoning loop *is* the summarizer (invariant #1) | heavy | `lemonade_heavy_model` | [agent.py](../src/news_digest/agent.py) |
| **Curator: craft the web-search query** — turns a failing source + topic into a Perplexity query | light | `lemonade_light_model` | [`craft_query`](../src/news_digest/curator.py) |
| **Curator: judge candidate relevance** — scores a discovered source against the topic (drives auto-adopt / queue / reject) | light | `lemonade_light_model` | [`judge_relevance`](../src/news_digest/curator.py) |

The **heavy** model does the daily work — generating digests. The two **light**
model calls fire only when the source curator is repairing a persistently-failing
source, and fall back to the heavy model if no light model is configured
([curator.py](../src/news_digest/curator.py)). Article deduplication
(`deduplicate_articles`) is a pure function — **no model involved**.

---

## §1.6 🧠 Meet GAIA — the framework doing the thinking

**GAIA is [AMD's open-source, local-first agent framework](https://github.com/amd/gaia).**
It gives us the hard parts of an LLM agent — a planning loop, a tool registry,
conversation/token accounting, and a client for local inference — so the app
only has to supply *tools* and a *prompt*. We **build on GAIA, we don't fork it**:
a pinned-revision [capability audit](gaia-audit.md) confirmed every primitive we
rely on, with machine-checkable contract tests guarding the pin.

### GAIA at a glance — the four primitives we compose

| Primitive | What GAIA gives us | Where we use it |
|---|---|---|
| 🤖 **`Agent`** | The plan → act → reason loop, tool dispatch, and `process_query()` entry point | base class of [`NewsDigestAgent`](../src/news_digest/agent.py) |
| 🔧 **`@tool`** | A decorator that registers a plain function into a global tool registry the model can call | [`fetch_rss` · `fetch_html` · `parse_article`](../src/news_digest/tools/scraping.py) |
| 💾 **`DatabaseMixin`** | Drop-in SQLite helpers (`init_db`, `query`, `insert`…) for local state | mixed into the agent, [`init_db`](../src/news_digest/agent.py) |
| ⚡ **`LemonadeClient`** | An OpenAI-style client for the **local** Lemonade runtime | model + context management, [`load_model`](../src/news_digest/agent.py) |

### How the pieces compose — GAIA → Lemonade → Strix Halo

Our code is small; GAIA is the engine underneath it, and the engine runs the
model locally on AMD silicon. The same picture, top to bottom, is the whole
local-inference story.

```mermaid
flowchart TB
    subgraph OURS["📰 Our code · src/news_digest/"]
        direction TB
        AG["<b>NewsDigestAgent</b>"]
        TOOLS["@tool scrapers<br/>fetch_rss · fetch_html · parse_article"]
        PROMPT["SYSTEM_PROMPT<br/>(the digest 'job description')"]
    end

    subgraph GAIA["🧠 GAIA framework · amd-gaia"]
        direction TB
        BASE["<b>Agent</b><br/>plan / execute loop · tool registry"]
        TOOLDEC["<b>@tool</b><br/>global registry"]
        DBM["<b>DatabaseMixin</b><br/>SQLite helpers"]
        LC["<b>LemonadeClient</b><br/>OpenAI-style client"]
    end

    subgraph LEM["⚡ Lemonade Server · localhost"]
        direction TB
        API["/api/v1/chat/completions<br/>OpenAI-compatible endpoint"]
        MODEL["heavy 35B model<br/>pinned resident · 32k ctx"]
        API --> MODEL
    end

    subgraph HW["🔴 AMD Strix Halo · the silicon"]
        direction TB
        GPU["Radeon GPU · llama.cpp / vulkan"]
        MEM["128 GB unified memory<br/>(model stays loaded, no reload)"]
        GPU --- MEM
    end

    AG ==>|"inherits"| BASE
    AG ==>|"inherits"| DBM
    TOOLS -->|"registered by"| TOOLDEC
    BASE -->|"advertises tools to model"| TOOLDEC
    AG -.->|"_get_system_prompt()"| PROMPT

    BASE ==>|"every completion runs through"| LC
    LC ==>|"HTTP · stays on localhost"| API
    MODEL ==>|"tokens generated on"| GPU

    style OURS fill:#eef6ff,stroke:#369
    style GAIA fill:#f3fff0,stroke:#393
    style LEM fill:#fff7e6,stroke:#d80
    style HW fill:#ffecec,stroke:#d33
    style AG fill:#fff,stroke:#369,stroke-width:2px
    style BASE fill:#fff,stroke:#393,stroke-width:2px
    style LC fill:#fff,stroke:#d80,stroke-width:2px
    style MODEL fill:#fff,stroke:#d33,stroke-width:2px
```

### Inside one `process_query()` — GAIA's agent loop

When we hand GAIA a topic, it runs its own **planner state machine**
([audit §1.2](gaia-audit.md)): `STATE_PLANNING` → `STATE_EXECUTING_PLAN` /
`STATE_DIRECT_EXECUTION` → `STATE_COMPLETION`, with `STATE_ERROR_RECOVERY` as the
safety net. The model decides which tools to call and when the digest is finished
— that reasoning *is* the summarizer (design invariant #1). Every "reason" step
is a chat completion served by **Lemonade on the Strix Halo GPU**.

```mermaid
stateDiagram-v2
    direction LR
    state "🗺️ Planning" as Planning
    state "⚙️ Executing — the reasoning loop" as Executing {
        direction LR
        [*] --> CallTool
        state "pick a @tool" as CallTool
        state "scrape returns" as ReadResult
        state "enough? what's missing?" as Reason
        CallTool --> ReadResult
        ReadResult --> Reason
        Reason --> CallTool: need more sources
        Reason --> [*]: digest assembled
        note right of Reason
            chat completion →
            Lemonade on Strix Halo GPU
        end note
    }
    state "✅ Completion" as Completion
    state "🛟 Error recovery" as Recovery
    [*] --> Planning: process_query(query)
    Planning --> Executing: plan ready
    Planning --> Completion: simple query (direct execution)
    Executing --> Completion: final-answer JSON
    Executing --> Recovery: tool / LLM error
    Recovery --> Executing: recover & retry
    Recovery --> Completion: degrade gracefully
    Completion --> [*]: result dict
```

### What GAIA hands back — built-in observability

`process_query()` doesn't just return text — it returns a result dict GAIA
assembled with **per-run accounting we log on every digest**
([agent.py](../src/news_digest/agent.py), the `summarize` log entry). That's how
the dashboard knows token cost and latency per topic, for free:

```mermaid
flowchart LR
    PQ["process_query()<br/>result dict"] --> R1["result · the digest JSON"]
    PQ --> R2["input / output / total_tokens"]
    PQ --> R3["duration · steps_taken"]
    PQ --> R4["error_history · conversation"]
    R2 --> LOG[("system_logs<br/>category=summarize")]
    R3 --> LOG
```

### Tuning GAIA for *local* models — the honest part

GAIA's defaults target hosted models; a resident **35B running locally** needs a
firmer hand. Everything we adjust is a GAIA seam, set once in
[`NewsDigestAgent.__init__`](../src/news_digest/agent.py):

- 🎯 **`temperature = 0`** — local models emit malformed JSON far less often when
  deterministic.
- 📏 **`max_tokens = 4096`** — GAIA defaults to 512, which truncates a 5–7-item
  digest mid-JSON.
- 🧵 **`enable_thinking = False`** — the loaded chat models otherwise emit
  "thinking" with empty content, which breaks GAIA's JSON-in-content tool
  protocol.
- 🪟 **32k context window** — pinned via `LemonadeClient.load_model(ctx_size=…)`
  so a multi-source run doesn't overflow Lemonade's 4096 default.
- 🐍 **Publish in Python, not via a tool call** — local models don't reliably emit
  a final publish tool call, so GAIA produces the digest as its *final answer*
  and `_publish_from_result` persists it deterministically.

> The takeaway: GAIA does the orchestration, planning, and local-LLM plumbing; we
> supply three scraper tools, one prompt, and a handful of local-model tuning
> knobs. That's the whole agent.

---

## §1.7 Where GAIA is invoked — the call path

A digest is one call into GAIA. Everything above it is plumbing; everything below
it is the local model doing the reasoning. The chain from a scheduler tick down
to the token generator on the AMD GPU:

```mermaid
flowchart TD
    A["systemd: news-digest.service"] --> B["scheduler.main()<br/>BlockingScheduler, UTC"]
    B -->|"every 15-min tick"| C["run_cycle()"]
    C -->|"one due topic at a time"| D["_run_topic()"]
    D --> E["agent.generate_and_publish(query)"]
    E --> F["self.process_query(query)<br/>↞ THE GAIA hand-off"]

    subgraph GAIA["🧠 GAIA agent loop — amd-gaia (in-process)"]
        direction TB
        G["plan → invoke @tool scrapers<br/>fetch_rss / fetch_html / parse_article"]
        H["chat.send_messages()<br/>temperature=0 · max_tokens=4096"]
        G --> H
        H --> G
    end

    F --> G
    H -->|"HTTP POST /api/v1/chat/completions"| I["⚡ Lemonade Server<br/>localhost · 🔴 Strix Halo GPU"]
    I -->|"final-answer JSON (the digest)"| J["_publish_from_result()<br/>parse JSON, NOT an LLM tool call"]
    J --> K[("Supabase · digests")]

    style F fill:#f3fff0,stroke:#393,stroke-width:2px
    style I fill:#ffecec,stroke:#d33,stroke-width:2px
```

The three places the model/GAIA boundary is crossed — each is one line in the
codebase:

| What | Where | Note |
|---|---|---|
| **GAIA entry point** | `self.process_query(query)` ([agent.py](../src/news_digest/agent.py)) | The *only* call that hands control to GAIA. One per topic run. |
| **GAIA → Lemonade** | GAIA's `chat.send_messages()`, wrapped in `_force_no_thinking` | Every completion in the loop hits `LEMONADE_BASE_URL` over the OpenAI-compatible API. |
| **Direct Lemonade call** | `LemonadeClient(...).load_model(ctx_size=32768)` | The one place we touch Lemonade directly — to pin a 32k context window so multi-source runs don't overflow the 4096 default. |

The agent itself is `NewsDigestAgent(Agent, DatabaseMixin)` — exactly the two
GAIA primitives composed.

---

## §1.8 How the timing works

Two clocks run. A **15-minute tick** decides *whether* any topic is due; each
topic's **cadence** (`24h` or `7d`) decides *when* it actually fires. Because the
local model is the bottleneck, only one topic runs at a time
(`max_instances=1`).

```mermaid
flowchart LR
    T["⏱ Tick<br/>every 15 min"] --> Q{"For each topic:<br/>enabled?"}
    Q -->|"no — kill switch"| SKIP1["skip, log"]
    Q -->|"yes"| DUE{"now − last_digest<br/>≥ cadence?"}
    DUE -->|"no"| SKIP2["not due, wait"]
    DUE -->|"yes"| J["jitter 0–300s"]
    J --> R["run topic<br/>max_instances=1"]
    R --> V{"row landed<br/>in Supabase?"}
    V -->|"yes"| DONE["✓ published"]
    V -->|"no · lemonade_down"| STOP["stop — no retry<br/>(LLM unreachable)"]
    V -->|"no · other"| RETRY{"attempt < 3?"}
    RETRY -->|"yes"| R
    RETRY -->|"no"| ERR["✗ log error<br/>(not faked as success)"]
```

The daily wall-clock picture — the digest loop runs around the clock, with two
maintenance jobs at configurable UTC hours (`config.py` defaults shown):

| Job | When (UTC) | What it does |
|---|---|---|
| 🔁 **Digest cycle** | every 15 min, 24/7 | tick → due-check → run each due topic |
| 🔎 **Source curator** | `04:00` daily *(default)* | repairs failing sources: light-model query craft + relevance judging, plus optional Perplexity web search |
| 🧹 **Retention purge** | `05:00` daily *(default)* | drops digests older than the retention window |

Timing facts worth showing, all from [scheduler.py](../src/news_digest/scheduler.py):

- **Tick: 15 min**, `coalesce + max_instances=1` — if a digest run overruns the
  tick, missed ticks collapse instead of stacking.
- **Jitter: 0–300 s** per topic, so sources aren't all hit on the same instant.
- **Cadence gate:** a topic fires only when `now − last_digest_date ≥ 24h | 7d` —
  publishing is data-driven, not a fixed cron hour.
- **Retry-until-verified:** up to 3 attempts, but it re-reads Supabase to confirm
  a row actually landed — GAIA can report `status=success` on a malformed final
  turn that published nothing.
- **Immediate first cycle** on (re)start so a reboot doesn't delay the first
  digest by 15 min.

---

## §1.9 Service architecture

What actually runs on the box, and what crosses the network:

```mermaid
flowchart TB
    subgraph HOST["🔴 AMD Strix Halo · Ubuntu 24.04 · 128 GB · always-on"]
        subgraph U1["systemd unit: news-digest.service"]
            SCHED["scheduler (BlockingScheduler)<br/>+ NewsDigestAgent in-process"]
            SQLITE[("SQLite<br/>run log · article cache<br/>log fallback")]
            SCHED --- SQLITE
        end
        subgraph U2["systemd unit: lemonade (always-on)"]
            LEM["⚡ Lemonade Server<br/>heavy model pinned resident"]
            GPU["AMD GPU<br/>llama.cpp · vulkan"]
            LEM --- GPU
        end
        SCHED -->|"OpenAI API · localhost"| LEM
    end

    SCHED -->|"scrape RSS/HTML<br/>1.5s/domain, SSRF-guarded"| WEB["🌐 curated sources"]
    SCHED -->|"service_role · digests + logs"| SB[("Supabase<br/>Postgres + RLS")]
    SCHED -.->|"source discovery"| PPLX["Perplexity API"]
    SB -->|"anon key · RLS read-only"| WEBAPP["web app<br/>Cloudflare Pages"]
    WEBAPP -->|"reads digests, TTS playback"| USER["📱 user"]

    style LEM fill:#ffecec,stroke:#d33,color:#000
    style GPU fill:#ffecec,stroke:#d33,color:#000
    style HOST fill:#f6f8fa,stroke:#888
```

The boundary is the whole point: **inference and source text never leave the
host.** Two systemd units share the box — the agent and an always-on Lemonade
with the heavy model resident, talking over `localhost`. Only finished digests
and logs cross to Supabase; the phone reads those through an anon key under RLS.
(The only external call beyond storage is the source-curator's optional
Perplexity web search — that's *external discovery*. The curator's own
reasoning — crafting the query and judging relevance — is local inference on
the light model, same box as the digest.)

---

## §2 Component map

### §2.1 `NewsDigestAgent` — `src/news_digest/agent.py`
Responsibility: orchestrate a single topic run. Inherits from `gaia.agents.base.agent.Agent` and mixes in `gaia.database.DatabaseMixin`. Registers all `@tool` functions in `_register_tools()` and returns the system prompt from `_get_system_prompt()`.
Interface: `process_query(query: str) -> str` — the only entry point external callers use.
Implemented by: #4 (hello-world scope), #9 (full scope).

### §2.2 Tools — `src/news_digest/tools/*.py`
All tools are module-level functions decorated with `@gaia.agents.base.tools.tool`. They take primitives or simple dicts and return serializable dicts. They log via `news_digest.logging.log()`, never via `print` or ad-hoc Supabase calls.

- `scraping.fetch_rss(url, since_hours=24) -> list[dict]` (#5)
- `scraping.fetch_html(url, selector=None) -> dict` (#6)
- `scraping.parse_article(url) -> dict` (#6, uses `trafilatura`)
- `publishing.fetch_topic_config(slug) -> dict` (#8)
- `publishing.push_to_supabase(topic_slug, summary, items, sources_used, token_count, content=None) -> dict` (#8, #58)
- `publishing.get_last_digest_date(topic_slug) -> str | None` (#8)
- `social.fetch_reddit(subreddit, ...) -> list[dict]` (#21, Epic 7)

### §2.3 Config — `src/news_digest/config.py` (#25)
A `pydantic-settings` `Settings` class, module-level singleton. Loaded once at import. Every module imports from here; no `os.getenv()` elsewhere in the codebase.

### §2.4 Logging envelope — `src/news_digest/logging.py` (#26, #15)
`log(level, category, topic_slug=None, message, metadata=None)` writes to Supabase `system_logs` with a local SQLite fallback at `data/system_logs_fallback.sqlite`. `drain_fallback()` ships accumulated rows upward when Supabase is reachable again.

### §2.5 Prompts — `src/news_digest/prompts.py`
A `SYSTEM_PROMPT` constant plus helpers that concatenate it with per-topic `prompt_hint` pulled from `digest_topics`. Extended across #7, #16, #17, #18, #19.

### §2.6 Scheduler — `src/news_digest/scheduler.py` (#13)
APScheduler `BlockingScheduler` process. On each 15-minute tick: pulls enabled topics from Supabase, checks `get_last_digest_date` against cadence, invokes `agent.process_query()` per due topic. Runs one topic at a time (`max_instances=1`) because the local LLM is the bottleneck.

### §2.7 Web app — `web/` (#10–#12, #27, #20, #22)
Vanilla JS + Vite, deployed to Cloudflare Pages. Talks to Supabase via `@supabase/supabase-js`. Auth is Supabase magic link restricted by an email allowlist. All data access goes through RLS with the anon key.

### §2.8 systemd service — `systemd/news-digest.service` (#14)
`Type=simple`, `Restart=on-failure`, bounded by `StartLimitBurst`. Loads `.env` via `EnvironmentFile`. Memory capped at 16 GB as a guardrail despite the 128 GB host.

---

## §3 Data model

### §3.1 Supabase — `supabase/migrations/0001_init.sql` (#3)

```sql
-- Topic configuration
CREATE TABLE digest_topics (
  id serial PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  cadence text NOT NULL CHECK (cadence IN ('24h','7d')),
  sources jsonb NOT NULL,           -- list of {type: 'rss'|'html'|'reddit', url, ...}
  prompt_hint text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Published digests
CREATE TABLE digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_slug text NOT NULL REFERENCES digest_topics(slug),
  content text NOT NULL,            -- flat TTS-safe prose; derived from summary+items on #58+ rows
  summary text,                     -- short top-level overview; null on pre-#58 rows
  items jsonb,                      -- ranked items (see §7.1); null on pre-#58 rows
  cadence text NOT NULL,
  digest_date date NOT NULL,
  sources_used jsonb NOT NULL,
  token_count integer,
  prompt_version text NOT NULL,     -- sha256[:12] of SYSTEM_PROMPT + prompt_hint at gen time
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (topic_slug, digest_date)  -- idempotent scheduler retries
);
CREATE INDEX ON digests (topic_slug, digest_date DESC);

-- Structured logs
CREATE TABLE system_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL CHECK (level IN ('info','warn','error')),
  category text NOT NULL,           -- schedule|scrape|summarize|publish|feedback|hello_world|system
  topic_slug text,
  message text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON system_logs (created_at DESC, category);
```

RLS posture:
- `anon` role: `SELECT` on `digests`, `digest_topics` (enabled-only), `system_logs`.
- `service_role`: full access; used by the agent only.
- No `INSERT/UPDATE/DELETE` grants to `anon`.

### §3.2 Local SQLite — `data/news_digest.db`
`DatabaseMixin` handles run logs and article caching. Schema is GAIA-defined; we do not extend it.

### §3.3 Fallback SQLite — `data/system_logs_fallback.sqlite`
Mirrors `system_logs` schema with one extra column `synced_at timestamptz NULL`. `drain_fallback()` sets `synced_at` after a successful Supabase insert and eventually vacuums.

### §3.4 Prompt versioning
`prompt_version` is `sha256(SYSTEM_PROMPT + '\n' + prompt_hint)[:12]` at generation time. This makes every digest attributable to a specific prompt. A new issue or a scripted query can answer "did quality regress after we changed the prompt on date X?".

---

## §4 Control flow

Sequence of a single topic run.

```mermaid
sequenceDiagram
    participant Cron as APScheduler
    participant Agent as NewsDigestAgent
    participant SB as Supabase
    participant Tool as @tool (scrape)
    participant LLM as Lemonade
    participant Log as logging.log()

    Cron->>SB: SELECT enabled topics
    Cron->>SB: get_last_digest_date(slug)
    Note over Cron: due? → invoke agent
    Cron->>Agent: process_query("Generate <slug> for today")
    Agent->>SB: fetch_topic_config(slug)
    Agent->>Tool: fetch_rss(url) × N sources
    Tool->>Log: log(info, scrape, slug, ...)
    Agent->>LLM: chat.completions (system + hint + articles)
    LLM-->>Agent: digest text
    Agent->>SB: push_to_supabase(slug, content, ...)
    Agent->>Log: log(info, publish, slug, {digest_id})
```

Scheduler tick cadence: every 15 minutes. Topic cadence checked against `get_last_digest_date`. Jitter: 0–300 s random delay per topic to spread load.

---

## §5 Cross-cutting patterns

Every developer touching this codebase needs these five patterns in working memory.

### §5.1 Config loader (#25)

```python
from news_digest.config import settings
settings.supabase_url          # validated string
settings.lemonade_heavy_model  # e.g., "Qwen2.5-32B-Instruct"
```

Loaded once at process start via `pydantic-settings`. Tests override with `monkeypatch.setenv` before import, or instantiate `Settings(...)` directly.

### §5.2 Logging envelope (#26, #15)

```python
from news_digest.logging import log
log(level="info", category="scrape", topic_slug="ai_models",
    message=f"fetched {len(entries)} entries",
    metadata={"url": url, "duration_ms": elapsed})
```

Contract: never raises. Supabase failure → SQLite fallback → still never raises. Caller does not inspect the return value.

### §5.3 Retry policy

Scraping tools only. `@retry` lives on a **private helper**, not on the public `@tool`-decorated function. This separation is intentional: `@tool` functions must never raise — they always return a typed value (e.g. `list[dict]`). Isolating the retry budget inside the helper preserves that contract.

```python
from tenacity import (
    retry, retry_if_not_exception_type,
    stop_after_attempt, wait_exponential,
)

class _NonRetryableHttp(Exception):
    """4xx (except 429) and oversized body — skip retry, log once."""

@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, max=30),
    reraise=False,
    retry=retry_if_not_exception_type(_NonRetryableHttp),
    retry_error_callback=_retry_returns_none,   # returns None sentinel on exhaustion
)
def _fetch_feed_bytes(url: str, ...) -> bytes | None: ...

@tool
def fetch_rss(url: str, since_hours: int = 24) -> list[dict]:
    raw = _fetch_feed_bytes(url)   # None → retries exhausted
    if raw is None:
        log("warn", "scrape", ...)
        return []
    ...
```

Key knobs:
- **429 is retryable.** `_NonRetryableHttp` is raised only on 4xx ≠ 429. 429 falls through to `raise_for_status()` and is retried with backoff.
- **Exhaustion → `None` sentinel.** `reraise=False` alone would raise `tenacity.RetryError`; the `retry_error_callback` intercepts it, captures the last exception for diagnostic logging, and returns `None`. The public tool translates `None` to `[]` and logs once.
- **Single-log invariant.** `_fetch_feed_bytes` never calls `log()`. All logging happens in the public tool so each failure mode maps to exactly one log entry.

Publishing and LLM calls do **not** retry automatically — failures are meaningful and should be logged and surfaced. The scheduler handles topic-level failure isolation.

### §5.4 Per-domain rate limiter

Module-level dict in `scraping.py`: `_last_fetch: dict[str, float] = {}`. Before each request, sleep to enforce 1.5 s since the last fetch to the same domain. Thread-safe via `threading.Lock`.

### §5.5 Kill switch

Before dispatching to any topic, the scheduler re-reads `digest_topics.enabled`. Setting `enabled=false` in Supabase pauses that topic without SSH. A `system` category log entry records the pause. The scheduler itself is paused by `systemctl stop news-digest`.

---

## §6 Failure modes

| Failure | Detection | Recovery | Logged as |
|---|---|---|---|
| RSS feed 5xx / DNS | `httpx` exception | `tenacity` retry 3×; skip source on exhaustion | `warn` / `scrape` |
| Malformed feed entries | `feedparser` raises / missing fields | drop entry, continue | `warn` / `scrape` |
| Lemonade Server down | connection refused | log, skip topic, continue scheduler | `error` / `summarize` |
| Digest too long / short | word-count check post-gen | one re-prompt with "too long/short"; then accept | `warn` / `summarize` |
| Supabase publish fails | `supabase-py` exception | write fallback SQLite; `drain_fallback` retries | `error` / `publish` |
| Duplicate publish for a date | `UNIQUE(topic_slug, digest_date)` | `ON CONFLICT UPDATE` (idempotent) | `info` / `publish` |
| Scheduler crash | process exits | systemd `Restart=on-failure` within 60 s | journald |
| Crash loop | `StartLimitBurst` exceeded | systemd stops restarting; surfaces in `journalctl` | journald |
| Missed digest (24h topic) | scheduled Edge Function 12:00 ET | writes `warn` / missed_digest row; UI surfaces | `warn` / `system` |
| Source consistently failing | materialized view < 50% success / 7 d | UI surfaces red; user manually disables or updates source | view only |

---

## §7 Prompt architecture

### §7.1 System prompt and output contract
Single `SYSTEM_PROMPT` constant in `prompts.py`. The LLM assembles a
**structured digest** — a short top-level `summary` plus a ranked `items` array —
and calls `push_to_supabase(topic_slug, summary, items, sources_used, token_count)`.

Canonical item shape (Python dict keys and TypeScript `DigestItem` interface match verbatim):
```jsonc
{
  "headline": "one-line description",
  "blurb":    "1–2 sentences — what happened (shown collapsed)",
  "detail":   "fuller prose — why it matters, specifics/numbers (expandable)",
  "metadata": {
    "sources": [{"title": "Source Name", "url": "https://…"}],
    "tags":    ["optional", "tags"]
  }
}
```

`content` (the `text NOT NULL` column) is **derived** by `flatten_digest(summary, items)`
inside `push_to_supabase`. It is plain prose, no URLs or markdown — kept as the TTS
source (#11) and the backward-compat fallback for pre-#58 rows where `summary`/`items`
are null. Source links live only in `metadata.sources`.

Hard rules for the output:
- `summary` and `blurb`: clean prose, no raw URLs.
- `metadata.sources`: machine-readable source links (rendered as `<a>` in the web app,
  guarded to http(s) only against XSS via LLM-injected `javascript:` / `data:` schemes).
- Rank items by significance; explain why each item matters in `detail`.
- Aim for one to two sentences of `summary` and three to seven items.

### §7.2 Per-topic prompt hint
`digest_topics.prompt_hint` contains topic-specific steering: what to emphasize, what to exclude. Concatenated after `SYSTEM_PROMPT` at run time.

**Per-item sentiment (world_news, #19).** The `world_news` prompt_hint instructs the LLM to set a `sentiment` key inside each item's `metadata` object — a dedicated field, deliberately *not* an element of the free-form `tags` array. Allowed values (lowercase): `positive`, `negative`, `neutral`, `concerning`; the canonical set lives in `SENTIMENT_TAGS` (`src/news_digest/prompts.py`) and is mirrored by the web renderer's whitelist. The web app (`web/src/views/digest-card.ts`) renders a small badge alongside the item headline when `metadata.sentiment` is one of the four values, and silently ignores anything else — the value is LLM-generated, so it is validated before display and never interpolated as HTML.

### §7.3 Dedup context
When running a topic that overlaps with another (e.g., `ai_updates` after `ai_models`), the agent fetches the previous day's sibling digest and includes it in the prompt: *"Do not repeat items already covered in this context."* Managed in the agent, not the prompt templates.

### §7.4 Prompt versioning
At generation time, compute `sha256(SYSTEM_PROMPT + '\n' + prompt_hint)[:12]` and store on `digests.prompt_version`. A history of prompt changes lives in git; `prompt_version` ties any published digest to its exact prompt text.

### §7.5 Length enforcement
Post-generation: `enforce_length(summary, items, regenerate)` measures word count over
`flatten_digest(summary, items)` — the flattened structured text, not the raw LLM
output. If the word count is outside the 500–800 ± 20 % band (400–960), re-prompt
once with a length-correction hint. Accept the second attempt regardless. Returns a
`(summary, items)` tuple. `enforce_length` is a pure function and is not currently
wired into the agent loop; it is available for future integration.

---

## §8 Security & secrets

- **`.env` is the boundary.** It lives on the Strix Halo only. `systemd` loads it via `EnvironmentFile`. It is in `.gitignore`. `.env.example` tracks the schema.
- **Service-role key:** used only by the agent process. Never shipped to the browser.
- **Anon key:** used by the web app. Relies on RLS.
- **Auth allowlist:** Supabase Edge Function (trigger on `auth.users` insert) rejects sign-ups not on the allowlist.
- **Scraping hygiene:** identifiable `User-Agent`, robots.txt respected where defined, 1.5 s polite delay per domain.
- **URL safety:** `_validate_url` in `scraping.py` rejects non-`http(s)` schemes and resolves the hostname via `socket.getaddrinfo`, blocking loopback, RFC 1918, link-local, multicast, and reserved IPs before any bytes leave the process. This guards against prompt-injection SSRF (LLM coerced into fetching `localhost:13305` or cloud IMDS). Implemented in #5.

---

## §9 Deployment topology

- **Host:** AMD Strix Halo, Ubuntu 24.04. Single user account runs both the agent and Lemonade.
- **Process:** one `news-digest.service` managed by systemd.
- **Data volume:** `/var/lib/news-digest/` holds `data/` (SQLite DBs). Writable only by the service user.
- **Lemonade:** separate systemd unit, always-on. Heavy model pinned resident.
- **Web app:** Cloudflare Pages, deploys from `web/` directory on `main`.
- **Supabase:** free tier, project `News Digest` (distinct from Command Center).
- **Upgrades:**
  1. `git pull && pip install -e ".[dev]"`
  2. Apply any new migrations: `supabase db push`
  3. `systemctl restart news-digest`
  4. Verify log view shows a `system`/`startup` entry.

---

## §10 Testing strategy

| Layer | Tool | Scope |
|---|---|---|
| Unit | `pytest` | Pure functions in `tools/*.py`, parsers, `config`, `logging` |
| Integration | `pytest` + test Supabase project | Round-trip: tool writes, RLS enforcement |
| Smoke | Manual `python -m news_digest "Generate..."` | End-to-end run against production Lemonade + Supabase |
| UI | Manual on iPhone Safari | #10–#12, #27 |

No mocked Supabase in integration tests — per project convention, mocks mask migration/RLS issues. Instead, a dedicated test project and schema reset between runs.

CI (#24) runs unit + integration. Smoke and UI tests are manual and gate each epic exit.

---

## §11 Epic-to-component matrix

| Component | E0 | E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 |
|---|---|---|---|---|---|---|---|---|---|
| `docs/architecture.md` | ✚ | · | · | · | · | · | · | · | · |
| CI / pre-commit | ✚ | · | · | · | · | · | · | · | · |
| `config.py` | · | ✚ | · | · | · | · | · | · | · |
| `logging.py` | · | ✚ | · | · | ● | · | · | · | · |
| `agent.py` | · | ✚ | ● | · | · | · | · | · | · |
| `tools/scraping.py` | · | · | ✚ | · | ● | ● | · | ● | · |
| `tools/publishing.py` | · | · | ✚ | · | ● | · | · | · | · |
| `prompts.py` | · | · | ✚ | · | · | ● | · | · | ● |
| `scheduler.py` | · | · | · | · | ✚ | · | · | · | · |
| `systemd/` | · | · | · | · | ✚ | · | · | · | · |
| Supabase schema | · | ✚ | · | · | · | · | ● | · | ● |
| `web/` | · | · | · | ✚ | ● | · | ● | · | ● |

Legend: ✚ introduces · untouched ● extends

Tracking issues: #28 (E0), #29 (E1), #30 (E2), #31 (E3), #32 (E4), #33 (E5), #34 (E6), #35 (E7), #36 (E8).

---

## §12 Glossary & links

- **GAIA** — AMD's local-first agent framework. [amd/gaia](https://github.com/amd/gaia). Primitives used: `Agent`, `@tool`, `DatabaseMixin`, `LemonadeClient`.
- **Lemonade Server** — AMD-optimized LLM runtime with OpenAI-compatible API. `config.py` defaults `LEMONADE_BASE_URL` to `http://localhost:8000/api/v1`; the Strix Halo host overrides this to `http://localhost:13305/api/v1` (Lemonade snap default) via `.env`. See [gaia-audit §2.2.b](gaia-audit.md).
- **Strix Halo** — AMD's APU for workstations; hosts this project 24/7.
- **BoardDocs** — platform hosting township meeting minutes for local news topic.
- **PRAW** — Python Reddit API Wrapper (Epic 7 source).
- **RLS** — Supabase Row-Level Security; primary access-control mechanism.
- **Cadence** — a topic's publish frequency; currently `24h` or `7d`.

---

*Last updated: 2026-06-15. Changes to architecture land on `main` with their implementation PR; this document is the source of truth.*
