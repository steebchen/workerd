const TENANT = `
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/spin") { for (;;) {} }
    if (url.pathname === "/burn") {
      const n = Number(url.searchParams.get("n") || "50000000");
      let x = 0; for (let i = 0; i < n; i++) x = (x + i * 7) % 1000003;
      return new Response("burned " + x);
    }
    return new Response("tenant ok");
  }
};`;

// Holds `mib` MiB per isolate, so a few of them overrun the bounded loader's memory budget.
const BIG_TENANT = `
let retained;
export default {
  fetch(request) {
    const mib = Number(new URL(request.url).searchParams.get("mib"));
    retained ??= new Uint8Array(mib * 1024 * 1024).fill(1);
    return new Response("big " + retained.byteLength);
  }
};`;
const bigLoads = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return new Response("pong");
    if (url.pathname === "/big") {
      const name = url.searchParams.get("name");
      const worker = env.boundedLoader.get(name, () => {
        bigLoads.set(name, (bigLoads.get(name) ?? 0) + 1);
        return {
          compatibilityDate: "2025-09-15",
          mainModule: "tenant.js",
          modules: { "tenant.js": BIG_TENANT },
          globalOutbound: null,
        };
      });
      const response = await worker.getEntrypoint().fetch(new Request("http://tenant/" + url.search));
      await response.arrayBuffer();
      return new Response(name + " loads=" + bigLoads.get(name));
    }
    if (url.pathname === "/tail-times") return env.tail.fetch("http://tail/");
    if (url.pathname === "/startup-spin") {
      const spinning = env.loader.get("startup-spin", () => ({
        compatibilityDate: "2025-09-15",
        mainModule: "tenant.js",
        modules: { "tenant.js": "for (;;) {}\n" + TENANT },
        globalOutbound: null,
        limits: { startupCpuMs: 200 },
      }));
      try {
        return await spinning.getEntrypoint().fetch(new Request("http://tenant/"));
      } catch (error) {
        return new Response("tenant failed: " + error.message, { status: 503 });
      }
    }
    const cpuMs = url.searchParams.get("cpuMs");
    const worker = env.loader.get("tenant", () => ({
      compatibilityDate: "2025-09-15",
      mainModule: "tenant.js",
      modules: { "tenant.js": TENANT },
      globalOutbound: null,
      tails: [env.tail],
    }));
    const entrypoint = worker.getEntrypoint(
      undefined,
      cpuMs ? { limits: { cpuMs: Number(cpuMs) } } : undefined,
    );
    try {
      return await entrypoint.fetch(new Request("http://tenant" + url.pathname + url.search));
    } catch (error) {
      return new Response("tenant failed: " + error.message, { status: 503 });
    }
  },
};
