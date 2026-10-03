# udp-openfeature

An [OpenFeature](https://openfeature.dev) provider for **UDP** server keys. It downloads a configuration snapshot,
keeps it fresh over SSE, and evaluates flags **in your process** — so a flag lookup is a function call, not a
network round trip.

It is one half of a pair: [`@udp/openfeature-provider`](https://www.npmjs.com/package/@udp/openfeature-provider) is
the Node.js provider with the same state machine, the same options and the same defaults. Both are released under
the same version number, and their agreement is tested against one shared vector file.

## Install

```bash
pip install udp-openfeature            # add [metrics] for the measurement middleware
```

Python 3.11 or newer. The only runtime dependency is `openfeature-sdk`; `prometheus-client` comes with the
`metrics` extra, mirroring `prom-client` being an optional peer on the Node side.

## Use

```python
from openfeature import api
from openfeature.evaluation_context import EvaluationContext
from udp_openfeature import UDPFeatureFlagProvider

api.set_provider_and_wait(UDPFeatureFlagProvider("https://flags.example.com", "udp_sk_…"))

client = api.get_client()
client.get_boolean_value("checkout-v2", False, EvaluationContext(targeting_key="user-42"))
```

The SDK key carries both the project and the environment, so there is no `project_id` argument.

### Request labels for flag-level rollbacks

The provider records every evaluation of a flag the platform is currently watching in a per-request store, and the
middleware turns that into an `ff` label on the request duration histogram. That is what lets a rollout be rolled
back per flag rather than per deployment. You do not install a hook yourself.

```python
from udp_openfeature.metrics import UDPMetricsMiddleware, UDPMetricsWSGIMiddleware

# ASGI: FastAPI, Starlette
app.add_middleware(UDPMetricsMiddleware)

# WSGI: Flask
app.wsgi_app = UDPMetricsWSGIMiddleware(app.wsgi_app)
```

Set `OTEL_SERVICE_NAME` to the workload name used by the rollout, and
`OTEL_RESOURCE_ATTRIBUTES=service.version=<imageTag>`.

## Options

Only `host` and `sdk_key` are positional; everything else is keyword-only.

| Option                         | Default | Meaning                                                             |
| ------------------------------ | ------- | ------------------------------------------------------------------- |
| `stale_after_seconds`          | `300`   | How long without a confirmed-fresh config before `PROVIDER_STALE`   |
| `polling_interval_ms`          | `30000` | Polling period when SSE is unavailable, and retry period on a 401   |
| `sse_failures_before_fallback` | `3`     | Consecutive SSE failures before falling back to polling             |
| `init_timeout_ms`              | `10000` | How long initialization waits for the first snapshot before raising |
| `report_stats`                 | `True`  | Report evaluation counts back to the platform every ~60s            |
| `connection_factory`           | default | Replace the HTTP connection factory (proxy, custom transport)       |
| `logger`                       | silent  | A `logging.Logger`; the default has a `NullHandler`                 |

Every numeric option is validated at construction time: a non-positive value raises `ValueError` rather than
producing a hot retry loop. `stale_after_seconds` must be larger than both the heartbeat deadline and
`polling_interval_ms`.

The provider runs its synchronization on a **daemon** thread, so your program can exit even if it never calls
`api.shutdown()`.

## Behaviour you can rely on

- **Evaluation never raises into your application.** Any internal error resolves to the default value you passed,
  with an error code in the evaluation details.
- **Fail-static.** When the platform is unreachable, the last known configuration keeps serving, and the provider
  converges once the connection returns. Evaluations before the first snapshot resolve as `PROVIDER_NOT_READY`.
- **`integer` is not rounded.** OpenFeature Python separates `integer` and `float`: asking for an integer and
  finding `2.5` is a `TYPE_MISMATCH`, not a silent truncation.

## Known limits

- **There is no fail-closed option.** Flags usually wrap the main path of an application, so turning a platform
  outage into an application outage is the wrong trade. This is a decision, not an omission.
- **Regular expressions in targeting rules use a portable subset.** Unicode property escapes, inline flags and
  non-ASCII group names are rejected on both the write path and in every SDK, so that the Python and Node providers
  cannot disagree on a valid-looking pattern.
- **Anonymous users skip percentage rules** rather than being assigned a sticky bucket: a server-side provider has
  no stable session to hash.

## Documentation

Design and rationale (in Vietnamese), section 6.8:
<https://github.com/23521549-lang/udp/blob/main/docs/UDP_design.md>

## Development

This package lives in the UDP monorepo, at `sdks/python`.

```bash
python -m venv .venv
.venv/bin/pip install -e ".[dev]"      # Windows: .venv\Scripts\pip
ruff check . && ruff format --check . && mypy && pytest -q
```

Agreement with the Node core is tested two ways: against
`packages/flag-evaluator/conformance/vectors.json`, which the Node core itself generates
(`pnpm --filter @udp/flag-evaluator conformance`), and against a live platform instance in
`packages/openfeature-provider/tests/python-parity.test.ts`, which drives this provider in a subprocess and needs
the `.venv` above.

## License

Apache-2.0.
