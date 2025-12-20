# syntax=docker/dockerfile:1

FROM suarez123/llama-worker:20251216-gpu-q6-ctx12288 AS model_source

FROM nvidia/cuda:12.2.2-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip python3-dev \
    git build-essential cmake ninja-build \
    curl ca-certificates wget && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt

ENV FORCE_CMAKE=1 \
    GGML_CUDA=1 \
    CMAKE_ARGS="-DGGML_CUDA=on -DGGML_CUDA_F16=1 -DGGML_CUDA_FORCE_DMMV=1 -DLLAMA_CUDA_DMMV_X=64 -DCMAKE_CUDA_ARCHITECTURES=70;75;80;86;89;90" \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    LD_LIBRARY_PATH=/usr/local/nvidia/lib:/usr/local/nvidia/lib64:/usr/local/cuda/lib64:/usr/local/lib:/usr/lib:/usr/lib/x86_64-linux-gnu \
    LIBRARY_PATH=/usr/local/cuda/lib64:/usr/local/lib:/usr/lib

RUN git clone --depth=1 --recurse-submodules https://github.com/abetlen/llama-cpp-python.git /opt/llama-cpp-python

RUN python3 -m pip install --upgrade pip && \
    python3 -m pip install --no-cache-dir --no-binary llama-cpp-python "/opt/llama-cpp-python[cuda]" && \
    python3 -m pip install --no-cache-dir "huggingface_hub[cli]>=0.23.0" prompt_toolkit>=3.0 rich>=13.7 runpod==1.5.0 && \
    python3 -m pip cache purge

COPY app /opt/app
COPY scripts /opt/scripts
RUN chmod +x /opt/scripts/*.sh

RUN mkdir -p /opt/models
COPY --from=model_source /opt/models/Berghof-NSFW-7B.i1-Q6_K.gguf /opt/models/Berghof-NSFW-7B.i1-Q6_K.gguf

ENV MODEL_PATH=/opt/models/Berghof-NSFW-7B.i1-Q6_K.gguf \
    SYSTEM_PROMPT="You are a helpful assistant." \
    CTX_SIZE=12288 \
    GPU_LAYERS=999 \
    LLAMA_MODE=serverless \
    LLAMA_MAX_TOKENS=3500 \
    PYTHONPATH=/opt/app

WORKDIR /opt/app
ENTRYPOINT ["/opt/scripts/entrypoint.sh"]
