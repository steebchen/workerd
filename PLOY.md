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

## Releasing

1. Rebase `ploy/main` onto the upstream release tag (`git rebase v1.YYYYMMDD.N`) and push it. The
   workflow builds `linux-64` and `linux-arm64` and runs the Worker Loader tests and smoke test.
2. Once it is green, tag the commit `v1.YYYYMMDD.N-ploy.M` and push the tag. The tag run publishes
   `workerd-<arch>.gz` plus `SHA256SUMS` as a release.
3. A cold build can exceed the 6 hour job limit; re-run the failed job and it resumes from the
   saved Bazel cache.
