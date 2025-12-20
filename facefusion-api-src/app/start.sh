#!/usr/bin/env bash
set -euo pipefail

FASTAPI_HOST=${FASTAPI_HOST:-0.0.0.0}
FASTAPI_PORT=${FASTAPI_PORT:-8000}
FASTAPI_APP=${FASTAPI_APP:-fastapi_server:app}
ENABLE_CLOUDFLARE=${ENABLE_CLOUDFLARE:-0}
CLOUDFLARED_BIN=${CLOUDFLARED_BIN:-/usr/local/bin/cloudflared}
CLOUDFLARED_CONFIG=${CLOUDFLARED_CONFIG:-/opt/cloudflared/config.yml}
CLOUDFLARED_CERT=${CLOUDFLARED_CERT:-/opt/cloudflared/cert.pem}
CLOUDFLARE_TUNNEL_NAME=${CLOUDFLARE_TUNNEL_NAME:-lipdiffusion-internal}
CLOUDFLARED_NOHUP=${CLOUDFLARED_NOHUP:-0}
FASTAPI_LOG_FILE=${FASTAPI_LOG_FILE:-/opt/app/fastapi.log}
FORWARDED_ALLOW_IPS=${FASTAPI_FORWARDED_ALLOW_IPS:-127.0.0.1,::1}

CF_PID=""
API_PID=""

cleanup() {
  local exit_code=$?
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" >/dev/null 2>&1; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" 2>/dev/null || true
  fi
  if [[ -n "$CF_PID" ]] && kill -0 "$CF_PID" >/dev/null 2>&1; then
    kill "$CF_PID" >/dev/null 2>&1 || true
    wait "$CF_PID" 2>/dev/null || true
  fi
  exit $exit_code
}
trap cleanup EXIT INT TERM

start_cloudflared() {
  if [[ "$ENABLE_CLOUDFLARE" == "0" ]]; then
    echo "[startup] Cloudflare tunnel disabled via ENABLE_CLOUDFLARE"
    return
  fi
  if [[ ! -x "$CLOUDFLARED_BIN" ]]; then
    echo "[startup] cloudflared binary not found at $CLOUDFLARED_BIN (skipping tunnel)" >&2
    return 0
  fi
  if [[ ! -f "$CLOUDFLARED_CONFIG" ]]; then
    echo "[startup] cloudflared config missing at $CLOUDFLARED_CONFIG (skipping tunnel)" >&2
    return 0
  fi
  if [[ ! -f "$CLOUDFLARED_CERT" ]]; then
    echo "[startup] cloudflared cert missing at $CLOUDFLARED_CERT (skipping tunnel)" >&2
    return 0
  fi
  local common_args=(
    "tunnel" "--config" "$CLOUDFLARED_CONFIG" "--origincert" "$CLOUDFLARED_CERT" "--no-autoupdate" "run" "$CLOUDFLARE_TUNNEL_NAME"
  )
  if [[ "$CLOUDFLARED_NOHUP" == "1" ]]; then
    nohup "$CLOUDFLARED_BIN" "${common_args[@]}" >/var/log/cloudflared.log 2>&1 &
  else
    "$CLOUDFLARED_BIN" "${common_args[@]}" &
  fi
  CF_PID=$!
  echo "[startup] cloudflared started with PID $CF_PID"
}

start_fastapi() {
  local uvicorn_bin=${UVICORN_BIN:-/opt/venv/bin/uvicorn}
  if [[ ! -x "$uvicorn_bin" ]]; then
    uvicorn_bin=$(command -v uvicorn || true)
  fi
  if [[ -z "$uvicorn_bin" || ! -x "$uvicorn_bin" ]]; then
    echo "[startup] uvicorn binary not found (checked /opt/venv/bin/uvicorn and PATH)" >&2
    return 1
  fi
  mkdir -p "$(dirname "$FASTAPI_LOG_FILE")"
  touch "$FASTAPI_LOG_FILE"
  "$uvicorn_bin" "$FASTAPI_APP" \
    --host "$FASTAPI_HOST" \
    --port "$FASTAPI_PORT" \
    --proxy-headers \
    --forwarded-allow-ips="$FORWARDED_ALLOW_IPS" >>"$FASTAPI_LOG_FILE" 2>&1 &
  API_PID=$!
  echo "[startup] FastAPI server started with PID $API_PID (logging to $FASTAPI_LOG_FILE)"
}

start_cloudflared || true
start_fastapi

wait "$API_PID"
