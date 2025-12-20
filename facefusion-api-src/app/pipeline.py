"""Shared Wav2Lip + FaceFusion pipeline utilities for RunPod deployments."""

from __future__ import annotations

import hashlib
import mimetypes
import os
import shlex
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import List, Optional

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError
from pydantic import BaseModel, Field
import logging


# ---------------------------------------------------------------------------
# Environment configuration
# ---------------------------------------------------------------------------

FACEFUSION_ROOT = Path(os.getenv("FACEFUSION_ROOT", "/opt/facefusion"))
WAV2LIP_ROOT = Path(os.getenv("WAV2LIP_ROOT", "/opt/wav2lip"))
TMP_ROOT = Path(os.getenv("FACEFUSION_TMP_ROOT", "/dev/shm/facefusion"))

R2_ENDPOINT = os.getenv("R2_ENDPOINT")
R2_BUCKET = os.getenv("R2_BUCKET")
R2_ACCESS_KEY = os.getenv("R2_ACCESS_KEY_ID")
R2_SECRET_KEY = os.getenv("R2_SECRET_ACCESS_KEY")
R2_REGION = os.getenv("R2_REGION", "auto")
R2_PUBLIC_URL = os.getenv("R2_PUBLIC_BASE_URL")
R2_PRESIGN_EXPIRY = int(os.getenv("R2_PRESIGN_EXPIRY", "900"))

LOGGER = logging.getLogger("facefusion.pipeline")

# ---------------------------------------------------------------------------
# Shared data models
# ---------------------------------------------------------------------------


class Wav2LipOptions(BaseModel):
    checkpoint_path: str = Field(
        "checkpoints/wav2lip_gan.onnx",
        description="Path to the ONNX checkpoint inside the Wav2Lip container.",
    )
    enhancer: str = Field(
        "auto",
        description="Enhancer to apply inside Wav2Lip. 'auto' enables GFPGAN when no source image is provided.",
    )
    blending: int = Field(
        30,
        ge=0,
        le=100,
        description="Enhancer blend strength (0-100). Converted to the 0.1-1.0 scale expected by Wav2Lip.",
    )
    denoise: bool = Field(False, description="Apply resemble audio denoiser before inference.")
    face_mode: int = Field(0, ge=0, le=1, description="Face crop mode to pass via --face_mode.")
    pingpong: bool = Field(False, description="Enable pingpong loop when audio is longer than video.")
    fade: bool = Field(False, description="Add short fade in/out on the generated clip.")
    frame_enhancer: bool = Field(False, description="Enable Real-ESRGAN frame enhancer.")
    face_mask: bool = Field(True, description="Enable BlendMask mask application.")
    face_occluder: bool = Field(False, description="Enable XSeg occlusion mask.")
    skip_crop_gui: bool = Field(True, description="Skip interactive crop GUI (use full frame).")
    skip_face_selection: bool = Field(True, description="Automatically pick the first detected face.")
    output_prefix: str = Field(
        "outputs/wav2lip",
        description="R2 prefix for intermediate Wav2Lip results (used when no explicit key is provided).",
    )
    extra_args: List[str] = Field(default_factory=list, description="Additional CLI arguments for Wav2Lip.")


class FaceFusionOptions(BaseModel):
    processors: List[str] = Field(
        default_factory=lambda: ["face_swapper", "face_enhancer"],
        description="Processors to invoke during FaceFusion headless run.",
    )
    face_swapper_model: str = "inswapper_128_fp16"
    face_enhancer_model: str = "gfpgan_1.4"
    face_enhancer_blend: int = 30
    execution_providers: List[str] = Field(default_factory=lambda: ["cuda"])
    execution_thread_count: int = 4
    execution_queue_count: int = 1


class SoVitsOptions(BaseModel):
    reference_text: Optional[str] = Field(None, description="Inline transcript for the reference audio.")
    output_prefix: str = Field(
        "outputs/sovits", description="R2 prefix used when SoVITS output key is not provided."
    )
    output_key: Optional[str] = Field(None, description="Explicit R2 key for SoVITS generated audio.")
    gpt_model: str = Field(
        "/opt/sovits/assets/gpt_sovits_models_hscene-e17.ckpt",
        description="Path to the GPT checkpoint within the SoVITS container.",
    )
    sovits_model: str = Field(
        "/opt/sovits/GPT-SoVITS/GPT_SoVITS/pretrained_models/gsv-v4-pretrained/s2Gv4.pth",
        description="Path to the SoVITS checkpoint within the container.",
    )
    ref_language: str = Field("ja", description="Language alias for the reference audio.")
    target_language: str = Field("ja", description="Language alias for the target text.")
    cut: str = Field("punctuation", description="Sentence split preset.")
    top_p: float = Field(1.0, ge=0.0, le=1.0)
    temperature: float = Field(1.0, ge=0.0)
    # Allow slower synthesis from UI slider; backend clamps to >=1.0
    speed: float = Field(1.5, ge=1.0, le=2.0)
    sample_steps: int = Field(8, ge=1, le=40)
    pause_second: float = Field(0.3, ge=0.0, le=2.0)
    with_prosody: bool = Field(False, description="When true, enables prosody marks in SoVITS.")
    ref_text_free: bool = Field(False, description="When true, ignore reference_text and synthesize without it.")


class PipelineRequest(BaseModel):
    source_keys: List[str] = Field(
        default_factory=list,
        description="R2 object keys for source images. When empty, only Wav2Lip will be executed.",
    )
    target_key: Optional[str] = Field(
        None,
        description="R2 object key for the target video (pre lip-sync). Optional when audio-only.",
    )
    audio_key: Optional[str] = Field(None, description="R2 object key for the driving audio track.")
    audio_base64: Optional[str] = Field(None, description="Base64 encoded audio data.")
    reference_audio_key: Optional[str] = Field(
        None,
        description="Optional R2 key for the reference voice sample. Defaults to the provided audio_key.",
    )
    script_text: Optional[str] = Field(
        None, description="When provided, SoVITS will synthesise this text before running Wav2Lip."
    )
    output_key: Optional[str] = Field(None, description="Desired R2 key for the final generated video.")
    wav2lip_output_key: Optional[str] = Field(
        None, description="Optional override for the intermediate Wav2Lip result object key."
    )
    sovits: SoVitsOptions = Field(default_factory=SoVitsOptions)
    retain_intermediate: bool = Field(
        True, description="Include intermediate Wav2Lip metadata in the final task response."
    )
    wav2lip: Wav2LipOptions = Field(default_factory=Wav2LipOptions)
    facefusion: FaceFusionOptions = Field(default_factory=FaceFusionOptions)


# ---------------------------------------------------------------------------
# R2 helpers
# ---------------------------------------------------------------------------


def get_s3_client():
    """Return an S3-compatible client configured for Cloudflare R2."""
    if not all([R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY, R2_SECRET_KEY]):
        raise RuntimeError(
            "R2 configuration is incomplete. Set R2_ENDPOINT, R2_BUCKET, "
            "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY."
        )

    session = boto3.session.Session()
    use_ssl = R2_ENDPOINT.startswith("https://")
    config = Config(signature_version="s3v4", retries={"max_attempts": 3})

    return session.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
        region_name=R2_REGION,
        use_ssl=use_ssl,
        config=config,
    )


def build_public_url(key: str) -> Optional[str]:
    """Build a public URL using either the configured CDN base or the raw R2 endpoint."""
    if not key:
        return None
    if R2_PUBLIC_URL:
        base = R2_PUBLIC_URL.rstrip("/")
        return f"{base}/{key.lstrip('/')}"
    if R2_ENDPOINT:
        base = R2_ENDPOINT.rstrip("/")
        return f"{base}/{R2_BUCKET}/{key.lstrip('/')}"
    return None


def generate_presigned_download(client, key: str, expires_in: Optional[int] = None) -> Optional[str]:
    """Generate a presigned download URL for the given R2 object key."""
    if not key:
        return None
    expiry = expires_in or R2_PRESIGN_EXPIRY
    try:
        return client.generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": R2_BUCKET, "Key": key},
            ExpiresIn=expiry,
        )
    except ClientError:
        return None


def _download_object(client, key: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        client.download_file(R2_BUCKET, key, str(destination))
    except ClientError as exc:  # noqa: BLE001
        raise RuntimeError(f"Failed to download {key} from R2: {exc}") from exc


def _upload_object(client, source: Path, key: str) -> int:
    size = source.stat().st_size if source.exists() else 0
    mime_type, _ = mimetypes.guess_type(str(source))
    extra_args = {"ContentType": mime_type} if mime_type else None
    try:
        if extra_args:
            client.upload_file(str(source), R2_BUCKET, key, ExtraArgs=extra_args)
        else:
            client.upload_file(str(source), R2_BUCKET, key)
    except ClientError as exc:  # noqa: BLE001
        raise RuntimeError(f"Failed to upload {key} to R2: {exc}") from exc
    return size


def _file_md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# Workspace helpers
# ---------------------------------------------------------------------------


def _ensure_tmp_root() -> None:
    try:
        TMP_ROOT.mkdir(parents=True, exist_ok=True)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"Failed to prepare temporary root {TMP_ROOT!s}: {exc}") from exc


def allocate_workdir() -> Path:
    """Create a temporary working directory, preferring TMP_ROOT when available."""
    if TMP_ROOT:
        try:
            _ensure_tmp_root()
            return Path(tempfile.mkdtemp(prefix="facefusion_", dir=str(TMP_ROOT)))
        except Exception:  # noqa: BLE001
            pass
    return Path(tempfile.mkdtemp(prefix="facefusion_"))


def _probe_duration_seconds(path: Path) -> Optional[float]:
    """Return media duration in seconds using ffprobe; None if unavailable."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        return float(result.stdout.strip())
    except Exception:
        return None


def _align_video_to_audio_length(video_path: Path, audio_path: Path, workdir: Path, fps: int = 30) -> Path:
    """
    Force the video length to match the audio length (loop or trim) and normalize fps.
    Returns a new video path; if alignment fails, returns the original path.
    """
    audio_dur = _probe_duration_seconds(audio_path)
    video_dur = _probe_duration_seconds(video_path)
    if not audio_dur or not video_dur:
        return video_path
    normalized = workdir / "target_normalized.mp4"
    try:
        cmd = [
            "ffmpeg",
            "-y",
            "-stream_loop",
            "-1",
            "-i",
            str(video_path),
            "-t",
            f"{audio_dur:.3f}",
            "-filter_complex",
            f"[0:v]fps={fps},format=yuv420p,setpts=PTS-STARTPTS[v]",
            "-map",
            "[v]",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            str(normalized),
        ]
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        return normalized if normalized.exists() else video_path
    except Exception:
        return video_path


def _prepare_wav2lip_workspace() -> None:
    """Ensure Wav2Lip relative output folders exist before execution."""
    for folder in ("temp", "hq_temp"):
        target = WAV2LIP_ROOT / folder
        try:
            target.mkdir(parents=True, exist_ok=True)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Failed to prepare Wav2Lip workspace directory {target}: {exc}") from exc


# ---------------------------------------------------------------------------
# Command builders
# ---------------------------------------------------------------------------


def _compute_wav2lip_blend(value: int) -> str:
    """Convert 0-100 percentage to the 1-10 scale expected by Wav2Lip CLI."""
    normalized = max(0, min(100, value))
    scaled = max(1, min(10, round(normalized / 10)))
    return str(scaled)


def _build_wav2lip_command(
    pipeline: PipelineRequest,
    wav_opts: Wav2LipOptions,
    local_target: str,
    local_audio: str,
    local_output: str,
    enhancer: Optional[str],
) -> List[str]:
    cmd: List[str] = [
        "python3",
        "inference_onnxModel.py",
        "--checkpoint_path",
        wav_opts.checkpoint_path,
        "--face",
        local_target,
        "--audio",
        local_audio,
        "--outfile",
        local_output,
        "--face_mode",
        str(wav_opts.face_mode),
    ]

    if wav_opts.skip_crop_gui:
        cmd.append("--skip_crop_gui")
    if wav_opts.skip_face_selection:
        cmd.append("--skip_face_selection")
    if wav_opts.pingpong:
        cmd.append("--pingpong")
    if wav_opts.fade:
        cmd.append("--fade")
    if wav_opts.denoise:
        cmd.append("--denoise")
    if wav_opts.frame_enhancer:
        cmd.append("--frame_enhancer")
    if wav_opts.face_mask:
        cmd.append("--face_mask")
    if wav_opts.face_occluder:
        cmd.append("--face_occluder")

    if enhancer and enhancer not in {"", "none"}:
        cmd.extend(["--enhancer", enhancer])
        cmd.extend(["--blending", _compute_wav2lip_blend(wav_opts.blending)])

    if wav_opts.extra_args:
        cmd.extend(wav_opts.extra_args)

    return cmd


def _build_facefusion_command(
    ff_options: FaceFusionOptions, local_sources: List[str], local_target: str, local_output: str
) -> List[str]:
    cmd: List[str] = ["python", "facefusion.py", "headless-run"]
    for source in local_sources:
        cmd.extend(["-s", source])
    cmd.extend(["-t", local_target, "-o", local_output])

    cmd.extend(["--processors", *ff_options.processors])
    cmd.extend(["--face-swapper-model", ff_options.face_swapper_model])
    cmd.extend(["--face-enhancer-model", ff_options.face_enhancer_model])
    cmd.extend(["--face-enhancer-blend", str(ff_options.face_enhancer_blend)])
    cmd.extend(["--face-detector-model", ff_options.face_detector_model])
    cmd.extend(["--face-mask-types", *ff_options.face_mask_types])
    cmd.extend(["--execution-providers", *ff_options.execution_providers])
    cmd.extend(["--execution-thread-count", str(ff_options.execution_thread_count)])
    cmd.extend(["--output-video-encoder", ff_options.output_video_encoder])
    cmd.extend(["--output-video-preset", ff_options.output_video_preset])

    if ff_options.extra_args:
        cmd.extend(ff_options.extra_args)

    return cmd


# ---------------------------------------------------------------------------
# Audio merging
# ---------------------------------------------------------------------------


def _merge_audio_tracks(video_path: Path, audio_sources: List[Path]) -> dict[str, object]:
    """
    Replace the audio track of `video_path` using one of the provided `audio_sources`.

    The first candidate that successfully remuxes the file is used. Remaining candidates are ignored.
    """
    valid_sources: List[Path] = []
    seen: set[str] = set()
    for source in audio_sources:
        if not source:
            continue
        resolved = Path(source)
        if not resolved.exists():
            continue
        key = str(resolved.resolve())
        if key in seen:
            continue
        seen.add(key)
        valid_sources.append(resolved)

    if not valid_sources:
        # If no audio sources, we can't merge audio.
        # But maybe the video already has audio?
        # For now, we raise error if this function was called implying audio merge was desired.
        raise RuntimeError(
            {
                "error": "audio_merge_failed",
                "detail": "No valid audio sources were provided.",
            }
        )

    attempts: List[dict[str, object]] = []
    for index, audio_source in enumerate(valid_sources):
        temp_output = video_path.with_name(f"{video_path.stem}_audio{index}{video_path.suffix}")
        command = [
            "ffmpeg",
            "-y",
            "-i",
            str(video_path),
            "-i",
            str(audio_source),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0?",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            "-shortest",
            str(temp_output),
        ]
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and temp_output.exists():
            video_path.unlink(missing_ok=True)
            temp_output.rename(video_path)
            return {
                "command": " ".join(shlex.quote(part) for part in command),
                "stdout": result.stdout,
                "stderr": result.stderr,
                "audio_source": str(audio_source),
            }

        attempts.append(
            {
                "source": str(audio_source),
                "command": " ".join(shlex.quote(part) for part in command),
                "stdout": result.stdout,
                "stderr": result.stderr,
                "returncode": result.returncode,
            }
        )
        temp_output.unlink(missing_ok=True)

    raise RuntimeError(
        {
            "error": "audio_merge_failed",
            "detail": "Failed to merge audio from all candidates.",
            "attempts": attempts,
        }
    )


# ---------------------------------------------------------------------------
# Pipeline execution helpers
# ---------------------------------------------------------------------------


def run_wav2lip(request: PipelineRequest, *, s3=None) -> dict[str, object]:
    """Execute the Wav2Lip stage and upload the result to R2."""
    s3 = s3 or get_s3_client()

    if not request.audio_key and not request.audio_base64:
        raise RuntimeError("Wav2Lip stage requires an audio_key or audio_base64.")

    temp_dir = allocate_workdir()
    try:
        target_suffix = Path(request.target_key).suffix or ".mp4"
        
        # Determine audio suffix (default to .wav if base64 or unknown)
        audio_suffix = ".wav"
        if request.audio_key:
            audio_suffix = Path(request.audio_key).suffix or ".wav"

        local_target = temp_dir / f"target{target_suffix}"
        local_audio = temp_dir / f"audio{audio_suffix}"
        local_output = temp_dir / "wav2lip.mp4"

        _download_object(s3, request.target_key, local_target)
        
        if request.audio_base64:
            import base64
            try:
                decoded = base64.b64decode(request.audio_base64)
                with local_audio.open("wb") as f:
                    f.write(decoded)
            except Exception as exc:
                raise RuntimeError(f"Failed to decode audio_base64: {exc}") from exc
        elif request.audio_key:
            _download_object(s3, request.audio_key, local_audio)

        wav_opts = request.wav2lip
        enhancer = wav_opts.enhancer
        if enhancer == "auto":
            enhancer = "none" if request.source_keys else "gfpgan"

        _prepare_wav2lip_workspace()

        # Normalize/loop video to match audio length to avoid speed mismatch (e.g., mobile uploads)
        normalized_target = _align_video_to_audio_length(local_target, local_audio, temp_dir, fps=30)

        command = _build_wav2lip_command(
            request,
            wav_opts,
            str(normalized_target),
            str(local_audio),
            str(local_output),
            enhancer,
        )

        start = time.perf_counter()
        try:
            result = subprocess.run(
                command,
                cwd=str(WAV2LIP_ROOT),
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:  # noqa: BLE001
            raise RuntimeError(
                {
                    "error": "wav2lip_failed",
                    "command": " ".join(shlex.quote(part) for part in command),
                    "stdout": exc.stdout,
                    "stderr": exc.stderr,
                }
            ) from exc

        duration = time.perf_counter() - start

        if not local_output.exists():
            raise RuntimeError("Wav2Lip did not produce an output file.")

        prefix = (wav_opts.output_prefix or "outputs/wav2lip").strip("/")
        if request.wav2lip_output_key:
            output_key = request.wav2lip_output_key
        elif prefix:
            output_key = f"{prefix}/{uuid.uuid4().hex}.mp4"
        else:
            output_key = f"{uuid.uuid4().hex}.mp4"

        uploaded_bytes = _upload_object(s3, local_output, output_key)
        public_url = build_public_url(output_key)
        presigned_url = generate_presigned_download(s3, output_key)

        wav2lip_result = {
            "status": "completed",
            "output_key": output_key,
            "output_url": presigned_url or public_url,
            "presigned_url": presigned_url,
            "public_url": public_url,
            "duration_sec": round(duration, 2),
            "bytes_uploaded": uploaded_bytes,
            "command": " ".join(shlex.quote(part) for part in command),
            "stdout": result.stdout,
            "stderr": result.stderr,
            "enhancer": enhancer,
        }

        response = {
            "request": request.model_dump(),
            "wav2lip": wav2lip_result,
        }
        if not request.source_keys:
            response.update(wav2lip_result)
        return response
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def run_facefusion(
    request: PipelineRequest,
    wav2lip_result: Optional[dict[str, object]] = None,
    *,
    s3=None,
) -> dict[str, object]:
    """Execute the FaceFusion stage (optionally consuming the Wav2Lip output)."""
    s3 = s3 or get_s3_client()

    if not request.source_keys:
        if wav2lip_result:
            return wav2lip_result
        raise RuntimeError("FaceFusion stage requires source images or a prior Wav2Lip result.")

    temp_dir = allocate_workdir()
    try:
        local_sources: List[str] = []
        for index, key in enumerate(request.source_keys):
            suffix = Path(key).suffix or ".png"
            dest = temp_dir / f"source_{index}{suffix}"
            _download_object(s3, key, dest)
            local_sources.append(str(dest))

        target_r2_key = wav2lip_result["output_key"] if wav2lip_result else request.target_key
        local_target = temp_dir / f"target{Path(target_r2_key).suffix or '.mp4'}"
        _download_object(s3, target_r2_key, local_target)
        
        local_audio: Optional[Path] = None
        if request.audio_base64:
            import base64
            local_audio = temp_dir / "audio.wav"
            try:
                decoded = base64.b64decode(request.audio_base64)
                with local_audio.open("wb") as f:
                    f.write(decoded)
            except Exception:
                # Fallback or ignore if decode fails (should be handled upstream)
                local_audio = None
        elif request.audio_key:
            audio_suffix = Path(request.audio_key).suffix or ".wav"
            local_audio = temp_dir / f"audio{audio_suffix}"
            _download_object(s3, request.audio_key, local_audio)
        
        target_hash = _file_md5(local_target)

        output_key = request.output_key or f"outputs/result_{uuid.uuid4().hex}.mp4"
        local_output = temp_dir / "result.mp4"

        command = _build_facefusion_command(request.facefusion, local_sources, str(local_target), str(local_output))
        start = time.perf_counter()

        fallback_info = None
        selected_encoder = request.facefusion.output_video_encoder
        try:
            result = subprocess.run(
                command,
                cwd=str(FACEFUSION_ROOT),
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:  # noqa: BLE001
            stderr_text = exc.stderr or ""
            stdout_text = exc.stdout or ""
            encoder_lower = (selected_encoder or "").lower()
            should_retry = encoder_lower == "h264_nvenc" and (
                "Unknown encoder" in stderr_text
                or "Merging video failed" in stderr_text
                or "NVENC" in stderr_text
            )
            if should_retry:
                LOGGER.warning(
                    "FaceFusion NVENC encoder failed; retrying with CPU encoder. stderr_snippet=%s",
                    stderr_text.strip()[:400],
                )
                if hasattr(request.facefusion, "model_copy"):
                    fallback_options = request.facefusion.model_copy(deep=True)
                else:
                    fallback_options = request.facefusion.copy(deep=True)
                fallback_options.output_video_encoder = "libx264"
                fallback_options.output_video_preset = "medium"
                fallback_command = _build_facefusion_command(
                    fallback_options, local_sources, str(local_target), str(local_output)
                )
                try:
                    local_output.unlink()
                except FileNotFoundError:
                    pass
                try:
                    result = subprocess.run(
                        fallback_command,
                        cwd=str(FACEFUSION_ROOT),
                        check=True,
                        capture_output=True,
                        text=True,
                    )
                except subprocess.CalledProcessError as retry_exc:  # noqa: BLE001
                    raise RuntimeError(
                        {
                            "error": "inference_failed",
                            "command": " ".join(shlex.quote(part) for part in fallback_command),
                            "stdout": retry_exc.stdout,
                            "stderr": retry_exc.stderr,
                            "fallback_from": selected_encoder,
                        }
                    ) from retry_exc
                command = fallback_command
                selected_encoder = fallback_options.output_video_encoder
                snippet = stderr_text.strip()[:400] if stderr_text else None
                fallback_info = {
                    "previous_encoder": "h264_nvenc",
                    "current_encoder": selected_encoder,
                }
                if snippet:
                    fallback_info["stderr_snippet"] = snippet
            else:
                raise RuntimeError(
                    {
                        "error": "inference_failed",
                        "command": " ".join(shlex.quote(part) for part in command),
                        "stdout": stdout_text,
                        "stderr": stderr_text,
                    }
                ) from exc

        duration = time.perf_counter() - start

        if not local_output.exists():
            raise RuntimeError("FaceFusion did not produce an output file.")

        audio_sources: List[Path] = []
        if wav2lip_result:
            audio_sources.append(local_target)
        if local_audio:
            audio_sources.append(local_audio)
            
        audio_merge_info = None
        if audio_sources:
            try:
                audio_merge_info = _merge_audio_tracks(local_output, audio_sources)
            except RuntimeError as exc:  # noqa: BLE001
                raise RuntimeError(exc.args[0]) from exc

        output_hash = _file_md5(local_output)
        if output_hash == target_hash:
            raise RuntimeError(
                {
                    "error": "no_face_detected",
                    "detail": "Generated video matches the (lip-synced) target; likely no faces were detected in the target frames.",
                }
            )

        uploaded_bytes = _upload_object(s3, local_output, output_key)
        public_url = build_public_url(output_key)
        presigned_url = generate_presigned_download(s3, output_key)
        download_url = presigned_url or public_url

        response: dict[str, object] = {
            "status": "completed",
            "command": " ".join(shlex.quote(part) for part in command),
            "output_key": output_key,
            "output_url": download_url,
            "presigned_url": presigned_url,
            "public_url": public_url,
            "duration_sec": round(duration, 2),
            "stdout": result.stdout,
            "stderr": result.stderr,
            "bytes_uploaded": uploaded_bytes,
            "encoder": selected_encoder,
        }

        if fallback_info:
            response["encoder_fallback"] = fallback_info

        if audio_merge_info:
            response["audio_merge"] = audio_merge_info

        if wav2lip_result and request.retain_intermediate:
            response["intermediate"] = {"wav2lip": wav2lip_result}

        return response
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


__all__ = [
    "FACEFUSION_ROOT",
    "WAV2LIP_ROOT",
    "TMP_ROOT",
    "R2_BUCKET",
    "R2_ENDPOINT",
    "R2_PRESIGN_EXPIRY",
    "build_public_url",
    "generate_presigned_download",
    "get_s3_client",
    "allocate_workdir",
    "run_wav2lip",
    "run_facefusion",
    "PipelineRequest",
    "Wav2LipOptions",
    "FaceFusionOptions",
    "SoVitsOptions",
]
