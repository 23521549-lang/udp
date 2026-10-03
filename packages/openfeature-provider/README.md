# @udp/openfeature-provider

An [OpenFeature](https://openfeature.dev) provider for **UDP** server keys. It downloads a configuration snapshot,
keeps it fresh over SSE, and evaluates flags **in your process** — so a flag lookup is a function call, not a
network round trip.

It is one half of a pair: [`udp-openfeature`](https://pypi.org/project/udp-openfeature/) is the Python provider with
the same state machine, the same options and the same defaults. Both are released under the same version number.

## Install

```bash
npm install @udp/openfeature-provider @openfeature/server-sdk
```

`@openfeature/server-sdk` and `@openfeature/core` are peer dependencies. `prom-client` is an **optional** peer, used
only by the `/metrics` subpath — your application's own copy is used, so the histogram lands in the same registry
your `/metrics` endpoint serves.

Node.js 20.11 or newer. The package has **no runtime dependencies**: the evaluation core is bundled in.

## Use

```ts
import { OpenFeature } from "@openfeature/server-sdk";
import { UDPFeatureFlagProvider } from "@udp/openfeature-provider";

await OpenFeature.setProviderAndWait(
  new UDPFeatureFlagProvider({
    host: "https://flags.example.com",
    sdkKey: process.env.UDP_SDK_KEY!,
  }),
);

const client = OpenFeature.getClient();
const on = await client.getBooleanValue("checkout-v2", false, {
  targetingKey: "user-42",
});
```

The SDK key carries both the project and the environment, so there is no `projectId` option.

### Request labels for flag-level rollbacks

The provider installs its own hook: every evaluation of a flag that the platform is currently watching is recorded
in a per-request store, and the metrics middleware turns that into an `ff` label on the request duration histogram.
That is what lets a rollout be rolled back per flag rather than per deployment. You do not install the hook
yourself.

```ts
import { udpMetricsMiddleware } from "@udp/openfeature-provider/metrics";

app.use(udpMetricsMiddleware());
```

Set `OTEL_SERVICE_NAME` to the workload name used by the rollout, and
`OTEL_RESOURCE_ATTRIBUTES=service.version=<imageTag>`.

## Options

Only `host` and `sdkKey` are required.

| Option                        | Default | Meaning                                                             |
| ----------------------------- | ------- | ------------------------------------------------------------------- |
| `staleAfterSeconds`           | `300`   | How long without a confirmed-fresh config before `PROVIDER_STALE`   |
| `pollingIntervalMs`           | `30000` | Polling period when SSE is unavailable, and retry period on a 401   |
| `sseFailuresBeforeFallback`   | `3`     | Consecutive SSE failures before falling back to polling             |
| `initTimeoutMs`               | `10000` | How long `initialize()` waits for the first snapshot before throwing |
| `reportStats`                 | `true`  | Report evaluation counts back to the platform every ~60s            |
| `fetch`                       | global  | Replace `fetch` (proxy, custom agent)                               |
| `logger`                      | silent  | `{ warn }` for diagnostics (resync, degraded, 401, snapshot mismatch) |

Every numeric option is validated at construction time: a non-positive or `NaN` value throws a `RangeError` rather
than producing a hot retry loop. `staleAfterSeconds` must be larger than both the heartbeat deadline and
`pollingIntervalMs`.

## Behaviour you can rely on

- **Evaluation never throws into your application.** Any internal error resolves to the default value you passed,
  with an error code in the evaluation details.
- **Fail-static.** When the platform is unreachable, the last known configuration keeps serving, and the provider
  converges once the connection returns. Evaluations before the first snapshot resolve as `PROVIDER_NOT_READY`.
- **Your app still starts** if the platform is down or the key is rejected: the provider retries in the background.

## Known limits

- **There is no fail-closed option.** Flags usually wrap the main path of an application, so turning a platform
  outage into an application outage is the wrong trade. This is a decision, not an omission.
- **The `./testing` subpath is not published.** Test doubles and in-memory transports exist only inside the UDP
  monorepo; the published package exports `.` and `./metrics`.
- **Regular expressions in targeting rules use a portable subset.** Unicode property escapes, inline flags and
  non-ASCII group names are rejected on both the write path and in every SDK, so that the Node and Python providers
  cannot disagree on a valid-looking pattern.
- **Anonymous users skip percentage rules** rather than being assigned a sticky bucket: a server-side provider has
  no stable session to hash.

## Documentation

Design and rationale (in Vietnamese), section 6.8:
<https://github.com/23521549-lang/udp/blob/main/docs/UDP_design.md>

## Development

This package lives in the UDP monorepo.

```bash
pnpm --filter @udp/openfeature-provider build      # esbuild + tsc, writes dist/
pnpm --filter @udp/openfeature-provider test
pnpm --filter @udp/openfeature-provider typecheck
```

The published tarball is produced by `scripts/pack.ts`, which is also what the consumption test installs — the
artifact that is tested is the artifact that is published.

## License

Apache-2.0. Third-party code bundled into `dist/` is listed with its licences in `dist/THIRD_PARTY_NOTICES`.
