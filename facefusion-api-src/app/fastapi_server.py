"""FastAPI orchestrator for the RunPod serverless FaceFusion pipeline."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import random
import mimetypes
import os
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Dict, List, Optional, Set
from urllib.parse import quote

import httpx
import redis.asyncio as redis
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field, constr

from pipeline import (
    PipelineRequest,
    R2_BUCKET,
    allocate_workdir,
    build_public_url,
    generate_presigned_download,
    get_s3_client,
    _upload_object,
)

LOGGER = logging.getLogger("facefusion.api")

# ---------------------------------------------------------------------------
# Service authentication (CF Access / shared API key)
# ---------------------------------------------------------------------------

CF_ACCESS_CLIENT_ID = os.getenv("CF_ACCESS_CLIENT_ID")
CF_ACCESS_CLIENT_SECRET = os.getenv("CF_ACCESS_CLIENT_SECRET")
API_SHARED_SECRET = os.getenv("FF_API_SECRET") or os.getenv("FF_API_KEY")

SERVICE_AUTH_ENABLED = bool(API_SHARED_SECRET or (CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET))

def _compare_secret(candidate: Optional[str], expected: Optional[str]) -> bool:
    return bool(candidate and expected and hmac.compare_digest(candidate.strip(), expected.strip()))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _request_to_dict(request: PipelineRequest) -> Dict[str, Any]:
    if hasattr(request, "model_dump"):
        return request.model_dump()
    return request.dict()


def _normalise_exception(value: Exception) -> Dict[str, Any]:
    if isinstance(value, RuntimeError) and value.args:
        first = value.args[0]
        if isinstance(first, dict):
            payload = dict(first)
            payload.setdefault("error", payload.get("error") or "runtime_error")
            return payload
        return {"error": "runtime_error", "detail": value.args}
    return {"error": value.__class__.__name__, "detail": str(value)}


def _sanitize_config_value(value: str) -> str:
    """Strip control characters that break downstream clients (e.g. HTTP URLs)."""
    cleaned = "".join(ch for ch in value if ch >= " " and ch != "\x7f")
    return cleaned.strip()


def _is_allowed_mime(content_type: Optional[str]) -> bool:
    if not content_type:
        return False
    lowered = content_type.lower()
    if lowered in ALLOWED_MIME_EXACT:
        return True
    return any(lowered.startswith(prefix) for prefix in ALLOWED_MIME_PREFIXES)


def _data_url_to_bytes(value: Optional[str]) -> Optional[bytes]:
    """Decode data URL (data:...;base64,XXXX) to raw bytes."""
    if not value or not value.startswith("data:"):
        return None
    try:
        _, payload = value.split(",", 1)
        return base64.b64decode(payload)
    except Exception:
        return None



def _probe_duration_seconds(path: Path) -> Optional[float]:
    """Return media duration in seconds using ffprobe; None when unavailable."""
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


async def _save_upload_file(upload: UploadFile, destination: Path) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    await upload.seek(0)
    with destination.open("wb") as handle:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            handle.write(chunk)
    await upload.seek(0)
    return size


def _detect_speech_segments(
    audio_path: Path,
    min_length: float,
    max_segments: int,
    offset: float,
    clip_end: float,
) -> List[tuple[float, float]]:
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-i",
        str(audio_path),
        "-af",
        f"silencedetect=noise={SILENCE_THRESHOLD_DB}dB:d={SILENCE_MIN_DURATION}",
        "-f",
        "null",
        "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except Exception:
        return []

    duration = _probe_duration_seconds(audio_path) or max(clip_end - offset, 0.0)
    segments: List[tuple[float, float]] = []
    last_end = 0.0

    for line in result.stderr.splitlines():
        if "silence_start" in line:
            try:
                silence_start = float(line.split("silence_start:")[1].split()[0])
            except Exception:
                continue
            start = offset + last_end
            end = min(offset + silence_start, clip_end)
            if end - start >= min_length:
                segments.append((start, end))
        elif "silence_end" in line:
            try:
                last_end = float(line.split("silence_end:")[1].split("|")[0].strip())
            except Exception:
                continue

    final_end = offset + duration
    if final_end - (offset + last_end) >= min_length:
        segments.append((offset + last_end, min(final_end, clip_end)))
    return segments[:max_segments]


def _fallback_segments(
    trim_start: float,
    trim_end: float,
    max_segments: int,
    min_length: float,
) -> List[tuple[float, float]]:
    segments: List[tuple[float, float]] = []
    total_span = max(trim_end - trim_start, min_length)
    chunk = max(total_span / max_segments, min_length)
    cursor = trim_start
    while cursor < trim_end and len(segments) < max_segments:
        end = min(cursor + chunk, trim_end)
        segments.append((cursor, end))
        cursor = end + 0.2
    return segments


def _upload_candidate_clip(s3, source: Path, key: str) -> None:
    mime_type, _ = mimetypes.guess_type(str(source))
    extra_args = {"ContentType": mime_type} if mime_type else None
    try:
        if extra_args:
            s3.upload_file(str(source), R2_BUCKET, key, ExtraArgs=extra_args)
        else:
            s3.upload_file(str(source), R2_BUCKET, key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to upload candidate audio: {exc}") from exc


class _TransferCounter:
    """Thread-safe counter used to track streamed byte size."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._total = 0

    def __call__(self, bytes_amount: int) -> None:
        with self._lock:
            self._total += bytes_amount

    @property
    def total(self) -> int:
        with self._lock:
            return self._total


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


# Storage constraints
ALLOWED_PREFIXES = ("uploads/", "facefusion/results/")
ALLOWED_MIME_PREFIXES = ("image/", "video/", "audio/")
ALLOWED_MIME_EXACT = {"application/json"}
MAX_UPLOAD_BYTES = 150 * 1024 * 1024  # ~150MB: 1蛻・虚逕ｻ繧・聞繧・浹螢ｰ繧偵き繝舌・
AUDIO_CANDIDATE_PREFIX = "outputs/audio-candidates"
MAX_AUDIO_CANDIDATES = 5
MIN_SEGMENT_SECONDS = 1.0
MAX_SEGMENT_SECONDS = 5.0
SILENCE_THRESHOLD_DB = -35
SILENCE_MIN_DURATION = 0.2



def _katakana_script(text: str) -> str:
    # Katakana conversion disabled; return as-is
    return text


class PresignRequest(BaseModel):
    intent: str = Field("upload", description="Create URL for uploads or downloads")
    key: Optional[str] = Field(None, description="Optional custom key; random when omitted")
    expires_in: int = Field(3600, ge=60, le=604800, description="Seconds the presigned URL remains valid")
    content_type: Optional[str] = Field(None, description="Content-Type to enforce on upload presigned URLs")


class PresignResponse(BaseModel):
    key: str
    url: str
    intent: str
    expires_in: int
    public_url: Optional[str] = None


class DirectUploadResponse(BaseModel):
    key: str
    size: int
    content_type: Optional[str] = None
    public_url: Optional[str] = None


class AudioCandidate(BaseModel):
    id: str
    label: str
    start: float
    end: float
    url: Optional[str] = None
    key: Optional[str] = None


class AudioCandidatesResponse(BaseModel):
    candidates: List[AudioCandidate]


# ---------------------------------------------------------------------------
# Service authentication helpers
# ---------------------------------------------------------------------------


async def _require_service_auth(
    x_api_key: Annotated[Optional[str], Header(alias="X-Api-Key")] = None,
    authorization: Annotated[Optional[str], Header(alias="Authorization")] = None,
    cf_access_client_id: Annotated[Optional[str], Header(alias="CF-Access-Client-Id")] = None,
    cf_access_client_secret: Annotated[Optional[str], Header(alias="CF-Access-Client-Secret")] = None,
) -> None:
    if not SERVICE_AUTH_ENABLED:
        raise HTTPException(status_code=503, detail="Service authentication is not configured")

    bearer_token = None
    if authorization:
        parts = authorization.strip().split()
        if len(parts) == 2 and parts[0].lower() == "bearer":
            bearer_token = parts[1]
        else:
            bearer_token = authorization.strip()

    if _compare_secret(x_api_key, API_SHARED_SECRET) or _compare_secret(bearer_token, API_SHARED_SECRET):
        return

    if _compare_secret(cf_access_client_id, CF_ACCESS_CLIENT_ID) and _compare_secret(
        cf_access_client_secret, CF_ACCESS_CLIENT_SECRET
    ):
        return

    raise HTTPException(status_code=401, detail="Missing or invalid service token")


# ---------------------------------------------------------------------------
# Billing / Supabase integration
# ---------------------------------------------------------------------------

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY")
STRIPE_PRICE_ID = os.getenv("STRIPE_PRICE_ID")
STRIPE_SUCCESS_URL = os.getenv("STRIPE_SUCCESS_URL", "https://app.lipdiffusion.uk?billing=success")
STRIPE_CANCEL_URL = os.getenv("STRIPE_CANCEL_URL", "https://app.lipdiffusion.uk?billing=cancelled")
STRIPE_PORTAL_RETURN_URL = os.getenv("STRIPE_PORTAL_RETURN_URL", STRIPE_SUCCESS_URL)
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET")
TICKET_API_TOKEN = os.getenv("FF_TICKET_SERVICE_TOKEN")
SUBSCRIPTION_TICKET_BUNDLE = int(os.getenv("TICKET_SUBSCRIPTION_BUNDLE", "10"))

SUPABASE_READY = bool(SUPABASE_URL and SUPABASE_SERVICE_KEY and SUPABASE_ANON_KEY)
STRIPE_READY = bool(STRIPE_SECRET_KEY)
TICKETS_ENABLED = SUPABASE_READY
BILLING_READY = SUPABASE_READY and STRIPE_READY and bool(STRIPE_PRICE_ID)
TICKET_SECRET_ENABLED = bool(TICKET_API_TOKEN)

NormalizedEmail = constr(strip_whitespace=True, min_length=3, max_length=320)


class SupabaseUser(BaseModel):
    id: str
    email: str


class TicketConsumeRequest(BaseModel):
    email: NormalizedEmail
    count: int = Field(1, ge=1, le=100)
    reason: str = Field("gradio_run", min_length=1, max_length=64)


class TicketConsumeResponse(BaseModel):
    email: str
    usage_id: str
    balance: int


class TicketRefundRequest(BaseModel):
    usage_id: str = Field(..., min_length=6, max_length=64)
    reason: Optional[str] = Field("job_failed", max_length=64)


class BillingStatusResponse(BaseModel):
    email: str
    tickets: int
    subscription_status: Optional[str] = None
    stripe_customer_id: Optional[str] = None
    stripe_subscription_id: Optional[str] = None
    current_period_end: Optional[str] = None
    has_active_subscription: bool


class CheckoutRequest(BaseModel):
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None
    price_id: Optional[str] = None


class CheckoutResponse(BaseModel):
    url: str


class PortalRequest(BaseModel):
    return_url: Optional[str] = None


def _normalize_email(value: str) -> str:
    return (value or '').strip().lower()


def _normalize_subscription_status(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    normalized = value.strip().lower()
    if normalized == "complete":
        return "active"
    return normalized


def _ts_to_iso(timestamp_value: Optional[int]) -> Optional[str]:
    if not timestamp_value:
        return None
    try:
        return datetime.fromtimestamp(timestamp_value, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:  # noqa: BLE001
        return None


def _usage_id_from_event(source: Optional[str]) -> str:
    if source:
        try:
            uuid.UUID(source)
            return source
        except ValueError:
            return str(uuid.uuid5(uuid.NAMESPACE_URL, source))
    return str(uuid.uuid4())


class SupabaseTicketStore:
    def __init__(self, base_url: str, service_key: str, anon_key: str) -> None:
        self.base_url = base_url.rstrip('/')
        self.service_key = service_key
        self.anon_key = anon_key
        self.rest_url = f"{self.base_url}/rest/v1"
        self.auth_url = f"{self.base_url}/auth/v1"
        self._client = httpx.AsyncClient(timeout=20.0)

    async def close(self) -> None:
        await self._client.aclose()

    def _service_headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if extra:
            headers.update(extra)
        return headers

    async def fetch_user_from_token(self, token: str) -> SupabaseUser:
        headers = {
            "apikey": self.anon_key,
            "Authorization": f"Bearer {token}",
        }
        response = await self._client.get(f"{self.auth_url}/user", headers=headers)
        if response.status_code >= 400:
            raise HTTPException(status_code=401, detail="Invalid Supabase session")
        payload = response.json()
        user_id = payload.get("id")
        email = _normalize_email(payload.get("email"))
        if not user_id or not email:
            raise HTTPException(status_code=401, detail="Supabase session missing id/email")
        return SupabaseUser(id=user_id, email=email)

    async def fetch_ticket_row(self, *, email: Optional[str] = None, customer_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        if not email and not customer_id:
            raise ValueError("email or customer_id must be provided")
        params = {"limit": "1"}
        if email:
            params["email"] = f"eq.{_normalize_email(email)}"
        if customer_id:
            params["stripe_customer_id"] = f"eq.{customer_id}"
        response = await self._client.get(f"{self.rest_url}/user_tickets", headers=self._service_headers(), params=params)
        response.raise_for_status()
        data = response.json()
        if isinstance(data, list) and data:
            return data[0]
        return None

    async def ensure_user_record(self, *, user_id: Optional[str], email: str) -> Dict[str, Any]:
        normalized = _normalize_email(email)
        payload: Dict[str, Any] = {"email": normalized}
        if user_id:
            payload["user_id"] = user_id
        headers = self._service_headers({"Prefer": "resolution=merge-duplicates,return=representation"})
        response = await self._client.post(f"{self.rest_url}/user_tickets", headers=headers, json=payload)
        if response.status_code in (200, 201):
            data = response.json()
            if isinstance(data, list) and data:
                return data[0]
        record = await self.fetch_ticket_row(email=normalized)
        if record:
            return record
        raise HTTPException(status_code=500, detail="Failed to ensure Supabase ticket row")

    async def patch_user(self, email: str, payload: Dict[str, Any]) -> None:
        normalized = _normalize_email(email)
        headers = self._service_headers({"Prefer": "return=representation"})
        params = {"email": f"eq.{normalized}"}
        response = await self._client.patch(f"{self.rest_url}/user_tickets", headers=headers, params=params, json=payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=500, detail=self._extract_error(response))

    async def set_customer_id(self, email: str, customer_id: str) -> None:
        await self.patch_user(email, {"stripe_customer_id": customer_id})

    async def update_subscription(self, email: str, *, subscription_id: Optional[str], status: Optional[str], current_period_end: Optional[int]) -> None:
        payload = {
            "stripe_subscription_id": subscription_id,
            "subscription_status": status,
            "current_period_end": _ts_to_iso(current_period_end) if current_period_end else None,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
        await self.patch_user(email, payload)

    def _extract_error(self, response: httpx.Response) -> str:
        try:
            payload = response.json()
            if isinstance(payload, dict):
                return payload.get("message") or payload.get("details") or json.dumps(payload)
            return json.dumps(payload)
        except Exception:  # noqa: BLE001
            return response.text

    async def consume(self, email: str, *, amount: int, user_id: Optional[str], reason: str, usage_id: Optional[str], metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        usage = usage_id or str(uuid.uuid4())
        payload: Dict[str, Any] = {
            "p_email": _normalize_email(email),
            "p_amount": amount,
            "p_reason": reason,
            "p_usage_id": usage,
        }
        if user_id:
            payload["p_user_id"] = user_id
        if metadata:
            payload["p_metadata"] = metadata
        response = await self._client.post(
            f"{self.rest_url}/rpc/consume_user_tickets",
            headers=self._service_headers(),
            json=payload,
        )
        if response.status_code >= 400:
            raise HTTPException(status_code=400, detail=self._extract_error(response))
        data = response.json() or {}
        return {
            "usage_id": data.get("usage_id", usage),
            "balance": data.get("balance", 0),
        }

    async def refund(self, usage_id: str, reason: Optional[str]) -> Dict[str, Any]:
        payload = {"p_usage_id": usage_id, "p_reason": reason or "refunded"}
        response = await self._client.post(
            f"{self.rest_url}/rpc/refund_user_tickets",
            headers=self._service_headers(),
            json=payload,
        )
        if response.status_code >= 400:
            raise HTTPException(status_code=400, detail=self._extract_error(response))
        return response.json() if response.text else {"usage_id": usage_id}

    async def grant(self, email: str, *, amount: int, user_id: Optional[str], reason: str, usage_id: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        payload: Dict[str, Any] = {
            "p_email": _normalize_email(email),
            "p_amount": amount,
            "p_reason": reason,
            "p_usage_id": usage_id,
        }
        if user_id:
            payload["p_user_id"] = user_id
        if metadata:
            payload["p_metadata"] = metadata
        response = await self._client.post(
            f"{self.rest_url}/rpc/grant_user_tickets",
            headers=self._service_headers(),
            json=payload,
        )
        if response.status_code >= 400:
            raise HTTPException(status_code=400, detail=self._extract_error(response))


class StripeClient:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key.strip()
        self.base_url = "https://api.stripe.com/v1"
        self._client = httpx.AsyncClient(timeout=20.0)

    async def close(self) -> None:
        await self._client.aclose()

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/x-www-form-urlencoded",
        }

    async def retrieve_customer(self, customer_id: str) -> Optional[Dict[str, Any]]:
        response = await self._client.get(f"{self.base_url}/customers/{customer_id}", headers=self._headers())
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()

    async def create_customer(self, *, email: str, user_id: Optional[str]) -> str:
        data = {
            "email": email,
        }
        if user_id:
            data["metadata[supabase_user_id]"] = user_id
        response = await self._client.post(f"{self.base_url}/customers", headers=self._headers(), data=data)
        response.raise_for_status()
        payload = response.json()
        customer_id = payload.get("id")
        if not customer_id:
            raise HTTPException(status_code=500, detail="Stripe did not return a customer id")
        return customer_id

    async def create_checkout_session(self, *, customer_id: str, price_id: str, success_url: str, cancel_url: str, metadata: Dict[str, str]) -> str:
        data = {
            "mode": "subscription",
            "customer": customer_id,
            "success_url": success_url,
            "cancel_url": cancel_url,
            "line_items[0][price]": price_id,
            "line_items[0][quantity]": "1",
            "automatic_tax[enabled]": "false",
        }
        for key, value in metadata.items():
            data[f"metadata[{key}]"] = value
        response = await self._client.post(f"{self.base_url}/checkout/sessions", headers=self._headers(), data=data)
        response.raise_for_status()
        payload = response.json()
        url = payload.get("url")
        if not url:
            raise HTTPException(status_code=500, detail="Stripe did not return checkout url")
        return url

    async def create_portal_session(self, *, customer_id: str, return_url: str) -> str:
        data = {"customer": customer_id, "return_url": return_url}
        response = await self._client.post(f"{self.base_url}/billing_portal/sessions", headers=self._headers(), data=data)
        response.raise_for_status()
        payload = response.json()
        url = payload.get("url")
        if not url:
            raise HTTPException(status_code=500, detail="Stripe did not return portal url")
        return url



supabase_store: Optional[SupabaseTicketStore] = None
stripe_client: Optional[StripeClient] = None

if SUPABASE_READY:
    try:
        supabase_store = SupabaseTicketStore(SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY)
    except Exception as exc:  # noqa: BLE001
        LOGGER.error("Failed to initialise SupabaseTicketStore: %s", exc)
else:
    LOGGER.warning("Supabase URL / keys are missing. Billing and ticket endpoints are disabled.")

if STRIPE_READY and STRIPE_SECRET_KEY:
    try:
        stripe_client = StripeClient(STRIPE_SECRET_KEY)
    except Exception as exc:  # noqa: BLE001
        LOGGER.error("Failed to initialise StripeClient: %s", exc)
else:
    if not STRIPE_READY:
        LOGGER.warning("Stripe secret key is missing. Checkout endpoints are disabled.")


async def _close_billing_clients() -> None:
    if supabase_store:
        await supabase_store.close()
    if stripe_client:
        await stripe_client.close()


def _ticket_secret_valid(token: Optional[str]) -> bool:
    if not (TICKET_SECRET_ENABLED and TICKET_API_TOKEN):
        return False
    if not token:
        return False
    return hmac.compare_digest(token.strip(), TICKET_API_TOKEN.strip())


async def _require_supabase_user(
    authorization: Annotated[Optional[str], Header(alias="Authorization")] = None,
) -> SupabaseUser:
    if not (SUPABASE_READY and supabase_store):
        raise HTTPException(status_code=503, detail="Supabase integration is not configured")
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header missing")
    scheme, _, token = authorization.partition(' ')
    if scheme.lower() != 'bearer' or not token:
        raise HTTPException(status_code=401, detail="Authorization header must be Bearer <token>")
    return await supabase_store.fetch_user_from_token(token)


def _require_ticket_secret(header: Optional[str]) -> None:
    if not TICKETS_ENABLED:
        raise HTTPException(status_code=503, detail="Ticket API is not configured")
    if not _ticket_secret_valid(header):
        raise HTTPException(status_code=401, detail="Invalid ticket token")


async def _require_ticket_actor(
    authorization: Annotated[Optional[str], Header(alias="Authorization")] = None,
    ticket_token: Annotated[Optional[str], Header(alias="X-Ticket-Token")] = None,
) -> Optional[SupabaseUser]:
    """
    チケット操作の認可。サービス用シークレットがあればそれを優先し、
    ない場合は Supabase の Bearer トークンで認証したユーザーを返す。
    """
    if _ticket_secret_valid(ticket_token):
        return None
    return await _require_supabase_user(authorization=authorization)


async def _optional_auth(
    authorization: Annotated[Optional[str], Header(alias="Authorization")] = None,
    x_secret_token: Annotated[Optional[str], Header(alias="X-Secret-Token")] = None,
) -> Optional[SupabaseUser]:
    """Allow either Supabase user auth or X-Secret-Token."""
    # If X-Secret-Token is valid, allow access without user
    if _ticket_secret_valid(x_secret_token):
        return None
    
    # Otherwise, require Supabase user authentication
    if not (SUPABASE_READY and supabase_store):
        raise HTTPException(status_code=503, detail="Supabase integration is not configured")
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header missing")
    scheme, _, token = authorization.partition(' ')
    if scheme.lower() != 'bearer' or not token:
        raise HTTPException(status_code=401, detail="Authorization header must be Bearer <token>")
    return await supabase_store.fetch_user_from_token(token)


def _stripe_available() -> bool:
    return bool(BILLING_READY and stripe_client and STRIPE_PRICE_ID)


def _tickets_available() -> bool:
    return bool(TICKETS_ENABLED and supabase_store)


def _default_success_url(provided: Optional[str]) -> str:
    return (provided or STRIPE_SUCCESS_URL).rstrip('/')


def _default_cancel_url(provided: Optional[str]) -> str:
    return (provided or STRIPE_CANCEL_URL).rstrip('/')


def _portal_return_url(provided: Optional[str]) -> str:
    return (provided or STRIPE_PORTAL_RETURN_URL).rstrip('/')


async def _ensure_customer_record(user: SupabaseUser) -> Dict[str, Any]:
    assert supabase_store  # noqa: S101
    return await supabase_store.ensure_user_record(user_id=user.id, email=user.email)


async def _ensure_stripe_customer(user: SupabaseUser, record: Dict[str, Any]) -> str:
    assert supabase_store  # noqa: S101
    assert stripe_client  # noqa: S101
    customer_id = (record or {}).get('stripe_customer_id')
    if customer_id:
        existing = await stripe_client.retrieve_customer(customer_id)
        if existing:
            return customer_id
    customer_id = await stripe_client.create_customer(email=user.email, user_id=user.id)
    await supabase_store.set_customer_id(user.email, customer_id)
    return customer_id


def _stripe_metadata(user: SupabaseUser) -> Dict[str, str]:
    meta = {"supabase_user_id": user.id, "email": user.email}
    return meta


def _parse_stripe_signature(header_value: Optional[str], payload: bytes) -> Dict[str, Any]:
    if not (STRIPE_WEBHOOK_SECRET and header_value):
        raise HTTPException(status_code=400, detail="Stripe signature header missing")
    parts = {}
    for chunk in header_value.split(','):
        key, _, value = chunk.partition('=')
        parts.setdefault(key, []).append(value)
    timestamp = parts.get('t', [None])[0]
    signature = parts.get('v1', [None])[0]
    if not timestamp or not signature:
        raise HTTPException(status_code=400, detail="Invalid Stripe signature header")
    signed = f"{timestamp}.{payload.decode('utf-8')}"
    expected = hmac.new(STRIPE_WEBHOOK_SECRET.encode('utf-8'), signed.encode('utf-8'), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=400, detail="Stripe signature mismatch")
    try:
        return json.loads(payload)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid Stripe payload") from exc


async def _award_subscription_bundle(row: Dict[str, Any], *, event_id: str, subscription_id: Optional[str], reason: str) -> None:
    # Deprecated: Logic moved to _handle_invoice_payment_succeeded for "top up" behavior
    pass



async def _handle_subscription_update(event_type: str, payload: Dict[str, Any], event_id: str) -> None:
    if not supabase_store:
        return
    customer_id = payload.get('customer')
    if not customer_id:
        return
    row = await supabase_store.fetch_ticket_row(customer_id=customer_id)
    if not row:
        LOGGER.warning("Stripe event %s references unknown customer %s", event_type, customer_id)
        return
    subscription_id = payload.get('id')
    status = _normalize_subscription_status(payload.get('status'))
    period_end = payload.get('current_period_end')
    await supabase_store.update_subscription(row['email'], subscription_id=subscription_id, status=status, current_period_end=period_end)
    if event_type == 'customer.subscription.created':
        # await _award_subscription_bundle(row, event_id=event_id, subscription_id=subscription_id, reason='subscription_created')
        pass


async def _handle_checkout_completed(session: Dict[str, Any], event_id: str) -> None:
    if not supabase_store:
        return
    customer_id = session.get('customer')
    if not customer_id:
        return
    row = await supabase_store.fetch_ticket_row(customer_id=customer_id)
    if not row:
        LOGGER.warning("Checkout completed for unknown customer %s", customer_id)
        return
    subscription_data = session.get('subscription')
    subscription_id: Optional[str] = None
    period_end = session.get('current_period_end')
    subscription_status = None
    if isinstance(subscription_data, dict):
        subscription_id = subscription_data.get('id')
        period_end = subscription_data.get('current_period_end', period_end)
        subscription_status = subscription_data.get('status')
    else:
        subscription_id = subscription_data
        subscription_status = session.get('subscription_status')
    status = _normalize_subscription_status(subscription_status) or _normalize_subscription_status(session.get('status')) or 'active'
    await supabase_store.update_subscription(row['email'], subscription_id=subscription_id, status=status, current_period_end=period_end)
    # await _award_subscription_bundle(row, event_id=event_id, subscription_id=subscription_id, reason='subscription_checkout')

async def _handle_invoice_payment_succeeded(payload: Dict[str, Any], event_id: str) -> None:
    if not supabase_store:
        return
    customer_id = payload.get('customer')
    if not customer_id:
        return
    row = await supabase_store.fetch_ticket_row(customer_id=customer_id)
    if not row:
        LOGGER.warning("Invoice payment for unknown customer %s", customer_id)
        return

    # Top up logic: ensure user has at least 10 tickets
    current_balance = int(row.get('tickets', 0))
    target_balance = 10
    shortage = target_balance - current_balance

    if shortage <= 0:
        LOGGER.info("User %s has %d tickets (>= %d). No top-up needed.", row['email'], current_balance, target_balance)
        return

    usage_id = _usage_id_from_event(event_id)
    subscription_id = payload.get('subscription')
    
    LOGGER.info("Topping up user %s: %d -> %d (adding %d)", row['email'], current_balance, target_balance, shortage)
    
    await supabase_store.grant(
        email=row.get('email', ''),
        amount=shortage,
        user_id=row.get('user_id'),
        reason='monthly_topup',
        usage_id=usage_id,
        metadata={"subscription_id": subscription_id, "invoice_id": payload.get('id')} if subscription_id else None,
    )

# ---------------------------------------------------------------------------
# RunPod integration
# ---------------------------------------------------------------------------


class RunPodEndpoint:
    """Client wrapper for a RunPod serverless endpoint."""

    def __init__(self, endpoint_id: str, api_key: str, base_url: str, timeout: float = 120.0) -> None:
        if not endpoint_id:
            raise ValueError("RunPod endpoint ID is required.")
        if not api_key:
            raise ValueError("RunPod API key is required.")
        endpoint_id_clean = _sanitize_config_value(endpoint_id)
        base_url_clean = _sanitize_config_value(base_url)
        api_key_clean = _sanitize_config_value(api_key)
        if not endpoint_id_clean:
            raise ValueError("RunPod endpoint ID is invalid after sanitising control characters.")
        if not base_url_clean:
            raise ValueError("RunPod base URL is invalid after sanitising control characters.")
        if not api_key_clean:
            raise ValueError("RunPod API key is invalid after sanitising control characters.")
        self.endpoint_id = endpoint_id_clean
        self.api_key = api_key_clean
        self.base_url = base_url_clean.rstrip("/")
        self.timeout = timeout
        self._client = httpx.AsyncClient(timeout=self.timeout)

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _url(self, suffix: str) -> str:
        return f"{self.base_url}/{self.endpoint_id}{suffix}"

    async def submit(self, payload: Dict[str, Any]) -> str:
        try:
            response = await self._client.post(self._url("/run"), headers=self._headers(), json={"input": payload})
            response.raise_for_status()
        except httpx.HTTPError as exc:  # noqa: BLE001
            raise RuntimeError({"error": "runpod_submit_failed", "detail": str(exc)}) from exc

        data = response.json()
        job_id = data.get("id") or data.get("jobId") or data.get("job_id")
        if not job_id:
            raise RuntimeError({"error": "runpod_submit_failed", "detail": data})
        return job_id

    async def status(self, job_id: str) -> Dict[str, Any]:
        url = self._url(f"/status/{job_id}")
        headers = self._headers()
        try:
            response = await self._client.get(url, headers=headers)
            if response.status_code == 405:
                response = await self._client.post(url, headers=headers, json={})
            response.raise_for_status()
        except httpx.HTTPError as exc:  # noqa: BLE001
            raise RuntimeError({"error": "runpod_status_failed", "detail": str(exc)}) from exc
        return response.json()

    async def wait(self, job_id: str, *, poll_interval: float, timeout: Optional[float]) -> Dict[str, Any]:
        start = time.monotonic()
        while True:
            status = await self.status(job_id)
            output = status.get("output")
            state_raw = status.get("status") or status.get("state") or ""
            state = str(state_raw).upper()

            if isinstance(output, dict) and output.get("error"):
                raise RuntimeError({"error": "runpod_output_error", "detail": output})

            if state in {"COMPLETED", "COMPLETED_SUCCESS", "SUCCEEDED"} or (state == "" and output):
                return status
            if state in {"FAILED", "FAILED_INTERNAL", "CANCELLED", "ERROR"}:
                detail = output if isinstance(output, dict) else status
                raise RuntimeError({"error": "runpod_job_failed", "detail": detail})

            if timeout and time.monotonic() - start > timeout:
                raise RuntimeError({"error": "runpod_job_timeout", "detail": {"job_id": job_id, "status": state}})

            await asyncio.sleep(max(poll_interval, 1.0))

    async def close(self) -> None:
        await self._client.aclose()


# ---------------------------------------------------------------------------
# Redis-backed job store
# ---------------------------------------------------------------------------


def _json_safe(value: Any, visited: Optional[Set[int]] = None) -> Any:
    """Convert nested structures into JSON-serialisable form, breaking cycles."""
    if visited is None:
        visited = set()

    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (bytes, bytearray)):
        return value.decode('utf-8', errors='replace')
    if hasattr(value, 'model_dump'):
        return _json_safe(value.model_dump(), visited)

    obj_id = id(value)
    if obj_id in visited:
        return '<circular>'

    visited.add(obj_id)
    try:
        if isinstance(value, dict):
            return {str(key): _json_safe(item, visited) for key, item in value.items()}
        if isinstance(value, (list, tuple, set)):
            iterable = list(value) if isinstance(value, set) else value
            return [_json_safe(item, visited) for item in iterable]
        return repr(value)
    finally:
        visited.discard(obj_id)


class JobStore:
    def __init__(
        self,
        client: redis.Redis,
        prefix: str,
        ttl: int,
        *,
        persist_dir: Optional[str] = None,
        persist_ttl: Optional[int] = None,
    ) -> None:
        self.client = client
        self.prefix = prefix.rstrip(":")
        self.ttl = ttl
        self.persist_ttl = persist_ttl or ttl
        self.persist_path: Optional[Path] = None
        if persist_dir:
            try:
                path = Path(persist_dir)
                path.mkdir(parents=True, exist_ok=True)
                self.persist_path = path
            except OSError:
                LOGGER.warning("Failed to initialise task persistence directory %s", persist_dir, exc_info=True)
                self.persist_path = None

    def _key(self, task_id: str) -> str:
        return f"{self.prefix}:{task_id}"

    def _backup_path(self, task_id: str) -> Optional[Path]:
        if not self.persist_path:
            return None
        safe_id = "".join(ch for ch in task_id if ch.isalnum() or ch in "-_.")
        if not safe_id:
            safe_id = "task"
        return self.persist_path / f"{safe_id}.json"

    def _purge_backup(self, path: Path) -> None:
        try:
            path.unlink(missing_ok=True)  # type: ignore[arg-type]
        except TypeError:
            try:
                if path.exists():
                    path.unlink()
            except OSError:
                pass
        except OSError:
            pass

    def _write_backup(self, job: Dict[str, Any]) -> None:
        path = self._backup_path(job.get("task_id", ""))
        if not path:
            return
        payload = {"payload": job, "expires_at": time.time() + self.persist_ttl}
        tmp_path = path.with_suffix(".tmp")
        try:
            tmp_path.write_text(json.dumps(payload))
            tmp_path.replace(path)
        except OSError:
            # Fall back to best-effort writes without failing request processing.
            pass
        finally:
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except OSError:
                pass

    def _read_backup(self, task_id: str) -> Optional[Dict[str, Any]]:
        path = self._backup_path(task_id)
        if not path or not path.exists():
            return None
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            self._purge_backup(path)
            return None

        expires_at = data.get("expires_at")
        payload = data.get("payload")
        if expires_at and expires_at < time.time():
            self._purge_backup(path)
            return None
        if not isinstance(payload, dict):
            self._purge_backup(path)
            return None
        return payload

    async def write(self, job: Dict[str, Any]) -> Dict[str, Any]:
        payload = _json_safe(job)
        await self.client.set(self._key(job["task_id"]), json.dumps(payload), ex=self.ttl)
        self._write_backup(payload)
        return payload

    async def get(self, task_id: str) -> Optional[Dict[str, Any]]:
        raw = await self.client.get(self._key(task_id))
        if raw is None:
            payload = self._read_backup(task_id)
            if not payload:
                return None
            await self.client.set(self._key(task_id), json.dumps(payload), ex=self.ttl)
            return payload
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    async def update_fields(self, task_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        job = await self.get(task_id)
        if not job:
            return None

        for key, value in updates.items():
            if key == "details" and isinstance(value, dict):
                job.setdefault("details", {}).update(value)
            elif key == "progress" and isinstance(value, list):
                job.setdefault("progress", []).extend(value)
            else:
                job[key] = value

        job["updated_at"] = _now_iso()
        sanitized = await self.write(job)
        return sanitized

    async def append_progress(
        self,
        task_id: str,
        message: str,
        *,
        stage: Optional[str] = None,
        extra: Optional[Dict[str, Any]] = None,
    ) -> None:
        entry: Dict[str, Any] = {"timestamp": _now_iso(), "message": message}
        if stage:
            entry["stage"] = stage
        if extra:
            entry["extra"] = extra
        await self.update_fields(task_id, {"progress": [entry]})

    async def close(self) -> None:
        try:
            await self.client.aclose()
        except AttributeError:
            pass


# ---------------------------------------------------------------------------
# Job manager
# ---------------------------------------------------------------------------


class JobManager:
    def __init__(
        self,
        store: JobStore,
        sovits_endpoint: Optional[RunPodEndpoint],
        wav_endpoint: Optional[RunPodEndpoint],
        face_endpoint: Optional[RunPodEndpoint],
        *,
        poll_interval: float,
        job_timeout: float,
    ) -> None:
        self.store = store
        self.sovits_endpoint = sovits_endpoint
        self.wav_endpoint = wav_endpoint
        self.face_endpoint = face_endpoint
        self.poll_interval = poll_interval
        self.job_timeout = job_timeout
        self._tasks: set[asyncio.Task] = set()

    async def submit(self, request: PipelineRequest) -> str:
        needs_wav2lip = bool(request.target_key or request.source_keys)
        if needs_wav2lip and not self.wav_endpoint:
            raise RuntimeError("RUNPOD_WAV2LIP_ENDPOINT and RUNPOD_API_KEY are required when target/source are provided")

        task_id = uuid.uuid4().hex
        request_dict = _request_to_dict(request)
        job_record = {
            "task_id": task_id,
            "status": "pending",
            "state": "pending",
            "stage": "queued",
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "request": request_dict,
            "result": None,
            "error": None,
            "progress": [],
            "intermediate": None,
            "details": {},
        }
        await self.store.write(job_record)

        task = asyncio.create_task(self._execute(task_id, request))
        task.add_done_callback(self._tasks.discard)
        self._tasks.add(task)

        return task_id


    async def _execute(self, task_id: str, request: PipelineRequest) -> None:
        wav_result: Optional[Dict[str, Any]] = None
        sovits_result: Optional[Dict[str, Any]] = None
        intermediate: Dict[str, Any] = {}
        
        try:
            LOGGER.info("Starting _execute task_id=%s", task_id)
            request_dict = _request_to_dict(request)
            LOGGER.info("Request dict keys: %s", list(request_dict.keys()))
            
            script_text = (request.script_text or "").strip() if hasattr(request, "script_text") else ""
            voice_key = getattr(request, "reference_audio_key", None) or request.audio_key
            LOGGER.info("script_text len=%d, voice_key=%s, audio_key=%s", len(script_text), voice_key, request.audio_key)

            if script_text:
                if not self.sovits_endpoint:
                    raise RuntimeError(
                        {
                            "error": "sovits_not_configured",
                            "detail": "RUNPOD_SOVITS_ENDPOINT is required for SoVITS",
                        }
                    )
                if not voice_key:
                    raise RuntimeError(
                        {
                            "error": "missing_reference_audio",
                            "detail": "reference_audio_key or audio_key is required",
                        }
                    )
        
                await self.store.update_fields(
                    task_id,
                    {"status": "running", "state": "running", "stage": "sovits"},
                )
                await self.store.append_progress(task_id, "Submitting SoVITS job", stage="sovits")
        
                options_payload = request.sovits.model_dump()
                sovits_output_key = options_payload.pop("output_key", None)

                # ref_text 繧剃ｽｿ繧上★縺ｫ蜷域・縺輔○繧九◆繧・ref_text_free 繧呈怏蜉ｹ蛹悶＠縲〉ef_text 縺ｯ遨ｺ縺ｧ騾√ｋ縲・                # options 蜀・・ ref_text 髢｢騾｣繧ょ炎髯､縺励〉ef_text_free 繧貞ｼｷ蛻ｶ true 縺ｫ縺吶ｋ縲・                options_payload.pop("reference_text", None)
                options_payload.pop("reference_text_key", None)
                options_payload["ref_text_free"] = True
                ref_text = ""
                sovits_payload = {
                    "reference_audio_key": voice_key,
                    "target_text": script_text,
                    "reference_text": ref_text,
                    "ref_text_free": True,
                    "output_key": request.sovits.output_key or sovits_output_key,
                    "options": options_payload,
                }
        
                sovits_job_id = await self.sovits_endpoint.submit(sovits_payload)
                await self.store.update_fields(task_id, {"details": {"sovits_job_id": sovits_job_id}})
                await self.store.append_progress(
                    task_id,
                    "SoVITS job submitted",
                    stage="sovits",
                    extra={"job_id": sovits_job_id},
                )
        
                sovits_status = await self.sovits_endpoint.wait(
                    sovits_job_id,
                    poll_interval=self.poll_interval,
                    timeout=self.job_timeout,
                )
                sovits_output = sovits_status.get("output")
                if not isinstance(sovits_output, dict):
                    raise RuntimeError({"error": "no_sovits_output", "detail": sovits_status})
        
                output_key = sovits_output.get("output_key")
                if not output_key:
                    raise RuntimeError({"error": "missing_sovits_output_key", "detail": sovits_output})
        
                sovits_result = sovits_output
                intermediate["sovits"] = sovits_result
                
                # Handle Base64 audio transfer
                audio_base64 = sovits_output.get("audio_base64")
                if audio_base64:
                    request.audio_base64 = audio_base64
                    LOGGER.info("Received audio_base64 from SoVITS (length: %d)", len(audio_base64))
                
                request.audio_key = output_key
                request.reference_audio_key = voice_key
                request_dict = _request_to_dict(request)
        
                await self.store.update_fields(
                    task_id,
                    {
                        "details": {"sovits_status": sovits_status},
                        "intermediate": intermediate,
                    },
                )
                await self.store.append_progress(task_id, "SoVITS completed", stage="sovits")
            else:
                if not request.audio_key and not request.audio_base64:
                    raise RuntimeError(
                        {
                            "error": "missing_audio_key",
                            "detail": "audio_key or audio_base64 is required",
                        }
                    )

            # Audio-only path: no target video and no facefusion sources -> finish here
            if not request.target_key and not request.source_keys:
                final_result: Dict[str, Any] = {}
                if sovits_result:
                    final_result.update(sovits_result)
                elif request.audio_key:
                    final_result["output_key"] = request.audio_key
                await self.store.update_fields(
                    task_id,
                    {
                        "status": "completed",
                        "state": "completed",
                        "stage": "completed",
                        "result": final_result or None,
                        "error": None,
                    },
                )
                await self.store.append_progress(task_id, "Audio-only pipeline completed", stage="completed")
                return

            await self.store.update_fields(
                task_id,
                {"status": "running", "state": "running", "stage": "wav2lip"},
            )
            await self.store.append_progress(task_id, "Submitting Wav2Lip job", stage="wav2lip")

            LOGGER.info("Submitting Wav2Lip job. audio_key=%s", request.audio_key)
            # Ensure request_dict is fresh
            request_dict = _request_to_dict(request)
            LOGGER.info("Wav2Lip payload audio_key=%s", request_dict.get("audio_key"))
        
            wav_job_id = await self.wav_endpoint.submit(request_dict)
            await self.store.update_fields(task_id, {"details": {"wav2lip_job_id": wav_job_id}})
            await self.store.append_progress(
                task_id,
                "Wav2Lip job submitted",
                stage="wav2lip",
                extra={"job_id": wav_job_id},
            )
        
            wav_status = await self.wav_endpoint.wait(
                wav_job_id,
                poll_interval=self.poll_interval,
                timeout=self.job_timeout,
            )
            wav_output = wav_status.get("output")
            if isinstance(wav_output, dict):
                wav_result = dict(wav_output)
            elif isinstance(wav_output, str):
                wav_result = {"output_url": wav_output}
            else:
                raise RuntimeError({"error": "no_wav2lip_output", "detail": wav_status})

            intermediate["wav2lip"] = dict(wav_result)
            await self.store.update_fields(
                task_id,
                {
                    "intermediate": intermediate,
                    "details": {"wav2lip_status": wav_status},
                },
            )
            await self.store.append_progress(task_id, "Wav2Lip completed", stage="wav2lip")
        
            final_result: Dict[str, Any] = dict(wav_result)
        
            if request.source_keys:
                if not self.face_endpoint:
                    raise RuntimeError(
                        {
                            "error": "facefusion_not_configured",
                            "detail": "RUNPOD_FACEFUSION_ENDPOINT is required for facefusion",
                        }
                    )
                await self.store.update_fields(task_id, {"stage": "facefusion"})
                await self.store.append_progress(task_id, "Submitting FaceFusion job", stage="facefusion")
        
                face_payload = {
                    "request": request_dict,
                    "wav2lip": wav_result.get("wav2lip") if isinstance(wav_result, dict) else wav_result,
                }
        
                face_job_id = await self.face_endpoint.submit(face_payload)
                await self.store.update_fields(task_id, {"details": {"facefusion_job_id": face_job_id}})
                await self.store.append_progress(
                    task_id,
                    "FaceFusion job submitted",
                    stage="facefusion",
                    extra={"job_id": face_job_id},
                )
        
                face_status = await self.face_endpoint.wait(
                    face_job_id,
                    poll_interval=self.poll_interval,
                    timeout=self.job_timeout,
                )
                face_output = face_status.get("output")
                if not isinstance(face_output, dict):
                    raise RuntimeError({"error": "no_facefusion_output", "detail": face_status})
        
                final_result = face_output
                if intermediate:
                    final_result.setdefault("intermediate", {}).update(intermediate)
                await self.store.append_progress(task_id, "FaceFusion completed", stage="facefusion")
                await self.store.update_fields(
                    task_id,
                    {
                        "details": {"facefusion_status": face_status},
                    },
                )
            else:
                if intermediate:
                    final_result.setdefault("intermediate", {}).update(intermediate)
        
            await self.store.update_fields(
                task_id,
                {
                    "status": "completed",
                    "state": "completed",
                    "stage": "completed",
                    "result": final_result,
                    "error": None,
                },
            )
            await self.store.append_progress(task_id, "Pipeline completed", stage="completed")
        
        except Exception as exc:  # noqa: BLE001
            error_payload = _normalise_exception(exc)
            LOGGER.exception("Task %s failed: %s", task_id, error_payload)
            await self.store.update_fields(
                task_id,
                {
                    "status": "failed",
                    "state": "failed",
                    "stage": "failed",
                    "error": error_payload,
                },
            )
            await self.store.append_progress(task_id, "Pipeline failed", stage="failed", extra=error_payload)
        
    async def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        return await self.store.get(task_id)

    async def wait_for_completion(self, task_id: str, timeout: Optional[float] = None) -> Dict[str, Any]:
        start = time.monotonic()
        poll = max(self.poll_interval, 1.0)
        while True:
            record = await self.get_task(task_id)
            if not record:
                raise HTTPException(status_code=404, detail="Task not found")
            if record.get("status") in {"completed", "failed"}:
                return record
            if timeout and time.monotonic() - start > timeout:
                raise asyncio.TimeoutError
            await asyncio.sleep(poll)

    async def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        if self.wav_endpoint:
            await self.wav_endpoint.close()
        if self.face_endpoint:
            await self.face_endpoint.close()
        if self.sovits_endpoint:
            await self.sovits_endpoint.close()
        if getattr(self, 'llama_endpoint', None):
            await self.llama_endpoint.close()
        await self.store.close()


# ---------------------------------------------------------------------------
# Environment configuration
# ---------------------------------------------------------------------------


RUNPOD_API_KEY = os.getenv("RUNPOD_API_KEY", "")
RUNPOD_LLAMA_ENDPOINT = os.getenv("RUNPOD_LLAMA_ENDPOINT", "")
RUNPOD_SOVITS_ENDPOINT = os.getenv("RUNPOD_SOVITS_ENDPOINT", "")
RUNPOD_WAV2LIP_ENDPOINT = os.getenv("RUNPOD_WAV2LIP_ENDPOINT", "")
RUNPOD_FACEFUSION_ENDPOINT = os.getenv("RUNPOD_FACEFUSION_ENDPOINT", "")
RUNPOD_API_BASE = os.getenv("RUNPOD_API_BASE", "https://api.runpod.ai/v2")
RUNPOD_POLL_INTERVAL = float(os.getenv("RUNPOD_POLL_INTERVAL", "5"))
RUNPOD_JOB_TIMEOUT = float(os.getenv("RUNPOD_JOB_TIMEOUT", "1800"))

JOBSTORE_REDIS_URL = os.getenv("JOBSTORE_REDIS_URL") or os.getenv("CELERY_BROKER_URL") or "redis://127.0.0.1:6379/0"
JOBSTORE_REDIS_SSL_CERT_REQS = os.getenv("JOBSTORE_REDIS_SSL_CERT_REQS", "").strip().lower() or None
JOBSTORE_PREFIX = os.getenv("JOBSTORE_PREFIX", "ff:task")
JOBSTORE_TTL = int(os.getenv("JOBSTORE_TTL", "604800"))
JOBSTORE_PERSIST_DIR = os.getenv("JOBSTORE_PERSIST_DIR", "/opt/app/task_store")
JOBSTORE_PERSIST_TTL = max(int(os.getenv("JOBSTORE_PERSIST_TTL", "604800")), JOBSTORE_TTL)


def _create_redis_client(url: str) -> redis.Redis:
    kwargs: Dict[str, Any] = {"decode_responses": True}
    if url.startswith("rediss://"):
        mode = JOBSTORE_REDIS_SSL_CERT_REQS or "disable"
        if mode in {"disable", "disabled", "none", "off", "false"}:
            kwargs["ssl_cert_reqs"] = "none"
            kwargs["ssl_check_hostname"] = False
        elif mode in {"require", "required", "true", "on"}:
            kwargs["ssl_cert_reqs"] = "required"
            kwargs["ssl_check_hostname"] = True
        else:
            kwargs["ssl_cert_reqs"] = mode
    return redis.from_url(url, **kwargs)


redis_client = _create_redis_client(JOBSTORE_REDIS_URL)
job_store = JobStore(
    redis_client,
    prefix=JOBSTORE_PREFIX,
    ttl=JOBSTORE_TTL,
    persist_dir=JOBSTORE_PERSIST_DIR,
    persist_ttl=JOBSTORE_PERSIST_TTL,
)

sovits_endpoint: Optional[RunPodEndpoint] = None
wav_endpoint: Optional[RunPodEndpoint] = None
face_endpoint: Optional[RunPodEndpoint] = None

if RUNPOD_API_KEY and RUNPOD_SOVITS_ENDPOINT:
    sovits_endpoint = RunPodEndpoint(RUNPOD_SOVITS_ENDPOINT, RUNPOD_API_KEY, base_url=RUNPOD_API_BASE)
if RUNPOD_API_KEY and RUNPOD_WAV2LIP_ENDPOINT:
    wav_endpoint = RunPodEndpoint(RUNPOD_WAV2LIP_ENDPOINT, RUNPOD_API_KEY, base_url=RUNPOD_API_BASE)
if RUNPOD_API_KEY and RUNPOD_FACEFUSION_ENDPOINT:
    face_endpoint = RunPodEndpoint(RUNPOD_FACEFUSION_ENDPOINT, RUNPOD_API_KEY, base_url=RUNPOD_API_BASE)

job_manager = JobManager(
    job_store,
    sovits_endpoint,
    wav_endpoint,
    face_endpoint,
    poll_interval=RUNPOD_POLL_INTERVAL,
    job_timeout=RUNPOD_JOB_TIMEOUT,
)


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------


APP = FastAPI(title="FaceFusion API", version="4.0.0")


@APP.on_event("shutdown")
async def _shutdown() -> None:
    await job_manager.close()
    await _close_billing_clients()


@APP.get("/health")
async def health_check() -> Dict[str, str]:
    return {"status": "ok"}


@APP.post("/warmup", dependencies=[Depends(_require_service_auth)])
async def warmup() -> Dict[str, str]:
    """Lightweight no-op endpoint to let frontends pre-warm the pod."""
    return {"status": "ok"}


@APP.get("/")
async def root() -> Dict[str, str]:
    return {
        "message": "FaceFusion API is running",
        "docs": "/docs",
        "health": "/health",
    }


@APP.post("/storage/presign", response_model=PresignResponse, dependencies=[Depends(_require_service_auth)])
def presign_url(request: PresignRequest) -> PresignResponse:
    s3 = get_s3_client()
    key = request.key or f"uploads/{uuid.uuid4().hex}"
    key = key.lstrip("/")

    if not any(key.startswith(prefix) for prefix in ALLOWED_PREFIXES):
        raise HTTPException(status_code=400, detail="Invalid object key prefix")

    params = {"Bucket": R2_BUCKET, "Key": key}
    if request.intent == "upload":
        if request.content_type and not _is_allowed_mime(request.content_type):
            raise HTTPException(status_code=400, detail="Unsupported content type")
        if request.content_type:
            params["ContentType"] = request.content_type

    operation = "put_object" if request.intent == "upload" else "get_object"
    expires_in = min(request.expires_in, 900)

    try:
        url = s3.generate_presigned_url(
            ClientMethod=operation,
            Params=params,
            ExpiresIn=expires_in,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to generate presigned URL: {exc}") from exc

    return PresignResponse(
        key=key,
        url=url,
        intent=request.intent,
        expires_in=expires_in,
        public_url=build_public_url(key),
    )


@APP.post("/storage/upload", response_model=DirectUploadResponse, dependencies=[Depends(_require_service_auth)])
async def direct_upload(
    file: UploadFile = File(...),
    prefix: str = Form("uploads"),
    filename: Optional[str] = Form(None),
) -> DirectUploadResponse:
    s3 = get_s3_client()
    safe_prefix = prefix.strip().strip("/")
    if safe_prefix and not safe_prefix.endswith("/"):
        safe_prefix = f"{safe_prefix}/"

    if safe_prefix and not any(safe_prefix.startswith(p) for p in ALLOWED_PREFIXES):
        raise HTTPException(status_code=400, detail="Invalid upload prefix")

    if file.content_type and not _is_allowed_mime(file.content_type):
        raise HTTPException(status_code=400, detail="Unsupported content type")

    suggested_name = filename or file.filename or f"upload_{uuid.uuid4().hex}"
    key = f"{safe_prefix}{suggested_name}" if safe_prefix else suggested_name

    counter = _TransferCounter()
    await file.seek(0)

    extra_args = {"ContentType": file.content_type} if file.content_type else None

    try:
        await asyncio.to_thread(
            s3.upload_fileobj,
            file.file,
            R2_BUCKET,
            key,
            extra_args,
            counter,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to upload file to R2: {exc}") from exc
    finally:
        await file.close()

    if counter.total > MAX_UPLOAD_BYTES:
        try:
            s3.delete_object(Bucket=R2_BUCKET, Key=key)
        except Exception:
            pass
        raise HTTPException(status_code=413, detail=f"File too large (>{MAX_UPLOAD_BYTES} bytes)")

    return DirectUploadResponse(
        key=key,
        size=counter.total,
        content_type=file.content_type,
        public_url=build_public_url(key),
    )


@APP.post("/audio-candidates", response_model=AudioCandidatesResponse, dependencies=[Depends(_require_service_auth)])
async def audio_candidates(
    video: UploadFile = File(...),
    trim_start: float = Form(0.0),
    trim_end: float = Form(0.0),
    mode: str = Form("speech"),
) -> AudioCandidatesResponse:
    """Extract up to 6 speech-like clips with robust fallbacks (full source coverage)."""
    workdir = allocate_workdir()
    try:
        input_path = workdir / (video.filename or "input.mp4")
        await _save_upload_file(video, input_path)

        full_duration = _probe_duration_seconds(input_path) or max(trim_end, MIN_SEGMENT_SECONDS)
        audio_path = workdir / "audio_full.wav"
        extract_cmd = [
            "ffmpeg",
            "-y",
            "-err_detect",
            "ignore_err",
            "-fflags",
            "+genpts",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "44100",
            "-c:a",
            "pcm_s16le",
            str(audio_path),
        ]
        try:
            subprocess.run(extract_cmd, check=True, capture_output=True, text=True)
        except Exception:
            pass

        audio_duration = _probe_duration_seconds(audio_path) if audio_path.exists() else None
        clip_end = audio_duration or full_duration or (MIN_SEGMENT_SECONDS * 2)

        # Simple energy-based VAD to find speechy chunks fast
        segments = []
        try:
            import wave
            with wave.open(str(audio_path), 'rb') as wf:
                sr = wf.getframerate() or 44100
                n_frames = wf.getnframes()
                data = wf.readframes(n_frames)
            if data:
                import numpy as np  # noqa: PLC0415
                samples = np.frombuffer(data, dtype=np.int16)
                frame_len = int(sr * 0.03) or 1323
                if frame_len <= 0:
                    frame_len = 1323
                energies = []
                for i in range(0, len(samples), frame_len):
                    chunk = samples[i:i+frame_len]
                    if chunk.size == 0:
                        continue
                    energies.append(float(np.mean(chunk.astype(np.float32) ** 2)))
                if energies:
                    import statistics
                    med = statistics.median(energies)
                    mx = max(energies)
                    thr = max(med * 2.0, mx * 0.1, 1e5)
                    speech = [e > thr for e in energies]
                    win_sec = frame_len / sr
                    # merge consecutive speech frames
                    start = None
                    for idx, flag in enumerate(speech):
                        if flag and start is None:
                            start = idx * win_sec
                        if not flag and start is not None:
                            end_t = idx * win_sec
                            if end_t - start >= MIN_SEGMENT_SECONDS:
                                segments.append((start, min(end_t, clip_end)))
                            start = None
                    if start is not None:
                        end_t = len(speech) * win_sec
                        if end_t - start >= MIN_SEGMENT_SECONDS:
                            segments.append((start, min(end_t, clip_end)))
        except Exception:
            segments = []

        if not segments:
            segments = _fallback_segments(0.0, clip_end, MAX_AUDIO_CANDIDATES * 2, MIN_SEGMENT_SECONDS)

        random.shuffle(segments)

        def describe(idx: int) -> str:
            pitch_tags = ["high", "mid", "low"]
            pace_tags = ["slow", "normal", "fast"]
            color_tags = ["bright", "warm", "dark"]
            return f"{pitch_tags[idx % 3]} / {pace_tags[(idx + 1) % 3]} / {color_tags[(idx + 2) % 3]}"
        candidates: list[AudioCandidate] = []
        for idx, (start, end) in enumerate(segments):
            if len(candidates) >= 6:
                break
            length = end - start
            if length < MIN_SEGMENT_SECONDS:
                continue
            if length > MAX_SEGMENT_SECONDS:
                end = start + MAX_SEGMENT_SECONDS
            segment_path = workdir / f"cand_{idx + 1}.wav"
            cut_cmd = [
                "ffmpeg",
                "-y",
                "-i",
                str(audio_path if audio_path.exists() else input_path),
                "-ss",
                f"{start:.3f}",
                "-to",
                f"{end:.3f}",
                "-ac",
                "1",
                "-ar",
                "44100",
                "-af",
                "afftdn=nf=-25dB,silenceremove=stop_periods=-1:stop_duration=0.2:stop_threshold=-45dB,dynaudnorm=p=0.8:f=150:g=12",
                "-c:a",
                "pcm_s16le",
                str(segment_path),
            ]
            try:
                subprocess.run(cut_cmd, check=True, capture_output=True, text=True)
            except Exception:
                continue
            if not segment_path.exists() or segment_path.stat().st_size == 0:
                continue

            raw = segment_path.read_bytes()
            b64 = base64.b64encode(raw).decode("ascii")
            data_url = f"data:audio/wav;base64,{b64}"
            candidates.append(
                AudioCandidate(
                    id=f"cand-{len(candidates)+1}",
                    label=describe(idx),
                    start=round(start, 2),
                    end=round(end, 2),
                    url=data_url,
                    key=None,
                )
            )

        if not candidates:
            # fallback: fixed windows even if silence
            fallback = _fallback_segments(0.0, max(clip_end, MIN_SEGMENT_SECONDS * 2), 6, MIN_SEGMENT_SECONDS)
            for idx, (start, end) in enumerate(fallback):
                segment_path = workdir / f"fb_{idx + 1}.wav"
                cut_cmd = [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(audio_path if audio_path.exists() else input_path),
                    "-ss",
                    f"{start:.3f}",
                    "-to",
                    f"{end:.3f}",
                    "-ac",
                    "1",
                    "-ar",
                    "44100",
                    "-c:a",
                    "pcm_s16le",
                    str(segment_path),
                ]
                try:
                    subprocess.run(cut_cmd, check=True, capture_output=True, text=True)
                    raw = segment_path.read_bytes()
                    b64 = base64.b64encode(raw).decode("ascii")
                    data_url = f"data:audio/wav;base64,{b64}"
                    candidates.append(
                        AudioCandidate(
                            id=f"cand-{idx + 1}",
                            label="蝗ｺ螳夂ｪ灘・謚ｽ蜃ｺ",
                            start=round(start, 2),
                            end=round(end, 2),
                            url=data_url,
                            key=None,
                        )
                    )
                except Exception:
                    continue
                if len(candidates) >= 3:
                    break

        if not candidates:
            raise HTTPException(status_code=500, detail="Failed to generate audio candidates")

        return AudioCandidatesResponse(candidates=candidates)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Audio candidate generation failed: {exc}") from exc
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        try:
            await video.close()
        except Exception:
            pass

@APP.post("/transcode-preview", dependencies=[Depends(_require_service_auth)])
async def transcode_preview(
    video: UploadFile = File(...),
    trim_start: float = Form(0.0),
    trim_end: float = Form(0.0),
) -> Dict[str, Any]:
    workdir = allocate_workdir()
    s3 = get_s3_client()
    try:
        input_path = workdir / (video.filename or "input.mp4")
        await _save_upload_file(video, input_path)

        target_path = workdir / "compatible.mp4"
        transcode_cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
        ]
        if trim_end > trim_start and trim_end > 0:
            transcode_cmd.extend([
                "-ss",
                f"{trim_start:.3f}",
                "-to",
                f"{trim_end:.3f}",
            ])
        transcode_cmd.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                str(target_path),
            ]
        )
        try:
            subprocess.run(transcode_cmd, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as exc:
            LOGGER.error("preview transcode failed: %s", exc.stderr)
            raise HTTPException(status_code=500, detail="preview_transcode_failed") from exc

        duration = _probe_duration_seconds(target_path) or 0.0
        key = f"uploads/video/preview/{uuid.uuid4().hex}.mp4"
        _upload_object(s3, target_path, key)

        return {
            "key": key,
            "public_url": build_public_url(key),
            "duration": duration,
        }
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Transcode preview failed: {exc}") from exc
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        try:
            await video.close()
        except Exception:
            pass
@APP.post("/generate", dependencies=[Depends(_require_service_auth)])
async def generate_job(
    video: UploadFile = File(...),
    script_text: Optional[str] = Form(None),
    trim_start: float = Form(0.0),
    trim_end: float = Form(0.0),
    audio_candidate_id: Optional[str] = Form(None),
    audio_candidate_start: Optional[float] = Form(None),
    audio_candidate_end: Optional[float] = Form(None),
) -> Dict[str, Any]:
    workdir = allocate_workdir()
    s3 = get_s3_client()
    try:
        input_path = workdir / (video.filename or "input.mp4")
        await _save_upload_file(video, input_path)

        target_path = workdir / "compatible.mp4"
        transcode_cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
        ]
        if trim_end > trim_start and trim_end > 0:
            transcode_cmd.extend([
                "-ss",
                f"{trim_start:.3f}",
                "-to",
                f"{trim_end:.3f}",
            ])
        transcode_cmd.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                str(target_path),
            ]
        )
        try:
            subprocess.run(transcode_cmd, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as exc:
            LOGGER.error("video transcode failed: %s", exc.stderr)
            raise HTTPException(status_code=500, detail="video_transcode_failed") from exc

        full_audio = workdir / "full_audio.wav"
        audio_path = workdir / "candidate.wav"

        # extract full audio from video for waveform/trimming
        full_extract_cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "44100",
            "-c:a",
            "pcm_s16le",
            str(full_audio),
        ]
        try:
            subprocess.run(full_extract_cmd, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as exc:
            LOGGER.error("full audio extract failed: %s", exc.stderr)
            raise HTTPException(status_code=500, detail="full_audio_extract_failed") from exc

        full_duration = _probe_duration_seconds(full_audio) or 0.0
        audio_start = audio_candidate_start if audio_candidate_start is not None else 0.0
        audio_end = audio_candidate_end if audio_candidate_end is not None else full_duration
        if full_duration > 0:
            audio_start = max(0.0, min(audio_start, full_duration))
            if audio_end <= 0:
                audio_end = full_duration
            audio_end = min(max(audio_end, audio_start + 0.05), full_duration)
        if audio_end <= audio_start:
            audio_end = audio_start + 0.5

        LOGGER.info("audio trim from full audio start=%.3f end=%.3f dur=%.3f", audio_start, audio_end, full_duration)
        trim_cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(full_audio),
            "-ss",
            f"{audio_start:.3f}",
        ]
        if audio_end > audio_start:
            trim_cmd.extend(["-to", f"{audio_end:.3f}"])
        trim_cmd.extend(
            [
                "-ac",
                "1",
                "-ar",
                "44100",
                "-c:a",
                "pcm_s16le",
                str(audio_path),
            ]
        )
        try:
            subprocess.run(trim_cmd, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as exc:
            LOGGER.error("audio trim failed: %s", exc.stderr)
            raise HTTPException(status_code=500, detail="audio_trim_failed") from exc

        if not audio_path.exists() or audio_path.stat().st_size == 0:
            LOGGER.warning("audio trim produced empty file, retrying full audio")
            fallback_cmd = [
                "ffmpeg",
                "-y",
                "-i",
                str(full_audio),
                "-ac",
                "1",
                "-ar",
                "44100",
                "-c:a",
                "pcm_s16le",
                str(audio_path),
            ]
            try:
                subprocess.run(fallback_cmd, check=True, capture_output=True, text=True)
            except subprocess.CalledProcessError as exc:
                LOGGER.error("audio fallback failed: %s", exc.stderr)
                raise HTTPException(status_code=500, detail="audio_trim_failed") from exc

        if not audio_path.exists() or audio_path.stat().st_size == 0:
            LOGGER.error("audio preparation failed: path=%s size=%s", audio_path, audio_path.stat().st_size if audio_path.exists() else None)
            raise HTTPException(status_code=400, detail="failed to prepare audio candidate")
        LOGGER.info("audio prepared size=%d suffix=%s", audio_path.stat().st_size, audio_path.suffix)

        suffix = Path(video.filename or "video.mp4").suffix or ".mp4"
        target_key = f"uploads/video/{uuid.uuid4().hex}{suffix}"
        _upload_object(s3, target_path, target_key)

        audio_key = f"uploads/audio/{uuid.uuid4().hex}{audio_path.suffix}"
        _upload_object(s3, audio_path, audio_key)

        payload = PipelineRequest(
            source_keys=[],
            target_key=target_key,
            audio_key=audio_key,
            script_text=script_text.strip() if script_text else None,
            retain_intermediate=True,
        )

        task_id = await job_manager.submit(payload)
        record = await job_manager.get_task(task_id) or {}

        return {
            "task_id": task_id,
            "status": record.get("status"),
            "state": record.get("state"),
            "stage": record.get("stage"),
        }
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Failed to submit generation: {exc}") from exc
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


@APP.get("/billing/status", response_model=BillingStatusResponse)
async def billing_status(
    email: Optional[str] = Query(None, description="User email (required when using X-Secret-Token)"),
    user: Optional[SupabaseUser] = Depends(_optional_auth),
) -> BillingStatusResponse:
    if not (SUPABASE_READY and supabase_store):
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    
    # If authenticated via Supabase, use that user's email
    if user:
        target_email = user.email
        user_id = user.id
    # If using X-Secret-Token, require email parameter
    elif email:
        target_email = _normalize_email(email)
        user_id = None
    else:
        raise HTTPException(status_code=400, detail="Email parameter required when using X-Secret-Token")
    
    record = await supabase_store.ensure_user_record(user_id=user_id, email=target_email)
    tickets = int(record.get("tickets") or 0)
    status = record.get("subscription_status")
    sub_id = record.get("stripe_subscription_id")
    current_end = record.get("current_period_end")
    has_subscription = status in {"active", "trialing", "past_due"}
    return BillingStatusResponse(
        email=target_email,
        tickets=tickets,
        subscription_status=status,
        stripe_customer_id=record.get("stripe_customer_id"),
        stripe_subscription_id=sub_id,
        current_period_end=current_end,
        has_active_subscription=has_subscription,
    )


@APP.post("/billing/checkout", response_model=CheckoutResponse)
async def create_checkout_session(
    payload: CheckoutRequest,
    user: SupabaseUser = Depends(_require_supabase_user),
) -> CheckoutResponse:
    if not _stripe_available():
        raise HTTPException(status_code=503, detail="Stripe checkout is disabled")
    assert supabase_store  # noqa: S101
    assert stripe_client  # noqa: S101
    record = await _ensure_customer_record(user)
    customer_id = await _ensure_stripe_customer(user, record)
    price_id = payload.price_id or STRIPE_PRICE_ID
    if not price_id:
        raise HTTPException(status_code=500, detail="Stripe price id is not configured")
    url = await stripe_client.create_checkout_session(
        customer_id=customer_id,
        price_id=price_id,
        success_url=_default_success_url(payload.success_url),
        cancel_url=_default_cancel_url(payload.cancel_url),
        metadata=_stripe_metadata(user),
    )
    return CheckoutResponse(url=url)


@APP.post("/billing/portal", response_model=CheckoutResponse)
async def create_portal_session(
    payload: PortalRequest,
    user: SupabaseUser = Depends(_require_supabase_user),
) -> CheckoutResponse:
    if not _stripe_available():
        raise HTTPException(status_code=503, detail="Stripe portal is disabled")
    assert stripe_client  # noqa: S101
    record = await _ensure_customer_record(user)
    customer_id = record.get("stripe_customer_id") or await _ensure_stripe_customer(user, record)
    url = await stripe_client.create_portal_session(
        customer_id=customer_id,
        return_url=_portal_return_url(payload.return_url),
    )
    return CheckoutResponse(url=url)


@APP.post("/tickets/consume", response_model=TicketConsumeResponse)
async def consume_ticket(
    payload: TicketConsumeRequest,
    actor: Optional[SupabaseUser] = Depends(_require_ticket_actor),
) -> TicketConsumeResponse:
    if not _tickets_available():
        raise HTTPException(status_code=503, detail="Ticket service is disabled")
    assert supabase_store  # noqa: S101
    email = _normalize_email(actor.email if actor else payload.email)
    record = await supabase_store.ensure_user_record(user_id=actor.id if actor else None, email=email)
    usage = await supabase_store.consume(
        email=email,
        amount=payload.count,
        user_id=record.get("user_id"),
        reason=payload.reason,
        usage_id=None,
        metadata={"source": "gradio"},
    )
    return TicketConsumeResponse(email=email, usage_id=usage.get("usage_id"), balance=int(usage.get("balance", 0)))


@APP.post("/tickets/refund", response_model=TicketConsumeResponse)
async def refund_ticket(
    payload: TicketRefundRequest,
    actor: Optional[SupabaseUser] = Depends(_require_ticket_actor),
) -> TicketConsumeResponse:
    if not _tickets_available():
        raise HTTPException(status_code=503, detail="Ticket service is disabled")
    assert supabase_store  # noqa: S101
    result = await supabase_store.refund(payload.usage_id, payload.reason)
    email = result.get("email") or (actor.email if actor else "")
    balance = int(result.get("balance", 0)) if isinstance(result, dict) else 0
    return TicketConsumeResponse(email=email, usage_id=payload.usage_id, balance=balance)


@APP.post("/billing/webhook")
async def stripe_webhook(
    request: Request,
    stripe_signature: Annotated[Optional[str], Header(alias="Stripe-Signature")] = None,
) -> Dict[str, Any]:
    if not (stripe_client and STRIPE_WEBHOOK_SECRET and supabase_store):
        raise HTTPException(status_code=503, detail="Stripe webhook is not configured")
    body = await request.body()
    event = _parse_stripe_signature(stripe_signature, body)
    event_type = event.get("type")
    event_id = event.get("id") or str(uuid.uuid4())
    payload = event.get("data", {}).get("object", {})
    if event_type == "checkout.session.completed":
        await _handle_checkout_completed(payload, event_id)
    elif event_type in {"customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"}:
        await _handle_subscription_update(event_type, payload, event_id)
    elif event_type == "invoice.payment_succeeded":
        await _handle_invoice_payment_succeeded(payload, event_id)
    else:
        LOGGER.debug("Ignoring Stripe event %s", event_type)
    return {"received": True}


@APP.post("/run", dependencies=[Depends(_require_service_auth)])
async def run_pipeline(
    payload: PipelineRequest,
    wait: bool = Query(False, description="Set true to wait for task completion"),
    timeout: Optional[float] = Query(None, description="Timeout (seconds) while waiting"),
) -> Dict[str, Any]:
    try:
        task_id = await job_manager.submit(payload)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if wait:
        try:
            record = await job_manager.wait_for_completion(task_id, timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise HTTPException(status_code=504, detail="Task timeout") from exc
        return record

    record = await job_manager.get_task(task_id)
    if not record:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"task_id": task_id, "status": record.get("status"), "state": record.get("state"), "stage": record.get("stage")}


@APP.get("/status/{task_id}", dependencies=[Depends(_require_service_auth)])
async def task_status(
    task_id: str,
    wait: bool = Query(False, description="Wait for completion"),
    timeout: Optional[float] = Query(None, description="Timeout while waiting"),
) -> Dict[str, Any]:
    if wait:
        try:
            return await job_manager.wait_for_completion(task_id, timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise HTTPException(status_code=504, detail="Task timeout") from exc

    record = await job_manager.get_task(task_id)
    if not record:
        raise HTTPException(status_code=404, detail="Task not found")
    return record


app = APP


















