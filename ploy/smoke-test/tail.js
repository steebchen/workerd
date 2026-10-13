// Records cpuTime and wallTime of the tenant's tail events, like Ploy's log worker forwards them.
// GET returns one "<cpuTime> <wallTime>" line per event.
const events = [];

export default {
  tail(batch) {
    for (const event of batch)
      events.push(`${event.cpuTime} ${event.wallTime}`);
  },
  fetch() {
    return new Response(events.map((line) => line + '\n').join(''));
  },
};
