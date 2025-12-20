#!/usr/bin/env python3
"""RunPod serverless handler for llama-cpp-python text generation."""

from __future__ import annotations

import os
import time
import logging
from typing import Any, Dict

import runpod

from llama_runtime import build_llm

LOGGER = logging.getLogger('llama.serverless')
if not LOGGER.handlers:
    logging.basicConfig(level=logging.INFO)

LLM = None



DEFAULT_SYSTEM_PROMPT = (
    """
あなたは感情豊かな日本語のキャラクターです。
以下のルールを必ず守って返答してください。
- 説明や地の文は一切書かず、話し手一人のセリフだけを出力する。
- 他の登場人物のセリフや名前、やり取りは書かない。
- 心の声やト書きを表す括弧（）、【】、＜＞などの記号は使わない。
- 句読点（。、！？）以外の記号は使わない。
- 心情説明や解説を挟まず、話し言葉のセリフだけを自然な長さで書く。
"""
)


def _extract_payload(event: Any) -> Dict[str, Any]:
    if isinstance(event, dict) and "input" in event and isinstance(event["input"], dict):
        return dict(event["input"])
    if isinstance(event, dict):
        return dict(event)
    raise RuntimeError("Invalid payload; expected JSON object input.")



def _ensure_llm():
    global LLM
    if LLM is None:
        start = time.perf_counter()
        LOGGER.info('llama.load.start')
        LLM = build_llm()
        elapsed = time.perf_counter() - start
        LOGGER.info('llama.load.complete elapsed=%.3fs', elapsed)
    return LLM



def _compose_system_prompt(persona: str) -> str:
    persona_clean = persona.strip()
    if not persona_clean:
        return DEFAULT_SYSTEM_PROMPT
    return f"{DEFAULT_SYSTEM_PROMPT}\nキャラクター設定: {persona_clean}"


def handler(event: Any) -> Dict[str, Any]:
    payload = _extract_payload(event)

    user_input = str(
        payload.get("user_input")
        or payload.get("prompt")
        or payload.get("message")
        or payload.get("text")
        or ""
    ).strip()
    if not user_input:
        raise RuntimeError("user_input (conversation text) is required.")

    persona = str(payload.get("persona") or payload.get("persona_prompt") or "").strip()

    max_tokens = int(payload.get("max_tokens", 160))
    max_tokens = max(16, min(max_tokens, int(os.environ.get("LLAMA_MAX_TOKENS", "1024"))))

    temperature = float(payload.get("temperature", os.environ.get("TEMPERATURE", "0.7")))
    top_p = float(payload.get("top_p", os.environ.get("TOP_P", "0.9")))
    top_k = int(payload.get("top_k", os.environ.get("TOP_K", "40")))
    repeat_penalty = float(payload.get("repeat_penalty", os.environ.get("REPEAT_PENALTY", "1.1")))

    system_prompt = _compose_system_prompt(persona)

    try:
        llm = _ensure_llm()
    except FileNotFoundError as exc:  # noqa: BLE001
        raise RuntimeError(str(exc)) from exc

    LOGGER.info('llama.request prompt_len=%s persona_len=%s max_tokens=%s', len(user_input), len(persona), max_tokens)
    start = time.perf_counter()
    try:
        completion = llm.create_chat_completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_input},
            ],
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            repeat_penalty=repeat_penalty,
        )
    except Exception as exc:
        LOGGER.exception('llama.error: %s', exc)
        raise

    duration = time.perf_counter() - start
    LOGGER.info('llama.generation.complete duration=%.3fs', duration)

    choices = completion.get("choices") or []
    if not choices:
        raise RuntimeError({"error": "llama_no_choices", "detail": completion})

    choice = choices[0]
    message = choice.get("message") or {}
    text = (message.get("content") or choice.get("text") or "").strip()
    if not text:
        raise RuntimeError({"error": "llama_empty_response", "detail": choice})

    usage = completion.get("usage") or {}

    return {
        "status": "completed",
        "text": text,
        "persona": persona,
        "user_input": user_input,
        "system_prompt": system_prompt,
        "parameters": {
            "max_tokens": max_tokens,
            "temperature": temperature,
            "top_p": top_p,
            "top_k": top_k,
            "repeat_penalty": repeat_penalty,
        },
        "duration_sec": round(duration, 3),
        "usage": {
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "total_tokens": usage.get("total_tokens"),
        },
    }


runpod.serverless.start({"handler": handler})
