# GAIA Framework Capability Audit

This audit confirms which GAIA primitives the project depends on are available
at the currently pinned `amd-gaia` revision, and records the go/no-go decision
on building custom mixins. The empirical surface (import paths, signatures,
MRO compatibility) is encoded as machine-checkable assertions in
[`tests/test_gaia_contract.py`](../tests/test_gaia_contract.py); this document
captures the rationale and decisions only. When the pin moves, run the contract
tests first and update both files together.

## §1 Findings

### §1.0 Metadata

| Field | Value |
|---|---|
| Audit date | 2026-05-06 |
| Pinned revision | [`da5ba458dc1b147927e4c1e8b7c40c473e0da41e`](https://github.com/amd/gaia/commit/da5ba458dc1b147927e4c1e8b7c40c473e0da41e) |
| Commit date | 2026-04-17 |
| `pip show amd-gaia` Version | 0.17.2 |
| Latest PyPI release | [v0.17.5](https://pypi.org/project/amd-gaia/0.17.5/) (2026-05-01) |
| Probe environment | Strix Halo (Ubuntu 24.04, Python 3.12.3), throwaway venv at `/tmp/iss1-probe` |
| Lemonade endpoint | `http://localhost:13305/api/v1` (note: differs from `config.py` default — see §2.2.b) |

The pinned SHA was committed 3 days after v0.17.2 released and 3 days before
v0.17.3 — it represents 0.17.2 plus a small number of intervening patches.
`pip show` reports `0.17.2` because that was the most recent tagged release at
the SHA's commit time.

### §1.1 Capability matrix

| Primitive | Available | Confirmed via | Notable gaps | Decision |
|---|---|---|---|---|
| `Agent` | Yes | `test_primitives_importable`, `test_agent_process_query_signature` | `process_query` does not accept a `model=` kwarg; constructor takes 18 kwargs (incl. `use_claude`, `use_chatgpt` for cloud fallbacks the project will not enable) | Use as-is; matches [agent.py:12](../src/news_digest/agent.py) |
| `@tool` | Yes | `test_primitives_importable`, `test_tool_decorator_supports_bare_and_kwargs_forms` | Decorator accepts `**kwargs` but silently ignores them — no per-tool model routing | Use as-is; matches [tools/hello.py:7](../src/news_digest/tools/hello.py) |
| `DatabaseMixin` | Yes | `test_primitives_importable`, `test_agent_mro_resolves_with_database_mixin` | None | Use as-is; **NewsDigestAgent does not yet mix it in — see §2.2.a** |
| `LemonadeClient` | Yes | `test_primitives_importable`, `test_lemonade_client_completions_accepts_per_call_model` | None | Use as-is; not yet imported directly (Agent uses it internally) |
| Multi-model routing | Partial | `test_lemonade_client_completions_accepts_per_call_model`, `test_agent_process_query_signature` | Not at the Agent layer; available at the LemonadeClient layer | Branch A — see §2.1 |

### §1.2 `Agent` (`gaia.agents.base.agent.Agent`)

- Abstract base class (`Agent` extends `abc.ABC`); concrete subclasses must
  implement `_register_tools` and `_get_system_prompt`.
- `process_query(self, user_input: str, max_steps: int = None, trace: bool = False, filename: str = None) -> Dict[str, Any]`
  is the documented entry point. Returns a dict, not a string — note for any
  consumer that expects a plain string.
- Constructor surface includes `base_url`, `model_id`, `streaming`,
  `max_steps`, `max_plan_iterations`, `min_context_size`, `silent_mode`,
  `skip_lemonade`, plus `use_claude` / `use_chatgpt` / `claude_model` for
  remote-LLM fallbacks the project does not enable.
- Useful public surface beyond `process_query`: `system_prompt`,
  `rebuild_system_prompt`, `list_tools`, `get_tools`, `get_tools_info`,
  `display_result`, `get_error_history`, `validate_json_response`, plus
  `STATE_PLANNING` / `STATE_EXECUTING_PLAN` / `STATE_DIRECT_EXECUTION` /
  `STATE_COMPLETION` / `STATE_ERROR_RECOVERY` constants for the planner state
  machine.

### §1.3 `@tool` (`gaia.agents.base.tools.tool`)

- Signature: `tool(func: Callable = None, *, atomic: bool = False, **kwargs)`.
- Both `@tool` (bare) and `@tool(atomic=True)` are supported.
- Returns the original function unchanged; registration is a side-effect into
  a module-level `_TOOL_REGISTRY` dict (global, not per-agent-instance).
- `**kwargs` are explicitly ignored ("for backward compatibility") — passing
  `@tool(model="...")` would not raise but would have no effect. This is the
  decisive negative result for per-tool model routing.

### §1.4 `DatabaseMixin` (`gaia.database.DatabaseMixin`, re-exported from `gaia.database.mixin`)

- Public methods: `init_db`, `db_ready`, `query`, `insert`, `update`, `delete`,
  `execute`, `transaction`, `table_exists`, `close_db`.
- `__init__` signature is `(self, /, *args, **kwargs)` — masked. The audit did
  not exercise instantiation (the contract test only constructs the subclass
  body); a follow-up that actually uses the mixin will need to read
  `gaia/database/mixin.py` for the real init contract.
- **MRO compatibility**: `class _Probe(Agent, DatabaseMixin)` resolves cleanly
  to `_Probe → Agent → ABC → DatabaseMixin → object`. No `_register_tools` /
  `_get_system_prompt` collisions.

### §1.5 `LemonadeClient` (`gaia.llm.lemonade_client.LemonadeClient`)

- `__init__(self, model: Optional[str] = None, host: Optional[str] = None, port: Optional[int] = None, base_url: Optional[str] = None, verbose: bool = True, keep_alive: bool = False)`.
- Per-call `model` IS supported on the inference methods:
  `completions(model: str, prompt: str, ...)`,
  `chat_completions(...)`, `responses(...)`, `embeddings(...)`.
- Live probe against `http://localhost:13305/api/v1` succeeded during this
  audit: `list_models()` returned `{'data': [], 'object': 'list'}` (Lemonade
  was running but no models were loaded — the empty result is a clean
  protocol-level success, not a connection failure).
- Rich operational surface (`load_model`, `unload_model`, `pull_model`,
  `health_check`, `get_status`, `get_system_info`, `keep_alive`,
  `launch_server`, `terminate_server`) — useful for the operational tooling
  Epic 4 will need but out of scope for this audit.

### §1.6 Multi-model routing — the headline question

The architecture's invariants are explicit ([CLAUDE.md](../CLAUDE.md),
[docs/architecture.md §1](architecture.md)): **the LLM IS the summarizer**, and
**tools are pure functions**. A single agent run uses a single model. Multi-
model routing is therefore not a current requirement.

Mechanically, the picture at this pin is:

- **Agent layer:** `process_query` does NOT accept a `model=` kwarg. The agent
  is constructed with a single `model_id` and uses it for the entire run.
- **LemonadeClient layer:** every inference method takes `model=` per call, so
  arbitrary per-call routing is mechanically possible if a future feature ever
  needs it.

If per-tool model selection ever becomes a real requirement (e.g., a light
model for deduplication/classification, a heavy model for summarization), the
options are documented in §2.2.d. Designing a wrapper today would violate the
"tools are pure functions" invariant and is explicitly out of scope.

## §2 Decision & gaps

### §2.1 Go / no-go: **Branch A — use GAIA as-is**

All four primitives are present and behave as architecture.md §2.1/§12 expects:

- `Agent` is importable, abstract, with the expected hooks.
- `@tool` registers global tools with the bare and kwargs forms the codebase
  uses today.
- `DatabaseMixin` is importable and MRO-compatible with `Agent`.
- `LemonadeClient` is importable, per-call model selection works, the live
  endpoint responds.

Per-tool model routing at the agent layer is absent, but per the project's own
invariants this is not a gap that needs solving today. We do not need a custom
agent base, a custom mixin, or a per-tool wrapper. Proceed to Epic 2.

### §2.2 Follow-ups

#### §2.2.a `DatabaseMixin` not yet mixed into `NewsDigestAgent`

[architecture.md §2.1](architecture.md) calls for
`class NewsDigestAgent(Agent, DatabaseMixin)`, but
[src/news_digest/agent.py:18](../src/news_digest/agent.py) currently inherits
only `Agent`. The MRO is verified clean (see
`test_agent_mro_resolves_with_database_mixin`), so this is contract drift,
not an upstream blocker. Add the mixin during the [#9](https://github.com/itomek/itomek-news-digest-agent/issues/9) end-to-end work, or sooner
if any earlier issue (e.g., #5–#8) needs SQLite state. **File a follow-up
issue: "Add `DatabaseMixin` to `NewsDigestAgent`".**

#### §2.2.b Lemonade base URL drift

[`src/news_digest/config.py:22`](../src/news_digest/config.py) defaults
`lemonade_base_url` to `http://localhost:8000/api/v1`, but Lemonade on the
Strix Halo dev box is reachable at `http://localhost:13305/api/v1` (snap
default). The probe confirmed `:13305` works. The default was correct against
an older Lemonade build but is not reality today.

[architecture.md §12](architecture.md) carries the same stale value
("Default endpoint `http://localhost:8000/api/v1`"). Anyone setting up from
the architecture doc would copy the wrong port. **The follow-up issue must
update both [`src/news_digest/config.py`](../src/news_digest/config.py) AND
[`docs/architecture.md` §12](architecture.md) atomically — fixing only one
leaves the other as the authoritative wrong answer.** File a follow-up issue:
"Update Lemonade default URL to port 13305 in config.py and architecture.md
§12", or fold into the Epic 1 closeout work alongside #2.

#### §2.2.c Deferred PyPI migration — preserve supply-chain integrity

The pin migration from git+SHA to PyPI semver is intentionally deferred to a
separate PR. When that PR lands:

- **Recommended target: `amd-gaia==0.17.5`** (latest as of audit date) —
  exact pin, not a range.
- **Use hash pinning** via `uv.lock`, or `pip install --require-hashes` if
  staying on plain pip. A range like `>=0.17.5,<0.18` is strictly weaker than
  a git+SHA pin: it accepts any future patch release without re-review,
  whereas the SHA is immutable. Do not weaken supply-chain integrity for
  ergonomics.
- The future migration must run [`tests/test_gaia_contract.py`](../tests/test_gaia_contract.py) before
  merging — that's the regression tripwire for any signature drift between
  0.17.2 and 0.17.5.

**File a follow-up issue: "Migrate `amd-gaia` pin from git SHA to PyPI 0.17.5
with hash pinning".**

#### §2.2.d Multi-model routing — if it ever becomes a real requirement

Not a gap today. If the project grows to need per-tool model selection, the
two viable paths (in order of preference) are:

1. **Push the change upstream in `amd/gaia`** — add a `model=` kwarg to
   `Agent.process_query` that overrides `self.model_id` for that run.
2. **Bypass the agent for the model-specific subset of work** — call
   `LemonadeClient.completions(model=...)` directly from a thin orchestration
   layer that lives OUTSIDE the agent's tool surface (so `@tool` functions
   stay pure scrapers).

Both options preserve the "tools are pure functions" invariant. **Do not** add
a `LemonadeClient` instance to a tool's body — that has been ruled out.

## §3 Pin & supply chain

The current pin in [`pyproject.toml:17`](../pyproject.toml) is:

```
amd-gaia @ git+https://github.com/amd/gaia.git@da5ba458dc1b147927e4c1e8b7c40c473e0da41e
```

This is `amd-gaia` 0.17.2 plus 7 days of intervening patches (2026-04-17),
and is 3 patch releases behind today's PyPI latest (0.17.5, 2026-05-01). The
git+SHA form is intentional: it is supply-chain-strictly-stronger than a
semver range because the SHA is immutable. The annotation in `pyproject.toml`
records the audit's identity check so the pin is self-documenting.

The migration recommendation in §2.2.c stands: switch to PyPI when convenient,
but use exact pin + hashes — not an open range.
