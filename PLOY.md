# Ploy's workerd

Upstream workerd release plus the patches Ploy's handler needs. Binaries are published as GitHub
releases by `.github/workflows/ploy-release.yml`.

## Patches

### CPU limits for dynamic workers

Upstream accepts `limits: { cpuMs }` on Worker Loader code and entrypoints but does not enforce it
(`NullIsolateLimitEnforcer`). This build enforces `cpuMs`:

```js
const worker = env.loader.get(id, () => code);
await worker.getEntrypoint(undefined, { limits: { cpuMs: 1000 } }).fetch(request);
```

- Budget is per request and covers all JavaScript the request runs, including after awaits.
  Waiting on I/O does not count. `WorkerCode.limits.cpuMs` is the default for entrypoints that do
  not pass their own.
- Once spent, a watchdog thread terminates execution and the request fails with
  `Worker exceeded CPU time limit.` (outcome `exceededCpu`). The isolate keeps serving other
  requests.
- Implementation: `src/workerd/server/cpu-limit-enforcer.c++`. Tests:
  `src/workerd/api/tests/worker-loader-cpu-limit-test.js`, plus `ploy/smoke-test/run.sh`, which the
  release workflow runs against the built binary.

### CPU limit on dynamic worker startup

`limits.cpuMs` only covers requests. A dynamic worker's top-level code runs when the Worker Loader
builds the isolate, outside any request, so a tenant that loops at the top level would still hold
the thread. This build adds `WorkerCode.limits.startupCpuMs`:

```js
const worker = env.loader.get(id, () => ({ ...code, limits: { startupCpuMs: 2000 } }));
```

- Covers module compilation, top-level evaluation and the evaluation of dynamically-imported
  modules (`enterStartupJs`, `enterStartupPython`, `enterDynamicImportJs`), measured on the same
  per-thread CPU clock and enforced by the same watchdog as `cpuMs`.
- Once spent, the worker fails to load with `Worker exceeded CPU time limit during startup.`;
  requests to it fail with that error, and the process keeps serving other workers. A dynamic import
  that runs out fails that import only.
- Ignored on `getEntrypoint()` limits; it is a property of the worker's code.
- Implementation: `enterStartupCpuLimit()` in `src/workerd/server/cpu-limit-enforcer.c++`, used by
  `NullIsolateLimitEnforcer` in `server.c++`.

### CPU time in tail events

Upstream reports `cpuTime: 0` for every tail event (`RequestObserverWithTracer` hard-codes it).
This build reports the CPU time each request spent running JavaScript, for every worker, from the
same measurement the CPU limit uses:

- The per-request enforcer reads the isolate thread's CPU clock (`CLOCK_THREAD_CPUTIME_ID`) on
  entering and leaving JavaScript, so I/O waits and OS preemption are not counted.
- `LimitEnforcer::reportMetrics()`, which IoContext calls whenever a request stops being current,
  hands the accumulated time to the request's observer (`RequestObserver::reportCpuTime()`), which
  passes it to `setOutcome()` and so to `TraceItem.cpuTime`.
- On Linux the watchdog also reads the CPU clock of the thread it guards, so `cpuMs` counts CPU
  time, not wall time: a request preempted on a busy node is not cut off early.

### Wall time in tail events

Upstream also reports `wallTime: 0`. This build reports the time from when the request reached the
worker (including any wait for the isolate lock) until the request and its `waitUntil()` tasks
finished, measured on the monotonic clock in `RequestObserverWithTracer`. `wallTime - cpuTime` is
the time the request spent waiting: on I/O, or on other requests holding the isolate thread.

### Body sizes and content type in tail events

Upstream tail events say nothing about how many bytes a request moved. This build adds, for HTTP
requests to workers that have tail workers:

- `TraceItem.event.request.bodySize`: bytes the worker read from the request body.
- `TraceItem.event.response.bodySize`: bytes the worker wrote to the response body.
- `TraceItem.event.response.contentType`: the response's `Content-Type` header.

`RequestObserverWithTracer` wraps the request body stream and the response it hands to the worker
and counts bytes as they are read and written, pumps included, so chunked uploads and streamed
responses without a `Content-Length` are counted exactly. It hands the totals to the tracer next to
`cpuTime` and `wallTime` when the request finishes. A request body the worker never reads counts
as 0. Tests: `tailReportsStreamedBodySizes` and `tailReportsUnreadBodyAsZero` in
`worker-loader-cpu-limit-test.js`, and the chunked upload in `ploy/smoke-test/run.sh`.

## Releasing

1. Rebase `ploy/main` onto the upstream release tag (`git rebase v1.YYYYMMDD.N`) and push it. The
   workflow builds `linux-64` and `linux-arm64` and runs the Worker Loader tests and smoke test.
2. Once it is green, tag the commit `v1.YYYYMMDD.N-ploy.M` and push the tag. The tag run publishes
   `workerd-<arch>.gz` plus `SHA256SUMS` as a release.
3. A cold build can exceed the 6 hour job limit; re-run the failed job and it resumes from the
   saved Bazel cache.
