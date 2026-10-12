// Copyright (c) 2026 Ploy
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

#pragma once

#include <workerd/io/limit-enforcer.h>

#include <kj/memory.h>
#include <kj/time.h>

namespace workerd::server {

// Returns a per-request LimitEnforcer that caps how long the request may spend executing
// JavaScript. Once the budget is spent, execution is terminated and the request fails with
// "Worker exceeded CPU time limit." (outcome `exceededCpu`).
//
// Time is measured as wall time while the request holds the isolate lock, which in workerd is the
// time it keeps the event-loop thread busy. Waiting on I/O does not count. All other limits are
// left unenforced, matching workerd's default.
//
// This backs `limits.cpuMs` for dynamically-loaded workers (Worker Loader), which upstream workerd
// accepts but does not enforce.
kj::Own<LimitEnforcer> newCpuLimitEnforcer(kj::Duration limit);

}  // namespace workerd::server
