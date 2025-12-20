#!/usr/bin/env python3
"""Simple interactive chat loop powered by llama-cpp-python."""
from __future__ import annotations

import os
import signal
import sys
from typing import List

from prompt_toolkit import prompt
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.patch_stdout import patch_stdout
from rich.console import Console
from rich.panel import Panel

from llama_runtime import build_llm

console = Console()


def main() -> int:
    model_path = os.environ.get("MODEL_PATH", "/opt/models/Berghof-NSFW-7B.i1-Q4_K_M.gguf")
    n_ctx = int(os.environ.get("CTX_SIZE", "4096"))
    n_threads = int(os.environ.get("THREADS", os.cpu_count() or 4))
    n_gpu_layers = int(os.environ.get("GPU_LAYERS", "-1"))

    console.print(
        Panel.fit(
            f"Loading model\n[green]{model_path}[/green]\n"
            f"ctx={n_ctx} threads={n_threads} gpu_layers={n_gpu_layers}",
            title="llama.cpp",
        )
    )

    try:
        llm = build_llm()
    except FileNotFoundError as exc:
        console.print(f"[bold red]{exc}[/]")
        return 1

    system_prompt = os.environ.get("SYSTEM_PROMPT", "You are a helpful assistant.")
    top_k = int(os.environ.get("TOP_K", "40"))
    top_p = float(os.environ.get("TOP_P", "0.9"))
    temperature = float(os.environ.get("TEMPERATURE", "0.7"))
    max_tokens = int(os.environ.get("MAX_TOKENS", "1024"))

    history: List[dict[str, str]] = []

    console.print(
        Panel.fit(
            "Type your message and press Enter to send. Use /reset to clear history or /exit to quit.",
            title="Interactive Chat",
        )
    )

    stop_generation = False

    def handle_sigint(signum, frame):  # type: ignore[override]
        nonlocal stop_generation
        stop_generation = True
        console.print("\n[bold yellow]Stopping generation...[/]")

    signal.signal(signal.SIGINT, handle_sigint)

    user_history = InMemoryHistory()

    with patch_stdout(raw=True):
        while True:
            try:
                user_input = prompt("You > ", history=user_history)
            except EOFError:
                console.print("\n[bold]Goodbye![/]")
                return 0

            user_input = user_input.strip()
            if not user_input:
                continue

            if user_input in {"/exit", "/quit"}:
                console.print("[bold]Exiting...[/]")
                return 0

            if user_input == "/reset":
                history.clear()
                console.print("[green]Conversation history cleared.[/]")
                continue

            history.append({"role": "user", "content": user_input})

            messages = [
                {"role": "system", "content": system_prompt},
                *history,
            ]

            stop_generation = False
            console.print("Assistant > ", end="", style="cyan")
            sys.stdout.flush()

            collected: List[str] = []

            try:
                response = llm.create_chat_completion(
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    top_k=top_k,
                    top_p=top_p,
                    stream=True,
                )

                for chunk in response:
                    if stop_generation:
                        break
                    delta = chunk["choices"][0]["delta"].get("content")
                    if not delta:
                        continue
                    collected.append(delta)
                    console.print(delta, end="", style="bright_white")
                    sys.stdout.flush()
                console.print()
            except KeyboardInterrupt:
                console.print("\n[red]Generation interrupted.[/]")
                continue

            assistant_reply = "".join(collected).strip()
            if not assistant_reply:
                console.print("[yellow]No response generated.[/]")
                continue

            history.append({"role": "assistant", "content": assistant_reply})

    return 0


if __name__ == "__main__":
    sys.exit(main())
