// Copyright (c) 2026 Ploy
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

#include "cpu-limit-enforcer.h"

#include <workerd/jsg/exception.h>
#include <workerd/jsg/jsg.h>
#include <workerd/util/exception.h>

#include <kj/map.h>
#include <kj/mutex.h>
#include <kj/refcount.h>
#include <kj/thread.h>

namespace workerd::server {

namespace {

// Terminates JavaScript that runs past its deadline. A single detached thread serves the whole
// process; it sleeps until the earliest armed deadline or until a new entry is armed.
class CpuWatchdog {
 public:
  static CpuWatchdog& get() {
    // Leaked on purpose: the thread runs for the life of the process.
    static CpuWatchdog* instance = new CpuWatchdog();
    return *instance;
  }

  uint64_t arm(v8::Isolate* isolate, kj::TimePoint deadline) {
    auto lock = state.lockExclusive();
    auto id = lock->nextId++;
    lock->entries.insert(id, Entry{.isolate = isolate, .deadline = deadline});
    ++lock->generation;
    return id;
  }

  // Returns true if the watchdog terminated execution for this entry. After this returns, the
  // watchdog no longer touches the isolate on behalf of this entry.
  bool disarm(uint64_t id) {
    auto lock = state.lockExclusive();
    bool fired = false;
    KJ_IF_SOME(entry, lock->entries.find(id)) {
      fired = entry.fired;
    }
    lock->entries.erase(id);
    return fired;
  }

 private:
  struct Entry {
    v8::Isolate* isolate;
    kj::TimePoint deadline;
    bool fired = false;
  };
  struct State {
    kj::HashMap<uint64_t, Entry> entries;
    uint64_t nextId = 0;
    uint64_t generation = 0;
  };

  kj::MutexGuarded<State> state;
  kj::Own<kj::Thread> thread;

  CpuWatchdog() {
    thread = kj::heap<kj::Thread>([this]() { run(); });
    thread->detach();
  }

  void run() {
    auto& clock = kj::systemPreciseMonotonicClock();
    for (;;) {
      uint64_t generation;
      kj::Maybe<kj::Duration> timeout;
      {
        auto lock = state.lockExclusive();
        auto now = clock.now();
        kj::Maybe<kj::TimePoint> next;
        for (auto& slot: lock->entries) {
          auto& entry = slot.value;
          if (entry.fired) continue;
          if (entry.deadline <= now) {
            // Holding the lock guarantees the isolate is still inside the armed JavaScript scope,
            // because disarm() takes the same lock before the scope ends.
            entry.fired = true;
            entry.isolate->TerminateExecution();
          } else {
            KJ_IF_SOME(n, next) {
              if (entry.deadline < n) next = entry.deadline;
            } else {
              next = entry.deadline;
            }
          }
        }
        generation = lock->generation;
        KJ_IF_SOME(n, next) {
          timeout = n - now;
        }
      }
      state.when([generation](const State& s) { return s.generation != generation; },
          [](State&) {}, timeout);
    }
  }
};

kj::Exception cpuLimitExceeded() {
  auto exception = JSG_KJ_EXCEPTION(OVERLOADED, Error, "Worker exceeded CPU time limit.");
  exception.setDetail(CPU_LIMIT_DETAIL_ID, kj::heapArray<kj::byte>(0));
  return exception;
}

class CpuLimitEnforcer final: public LimitEnforcer, public kj::Refcounted {
 public:
  explicit CpuLimitEnforcer(kj::Duration limit)
      : CpuLimitEnforcer(limit, kj::newPromiseAndFulfiller<void>()) {}

  kj::Own<void> enterJs(jsg::Lock& lock, IoContext& context) override {
    auto& clock = kj::systemPreciseMonotonicClock();
    auto start = clock.now();
    auto remaining = used < limit ? limit - used : 0 * kj::NANOSECONDS;
    auto isolate = lock.v8Isolate;
    auto id = CpuWatchdog::get().arm(isolate, start + remaining);
    return kj::heap(kj::defer([this, isolate, id, start]() {
      bool fired = CpuWatchdog::get().disarm(id);
      used += kj::systemPreciseMonotonicClock().now() - start;
      if (fired) {
        // If JavaScript returned before V8 noticed the request, the termination is still pending
        // and would hit whatever runs next on this isolate, so clear it.
        isolate->CancelTerminateExecution();
      }
      if (fired || used >= limit) markExceeded();
    }));
  }

  void topUpActor() override {
    // An actor's IoContext outlives a single request; each delivered event gets a fresh budget.
    used = 0 * kj::NANOSECONDS;
  }
  void newSubrequest(bool isInHouse) override {}
  void newKvRequest(KvOpType op) override {}
  void newAnalyticsEngineRequest() override {}
  kj::Promise<void> limitDrain() override {
    return kj::NEVER_DONE;
  }
  kj::Promise<void> limitScheduled() override {
    return kj::NEVER_DONE;
  }
  kj::Duration getAlarmLimit() override {
    return 15 * kj::MINUTES;
  }
  size_t getBufferingLimit() override {
    return kj::maxValue;
  }
  kj::Maybe<EventOutcome> getLimitsExceeded() override {
    if (exceeded) return EventOutcome::EXCEEDED_CPU;
    return kj::none;
  }
  kj::Promise<void> onLimitsExceeded() override {
    return exceededPromise.addBranch();
  }
  void setCpuLimitNearlyExceededCallback(kj::Function<void()> cb) override {}
  void requireLimitsNotExceeded() override {
    if (exceeded) kj::throwFatalException(cpuLimitExceeded());
  }
  void reportMetrics(RequestObserver& requestMetrics) override {}
  kj::Duration consumeTimeElapsedForPeriodicLogging() override {
    return 0 * kj::SECONDS;
  }
  size_t getSqliteMemoryUsage() const override {
    return 0;
  }

 private:
  kj::Duration limit;
  kj::Duration used = 0 * kj::NANOSECONDS;
  bool exceeded = false;
  kj::ForkedPromise<void> exceededPromise;
  kj::Own<kj::PromiseFulfiller<void>> exceededFulfiller;

  CpuLimitEnforcer(kj::Duration limit, kj::PromiseFulfillerPair<void> paf)
      : limit(limit),
        exceededPromise(paf.promise.fork()),
        exceededFulfiller(kj::mv(paf.fulfiller)) {}

  void markExceeded() {
    if (exceeded) return;
    exceeded = true;
    exceededFulfiller->reject(cpuLimitExceeded());
  }
};

}  // namespace

kj::Own<LimitEnforcer> newCpuLimitEnforcer(kj::Duration limit) {
  return kj::refcounted<CpuLimitEnforcer>(limit);
}

}  // namespace workerd::server
