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

## Releasing

1. Rebase `ploy/main` onto the upstream release tag (`git rebase v1.YYYYMMDD.N`) and push it. The
   workflow builds `linux-64` and `linux-arm64` and runs the Worker Loader tests and smoke test.
2. Once it is green, tag the commit `v1.YYYYMMDD.N-ploy.M` and push the tag. The tag run publishes
   `workerd-<arch>.gz` plus `SHA256SUMS` as a release. The tag must come from a person, not CI:
   GITHUB_TOKEN cannot create refs on this fork.
3. A cold build can exceed the 6 hour job limit; re-run the failed job and it resumes from the
   saved Bazel cache.
