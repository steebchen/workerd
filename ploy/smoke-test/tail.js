// Records tail events like Ploy's log worker forwards them.
// GET / returns one "<cpuTime> <wallTime>" line per tenant event.
// GET /main returns one "<path> <requestBodySize> <responseBodySize> <contentType>" line per main
// worker event, the event Ploy's request log is built from.
const tenant = [];
const main = [];

export default {
  tail(batch) {
    for (const event of batch) {
      const request = event.event?.request;
      const url = new URL(request?.url ?? 'http://unknown/');
      if (url.hostname === 'tenant') {
        tenant.push(`${event.cpuTime} ${event.wallTime}`);
      } else {
        const response = event.event?.response;
        main.push(
          `${url.pathname} ${request?.bodySize} ${response?.bodySize} ${response?.contentType}`
        );
      }
    }
  },
  fetch(request) {
    const lines = new URL(request.url).pathname === '/main' ? main : tenant;
    return new Response(lines.map((line) => line + '\n').join(''));
  },
};
