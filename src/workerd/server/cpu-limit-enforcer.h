// Copyright (c) 2026 Ploy
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

#pragma once

#include <workerd/io/limit-enforcer.h>

#include <kj/memory.h>
#include <kj/time.h>

namespace workerd::server {

// Returns a per-request LimitEnforcer that measures the CPU time the request spends executing
// JavaScript and, when `limit` is set, caps it. Once the budget is spent, execution is terminated
// and the request fails with "Worker exceeded CPU time limit." (outcome `exceededCpu`).
//
// Time is the CPU time of the isolate thread while the request holds the isolate lock
// (CLOCK_THREAD_CPUTIME_ID), so waiting on I/O and being preempted by the OS do not count. Platforms
// without a per-thread CPU clock fall back to wall time.
//
// The measured time is handed to the request's observer through reportMetrics(), which is how it
// reaches `TraceItem.cpuTime` in tail workers; upstream workerd always reports 0 there.
//
// This also backs `limits.cpuMs` for dynamically-loaded workers (Worker Loader), which upstream
// workerd accepts but does not enforce. All other limits are left unenforced, matching workerd's
// default.
kj::Own<LimitEnforcer> newCpuLimitEnforcer(kj::Maybe<kj::Duration> limit);

// Scope for IsolateLimitEnforcer::enterStartupJs() and friends: caps the CPU time the enclosed
// JavaScript (a worker's top-level module evaluation, or a dynamic import) may spend at `limit`.
// Startup runs outside any request, so the per-request limit cannot cover it. When the scope is
// dropped after the limit was hit, `limitErrorOrTime` holds "Worker exceeded CPU time limit during
// startup."; otherwise the measured CPU time is added to it. No limit returns an empty scope.
kj::Own<void> enterStartupCpuLimit(jsg::Lock& lock,
    kj::Maybe<kj::Duration> limit,
    kj::OneOf<kj::Exception, kj::Duration>& limitErrorOrTime);

}  // namespace workerd::server
