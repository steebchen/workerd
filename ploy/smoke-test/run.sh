#!/bin/sh
# Usage: run.sh <workerd binary>. Runs a Ploy-like main worker that loads a tenant through the
# Worker Loader and checks that limits.cpuMs and limits.startupCpuMs cut off runaway tenants without
# stalling the process, and that maxCachedMemoryBytes evicts least recently used tenants.
set -u
BIN=$1
$BIN serve --experimental "$(dirname "$0")/config.capnp" >/tmp/wd.log 2>&1 &
PID=$!
sleep 2
fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2] want [$3]"; fail=1; fi; }
t() { curl -s --max-time 10 -o /tmp/body -w '%{http_code} %{time_total}' "http://127.0.0.1:8080$1"; }

r=$(t "/ok?cpuMs=100"); check "ok within limit" "$(echo $r | cut -d' ' -f1) $(cat /tmp/body)" "200 tenant ok"

( curl -s --max-time 10 -o /tmp/spin.body -w '%{http_code} %{time_total}' "http://127.0.0.1:8080/spin?cpuMs=200" > /tmp/spin.out ) &
SPIN=$!
sleep 0.05
p=$(t "/ping")
wait $SPIN
ping_ms=$(echo $p | awk '{printf "%d", $2*1000}')
code=$(cut -d' ' -f1 /tmp/spin.out); spin_s=$(cut -d' ' -f2 /tmp/spin.out)
check "infinite loop is cut off" "$code $(grep -o 'exceeded CPU time limit' /tmp/spin.body)" "503 exceeded CPU time limit"
echo "     spin request took ${spin_s}s, ping during spin took ${ping_ms}ms"
[ "$ping_ms" -lt 1500 ] && echo "PASS ping not blocked past the limit" || { echo "FAIL ping waited ${ping_ms}ms"; fail=1; }

r=$(t "/ok"); check "isolate still serves after termination" "$(echo $r | cut -d' ' -f1) $(cat /tmp/body)" "200 tenant ok"
r=$(t "/burn?n=200000000&cpuMs=60000"); check "heavy work within a big budget completes" "$(echo $r | cut -d' ' -f1)" "200"
r=$(t "/burn?n=2000000000&cpuMs=100"); check "heavy work over budget is cut off" "$(echo $r | cut -d' ' -f1) $(grep -o 'exceeded CPU time limit' /tmp/body)" "503 exceeded CPU time limit"
sleep 1
before=$(t "/tail-times" >/dev/null; cat /tmp/body)
r=$(t "/burn?n=300000000"); check "unlimited heavy work completes" "$(echo $r | cut -d' ' -f1)" "200"
burn_ms=$(echo $r | awk '{printf "%d", $2*1000}')
sleep 1
t "/tail-times" >/dev/null
after=$(cat /tmp/body)
cpu_ms=-1; wall_ms=-1
if [ "$(printf '%s\n' "$after" | grep -c .)" -gt "$(printf '%s\n' "$before" | grep -c .)" ]; then
	cpu_ms=$(printf '%s\n' "$after" | grep . | tail -1 | cut -d' ' -f1)
	wall_ms=$(printf '%s\n' "$after" | grep . | tail -1 | cut -d' ' -f2)
fi
echo "     tail cpuTime ${cpu_ms}ms wallTime ${wall_ms}ms for a request that took ${burn_ms}ms"
[ "$cpu_ms" -ge $((burn_ms / 3)) ] && [ "$cpu_ms" -le $((burn_ms * 2 + 50)) ] && echo "PASS tail reports request CPU time" || { echo "FAIL tail cpuTime ${cpu_ms}ms, request took ${burn_ms}ms"; fail=1; }
[ "$wall_ms" -ge "$cpu_ms" ] && [ "$wall_ms" -ge $((burn_ms / 2)) ] && [ "$wall_ms" -le $((burn_ms * 2 + 500)) ] && echo "PASS tail reports request wall time" || { echo "FAIL tail wallTime ${wall_ms}ms, cpuTime ${cpu_ms}ms, request took ${burn_ms}ms"; fail=1; }

r=$(t "/startup-spin"); check "startup loop is cut off" "$(echo $r | cut -d' ' -f1) $(grep -o 'exceeded CPU time limit during startup' /tmp/body)" "503 exceeded CPU time limit during startup"
echo "     startup-spin request took $(echo $r | cut -d' ' -f2)s"

# boundedLoader caches 128 MiB of tenants: two 44 MiB tenants fit, a third evicts the least recently
# used one, which then reloads on its next request.
big() { t "/big?mib=44&name=$1" >/dev/null; cat /tmp/body; }
big a >/dev/null; big b >/dev/null; big a >/dev/null; big c >/dev/null
check "cached tenant is reused" "$(big a)" "a loads=1"
check "recent tenant stays cached" "$(big c)" "c loads=1"
check "least recently used tenant is evicted" "$(big b)" "b loads=2"
rss_before=$(ps -o rss= -p $PID | tr -d ' ')
i=0; while [ $i -lt 20 ]; do big "n$i" >/dev/null; i=$((i + 1)); done
rss_after=$(ps -o rss= -p $PID | tr -d ' ')
echo "     RSS ${rss_before}KiB before, ${rss_after}KiB after loading 20 more 44 MiB tenants (880 MiB uncapped)"
[ $((rss_after - rss_before)) -lt $((440 * 1024)) ] && echo "PASS memory stays bounded" || { echo "FAIL RSS grew by $(((rss_after - rss_before) / 1024))MiB"; fail=1; }

r=$(t "/ping"); check "main worker unaffected" "$(echo $r | cut -d' ' -f1) $(cat /tmp/body)" "200 pong"
kill $PID
exit $fail
