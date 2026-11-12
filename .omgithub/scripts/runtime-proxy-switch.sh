#!/usr/bin/env bash
# Runtime egress switch, called once by run-with-model-fallback.mjs when a free model hits
# FreeUsageLimit even though WARP passed its startup probe: start the DataImpulse relay and
# restart `opencode serve` behind it. The session lives on disk, so the same model is retried.
# stdout of dataimpulse-proxy.sh carries ::add-mask:: lines; it is discarded here (this runs
# outside step stdout). Credentials stay inside the relay; only a 127.0.0.1 URL is used.
# Exit 0 when OpenCode is serving through DataImpulse; non-zero keeps the previous network.
set -uo pipefail
set +x
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ "${PROXY_REQUEST:-}" == 'true' ]] || { echo "runtime proxy switch: residential proxy fallback is off for this run" >&2; exit 1; }
: "${OPENCODE_BIN:?}" "${OPENCODE_WEB_DIR:?}"
# Phone-first before DataImpulse. Keep the previous WARP/DataImpulse URL as the
# mux "general" path so models.opencode.ai never moves onto the phone.
work_device="${RUNNER_TEMP:-/tmp}/device-proxy-runtime"
if bash "$here/device-proxy.sh" "$work_device" "$OPENCODE_BIN" "$OPENCODE_WEB_DIR" > /dev/null; then
  device="$(cat "$work_device/proxy-url" 2>/dev/null || true)"
  previous="$(cat "$OPENCODE_WEB_DIR/opencode-proxy" 2>/dev/null || true)"
  general=''
  [[ "$previous" == http://127.0.0.1:* && "$previous" != "$device" ]] && general="$previous"
  proxy=""
  if [[ "$device" == http://127.0.0.1:* ]]; then
    proxy="$(bash "$here/compose-egress-proxy.sh" "${RUNNER_TEMP:-/tmp}/egress-mux-runtime" "$device" "$general" || true)"
  fi
  if [[ "$proxy" == http://127.0.0.1:* ]] && bash "$here/start-opencode-serve.sh" "$proxy" --wait; then
    printf '%s\n' "$previous" > "$OPENCODE_WEB_DIR/opencode-proxy.fallback"
    PROXY_RESULT=device_ok node -e 'const fs=require("fs"),f=process.env.OPENCODE_WEB_DIR+"/warp-status.json";let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
fs.writeFileSync(f,JSON.stringify({...s,proxy:process.env.PROXY_RESULT,switched_at:"runtime"}))' 2>/dev/null || true
    echo "runtime proxy switch: device_ok" >&2
    exit 0
  fi
fi
work="${RUNNER_TEMP:-/tmp}/dataimpulse-runtime"
bash "$here/dataimpulse-proxy.sh" "$work" "$OPENCODE_BIN" "$OPENCODE_WEB_DIR" > /dev/null
rc=$?
result="$(node -p 'const r=require(process.argv[1]).result;["proxy_ok","proxy_429","proxy_error"].includes(r)?r:"proxy_error"' "$work/status.json" 2>/dev/null || echo proxy_error)"
proxy="$(cat "$work/proxy-url" 2>/dev/null || true)"
previous="$(cat "$OPENCODE_WEB_DIR/opencode-proxy" 2>/dev/null || true)"
switched=1
if [[ $rc -eq 0 && "$result" == proxy_ok && "$proxy" == http://127.0.0.1:* ]]; then
  if ! bash "$here/start-opencode-serve.sh" "$proxy" --wait; then
    result=proxy_error
    bash "$here/start-opencode-serve.sh" "$previous" --wait || true
  else switched=0; printf '%s\n' "$previous" > "$OPENCODE_WEB_DIR/opencode-proxy.fallback"; fi
fi
PROXY_RESULT="$result" node -e 'const fs=require("fs"),f=process.env.OPENCODE_WEB_DIR+"/warp-status.json";let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
fs.writeFileSync(f,JSON.stringify({...s,proxy:process.env.PROXY_RESULT,switched_at:"runtime"}))' 2>/dev/null || true
echo "runtime proxy switch: $result" >&2
exit $switched
