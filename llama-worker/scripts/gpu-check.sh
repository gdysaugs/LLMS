#!/usr/bin/env bash
set -euo pipefail

echo "[gpu-check] starting GPU health check"

if command -v nvidia-smi >/dev/null 2>&1; then
  echo "[gpu-check] nvidia-smi output:"
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader || true
else
  echo "[gpu-check] nvidia-smi not found"
fi

if [ -e /dev/nvidia0 ]; then
  echo "[gpu-check] /dev/nvidia0 present"
else
  echo "[gpu-check] /dev/nvidia0 missing"
  if [[ "${REQUIRE_GPU:-1}" == "1" ]]; then
    echo "[gpu-check] REQUIRE_GPU=1 and GPU device missing; exiting"
    exit 1
  fi
fi

if ldconfig -p | grep -q libcuda; then
  echo "[gpu-check] libcuda present in ldconfig cache"
else
  echo "[gpu-check] libcuda missing from ldconfig cache"
  if [[ "${REQUIRE_GPU:-1}" == "1" ]]; then
    echo "[gpu-check] REQUIRE_GPU=1 and libcuda missing; exiting"
    exit 1
  fi
fi

python3 - <<'PY'
import sys
try:
    from llama_cpp import llama_print_system_info
except Exception as exc:  # noqa: BLE001
    print(f"[gpu-check] llama_cpp import failed: {exc}", file=sys.stderr)
    sys.exit(1)

try:
    info = llama_print_system_info().strip()
    print("[gpu-check] llama_print_system_info:")
    print(info)
except Exception as exc:  # noqa: BLE001
    print(f"[gpu-check] llama_print_system_info failed: {exc}", file=sys.stderr)
    sys.exit(1)
PY

echo "[gpu-check] completed"
