// Copyright (c) 2026 Ploy
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
import assert from 'node:assert';
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

// Tests for `limits.cpuMs` on dynamically-loaded workers, enforced by workerd's server
// (src/workerd/server/cpu-limit-enforcer.c++).

const MAIN_MODULE = `
  import {WorkerEntrypoint} from "cloudflare:workers";

  function burn(iterations) {
    let x = 0;
    for (let i = 0; i < iterations; i++) x = (x + i * 7) % 1000003;
    return x;
  }

  export default class extends WorkerEntrypoint {
    ping() { return "pong"; }
    spin() { for (;;) {} }
    async spinLater() {
      await scheduler.wait(1);
      for (;;) {}
    }
    burn(iterations) { return burn(iterations); }
    async importDefault(specifier) { return (await import(specifier)).default; }
    async burnSlices(slices, iterations) {
      for (let i = 0; i < slices; i++) {
        burn(iterations);
        await scheduler.wait(1);
      }
      return "done";
    }
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/spin") for (;;) {}
      if (url.pathname === "/burn") {
        return new Response(String(burn(Number(url.searchParams.get("n")))));
      }
      if (url.pathname === "/idle") {
        await scheduler.wait(300);
        return new Response("idle");
      }
      if (url.pathname === "/upload") {
        // Reads the whole body, then streams back "size" bytes without a Content-Length.
        await request.arrayBuffer();
        let remaining = Number(url.searchParams.get("size"));
        const body = new ReadableStream({
          pull(controller) {
            if (remaining === 0) return controller.close();
            const n = Math.min(remaining, 1000);
            controller.enqueue(new Uint8Array(n));
            remaining -= n;
          },
        });
        return new Response(body, {headers: {"content-type": "application/x-ploy-test"}});
      }
      return new Response("ok");
    }
  }
`;

// Roughly 20-100 ms of work depending on the machine.
const SLICE_ITERATIONS = 20_000_000;

function load(env, name, overrides = {}) {
  return env.loader.get(name, () => ({
    compatibilityDate: '2025-01-01',
    mainModule: 'main.js',
    modules: { 'main.js': MAIN_MODULE },
    globalOutbound: null,
    ...overrides,
  }));
}

function limited(worker, cpuMs) {
  return worker.getEntrypoint(undefined, { limits: { cpuMs } });
}

function assertCpuLimitError(e) {
  assert.match(String(e?.message ?? e), /exceeded CPU time limit/);
  return true;
}

// An infinite loop is terminated once it spends its budget.
export let infiniteLoopIsTerminated = {
  async test(ctrl, env) {
    const worker = load(env, 'infiniteLoopIsTerminated');
    const start = Date.now();
    await assert.rejects(limited(worker, 50).spin(), assertCpuLimitError);
    assert.ok(Date.now() - start < 10_000, 'termination took too long');
  },
};

// Loops that start after an await are terminated too.
export let loopAfterAwaitIsTerminated = {
  async test(ctrl, env) {
    const worker = load(env, 'loopAfterAwaitIsTerminated');
    await assert.rejects(limited(worker, 50).spinLater(), assertCpuLimitError);
  },
};

// The limit applies to fetch() handlers.
export let fetchHandlerIsTerminated = {
  async test(ctrl, env) {
    const worker = load(env, 'fetchHandlerIsTerminated');
    const entrypoint = limited(worker, 50);
    await assert.rejects(
      entrypoint.fetch('http://example.com/spin'),
      assertCpuLimitError
    );
    const response = await entrypoint.fetch('http://example.com/');
    assert.strictEqual(await response.text(), 'ok');
  },
};

// The budget covers the whole request, not each slice between awaits.
export let budgetCoversWholeRequest = {
  async test(ctrl, env) {
    const worker = load(env, 'budgetCoversWholeRequest');
    // Calibrate one slice so the test does not depend on machine speed.
    const sliceStart = Date.now();
    await worker.getEntrypoint().burn(SLICE_ITERATIONS);
    const sliceMs = Math.max(1, Date.now() - sliceStart);

    // Ten slices take ~10x one slice; a budget of ~3 slices must run out midway.
    await assert.rejects(
      limited(worker, Math.ceil(sliceMs * 3)).burnSlices(10, SLICE_ITERATIONS),
      assertCpuLimitError
    );
    // A budget above the total lets it finish.
    assert.strictEqual(
      await limited(worker, sliceMs * 100).burnSlices(10, SLICE_ITERATIONS),
      'done'
    );
  },
};

// A terminated request does not poison the isolate for the next request.
export let isolateKeepsServing = {
  async test(ctrl, env) {
    const worker = load(env, 'isolateKeepsServing');
    for (let i = 0; i < 3; i++) {
      await assert.rejects(limited(worker, 20).spin(), assertCpuLimitError);
      assert.strictEqual(await limited(worker, 1000).ping(), 'pong');
      assert.strictEqual(await worker.getEntrypoint().ping(), 'pong');
    }
  },
};

// `WorkerCode.limits` sets the default for entrypoints that do not pass their own.
export let codeLevelLimit = {
  async test(ctrl, env) {
    const worker = load(env, 'codeLevelLimit', { limits: { cpuMs: 50 } });
    await assert.rejects(worker.getEntrypoint().spin(), assertCpuLimitError);
    assert.strictEqual(await worker.getEntrypoint().ping(), 'pong');
  },
};

// The entrypoint limit overrides the code-level one.
export let entrypointLimitOverridesCodeLimit = {
  async test(ctrl, env) {
    const worker = load(env, 'entrypointLimitOverridesCodeLimit', {
      limits: { cpuMs: 1 },
    });
    assert.strictEqual(
      typeof (await limited(worker, 60_000).burn(SLICE_ITERATIONS)),
      'number'
    );
  },
};

// Without limits, long-running work completes.
export let noLimitByDefault = {
  async test(ctrl, env) {
    const worker = load(env, 'noLimitByDefault');
    assert.strictEqual(
      await worker.getEntrypoint().burnSlices(5, SLICE_ITERATIONS),
      'done'
    );
  },
};

const SPIN_MODULE = 'for (;;) {}\nexport default "unreachable";';

function assertStartupCpuLimitError(e) {
  assert.match(
    String(e?.message ?? e),
    /exceeded CPU time limit during startup/
  );
  return true;
}

// `limits.startupCpuMs` terminates top-level code that runs past its budget. Startup runs outside
// any request, so the per-request limit cannot catch it.
export let startupLoopIsTerminated = {
  async test(ctrl, env) {
    const worker = load(env, 'startupLoopIsTerminated', {
      modules: { 'main.js': 'for (;;) {}\n' + MAIN_MODULE },
      limits: { startupCpuMs: 50 },
    });
    const start = Date.now();
    await assert.rejects(
      limited(worker, 1000).ping(),
      assertStartupCpuLimitError
    );
    assert.ok(Date.now() - start < 10_000, 'termination took too long');

    // Other workers in the process keep loading and serving.
    const healthy = load(env, 'startupLoopIsTerminatedHealthy', {
      limits: { startupCpuMs: 50 },
    });
    assert.strictEqual(await healthy.getEntrypoint().ping(), 'pong');
  },
};

// Startup work within the budget loads normally.
export let startupWithinLimitLoads = {
  async test(ctrl, env) {
    const worker = load(env, 'startupWithinLimitLoads', {
      modules: {
        'main.js': `globalThis.startupResult = (${(n) => {
          let x = 0;
          for (let i = 0; i < n; i++) x = (x + i) % 7;
          return x;
        }})(1000);\n${MAIN_MODULE}`,
      },
      limits: { startupCpuMs: 60_000 },
    });
    assert.strictEqual(await worker.getEntrypoint().ping(), 'pong');
  },
};

// Evaluating a dynamically-imported module is covered by the startup budget too.
export let dynamicImportIsTerminated = {
  async test(ctrl, env) {
    const worker = load(env, 'dynamicImportIsTerminated', {
      modules: {
        'main.js': MAIN_MODULE,
        'spin.js': SPIN_MODULE,
        'ok.js': 'export default "loaded";',
      },
      limits: { startupCpuMs: 50 },
    });
    await assert.rejects(
      worker.getEntrypoint().importDefault('./spin.js'),
      /exceeded CPU time limit/
    );
    assert.strictEqual(
      await worker.getEntrypoint().importDefault('./ok.js'),
      'loaded'
    );
  },
};

// Tail events are delivered to a different execution context; bounce them back through an actor.
export class RendezvousActor extends DurableObject {
  promiseAndResolvers = Promise.withResolvers();
  resolve(value) {
    this.promiseAndResolvers.resolve(value);
  }
  wait() {
    return this.promiseAndResolvers.promise;
  }
}

export class CpuTail extends WorkerEntrypoint {
  async tail(events) {
    events = JSON.parse(JSON.stringify(events));
    await this.ctx.exports.RendezvousActor.getByName(
      this.ctx.props.name
    ).resolve(
      events.map((e) => ({
        cpuTime: e.cpuTime,
        wallTime: e.wallTime,
        outcome: e.outcome,
        requestBodySize: e.event?.request?.bodySize,
        responseBodySize: e.event?.response?.bodySize,
        responseContentType: e.event?.response?.contentType,
      }))
    );
  }
}

async function tailedRequest(env, ctx, name, path, limits, init) {
  const worker = load(env, name, {
    tails: [ctx.exports.CpuTail({ props: { name } })],
  });
  const entrypoint = worker.getEntrypoint(undefined, limits && { limits });
  try {
    const response = await entrypoint.fetch('http://example.com' + path, init);
    await response.text();
  } catch (e) {
    assertCpuLimitError(e);
  }
  const events = await ctx.exports.RendezvousActor.getByName(name).wait();
  assert.strictEqual(events.length, 1);
  return events[0];
}

// Tail events report the CPU time the request spent in JavaScript (upstream always reports 0).
export let tailReportsCpuTime = {
  async test(ctrl, env, ctx) {
    const calibrate = load(env, 'tailReportsCpuTimeCalibrate');
    const start = Date.now();
    await calibrate.getEntrypoint().burn(SLICE_ITERATIONS * 5);
    const burnMs = Date.now() - start;

    const event = await tailedRequest(
      env,
      ctx,
      'tailReportsCpuTime',
      `/burn?n=${SLICE_ITERATIONS * 5}`
    );
    assert.strictEqual(event.outcome, 'ok');
    assert.ok(
      event.cpuTime >= burnMs / 3,
      `cpuTime ${event.cpuTime}ms, burn took ${burnMs}ms`
    );
    assert.ok(event.cpuTime <= burnMs * 3 + 50, `cpuTime ${event.cpuTime}ms`);
    // Wall time covers the CPU time plus everything else the request waited on.
    assert.ok(
      event.wallTime >= event.cpuTime,
      `wallTime ${event.wallTime}ms < cpuTime ${event.cpuTime}ms`
    );
  },
};

// Waiting on I/O is not CPU time, but it is wall time.
export let tailExcludesIdleTime = {
  async test(ctrl, env, ctx) {
    const event = await tailedRequest(
      env,
      ctx,
      'tailExcludesIdleTime',
      '/idle'
    );
    assert.strictEqual(event.outcome, 'ok');
    assert.ok(event.cpuTime < 100, `cpuTime ${event.cpuTime}ms`);
    // ...but it is wall time (upstream reports 0 here).
    assert.ok(event.wallTime >= 250, `wallTime ${event.wallTime}ms`);
    assert.ok(event.wallTime < 10_000, `wallTime ${event.wallTime}ms`);
  },
};

// A request cut off by its limit reports the time it was allowed to run and outcome exceededCpu.
export let tailReportsExceededCpu = {
  async test(ctrl, env, ctx) {
    const event = await tailedRequest(
      env,
      ctx,
      'tailReportsExceededCpu',
      '/spin',
      {
        cpuMs: 50,
      }
    );
    assert.strictEqual(event.outcome, 'exceededCpu');
    assert.ok(event.cpuTime >= 40, `cpuTime ${event.cpuTime}ms`);
  },
};

// Tail events report the bytes the request read from its body and wrote to its response, counted
// as they stream, so chunked uploads and streamed responses without a Content-Length are covered.
export let tailReportsStreamedBodySizes = {
  async test(ctrl, env, ctx) {
    let chunks = 3;
    const upload = new ReadableStream({
      pull(controller) {
        if (chunks-- === 0) return controller.close();
        controller.enqueue(new Uint8Array(1500));
      },
    });
    const event = await tailedRequest(
      env,
      ctx,
      'tailReportsStreamedBodySizes',
      '/upload?size=12345',
      undefined,
      { method: 'POST', body: upload }
    );
    assert.strictEqual(event.outcome, 'ok');
    assert.strictEqual(event.requestBodySize, 4500);
    assert.strictEqual(event.responseBodySize, 12345);
    assert.strictEqual(event.responseContentType, 'application/x-ploy-test');
  },
};

// A body the worker never reads counts as 0; a fixed-length response counts its bytes.
export let tailReportsUnreadBodyAsZero = {
  async test(ctrl, env, ctx) {
    const event = await tailedRequest(
      env,
      ctx,
      'tailReportsUnreadBodyAsZero',
      '/ok',
      undefined,
      { method: 'POST', body: 'ignored body' }
    );
    assert.strictEqual(event.outcome, 'ok');
    assert.strictEqual(event.requestBodySize, 0);
    assert.strictEqual(event.responseBodySize, 2);
    assert.strictEqual(event.responseContentType, 'text/plain;charset=UTF-8');
  },
};
