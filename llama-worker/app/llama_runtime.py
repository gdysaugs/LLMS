#!/usr/bin/env python3
"""Shared llama.cpp runtime helpers."""

from __future__ import annotations

import os
from functools import lru_cache

from llama_cpp import Llama, llama_print_system_info


import logging
LOGGER = logging.getLogger('llama.runtime')

def _log_system_info() -> None:
    try:
        info = llama_print_system_info().strip()
        LOGGER.info("llama.system_info\n%s", info)
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("llama.system_info failed: %s", exc)


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default



def _resolve_model_path() -> str:
    model_path = os.environ.get("MODEL_PATH", "/opt/models/Berghof-NSFW-7B.i1-Q4_K_M.gguf")
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Model file not found: {model_path}")
    return model_path


@lru_cache(maxsize=1)
def build_llm() -> Llama:
    """Initialise Llama instance once per process."""
    model_path = _resolve_model_path()
    n_ctx = _int_env("CTX_SIZE", 4096)
    n_threads = _int_env("THREADS", os.cpu_count() or 4)
    n_batch = _int_env("N_BATCH", min(512, n_ctx))
    main_gpu = _int_env("MAIN_GPU", 0)
    # Default to fully offload layers to GPU when unset.
    n_gpu_layers = _int_env("GPU_LAYERS", 999)

    LOGGER.info(
        "llama.init model=%s n_ctx=%s n_threads=%s n_gpu_layers=%s n_batch=%s main_gpu=%s cuda_visible=%s",
        model_path,
        n_ctx,
        n_threads,
        n_gpu_layers,
        n_batch,
        main_gpu,
        os.environ.get("CUDA_VISIBLE_DEVICES"),
    )

    _log_system_info()

    llm = Llama(
        model_path=model_path,
        n_ctx=n_ctx,
        n_threads=n_threads,
        n_gpu_layers=n_gpu_layers,
        n_batch=n_batch,
        main_gpu=main_gpu,
        use_mlock=False,
        use_mmap=True,
        verbose=False,
    )

    try:
        gpu_layers = getattr(llm, 'n_gpu_layers', None)
        if callable(gpu_layers):
            gpu_layers = gpu_layers()
        LOGGER.info('llama.gpu_layers.active=%s', gpu_layers)
    except Exception:
        LOGGER.warning('llama.gpu_layers probe failed', exc_info=True)

    return llm
