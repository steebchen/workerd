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
    if (url.pathname === "/upload") {
      await request.arrayBuffer();
      let remaining = Number(url.searchParams.get("size"));
      const body = new ReadableStream({
        pull(controller) {
          if (remaining === 0) return controller.close();
          const n = Math.min(remaining, 4096);
          controller.enqueue(new Uint8Array(n));
          remaining -= n;
        },
      });
      return new Response(body, { headers: { "content-type": "application/x-ploy-test" } });
    }
    return new Response("tenant ok");
  }
};`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return new Response("pong");
    if (url.pathname === "/tail-times") return env.tail.fetch("http://tail/");
    if (url.pathname === "/tail-main") return env.tail.fetch("http://tail/main");
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
      return await entrypoint.fetch(new Request("http://tenant" + url.pathname + url.search, request));
    } catch (error) {
      return new Response("tenant failed: " + error.message, { status: 503 });
    }
  },
};
