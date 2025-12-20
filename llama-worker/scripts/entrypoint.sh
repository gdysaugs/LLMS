#!/usr/bin/env bash
set -euo pipefail

MODE=${MODE:-serverless}

if [[ "${REQUIRE_GPU:-1}" != "0" ]]; then
  /opt/scripts/gpu-check.sh
fi

if [[ "${MODE}" == "cli" ]]; then
  exec /opt/scripts/chat.sh ""
fi

exec python3 /opt/app/serverless_llama.py
