import json
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote

from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("acsm-service")

ACTIVATION_DIR = Path.home() / ".config" / "libgourou"


def ensure_adobe_activation() -> bool:
    """Create an anonymous Adobe device activation once; no-op if already present."""
    if (ACTIVATION_DIR / "activation.xml").exists():
        logger.info("Adobe activation already present.")
        return True
    try:
        r = subprocess.run(["adept_activate", "--anonymous"], capture_output=True,
                           text=True, timeout=TOOL_TIMEOUT)
    except FileNotFoundError:
        logger.warning("adept_activate not found; skipping activation (libgourou not installed).")
        return False
    except subprocess.TimeoutExpired:
        logger.error("Adobe activation timed out.")
        return False
    if r.returncode != 0:
        logger.error("Adobe activation failed: %s", (r.stderr or r.stdout).strip())
        return False
    logger.info("Adobe anonymous activation successful.")
    return True


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_adobe_activation()
    yield


app = FastAPI(title="ACSM Fulfillment Service", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Book-Title", "X-Book-Author", "Content-Disposition"],
)

STORAGE_BASE = Path(tempfile.gettempdir()) / "acsm_work"
STORAGE_BASE.mkdir(parents=True, exist_ok=True)
TOOL_TIMEOUT = 120

ADEPT_NS = "{http://ns.adobe.com/adept}"


def err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def parse_acsm(path: Path) -> dict:
    """Validate Adept fulfillmentToken XML and extract metadata."""
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError:
        raise err(400, "ERR_ACSM_MALFORMED", "ACSM is not valid XML.")
    if root.tag != f"{ADEPT_NS}fulfillmentToken":
        raise err(400, "ERR_ACSM_MALFORMED", "Not an Adobe Adept fulfillmentToken.")

    def find(tag: str):
        el = root.find(f".//{ADEPT_NS}{tag}")
        return el.text.strip() if el is not None and el.text else None

    operator = find("operatorURL")
    if not operator or root.find(f".//{ADEPT_NS}resourceItemInfo") is None:
        raise err(400, "ERR_ACSM_MALFORMED", "Missing operatorURL or resourceItem.")

    title = author = None
    for el in root.iter():
        name = el.tag.split("}")[-1]
        if name == "title" and el.text and not title:
            title = el.text.strip()
        elif name == "creator" and el.text and not author:
            author = el.text.strip()
    return {"operator": operator, "title": title, "author": author}


def run_tool(cmd: list[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=TOOL_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise err(502, "ERR_UPSTREAM_TIMEOUT", "Adobe server timed out.")
    except FileNotFoundError:
        raise err(500, "ERR_TOOL_MISSING", f"{cmd[0]} is not installed.")


def classify_failure(stderr: str) -> HTTPException:
    low = stderr.lower()
    if "expired" in low:
        return err(410, "ERR_TOKEN_EXPIRED", "Fulfillment token expired.")
    if "auth" in low or "e_adept_" in low or "login" in low:
        return err(401, "ERR_ADOBE_AUTH_FAILED", "Adobe authentication failed.")
    return err(502, "ERR_UPSTREAM_TIMEOUT", f"Adobe fulfillment failed: {stderr.strip()[:300]}")


@app.get("/health")
def health_check():
    return {"status": "ok", "version": "1.0.0"}


@app.post("/api/v1/acsm/fulfill")
async def fulfill_acsm(
    file: UploadFile = File(...),
    adobe_id: str | None = Form(None),
    adobe_password: str | None = Form(None),
):
    if not (file.filename or "").lower().endswith(".acsm"):
        raise err(400, "ERR_ACSM_MALFORMED", "Invalid file type. Only .acsm files are accepted.")

    work_dir = STORAGE_BASE / str(uuid.uuid4())
    work_dir.mkdir(parents=True)
    cleanup = BackgroundTask(shutil.rmtree, work_dir, ignore_errors=True)

    try:
        acsm_path = work_dir / "input.acsm"
        with acsm_path.open("wb") as buf:
            shutil.copyfileobj(file.file, buf)
        meta = parse_acsm(acsm_path)

        encrypted = work_dir / "encrypted.bin"
        dl = run_tool(["acsmdownloader", "-f", str(acsm_path), "-o", str(encrypted)])
        if dl.returncode != 0:
            logger.error("acsmdownloader failed: %s", dl.stderr)
            raise classify_failure(dl.stderr or dl.stdout)

        # libgourou may append the real extension; locate the output
        produced = next((p for p in work_dir.iterdir()
                         if p.name.startswith("encrypted") ), None)
        if produced is None:
            raise err(500, "ERR_NO_OUTPUT", "No file produced by fulfillment.")
        ext = ".pdf" if produced.read_bytes()[:4] == b"%PDF" else ".epub"
        decrypted = work_dir / f"book{ext}"

        rm = run_tool(["adept_remove", "-f", str(produced), "-o", str(decrypted)])
        if rm.returncode != 0 or not decrypted.exists():
            logger.error("adept_remove failed: %s", rm.stderr)
            raise err(500, "ERR_DECRYPT_FAILED", "DRM decryption failed.")

        title = meta["title"] or Path(file.filename).stem
        headers = {"X-Book-Title": quote(title)}
        if meta["author"]:
            headers["X-Book-Author"] = quote(meta["author"])
        media = "application/pdf" if ext == ".pdf" else "application/epub+zip"
        return FileResponse(decrypted, media_type=media, headers=headers,
                            filename=f"{quote(title)}{ext}", background=cleanup)
    except BaseException:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise


# ---------------------------------------------------------------------------
# Cloud TTS proxy: keeps the provider API key server-side and avoids CORS.
# Configure via env: TTS_UPSTREAM_URL, TTS_API_KEY, TTS_BODY_TEMPLATE,
# TTS_EXTRA_HEADERS (JSON), TTS_DEFAULT_VOICE
# ---------------------------------------------------------------------------
TTS_MAX_CHARS = 1000
DEFAULT_TTS_TEMPLATE = '{"input":{{text}},"voice":{{voice}}}'


def tts_settings() -> dict:
    return {
        "url": os.getenv("TTS_UPSTREAM_URL", ""),
        "key": os.getenv("TTS_API_KEY", ""),
        "template": os.getenv("TTS_BODY_TEMPLATE", DEFAULT_TTS_TEMPLATE),
        "headers": os.getenv("TTS_EXTRA_HEADERS", ""),
        "voice": os.getenv("TTS_DEFAULT_VOICE", ""),
    }


def render_body(template: str, text: str, voice: str, rate: float) -> str:
    """Replace placeholders with JSON-encoded values (single pass, no $-pattern issues)."""
    import re
    vals = {"text": json.dumps(text), "voice": json.dumps(voice), "rate": str(rate)}
    return re.sub(r"\{\{\s*(text|voice|rate)\s*\}\}", lambda m: vals[m.group(1)], template)


def make_tts_client() -> httpx.AsyncClient:  # overridable in tests
    return httpx.AsyncClient(timeout=30)


class TtsRequest(BaseModel):
    text: str = Field(min_length=1)
    voice: str = ""
    rate: float = Field(1.0, ge=0.25, le=4.0)


@app.get("/api/v1/tts/config")
def tts_config():
    return {"enabled": bool(tts_settings()["url"])}


@app.post("/api/v1/tts")
async def tts_proxy(req: TtsRequest):
    cfg = tts_settings()
    if not cfg["url"]:
        raise err(503, "ERR_TTS_NOT_CONFIGURED", "TTS_UPSTREAM_URL is not set on the server.")
    if len(req.text) > TTS_MAX_CHARS:
        raise err(413, "ERR_TTS_TEXT_TOO_LONG", f"Text exceeds {TTS_MAX_CHARS} characters.")

    headers = {"Content-Type": "application/json"}
    if cfg["key"]:
        headers["Authorization"] = f"Bearer {cfg['key']}"
    try:
        if cfg["headers"].strip():
            headers.update(json.loads(cfg["headers"]))
    except (ValueError, TypeError):
        raise err(500, "ERR_TTS_MISCONFIGURED", "TTS_EXTRA_HEADERS is not valid JSON.")

    body = render_body(cfg["template"], req.text, req.voice or cfg["voice"], req.rate)
    try:
        async with make_tts_client() as client:
            up = await client.post(cfg["url"], content=body, headers=headers)
    except httpx.TimeoutException:
        raise err(502, "ERR_UPSTREAM_TIMEOUT", "TTS provider timed out.")
    except httpx.HTTPError as e:
        raise err(502, "ERR_TTS_UPSTREAM", f"TTS provider unreachable: {type(e).__name__}")

    if up.status_code != 200 or not up.content:
        logger.error("TTS upstream %s: %s", up.status_code, up.text[:200])
        raise err(502, "ERR_TTS_UPSTREAM", f"TTS provider returned HTTP {up.status_code}.")
    return Response(up.content, media_type=up.headers.get("content-type", "audio/mpeg"))
