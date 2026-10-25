#!/usr/bin/env bash
# Read-only verification of a running deployment. Safe on a live server.
source "$(dirname "$0")/lib.sh"
export IMAGE_TAG="${IMAGE_TAG:-$(cat deploy/state/current 2>/dev/null || resolve_tag)}"

fail=0
note() { printf '  %-46s %s\n' "$1" "$2"; }
ok() { note "$1" "$(c_green OK)"; }
bad() { note "$1" "$(c_red FAIL)"; fail=$((fail+1)); }

echo
echo "Deployment health - revision ${IMAGE_TAG}"
echo

for svc in redis api worker web; do
  state=$(docker inspect -f '{{.State.Status}}' "$(compose ps -q "$svc" 2>/dev/null)" 2>/dev/null || echo missing)
  [ "$state" = "running" ] && ok "$svc running" || bad "$svc running (state: $state)"
done

# The API's own liveness, from inside the network.
if compose exec -T api node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>r.json()).then(j=>{console.log(JSON.stringify(j.data));process.exit(j.data.status==='ok'?0:1)}).catch(()=>process.exit(1))" >/tmp/rs_health 2>&1; then
  ok "api /api/health"
  note "  dependencies" "$(cat /tmp/rs_health)"
else
  bad "api /api/health"
fi

# MongoDB, through the application's own connection settings.
compose exec -T api node -e "
const m=require('mongoose');
m.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:8000}).then(async()=>{
  const h=await m.connection.db.admin().command({hello:1});
  if(!h.setName) { console.error('NOT a replica set - transactions unavailable'); process.exit(1); }
  console.log('replicaSet='+h.setName+' writable='+h.isWritablePrimary);
  process.exit(0);
}).catch(e=>{console.error(e.message);process.exit(1)})" >/tmp/rs_mongo 2>&1 \
  && { ok "mongodb reachable, replica set"; note "  $(cat /tmp/rs_mongo)" ""; } \
  || { bad "mongodb reachable, replica set"; note "  $(head -1 /tmp/rs_mongo)" ""; }

# Redis, from the API.
compose exec -T redis redis-cli ping >/dev/null 2>&1 && ok "redis PING" || bad "redis PING"

# The worker registered its queue. No HTTP endpoint exists, by design.
compose logs worker --tail 200 2>/dev/null | grep -q 'Worker process ready' && ok "worker registered its queues" || bad "worker registered its queues"

# nginx, the SPA and the API through it.
compose exec -T web wget -q -O- http://127.0.0.1/healthz >/dev/null 2>&1 && ok "nginx healthz" || bad "nginx healthz"
compose exec -T web wget -q -O- http://127.0.0.1/ 2>/dev/null | grep -q '<div id="root"' && ok "SPA served" || bad "SPA served"
compose exec -T web wget -q -O- http://127.0.0.1/api/health 2>/dev/null | grep -q '"status":"ok"' && ok "api reachable through nginx" || bad "api reachable through nginx"

# Nothing internal may be published.
published=$(docker ps --format '{{.Names}} {{.Ports}}' | grep retailer-suites-prod || true)
echo "$published" | grep -qE '0\.0\.0\.0:(6379|27017)' && bad "redis/mongo not published" || ok "redis/mongo not published"

# Uploads are a volume, not container-local.
compose exec -T api sh -c 'test -w /app/server/uploads' && ok "uploads writable by the app user" || bad "uploads writable by the app user"
mount=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/server/uploads"}}{{.Type}}:{{.Name}}{{end}}{{end}}' "$(compose ps -q api)" 2>/dev/null)
[ -n "$mount" ] && ok "uploads on a named volume ($mount)" || bad "uploads on a named volume"

echo
echo "Resource use:"
docker stats --no-stream --format '  {{.Name}}  {{.MemUsage}}  cpu {{.CPUPerc}}' $(compose ps -q 2>/dev/null) 2>/dev/null || true

echo
[ "$fail" -gt 0 ] && { c_red "$fail check(s) failed."; exit 1; }
c_green "All checks passed."
