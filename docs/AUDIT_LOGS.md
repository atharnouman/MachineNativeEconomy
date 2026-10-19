# audit-logs: a read-only diagnostic over LiteLLM spend logs

`spendmarshal audit-logs EXPORT` reads a [LiteLLM](https://docs.litellm.ai/) spend-log export and prints a one-page
exceptions report. It runs offline, reads metadata only and never prints prompts or responses. It is the step before
anything is installed: what last month's export already shows about repeated requests, retry storms, agents looping on
a growing conversation, calls that produced nothing, expensive models doing small jobs, spend nobody can assign to a
client, and caps that no longer match use.

## Get the export

| What | How |
|---|---|
| Spend logs | `GET /spend/logs/v2?start_date=...&end_date=...&page=1&page_size=1000` on the LiteLLM proxy, as admin. A page is `{ data: [...], total, page, page_size, total_pages }`; one query is capped at 10,000 rows, so split the date range. Save the pages as they come: the tool reads one page, an array of pages, a plain array of rows (the legacy `GET /spend/logs?summarize=false`, which truncates at 10,000 rows) or newline-delimited rows. |
| Caps (optional, `--budgets`) | `GET /key/list?return_full_object=true&page_size=100` for keys and `GET /team/list` for teams; pass both (`--budgets keys.json --budgets teams.json`). Raw table rows work too. Only objects with a numeric `max_budget` count. |
| Prices (optional, `--prices`) | A local copy of LiteLLM's `model_prices_and_context_window.json`. Without it, "expensive" is judged from the observed cost per token in the export. |

Redact before sending an export to anyone: `messages`, `response` and `proxy_server_request` can be dropped. When a
row carries request content, the tool only hashes it in memory so repeats can be recognised; nothing from those fields
is printed or written. One line does the redaction for a page, an array of pages or a plain array of rows:

```bash
jq 'def strip: del(.messages, .response, .proxy_server_request); if type == "array" then map(if type == "object" and has("data") then .data |= map(strip) else strip end) elif has("data") then .data |= map(strip) else . end' spend-logs.json > spend-logs.redacted.json
```

Better still, run the tool locally and share only the report: nothing leaves the machine.

## What the export carries, and what it does not

These facts come from LiteLLM's own code and documentation (read 19 October 2026) and decide what the report can say.

| Field | What LiteLLM puts there | What the report does |
|---|---|---|
| `cache_key` | The literal `Cache OFF` whenever caching is not configured; a real key on every request only when it is | Only real keys identify a request. With caching off, repeats can only be "possible" (same shape) |
| `session_id` | Always filled: the caller's session when the request carried one (`litellm_session_id` in the body, `metadata.session_id`, or an `x-litellm-session-id` header), otherwise a per-request trace id | An id seen on one row only is not a session. Sessions, agents, customers and keys are the scopes, in that order |
| `status`, `spend`, tokens on failures | `failure`, `spend` 0 and zero tokens, unless a stream broke after chunks were delivered or a guardrail rejected a finished response; `metadata.error_information` carries `error_code`, `error_class`, `error_message` | Failures are counted as attempts and classified (budget refusal, rate limit, auth, upstream, other); their dollars are reported but are mostly zero |
| `team_id`, `end_user`, `agent_id` | `team_id` comes with the virtual key's team without the caller doing anything; `end_user` only when the caller sends `user` or a customer header | These are the client tags. Spend without any of them is reported as unattributed when other rows have one |
| `messages`, `response`, `proxy_server_request` | Never returned by `/spend/logs/v2`. The legacy `/spend/logs?summarize=false` returns `proxy_server_request` with the request body when `general_settings.store_prompts_in_spend_logs` is on | Request content, where present, is hashed in memory to confirm repeats; otherwise repeats stay "possible" |

So the first export from a typical deployment (caching off, no session ids, no customer tags) can show failed attempts,
retry storms, expensive small-output models, bursty keys and possible repeats, but not confirmed repeats, loops per
session or spend per client. The report says so in its coverage and attribution lines, and the next export improves
with three small changes on the caller's side: send a session id per run, send `user` per client, and turn caching on.

## Run

```bash
spendmarshal audit-logs spend-logs.json
```

```bash
spendmarshal audit-logs spend-logs.json --budgets keys.json --prices model_prices_and_context_window.json --format html --out report.html
```

## What it finds

Each finding carries its source rows (request ids, sessions or keys), one next step, and a label that says what the
data supports. The labels follow the advisor design: a weak signal is never upgraded into a strong claim.

| Finding | Counted as avoidable? | When the data is weaker |
|---|---|---|
| **Repeated requests**: the same request (by a real `cache_key`, else by a hash of request content) sent again in the same session, agent, customer or key within `--window` (default 10 minutes). All but the first are in question; cache hits are ignored. | yes | "possible repeated request" when only the shape matches (model, call type, prompt size): listed as unconfirmed, not counted |
| **Retry storms**: at least `--storm-calls` (default 5) consecutive failed or empty calls on one session, agent, customer or key within `--storm-window` (default 1 minute), with nothing successful between them. | these rows are part of the failed-and-empty finding; not added twice | |
| **Possible loops**: at least `--loop-calls` (default 10) calls in one session or agent, each within `--loop-gap` (default 90 seconds) of the previous one and with a longer prompt: an agent re-sending a growing conversation. | no: listed as unconfirmed, because a long legitimate job looks the same | needs session ids or agent ids; keys alone are too coarse |
| **Failed or empty calls**: rows with `status: failure`, classified from `error_information`, and successful generative calls that returned no completion tokens. | yes (mostly $0 for failures) | rows with no status are listed as "outcome unknown" and never counted; a row with no completion-token field is not empty |
| **Expensive models on small outputs**: a model at or above `--expensive` dollars per million tokens (default 5; list price with `--prices`, else observed) with at least 20 successful calls and a median answer of 40 tokens or fewer. | no: quality is not in the export | |
| **Unattributed spend**: rows with no team, customer or agent tag, in an export where other rows have one. | no: it is not waste, it is spend that cannot be rebilled or reviewed per client | silent when no row is tagged at all; the attribution line says so instead |
| **Caps against use** (`--budgets`): a cap more than five times the busiest window of its own period in the export, or a cap that use has reached 90% of; lifetime caps only for the second. Without caps: keys whose busiest day was more than ten times their typical day. | no: a review suggestion | a cap is called slack only when the export covers at least one full budget period |

The first lines of the report say what the export covers: rows read and skipped (with reasons), rows with an unknown
outcome, keys, sessions shared by several rows and one-off ids ignored, agents and models, whether cache keys and
request content were present, whether caps were supplied; the share of spend carrying a client tag; spend by outcome
with failed attempts by class; the avoidable total with each row counted once; and the unconfirmed total (possible
repeats and possible loops) listed beside it.

## What it cannot see

- Whether a call produced value. A successful call with a tiny answer is only "small", and an empty answer may have been
  wanted. The outcome field in the advisor design exists for this; the export does not have it.
- Whether a fast run with a growing prompt is a stuck agent or a long job.
- Whether a cheaper model would have done: replay real calls and compare before switching.
- Sampling settings. Two calls with the same content and different temperatures count as a repeat.
- Teams, customers and agents when the rows carry no tag; sessions when the caller sends no session id.

## Options

| Option | Default | Meaning |
|---|---|---|
| `--format text\|html\|json` | `text` | `json` is the full report object |
| `--out FILE` | stdout | write the report to a file |
| `--window` | `10m` | repeats of one request inside this window count |
| `--storm-calls` | `5` | consecutive failed or empty calls that make a storm |
| `--storm-window` | `1m` | the storm window |
| `--loop-calls` | `10` | calls with a growing prompt that make a possible loop |
| `--loop-gap` | `90s` | the longest pause between two calls of one loop |
| `--expensive` | `5` | dollars per million tokens from which a model is expensive |
| `--prices FILE` | | LiteLLM price table |
| `--budgets FILE` | | key or team export with `max_budget`; repeatable |

Durations take `s`, `m`, `h` and `d` (`90s`, `10m`, `2h`). Exit code 0 when a report was produced, 1 for a usage
error, 2 when the export or an option could not be read.

## Privacy

No network. Metadata only. Hashed keys and session ids are shortened in the output. Request content, where a row
carries it, is hashed in memory and never printed. LiteLLM stores keys as sha256 hashes, which is what the spend logs
carry; a raw `sk-` key in a budgets file is hashed in memory and never printed.
