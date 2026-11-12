#!/usr/bin/env bash
# Lazy egress, called once by run-with-model-fallback.mjs when Default started on Fusion with
# WARP skipped (WARP_LAZY=1) and the chain now reaches a free OpenCode model. Same order as the
# startup step: phone (opencode.ai / openrouter.ai) + WARP/DataImpulse for models.opencode.ai,
# else WARP alone, else DataImpulse, else runner network. Restarts `opencode serve` behind the
# chosen 127.0.0.1 relay (the session lives on disk).
# dataimpulse-proxy.sh stdout carries ::add-mask:: lines; it is discarded (not step stdout).
# Exit 0 = device and/or WARP, 3 = DataImpulse, 1 = unchanged (runner network).
set -uo pipefail
set +x
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${OPENCODE_BIN:?}" "${OPENCODE_WEB_DIR:?}"
tmp="${RUNNER_TEMP:-/tmp}"
record() { LAZY_RESULT="$1" node -e 'const fs=require("fs"),f=process.env.OPENCODE_WEB_DIR+"/warp-status.json";let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
fs.writeFileSync(f,JSON.stringify({...s,lazy:process.env.LAZY_RESULT}))' 2>/dev/null || true; }

DEVICE=''
work_device="$tmp/device-proxy-lazy"
if bash "$here/device-proxy.sh" "$work_device" "$OPENCODE_BIN" "$OPENCODE_WEB_DIR" > /dev/null \
  && DEVICE="$(cat "$work_device/proxy-url" 2>/dev/null)" && [[ "$DEVICE" == http://127.0.0.1:* ]]; then
  :
else
  DEVICE=''
fi

GENERAL=''
proxy="$(bash "$here/warp-proxy.sh" "$tmp/warp" "$OPENCODE_BIN" 2>&2 | tail -n 1)"
if [[ "$proxy" == http://127.0.0.1:* ]]; then
  GENERAL="$proxy"
fi

if [[ -z "$GENERAL" && "${PROXY_REQUEST:-}" == 'true' ]]; then
  work="$tmp/dataimpulse-lazy"
  if bash "$here/dataimpulse-proxy.sh" "$work" "$OPENCODE_BIN" "$OPENCODE_WEB_DIR" > /dev/null \
    && proxy="$(cat "$work/proxy-url" 2>/dev/null)" && [[ "$proxy" == http://127.0.0.1:* ]]; then
    GENERAL="$proxy"
  fi
fi

if [[ -n "$DEVICE" ]]; then
  composed="$(bash "$here/compose-egress-proxy.sh" "$tmp/egress-mux-lazy" "$DEVICE" "$GENERAL" || true)"
  if [[ "$composed" == http://127.0.0.1:* ]] && bash "$here/start-opencode-serve.sh" "$composed" --wait; then
    echo "lazy proxy: device mux ready (models via ${GENERAL:+general}${GENERAL:-direct})" >&2
    record device; exit 0
  fi
fi

if [[ -n "$GENERAL" ]] && bash "$here/start-opencode-serve.sh" "$GENERAL" --wait; then
  # Distinguish WARP vs DataImpulse by whether warp work dir has egress.
  if [[ -s "$tmp/warp/egress" ]]; then
    echo "lazy proxy: WARP ready" >&2; record warp; exit 0
  fi
  echo "lazy proxy: DataImpulse ready" >&2; record dataimpulse; exit 3
fi

if [[ "${PROXY_REQUEST:-}" != 'true' && -z "$DEVICE" ]]; then
  bash "$here/start-opencode-serve.sh" "" --wait >/dev/null 2>&1 || true
  echo "lazy proxy: WARP unavailable, residential proxy fallback off; runner network" >&2; record none; exit 1
fi
bash "$here/start-opencode-serve.sh" "" --wait >/dev/null 2>&1 || true
echo "lazy proxy: unavailable; runner network" >&2; record none; exit 1
