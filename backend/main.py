import asyncio
import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
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

# adept_activate 會把 activation.xml 存在這裡（必須用 volume 持久化）
ACTIVATION_DIR = Path.home() / ".config" / "adept"


ACTIVATION_ATTEMPTS = 5
ACTIVATION_TIMEOUT = 45   # 每次嘗試的秒數上限；adept_activate 偶爾會空轉並吃光記憶體
ACTIVATION_BACKOFF = 5    # 兩次嘗試之間的間隔秒數
# "unknown"（尚未開始）| "pending" | "ok" | "failed" | "unavailable"（未安裝 libgourou）
activation_state = "unknown"


OUTPUT_CAP = 256 * 1024  # 願意保留的工具輸出位元組數


def run_capped(cmd: list[str], timeout: float, stdin_text: str = "") -> subprocess.CompletedProcess:
    """subprocess.run that never buffers unbounded output in RAM.

    stdout/stderr go to size-limited temp files (RLIMIT_FSIZE), and only the tail is kept.
    A runaway tool (adept_activate can loop printing forever) is killed by SIGXFSZ/timeout.
    """
    def limit():
        try:
            import resource
            resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_CAP, OUTPUT_CAP))
        except Exception:
            pass
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err_f, tempfile.TemporaryFile() as inp:
        inp.write(stdin_text.encode()); inp.seek(0)
        r = subprocess.run(cmd, stdin=inp, stdout=out, stderr=err_f, timeout=timeout, preexec_fn=limit)
        def tail(f):
            f.seek(0, 2)
            f.seek(max(f.tell() - 2000, 0))
            return f.read().decode("utf-8", "replace")
        return subprocess.CompletedProcess(cmd, r.returncode, tail(out), tail(err_f))


def ensure_adobe_activation(attempts: int | None = None, timeout: float | None = None,
                            backoff: float | None = None) -> bool:
    """Create an anonymous Adobe device activation once; no-op if already present.

    adept_activate occasionally hangs and balloons in memory, so each attempt is
    time-boxed and retried.
    """
    global activation_state
    attempts = ACTIVATION_ATTEMPTS if attempts is None else attempts
    timeout = ACTIVATION_TIMEOUT if timeout is None else timeout
    backoff = ACTIVATION_BACKOFF if backoff is None else backoff
    if (ACTIVATION_DIR / "activation.xml").exists():
        logger.info("Adobe activation already present.")
        activation_state = "ok"
        return True
    for n in range(1, attempts + 1):
        try:
            # adept_activate 會問「目錄已存在，要覆寫嗎？[y/N]」，沒有回答就會無限重問。
            # 只有在 activation.xml 不存在時才會走到這裡，
            # 所以回答 "y" 不會覆寫到真正的身分。
            r = run_capped(["adept_activate", "--anonymous"], timeout, stdin_text="y\n")
        except FileNotFoundError:
            logger.warning("adept_activate not found; skipping activation (libgourou not installed).")
            activation_state = "unavailable"
            return False
        except subprocess.TimeoutExpired:
            logger.error("Adobe activation attempt %d/%d timed out after %ss.", n, attempts, timeout)
        else:
            if r.returncode == 0:
                logger.info("Adobe anonymous activation successful (attempt %d).", n)
                activation_state = "ok"
                return True
            logger.error("Adobe activation attempt %d/%d failed (rc=%s): %s", n, attempts,
                         r.returncode, (r.stderr or r.stdout).strip()[-500:])
        if n < attempts:
            time.sleep(backoff)
    activation_state = "failed"
    return False


@asynccontextmanager
async def lifespan(_: FastAPI):
    global activation_state
    activation_state = "pending"
    # 在工作執行緒中執行，這樣 Adobe 註冊期間 API（含 /health）仍可使用。
    task = asyncio.create_task(asyncio.to_thread(ensure_adobe_activation))
    yield
    task.cancel()


# ===========================================================================
# 前後端對接總覽（前端 Nuxt :3000 ⇄ 後端 FastAPI :8000，皆由瀏覽器直接呼叫）
#
#   端點                          前端呼叫處                          用途
#   GET  /health                  （手動/容器健康檢查）               存活檢查
#   GET  /api/v1/acsm/status      （除錯用）                          Adobe 裝置註冊狀態
#   POST /api/v1/acsm/fulfill     composables/useLibrary.ts           .acsm 兌換→解密→回傳 EPUB/PDF
#   GET  /api/v1/tts/config       composables/useSpeechReader.ts      問 TTS provider（edge/http）
#   POST /api/v1/tts              engines/cloud.ts                    文字→語音 mp3
#
# 共通約定：
#   - 錯誤一律 HTTP 4xx/5xx，body 為 {"detail":{"code":"ERR_xxx","message":"..."}}（見 err()）
#   - 瀏覽器跨網域（:3000 → :8000）靠下方 CORS 中介層放行；
#     自訂回應標頭 X-Book-Title 等需列在 expose_headers，前端才讀得到
#   - 前端的後端位址來自 nuxt.config.ts 的 runtimeConfig.public.acsmApiBase
# ===========================================================================
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
    """統一的錯誤格式：前端 useLibrary.fulfillAcsm 會讀 detail.code / detail.message 並顯示。"""
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


@app.get("/api/v1/acsm/status")
def acsm_status():
    return {"activation": activation_state}


@app.post("/api/v1/acsm/fulfill")
async def fulfill_acsm(
    # 前端以 FormData 的 "file" 欄位上傳 .acsm（見 useLibrary.fulfillAcsm）。
    # adobe_id / adobe_password 為預留欄位，目前前端未使用（匿名裝置註冊）。
    file: UploadFile = File(...),
    adobe_id: str | None = Form(None),
    adobe_password: str | None = Form(None),
):
    if not (file.filename or "").lower().endswith(".acsm"):
        raise err(400, "ERR_ACSM_MALFORMED", "Invalid file type. Only .acsm files are accepted.")

    # 容器剛啟動時 Adobe 裝置註冊在背景執行（見 lifespan），尚未完成就先擋下，讓前端稍後重試
    if activation_state == "pending":
        raise err(503, "ERR_ACTIVATION_PENDING", "Adobe device registration is still in progress; retry in a minute.")
    if activation_state == "failed":
        raise err(503, "ERR_ACTIVATION_FAILED", "Adobe device registration failed; restart the backend to retry.")

    # 每次請求用獨立暫存目錄（uuid），避免並行請求互相覆蓋；
    # 成功時待回應送完由 BackgroundTask 清掉，失敗時於下方 except 清掉。
    work_dir = STORAGE_BASE / str(uuid.uuid4())
    work_dir.mkdir(parents=True)
    cleanup = BackgroundTask(shutil.rmtree, work_dir, ignore_errors=True)

    try:
        acsm_path = work_dir / "input.acsm"
        with acsm_path.open("wb") as buf:
            shutil.copyfileobj(file.file, buf)
        meta = parse_acsm(acsm_path)  # 步驟 1：驗證 XML 並取出書名/作者

        # 步驟 2：acsmdownloader 向 Adobe 兌換授權並下載加密書（授權綁定第一次兌換的裝置身分）
        encrypted = work_dir / "encrypted.bin"
        dl = run_tool(["acsmdownloader", "-f", str(acsm_path), "-o", str(encrypted)])
        if dl.returncode != 0:
            logger.error("acsmdownloader failed: %s", dl.stderr)
            raise classify_failure(dl.stderr or dl.stdout)

        # libgourou 可能會自行加上真正的副檔名，所以要找出實際產生的檔案
        produced = next((p for p in work_dir.iterdir()
                         if p.name.startswith("encrypted") ), None)
        if produced is None:
            raise err(500, "ERR_NO_OUTPUT", "No file produced by fulfillment.")
        ext = ".pdf" if produced.read_bytes()[:4] == b"%PDF" else ".epub"
        decrypted = work_dir / f"book{ext}"

        # 步驟 3：adept_remove 用本機裝置金鑰（~/.config/adept）解密
        rm = run_tool(["adept_remove", "-f", str(produced), "-o", str(decrypted)])
        if rm.returncode != 0 or not decrypted.exists():
            logger.error("adept_remove failed: %s", rm.stderr)
            raise err(500, "ERR_DECRYPT_FAILED", "DRM decryption failed.")

        # 步驟 4：書名/作者經 URL 編碼放進標頭（HTTP 標頭不能直接放中文），前端用 decodeURIComponent 還原；
        # 檔案本體作為回應內容，Content-Type 讓前端分辨 PDF / EPUB
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
# 雲端 TTS 代理：把服務商的 API 金鑰留在伺服器端，並避開 CORS。
# 以環境變數設定：TTS_UPSTREAM_URL、TTS_API_KEY、TTS_BODY_TEMPLATE、
# TTS_EXTRA_HEADERS（JSON）、TTS_DEFAULT_VOICE
# ---------------------------------------------------------------------------
TTS_MAX_CHARS = 1000
DEFAULT_TTS_TEMPLATE = '{"input":{{text}},"voice":{{voice}}}'


EDGE_DEFAULT_VOICE = "zh-TW-HsiaoChenNeural"


def tts_provider() -> str:
    """"edge" (free Edge neural voices, no key) or "http" (forward to TTS_UPSTREAM_URL)."""
    p = os.getenv("TTS_PROVIDER", "edge").strip().lower()
    return p if p in ("edge", "http") else "edge"


def edge_rate(rate: float) -> str:
    """1.0 -> "+0%", 1.2 -> "+20%", 0.8 -> "-20%"."""
    return f"{round((rate - 1) * 100):+d}%"


def edge_pitch(pitch_pct: float) -> str:
    """edge-tts only accepts Hz; ~2 Hz per 1% around a typical ~200 Hz speaking pitch."""
    return f"{round(pitch_pct * 2):+d}Hz"


EDGE_ATTEMPTS = 3


def is_speakable(text: str) -> bool:
    """True if the text has at least one letter or digit (punctuation-only text yields no audio)."""
    import unicodedata
    return any(unicodedata.category(c)[0] in "LN" for c in text)


async def edge_synthesize(text: str, voice: str, rate: float, pitch_pct: float) -> bytes:
    """Synthesize via edge-tts. The service sporadically returns no audio, so retry a few times."""
    import edge_tts  # 延遲匯入，這樣只用 http 模式的部署不需要安裝它
    last: Exception | None = None
    for attempt in range(EDGE_ATTEMPTS):
        comm = edge_tts.Communicate(text, voice or EDGE_DEFAULT_VOICE,
                                    rate=edge_rate(rate), pitch=edge_pitch(pitch_pct))
        audio = bytearray()
        try:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    audio += chunk["data"]
        except ValueError:
            raise  # 參數錯誤：重試也沒用
        except Exception as e:  # NoAudioReceived、連線被重設等
            last = e
            logger.warning("edge-tts attempt %d/%d failed: %s", attempt + 1, EDGE_ATTEMPTS, type(e).__name__)
            await asyncio.sleep(0.3 * (attempt + 1))
            continue
        if audio:
            return bytes(audio)
    raise last or RuntimeError("edge-tts returned no audio")


def tts_settings() -> dict:
    return {
        "url": os.getenv("TTS_UPSTREAM_URL", ""),
        "key": os.getenv("TTS_API_KEY", ""),
        "template": os.getenv("TTS_BODY_TEMPLATE", DEFAULT_TTS_TEMPLATE),
        "headers": os.getenv("TTS_EXTRA_HEADERS", ""),
        "voice": os.getenv("TTS_DEFAULT_VOICE", ""),
    }


def render_body(template: str, text: str, voice: str, rate: float, pitch: float = 0.0) -> str:
    """Replace placeholders with JSON-encoded values (single pass, no $-pattern issues)."""
    import re
    vals = {"text": json.dumps(text), "voice": json.dumps(voice), "rate": str(rate), "pitch": str(pitch)}
    return re.sub(r"\{\{\s*(text|voice|rate|pitch)\s*\}\}", lambda m: vals[m.group(1)], template)


def make_tts_client() -> httpx.AsyncClient:  # 測試時可覆寫
    return httpx.AsyncClient(timeout=30)


class TtsRequest(BaseModel):
    text: str = Field(min_length=1)
    voice: str = ""
    rate: float = Field(1.0, ge=0.25, le=4.0)
    pitch: float = Field(0.0, ge=-50.0, le=50.0)  # 變化百分比，0 = 不變


@app.get("/api/v1/tts/config")
def tts_config():
    # 前端啟動時呼叫一次：provider == "edge" 代表語速/音調由伺服器合成時處理，
    # 前端播放時就不再用 playbackRate 加速（見 useSpeechReader / cloud.ts 的 serverProsody）
    provider = tts_provider()
    return {"enabled": provider == "edge" or bool(tts_settings()["url"]), "provider": provider}


@app.post("/api/v1/tts")
async def tts_proxy(req: TtsRequest):
    # 請求 body（JSON）由前端 CloudEngine 組出：{"text","voice","rate","pitch"}，經 TtsRequest 驗證。
    # 成功回傳 audio/mpeg 二進位；前端以 blob 播放。
    # 兩種 provider：
    #   edge：直接用 edge-tts 合成（免金鑰），標點符號-only 的文字回 400（前端也會先略過）
    #   http：把請求依範本轉發給 TTS_UPSTREAM_URL，金鑰只存在伺服器環境變數
    cfg = tts_settings()
    if len(req.text) > TTS_MAX_CHARS:
        raise err(413, "ERR_TTS_TEXT_TOO_LONG", f"Text exceeds {TTS_MAX_CHARS} characters.")
    if tts_provider() == "edge":
        if not is_speakable(req.text):
            raise err(400, "ERR_TTS_NO_SPEECH", "Text has no speakable characters (punctuation only).")
        try:
            audio = await edge_synthesize(req.text, req.voice or cfg["voice"], req.rate, req.pitch)
        except ValueError as e:  # 語音/語速/音調字串不合法
            raise err(400, "ERR_TTS_BAD_PARAMS", str(e))
        except Exception as e:
            logger.error("edge-tts failed: %s", e)
            raise err(502, "ERR_TTS_UPSTREAM", f"Edge TTS failed: {type(e).__name__}")
        if not audio:
            raise err(502, "ERR_TTS_UPSTREAM", "Edge TTS returned no audio.")
        return Response(audio, media_type="audio/mpeg")
    if not cfg["url"]:
        raise err(503, "ERR_TTS_NOT_CONFIGURED", "TTS_UPSTREAM_URL is not set on the server.")

    headers = {"Content-Type": "application/json"}
    if cfg["key"]:
        headers["Authorization"] = f"Bearer {cfg['key']}"
    try:
        if cfg["headers"].strip():
            headers.update(json.loads(cfg["headers"]))
    except (ValueError, TypeError):
        raise err(500, "ERR_TTS_MISCONFIGURED", "TTS_EXTRA_HEADERS is not valid JSON.")

    body = render_body(cfg["template"], req.text, req.voice or cfg["voice"], req.rate, req.pitch)
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
