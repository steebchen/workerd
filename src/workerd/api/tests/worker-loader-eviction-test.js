// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
import assert from 'node:assert';

// Three allocations alone exceed the loader's 128 MiB cache budget, while two leave ample room
// for these small Workers' V8 heaps. This makes the expected two-entry LRU behavior stable without
// relying on an exact V8 heap size.
const ALLOCATION_SIZE = 44 * 1024 * 1024;

function workerCode(name) {
  return {
    compatibilityDate: '2025-01-01',
    mainModule: 'worker.js',
    modules: {
      'worker.js': `
        let retained;
        export default {
          touch(_) {
            retained ??= new Uint8Array(${ALLOCATION_SIZE});
            retained.fill(${name.charCodeAt(0)});
            return { name: ${JSON.stringify(name)}, size: retained.byteLength };
          }
        };
      `,
    },
  };
}

export let evictsLeastRecentlyUsedWorker = {
  async test(ctrl, env) {
    const loadCounts = new Map();

    const invoke = async (name, shouldLoad) => {
      let stub = env.loader.get(name, () => {
        assert.strictEqual(
          shouldLoad,
          true,
          `${name} unexpectedly missed the loader cache`
        );
        loadCounts.set(name, (loadCounts.get(name) ?? 0) + 1);
        return workerCode(name);
      });
      let entrypoint = stub.getEntrypoint();
      assert.deepStrictEqual(await entrypoint.touch(null), {
        name,
        size: ALLOCATION_SIZE,
      });

      entrypoint = null;
      stub = null;
      gc();
      await scheduler.wait(10);
    };

    await invoke('a', true);
    await invoke('b', true);

    // A is older by insertion order, but this access makes B the least-recently-used Worker.
    await invoke('a', false);
    await invoke('c', true);

    // A and C remain warm. Check both before reloading B, since that reload itself may evict one
    // of the currently-cached Workers.
    await invoke('a', false);
    await invoke('c', false);

    // B was the least-recently-used entry when C pushed the cache over budget.
    await invoke('b', true);

    assert.strictEqual(loadCounts.get('a'), 1);
    assert.strictEqual(loadCounts.get('b'), 2);
    assert.strictEqual(loadCounts.get('c'), 1);
  },
};
