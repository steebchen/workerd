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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return new Response("pong");
    if (url.pathname === "/tail-cpu") return env.tail.fetch("http://tail/");
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
