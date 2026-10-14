// Copyright (c) 2026 Ploy
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

#include "cpu-limit-enforcer.h"

#include <workerd/io/observer.h>
#include <workerd/jsg/exception.h>
#include <workerd/jsg/jsg.h>
#include <workerd/util/exception.h>

#include <kj/map.h>
#include <kj/mutex.h>
#include <kj/refcount.h>
#include <kj/thread.h>

#if defined(__linux__) || defined(__APPLE__)
#include <time.h>
#define WORKERD_HAS_THREAD_CPU_CLOCK 1
#endif

#if defined(__linux__)
#include <pthread.h>
#define WORKERD_HAS_FOREIGN_THREAD_CPU_CLOCK 1
#endif

namespace workerd::server {

namespace {

#ifdef WORKERD_HAS_THREAD_CPU_CLOCK
kj::Duration readCpuClock(clockid_t clock) {
  struct timespec ts;
  KJ_SYSCALL(clock_gettime(clock, &ts));
  return ts.tv_sec * kj::SECONDS + ts.tv_nsec * kj::NANOSECONDS;
}
#endif

// CPU time consumed so far by the calling thread. Only differences between two readings on the
// same thread are meaningful.
kj::Duration threadCpuNow() {
#ifdef WORKERD_HAS_THREAD_CPU_CLOCK
  return readCpuClock(CLOCK_THREAD_CPUTIME_ID);
#else
  return kj::systemPreciseMonotonicClock().now() - kj::origin<kj::TimePoint>();
#endif
}

// A clock another thread can read to see how much CPU the arming thread has used. Where there is
// none, the watchdog treats wall time as CPU time, which can only cut a request off early.
struct ArmingThreadClock {
#ifdef WORKERD_HAS_FOREIGN_THREAD_CPU_CLOCK
  kj::Maybe<clockid_t> clock;

  static ArmingThreadClock current() {
    clockid_t clock;
    if (pthread_getcpuclockid(pthread_self(), &clock) == 0) {
      return {.clock = clock};
    }
    return {};
  }

  kj::Maybe<kj::Duration> read() const {
    KJ_IF_SOME(c, clock) {
      return readCpuClock(c);
    }
    return kj::none;
  }
#else
  static ArmingThreadClock current() {
    return {};
  }
  kj::Maybe<kj::Duration> read() const {
    return kj::none;
  }
#endif
};

// Terminates JavaScript that runs past its CPU deadline. A single detached thread serves the whole
// process; it sleeps until the earliest wall-clock point at which some armed request could have
// spent its budget, or until a new entry is armed.
class CpuWatchdog {
 public:
  static CpuWatchdog& get() {
    // Leaked on purpose: the thread runs for the life of the process.
    static CpuWatchdog* instance = new CpuWatchdog();
    return *instance;
  }

  // `cpuDeadline` is a reading of the arming thread's CPU clock. Since a thread cannot use more
  // CPU than wall time passes, `start + (cpuDeadline - cpuNow)` is the earliest the deadline can be
  // reached; the watchdog checks then and re-arms if the thread was not running the whole time.
  uint64_t arm(v8::Isolate* isolate, kj::Duration cpuNow, kj::Duration cpuDeadline) {
    auto wallDeadline = kj::systemPreciseMonotonicClock().now() + (cpuDeadline - cpuNow);
    auto lock = state.lockExclusive();
    auto id = lock->nextId++;
    lock->entries.insert(id,
        Entry{
          .isolate = isolate,
          .clock = ArmingThreadClock::current(),
          .cpuDeadline = cpuDeadline,
          .wallDeadline = wallDeadline,
        });
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
    ArmingThreadClock clock;
    kj::Duration cpuDeadline;
    kj::TimePoint wallDeadline;
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
          if (entry.wallDeadline <= now) {
            KJ_IF_SOME(cpuNow, entry.clock.read()) {
              if (cpuNow < entry.cpuDeadline) {
                // The thread was preempted or blocked for part of the time; wait for the rest.
                entry.wallDeadline = now + (entry.cpuDeadline - cpuNow);
              }
            }
          }
          if (entry.wallDeadline <= now) {
            // Holding the lock guarantees the isolate is still inside the armed JavaScript scope,
            // because disarm() takes the same lock before the scope ends.
            entry.fired = true;
            entry.isolate->TerminateExecution();
          } else {
            KJ_IF_SOME(n, next) {
              if (entry.wallDeadline < n) next = entry.wallDeadline;
            } else {
              next = entry.wallDeadline;
            }
          }
        }
        generation = lock->generation;
        KJ_IF_SOME(n, next) {
          timeout = n - now;
        }
      }
      state.when([generation](const State& s) { return s.generation != generation; }, [](State&) {},
          timeout);
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
  explicit CpuLimitEnforcer(kj::Maybe<kj::Duration> limit)
      : CpuLimitEnforcer(limit, kj::newPromiseAndFulfiller<void>()) {}

  kj::Own<void> enterJs(jsg::Lock& lock, IoContext& context) override {
    auto start = threadCpuNow();
    kj::Maybe<uint64_t> armed;
    KJ_IF_SOME(l, limit) {
      auto remaining = used < l ? l - used : 0 * kj::NANOSECONDS;
      armed = CpuWatchdog::get().arm(lock.v8Isolate, start, start + remaining);
    }
    return kj::heap(kj::defer([this, isolate = lock.v8Isolate, armed, start]() {
      bool fired = false;
      KJ_IF_SOME(id, armed) {
        fired = CpuWatchdog::get().disarm(id);
      }
      auto elapsed = threadCpuNow() - start;
      used += elapsed;
      unreported += elapsed;
      if (fired) {
        // If JavaScript returned before V8 noticed the request, the termination is still pending
        // and would hit whatever runs next on this isolate, so clear it.
        isolate->CancelTerminateExecution();
      }
      KJ_IF_SOME(l, limit) {
        if (fired || used >= l) markExceeded();
      }
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
  void reportMetrics(RequestObserver& requestMetrics) override {
    // IoContext calls this when the current incoming request stops being current, so CPU time is
    // attributed to the request that was current while it was spent.
    requestMetrics.reportCpuTime(unreported);
    unreported = 0 * kj::NANOSECONDS;
  }
  kj::Duration consumeTimeElapsedForPeriodicLogging() override {
    return 0 * kj::SECONDS;
  }
  size_t getSqliteMemoryUsage() const override {
    return 0;
  }

 private:
  kj::Maybe<kj::Duration> limit;
  // CPU time counted against `limit`; reset for each event delivered to an actor.
  kj::Duration used = 0 * kj::NANOSECONDS;
  // CPU time not yet handed to a request observer.
  kj::Duration unreported = 0 * kj::NANOSECONDS;
  bool exceeded = false;
  kj::ForkedPromise<void> exceededPromise;
  kj::Own<kj::PromiseFulfiller<void>> exceededFulfiller;

  CpuLimitEnforcer(kj::Maybe<kj::Duration> limit, kj::PromiseFulfillerPair<void> paf)
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

kj::Own<LimitEnforcer> newCpuLimitEnforcer(kj::Maybe<kj::Duration> limit) {
  return kj::refcounted<CpuLimitEnforcer>(limit);
}

kj::Own<void> enterStartupCpuLimit(jsg::Lock& lock,
    kj::Maybe<kj::Duration> limit,
    kj::OneOf<kj::Exception, kj::Duration>& limitErrorOrTime) {
  KJ_IF_SOME(l, limit) {
    auto start = threadCpuNow();
    auto id = CpuWatchdog::get().arm(lock.v8Isolate, start, start + l);
    return kj::heap(kj::defer([isolate = lock.v8Isolate, id, start, &limitErrorOrTime]() {
      bool fired = CpuWatchdog::get().disarm(id);
      if (fired) {
        // A termination V8 is already unwinding is left for the caller to observe through its
        // v8::TryCatch (dynamic imports assert on it); V8 clears it once no JavaScript is left on
        // the stack. Only a termination V8 has not acted on yet is cleared here, so it cannot hit
        // whatever runs next.
        if (!isolate->IsExecutionTerminating()) {
          isolate->CancelTerminateExecution();
        }
        limitErrorOrTime =
            JSG_KJ_EXCEPTION(OVERLOADED, Error, "Worker exceeded CPU time limit during startup.");
      } else KJ_IF_SOME(time, limitErrorOrTime.tryGet<kj::Duration>()) {
        time += threadCpuNow() - start;
      }
    }));
  }
  return {};
}

}  // namespace workerd::server
