// Copyright (c) 2026 Ploy
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
import assert from 'node:assert';

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
    async burnSlices(slices, iterations) {
      for (let i = 0; i < slices; i++) {
        burn(iterations);
        await scheduler.wait(1);
      }
      return "done";
    }
    async fetch(request) {
      if (new URL(request.url).pathname === "/spin") for (;;) {}
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
