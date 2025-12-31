import base64
import io
import os
import subprocess
import tempfile
import threading
from typing import Optional

import numpy as np
import runpod
import soundfile as sf
import torch
import whisper
from transformers import AutoModelForCausalLM, AutoTokenizer
from xcodec2.modeling_xcodec2 import XCodec2Model

MODEL_ID = os.getenv("LLASA_MODEL_ID", "NandemoGHS/Anime-Llasa-3B")
CODEC_ID = os.getenv("XCODEC2_MODEL_ID", "HKUSTAudio/xcodec2")
WHISPER_MODEL_ID = os.getenv("WHISPER_MODEL_ID", "openai/whisper-small")
ENABLE_WHISPER = os.getenv("ENABLE_WHISPER", "true").lower() == "true"
MAX_AUDIO_SECONDS = float(os.getenv("MAX_AUDIO_SECONDS", "15"))
SAMPLE_RATE = 16000

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32

MODEL_LOCK = threading.Lock()

tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
model = AutoModelForCausalLM.from_pretrained(MODEL_ID, torch_dtype=DTYPE, low_cpu_mem_usage=True)
model.to(DEVICE)
model.eval()

codec_model = XCodec2Model.from_pretrained(CODEC_ID)
codec_model.to(DEVICE)
codec_model.eval()

whisper_model = whisper.load_model(WHISPER_MODEL_ID, device=DEVICE) if ENABLE_WHISPER else None


def guess_suffix(filename: Optional[str], mime: Optional[str]) -> str:
  if filename and "." in filename:
    return os.path.splitext(filename)[1]
  if mime:
    mime = mime.lower()
    if mime == "audio/mpeg":
      return ".mp3"
    if "/" in mime:
      return "." + mime.split("/", 1)[-1]
  return ".wav"


def decode_audio_from_b64(audio_b64: str, filename: Optional[str], mime: Optional[str]) -> np.ndarray:
  raw = base64.b64decode(audio_b64)
  suffix = guess_suffix(filename, mime)
  with tempfile.TemporaryDirectory() as tmpdir:
    input_path = os.path.join(tmpdir, f"input{suffix}")
    output_path = os.path.join(tmpdir, "output.wav")
    with open(input_path, "wb") as f:
      f.write(raw)
    cmd = [
      "ffmpeg",
      "-y",
      "-i",
      input_path,
      "-ac",
      "1",
      "-ar",
      str(SAMPLE_RATE),
      output_path,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    audio, _ = sf.read(output_path, dtype="float32")
  if audio.ndim > 1:
    audio = audio.mean(axis=1)
  max_samples = int(MAX_AUDIO_SECONDS * SAMPLE_RATE)
  if audio.shape[0] > max_samples:
    audio = audio[:max_samples]
  return audio


def ids_to_speech_tokens(speech_ids):
  return [f"<|s_{int(speech_id)}|>" for speech_id in speech_ids]


def extract_speech_ids(tokens):
  speech_ids = []
  for token in tokens:
    if token.startswith("<|s_") and token.endswith("|>"):
      speech_ids.append(int(token[4:-2]))
  return speech_ids


def transcribe_audio(audio: np.ndarray, language: Optional[str]) -> str:
  if whisper_model is None:
    raise RuntimeError("Whisper is disabled but auto_transcribe was requested.")
  options = {"task": "transcribe"}
  if language and language != "auto":
    options["language"] = language
  result = whisper_model.transcribe(audio, **options)
  return (result.get("text") or "").strip()


def generate_audio(
  text: str,
  speech_prefix_tokens: list[str],
  *,
  temperature: float,
  top_p: float,
  repetition_penalty: float,
  max_length: int,
  include_prompt_audio: bool,
):
  formatted_text = f"<|TEXT_UNDERSTANDING_START|>{text}<|TEXT_UNDERSTANDING_END|>"
  assistant_content = "<|SPEECH_GENERATION_START|>" + "".join(speech_prefix_tokens)
  chat = [
    {"role": "user", "content": "Convert the text to speech:" + formatted_text},
    {"role": "assistant", "content": assistant_content},
  ]
  input_ids = tokenizer.apply_chat_template(
    chat,
    tokenize=True,
    return_tensors="pt",
    continue_final_message=True,
  ).to(DEVICE)
  speech_end_id = tokenizer.convert_tokens_to_ids("<|SPEECH_GENERATION_END|>")
  outputs = model.generate(
    input_ids,
    max_length=max_length,
    eos_token_id=speech_end_id,
    pad_token_id=speech_end_id,
    do_sample=True,
    top_p=top_p,
    temperature=temperature,
    repetition_penalty=repetition_penalty,
  )
  start_idx = input_ids.shape[1] - (len(speech_prefix_tokens) if include_prompt_audio else 0)
  generated_ids = outputs[0][start_idx:-1]
  speech_tokens = tokenizer.convert_ids_to_tokens(generated_ids)
  speech_ids = extract_speech_ids(speech_tokens)
  if not speech_ids:
    raise RuntimeError("No speech tokens were generated.")
  speech_ids_tensor = torch.tensor(speech_ids, device=DEVICE).unsqueeze(0).unsqueeze(0)
  return codec_model.decode_code(speech_ids_tensor)


def encode_wav_to_b64(wav_tensor: torch.Tensor) -> str:
  audio = wav_tensor.detach().cpu().numpy()
  audio = np.squeeze(audio)
  audio = np.clip(audio, -1.0, 1.0)
  with io.BytesIO() as buf:
    sf.write(buf, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def handler(job):
  payload = job.get("input") or {}
  text = (payload.get("text") or payload.get("target_text") or "").strip()
  if not text:
    raise ValueError("text is required.")
  prompt_audio_b64 = payload.get("prompt_audio_b64") or payload.get("reference_audio_b64")
  if not prompt_audio_b64:
    raise ValueError("prompt_audio_b64 is required.")

  prompt_text = (payload.get("prompt_text") or "").strip()
  auto_transcribe = payload.get("auto_transcribe", True)
  language = payload.get("language") or "ja"

  temperature = float(payload.get("temperature", 0.8))
  top_p = float(payload.get("top_p", 1.0))
  repetition_penalty = float(payload.get("repetition_penalty", 1.1))
  max_length = int(payload.get("max_length", 2048))
  strip_prompt_audio = bool(payload.get("strip_prompt_audio", True))

  seed = payload.get("seed")
  if seed is not None:
    seed = int(seed)
    torch.manual_seed(seed)
    np.random.seed(seed)
    if torch.cuda.is_available():
      torch.cuda.manual_seed_all(seed)

  audio = decode_audio_from_b64(
    prompt_audio_b64,
    payload.get("audio_filename"),
    payload.get("audio_mime"),
  )

  if auto_transcribe and not prompt_text:
    prompt_text = transcribe_audio(audio, language)

  input_text = f"{prompt_text}{text}" if prompt_text else text
  prompt_wav = torch.from_numpy(audio).float().unsqueeze(0).to(DEVICE)

  with MODEL_LOCK, torch.inference_mode():
    vq_code = codec_model.encode_code(input_waveform=prompt_wav)
    speech_ids_prefix = ids_to_speech_tokens(vq_code[0, 0, :])
    gen_wav = generate_audio(
      input_text,
      speech_ids_prefix,
      temperature=temperature,
      top_p=top_p,
      repetition_penalty=repetition_penalty,
      max_length=max_length,
      include_prompt_audio=not strip_prompt_audio,
    )
    audio_b64 = encode_wav_to_b64(gen_wav)

  return {
    "audio_b64": audio_b64,
    "sr": SAMPLE_RATE,
    "prompt_text": prompt_text,
  }


runpod.serverless.start({"handler": handler})
