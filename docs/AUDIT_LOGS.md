# audit-logs: a read-only diagnostic over LiteLLM spend logs

`spendmarshal audit-logs EXPORT` reads a [LiteLLM](https://docs.litellm.ai/) spend-log export and prints a one-page
exceptions report. It runs offline, reads metadata only and never prints prompts or responses. It is the step before
anything is installed: what last month's export already shows about repeated requests, retry loops, spend on calls that
produced nothing, expensive models doing small jobs, and caps that no longer match use.

## Get the export

| What | How |
|---|---|
| Spend logs | `GET /spend/logs/v2?start_date=...&end_date=...&page=1&page_size=1000` on the LiteLLM proxy, as admin. A page is `{ data: [...], total, page, page_size, total_pages }`; one query is capped at 10,000 rows, so split the date range. Save the pages as they come: the tool reads one page, an array of pages, a plain array of rows (the legacy `GET /spend/logs?summarize=false`, which truncates at 10,000 rows) or newline-delimited rows. |
| Caps (optional, `--budgets`) | `GET /key/list?return_full_object=true&page_size=100` for keys and `GET /team/list` for teams; pass both (`--budgets keys.json --budgets teams.json`). Raw table rows work too. Only objects with a numeric `max_budget` count. |
| Prices (optional, `--prices`) | A local copy of LiteLLM's `model_prices_and_context_window.json`. Without it, "expensive" is judged from the observed cost per token in the export. |

Redact before sending an export to anyone: `messages`, `response` and `proxy_server_request` can be dropped. The tool
uses `messages`, when present, only to hash each request in memory so repeats can be recognised; nothing from those
fields is printed or written.

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
| **Repeated requests**: the same request (by `cache_key`, else by a hash of `messages`) sent again in the same session, agent or key within `--window` (default 10 minutes). All but the first are in question; cache hits are ignored. | yes | "possible repeated request" when only the shape matches (model, call type, prompt size): listed, not counted |
| **Retry storms**: at least `--storm-calls` (default 5) consecutive failed or empty calls on one session, agent or key within `--storm-window` (default 1 minute), with nothing successful between them. | these rows are part of the next finding; not added twice | |
| **Failed or empty spend**: rows with `status: failure`, and successful generative calls that returned no completion tokens. | yes | rows with no status are listed as "outcome unknown" and never counted |
| **Expensive models on small outputs**: a model at or above `--expensive` dollars per million tokens (default 5; list price with `--prices`, else observed) with at least 20 successful calls and a median answer of 40 tokens or fewer. | no: quality is not in the export | |
| **Caps against use** (`--budgets`): a cap more than five times the busiest window of its own period in the export, or a cap that use has reached 90% of; lifetime caps only for the second. Without caps: keys whose busiest day was more than ten times their typical day. | no: a review suggestion | a cap is called slack only when the export covers at least one full budget period |

The first lines of the report say what the export covers: rows read and skipped (with reasons), rows with an unknown
outcome, keys, sessions, agents and models, whether caps were supplied, spend by outcome (which sums to the total), and
the avoidable total with each row counted once.

## What it cannot see

- Whether a call produced value. A successful call with a tiny answer is only "small", and an empty answer may have been
  wanted. The outcome field in the advisor design exists for this; the export does not have it.
- Whether a cheaper model would have done: replay real calls and compare before switching.
- Whether a failed call was refused by a budget or failed upstream, unless `error_information` is read by hand.
- Teams, unless rows carry `team_id`; agents, unless rows carry `agent_id`.

## Options

| Option | Default | Meaning |
|---|---|---|
| `--format text\|html\|json` | `text` | `json` is the full report object |
| `--out FILE` | stdout | write the report to a file |
| `--window` | `10m` | repeats of one request inside this window count |
| `--storm-calls` | `5` | consecutive failed or empty calls that make a storm |
| `--storm-window` | `1m` | the storm window |
| `--expensive` | `5` | dollars per million tokens from which a model is expensive |
| `--prices FILE` | | LiteLLM price table |
| `--budgets FILE` | | key or team export with `max_budget`; repeatable |

Durations take `s`, `m`, `h` and `d` (`90s`, `10m`, `2h`). Exit code 0 when a report was produced, 1 for a usage
error, 2 when the export or an option could not be read.

## Privacy

No network. Metadata only. Hashed keys and session ids are shortened in the output. LiteLLM stores keys as sha256
hashes, which is what the spend logs carry; a raw `sk-` key in a budgets file is hashed in memory and never printed.
