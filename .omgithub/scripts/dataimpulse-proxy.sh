#!/usr/bin/env bash
# Fallback egress for free models after WARP gives up: a sticky worldwide DataImpulse
# residential session (sessid = GITHUB_RUN_ID), served only to verified
# PlayGround runs by omgithub.com in exchange for this job's GitHub OIDC token.
#
# Usage: dataimpulse-proxy.sh <work-dir> <opencode-bin> <web-dir>
# Exit 0: <work-dir>/proxy-url holds http://127.0.0.1:PORT (a local relay that
#         adds the upstream credentials; OpenCode never sees them).
# Exit 4: the probe was rate limited (429). Exit 5: fallback off (PROXY_REQUEST!=true). Other non-zero: setup error.
# Always writes <work-dir>/status.json {"result":"proxy_ok|proxy_429|proxy_error"}.
# Never enable set -x here: the credentials pass through this script's children.
set -uo pipefail
set +x
PROBE_SECONDS=90
PROBE_MODELS=(opencode/deepseek-v4.1-flash-free opencode/glm-5.3-flash-free opencode/mimo-v2.6-flash-free opencode/big-pickle)
work="${1:?work dir}" opencode_bin="${2:?opencode binary}" web_dir="${3:?web dir}"
here="$(cd "$(dirname "$0")" && pwd)"
log() { printf '[dataimpulse] %s\n' "$*" >&2; }
mkdir -p "$work" && chmod 700 "$work"
status() { printf '{"result":"%s"}\n' "$1" > "$work/status.json" 2>/dev/null || true; }
status proxy_error
# Settings > Residential proxy fallback is off by default (no proxy label): never call ci-proxy.
if [[ "${PROXY_REQUEST:-}" != 'true' ]]; then log 'residential proxy fallback is off for this run'; status proxy_off; exit 5; fi
bounded() {
  local seconds="$1"; shift
  "$@" & local pid=$!
  ( sleep "$seconds"; kill -TERM "$pid" 2>/dev/null; sleep 3; kill -KILL "$pid" 2>/dev/null ) & local guard=$!
  wait "$pid"; local rc=$?
  kill "$guard" 2>/dev/null; wait "$guard" 2>/dev/null
  return "$rc"
}

# Credentials: masked in the job log before anything else can print them,
# written only to a 600 file the relay reads once and deletes.
umask 077
if ! timeout 40 node --input-type=module - "$work/creds.json" <<'NODE'
import { writeFileSync } from 'node:fs'
const env = process.env
const origin = String(env.OMGITHUB_ORIGIN || 'https://omgithub.com').replace(/\/$/, '')
const call = async (url, options) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}
try {
  const id = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL); id.searchParams.set('audience', origin)
  const { value } = await call(id, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } })
  const c = await call(`${origin}/api/github/${env.GITHUB_REPOSITORY}/issues/${env.TRIGGER_ISSUE_NUMBER}/ci-proxy`, {
    method: 'POST', headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json' },
    body: JSON.stringify({ run: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT) })
  })
  if (![c.login, c.password, c.host].every(v => typeof v === 'string' && v && !/[\s:@]/.test(v)) || !Number.isInteger(c.port)) throw new Error('bad response')
  const user = `${c.login}__sessid.${env.GITHUB_RUN_ID}`
  for (const secret of [c.login, c.password, user, `${user}:${c.password}`, Buffer.from(`${user}:${c.password}`).toString('base64'), `http://${user}:${c.password}@${c.host}:${c.port}`]) console.log(`::add-mask::${secret}`)
  writeFileSync(process.argv[2], JSON.stringify({ host: c.host, port: c.port, user, password: c.password }), { mode: 0o600 })
} catch (error) { console.error(`[dataimpulse] credentials unavailable (${String(error.message).slice(0, 60)})`); process.exit(1) }
NODE
then rm -f "$work/creds.json"; exit 2; fi

rm -f "$work/relay.port"
nohup node "$here/proxy-relay.mjs" "$work/creds.json" "$work/relay.port" "$web_dir/proxy-bytes.json" > /dev/null 2>&1 &
echo $! > "$work/relay.pid"
for _ in $(seq 1 50); do [[ -s "$work/relay.port" ]] && break; sleep 0.1; done
rm -f "$work/creds.json"
port="$(cat "$work/relay.port" 2>/dev/null)"
stop() { kill "$(cat "$work/relay.pid" 2>/dev/null)" 2>/dev/null; rm -f "$work/relay.pid"; }
[[ "$port" =~ ^[0-9]+$ ]] || { log 'relay did not start'; stop; exit 2; }
proxy="http://127.0.0.1:$port"
country="$(curl --silent --max-time 15 --proxy "$proxy" https://ipinfo.io/country 2>/dev/null | tr -cd 'A-Z' | cut -c1-2)"
log "relay up; exit country ${country:-unknown}"

# Same isolated free-model probe as warp-proxy.sh.
probe="$work/probe"; rm -rf "$probe"; mkdir -p "$probe/project" "$probe/data" "$probe/config" "$probe/cache" "$probe/state"
printf '{"plugin":[],"permission":{"*":"allow"}}\n' > "$probe/opencode.json"
rc=3
for model in "${PROBE_MODELS[@]}"; do
  out="$probe/run.jsonl"
  ( cd "$probe/project" && HTTPS_PROXY="$proxy" HTTP_PROXY="$proxy" https_proxy="$proxy" http_proxy="$proxy" \
      NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 \
      XDG_DATA_HOME="$probe/data" XDG_CONFIG_HOME="$probe/config" XDG_CACHE_HOME="$probe/cache" XDG_STATE_HOME="$probe/state" \
      OPENCODE_CONFIG="$probe/opencode.json" OPENCODE_API_KEY= OPENCODE_AUTH_JSON= OPENROUTER_API_KEY= \
      bounded "$PROBE_SECONDS" "$opencode_bin" run --standalone --model "$model" --format json 'Reply with exactly: OK' ) > "$out" 2>&1
  if grep -q '"type":"text"' "$out"; then log "probe: $model answered"; rc=0; break; fi
  if grep -Eqi 'FreeUsageLimit|free usage limit|"status":429|\b429\b|rate.?limit' "$out"; then log "probe: $model rate limited (429)"; rc=4; break; fi
  if grep -Eqi 'ModelDeprecated|model.{0,40}(not found|unavailable|deprecated)|ProviderModelNotFound' "$out"; then continue; fi
  log "probe: $model failed: $(tr '\n' ' ' < "$out" | grep -Eo '"name":"[A-Za-z]{1,60}' | head -1) upstream: $(node -p 'require(process.argv[1]).last_error||"-"' "$web_dir/proxy-bytes.json" 2>/dev/null || echo -)"; rc=2; break
done
rm -rf "$probe"
case "$rc" in
  0|3) status proxy_ok; printf '%s\n' "$proxy" > "$work/proxy-url"; exit 0 ;;
  4) status proxy_429; stop; exit 4 ;;
  *) status proxy_error; stop; exit 2 ;;
esac
