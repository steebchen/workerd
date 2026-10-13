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

}  // namespace workerd::server
