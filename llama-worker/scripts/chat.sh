#!/usr/bin/env bash
set -euo pipefail

MODEL_PATH=${MODEL_PATH:-/opt/models/Berghof-NSFW-7B.i1-Q4_K_M.gguf}

if [[ ! -f "${MODEL_PATH}" ]]; then
  cat <<'MSG'
[ERROR] Model file not found inside the container at "${MODEL_PATH}".
        Rebuild the image or provide a different MODEL_PATH.
MSG
  exit 1
fi

exec python3 /opt/app/chat_cli.py
