// Records the cpuTime of tail events for the tenant, like Ploy's log worker forwards it.
const cpuTimes = [];

export default {
  tail(events) {
    for (const event of events) cpuTimes.push(event.cpuTime);
  },
  fetch() {
    return Response.json(cpuTimes);
  },
};
