import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)
VALID = b'''<?xml version="1.0"?><fulfillmentToken xmlns="http://ns.adobe.com/adept">
<resourceItemInfo><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata></resourceItemInfo>
<operatorURL>https://x.example/op</operatorURL></fulfillmentToken>'''

def post(name, data):
    return client.post("/api/v1/acsm/fulfill", files={"file": (name, data)})

def test_health():
    assert client.get("/health").json() == {"status": "ok", "version": "1.0.0"}

def test_wrong_extension():
    r = post("a.txt", b"x")
    assert r.status_code == 400 and r.json()["detail"]["code"] == "ERR_ACSM_MALFORMED"

def test_malformed_xml():
    assert post("a.acsm", b"not xml").status_code == 400

def test_wrong_root():
    assert post("a.acsm", b"<foo/>").status_code == 400

def test_valid_reaches_tool(monkeypatch):
    import main
    monkeypatch.setattr(main, "run_tool", lambda cmd: (_ for _ in ()).throw(main.err(502, "ERR_UPSTREAM_TIMEOUT", "t")))
    r = post("a.acsm", VALID)
    assert r.status_code == 502 and r.json()["detail"]["code"] == "ERR_UPSTREAM_TIMEOUT"

def test_activation_skipped_when_tool_missing(monkeypatch, tmp_path):
    import main
    monkeypatch.setattr(main, "ACTIVATION_DIR", tmp_path)
    assert main.ensure_adobe_activation() is False  # 本機沒有 adept_activate

def test_activation_noop_when_present(monkeypatch, tmp_path):
    import main
    (tmp_path / "activation.xml").write_text("x")
    monkeypatch.setattr(main, "ACTIVATION_DIR", tmp_path)
    assert main.ensure_adobe_activation() is True

def test_startup_runs_with_lifespan():
    with TestClient(app) as c:
        assert c.get("/health").status_code == 200


# --- TTS proxy -------------------------------------------------------------
import httpx, json as _json

def _mock_client(handler):
    return lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))

def test_tts_not_configured(monkeypatch):
    monkeypatch.setenv("TTS_PROVIDER", "http")
    monkeypatch.delenv("TTS_UPSTREAM_URL", raising=False)
    assert client.get("/api/v1/tts/config").json() == {"enabled": False, "provider": "http"}
    r = client.post("/api/v1/tts", json={"text": "hi"})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "ERR_TTS_NOT_CONFIGURED"

def test_tts_proxies_with_server_side_key(monkeypatch):
    import main
    monkeypatch.setenv("TTS_PROVIDER", "http")
    monkeypatch.setenv("TTS_UPSTREAM_URL", "https://up.example/tts")
    monkeypatch.setenv("TTS_API_KEY", "secret")
    monkeypatch.setenv("TTS_DEFAULT_VOICE", "alloy")
    seen = {}
    def handler(req: httpx.Request):
        seen["auth"] = req.headers["authorization"]; seen["body"] = _json.loads(req.content)
        return httpx.Response(200, content=b"AUDIO", headers={"content-type": "audio/mpeg"})
    monkeypatch.setattr(main, "make_tts_client", _mock_client(handler))
    assert client.get("/api/v1/tts/config").json() == {"enabled": True, "provider": "http"}
    r = client.post("/api/v1/tts", json={"text": 'say "hi"', "rate": 1.2})
    assert r.status_code == 200 and r.content == b"AUDIO" and r.headers["content-type"] == "audio/mpeg"
    assert seen["auth"] == "Bearer secret"
    assert seen["body"] == {"input": 'say "hi"', "voice": "alloy"}

def test_tts_upstream_failure_and_limits(monkeypatch):
    import main
    monkeypatch.setenv("TTS_PROVIDER", "http")
    monkeypatch.setenv("TTS_UPSTREAM_URL", "https://up.example/tts")
    monkeypatch.setattr(main, "make_tts_client", _mock_client(lambda r: httpx.Response(401)))
    r = client.post("/api/v1/tts", json={"text": "hi"})
    assert r.status_code == 502 and r.json()["detail"]["code"] == "ERR_TTS_UPSTREAM"
    assert client.post("/api/v1/tts", json={"text": "x" * 1001}).status_code == 413
    assert client.post("/api/v1/tts", json={"text": ""}).status_code == 422


def test_activation_retries_then_succeeds(monkeypatch, tmp_path):
    import main, subprocess
    monkeypatch.setattr(main, "ACTIVATION_DIR", tmp_path)
    calls = []
    def fake_run(cmd, **kw):
        calls.append(1)
        if len(calls) < 3:
            raise subprocess.TimeoutExpired(cmd, kw["timeout"])
        return subprocess.CompletedProcess(cmd, 0, "", "")
    monkeypatch.setattr(main.subprocess, "run", fake_run)
    assert main.ensure_adobe_activation(attempts=5, timeout=1, backoff=0) is True
    assert len(calls) == 3 and main.activation_state == "ok"

def test_activation_gives_up_after_all_attempts(monkeypatch, tmp_path):
    import main, subprocess
    monkeypatch.setattr(main, "ACTIVATION_DIR", tmp_path)
    monkeypatch.setattr(main.subprocess, "run", lambda cmd, **kw: (_ for _ in ()).throw(subprocess.TimeoutExpired(cmd, 1)))
    assert main.ensure_adobe_activation(attempts=2, timeout=1, backoff=0) is False
    assert main.activation_state == "failed"

def test_fulfill_rejected_while_activation_pending(monkeypatch):
    import main
    monkeypatch.setattr(main, "activation_state", "pending")
    r = post("a.acsm", VALID)
    assert r.status_code == 503 and r.json()["detail"]["code"] == "ERR_ACTIVATION_PENDING"


def test_run_capped_keeps_only_a_tail_of_runaway_output():
    import main, sys
    r = main.run_capped([sys.executable, "-c", "import sys\nwhile True: sys.stdout.write('x'*1000)"], timeout=10)
    assert r.returncode != 0 and len(r.stdout) <= 2000


def test_run_capped_feeds_stdin():
    import main, sys
    r = main.run_capped([sys.executable, "-c", "import sys;print('got', sys.stdin.read().strip())"], timeout=10, stdin_text="y\n")
    assert r.returncode == 0 and "got y" in r.stdout


def test_edge_param_conversion():
    import main
    assert main.edge_rate(1.0) == "+0%" and main.edge_rate(1.2) == "+20%" and main.edge_rate(0.8) == "-20%"
    assert main.edge_pitch(0) == "+0Hz" and main.edge_pitch(8) == "+16Hz" and main.edge_pitch(-5) == "-10Hz"

def test_tts_edge_provider(monkeypatch):
    import main
    monkeypatch.delenv("TTS_PROVIDER", raising=False)  # edge 為預設值
    seen = {}
    async def fake(text, voice, rate, pitch):
        seen.update(text=text, voice=voice, rate=rate, pitch=pitch); return b"MP3DATA"
    monkeypatch.setattr(main, "edge_synthesize", fake)
    assert client.get("/api/v1/tts/config").json() == {"enabled": True, "provider": "edge"}
    r = client.post("/api/v1/tts", json={"text": "你真的要走嗎？", "voice": "zh-TW-YunJheNeural", "rate": 1.1, "pitch": 8})
    assert r.status_code == 200 and r.content == b"MP3DATA" and r.headers["content-type"] == "audio/mpeg"
    assert seen == {"text": "你真的要走嗎？", "voice": "zh-TW-YunJheNeural", "rate": 1.1, "pitch": 8}

def test_tts_edge_failure_is_502(monkeypatch):
    import main
    monkeypatch.delenv("TTS_PROVIDER", raising=False)
    async def boom(*a): raise RuntimeError("no network")
    monkeypatch.setattr(main, "edge_synthesize", boom)
    r = client.post("/api/v1/tts", json={"text": "hi"})
    assert r.status_code == 502 and r.json()["detail"]["code"] == "ERR_TTS_UPSTREAM"

def test_render_body_pitch():
    import main, json
    assert json.loads(main.render_body('{"p":{{pitch}},"r":{{rate}}}', "x", "v", 1.1, 8)) == {"p": 8.0, "r": 1.1}


def test_edge_synthesize_retries_transient_failures(monkeypatch):
    import main, asyncio, sys, types
    calls = {"n": 0}
    class Comm:
        def __init__(self, *a, **k): pass
        async def stream(self):
            calls["n"] += 1
            if calls["n"] < 3:
                raise RuntimeError("NoAudioReceived")
            yield {"type": "audio", "data": b"OK"}
    fake = types.SimpleNamespace(Communicate=Comm)
    monkeypatch.setitem(sys.modules, "edge_tts", fake)
    real_sleep = asyncio.sleep
    async def fast_sleep(_): await real_sleep(0)
    monkeypatch.setattr(main.asyncio, "sleep", fast_sleep)
    assert asyncio.run(main.edge_synthesize("hi", "", 1.0, 0)) == b"OK" and calls["n"] == 3


def test_tts_edge_rejects_punctuation_only(monkeypatch):
    import main
    monkeypatch.delenv("TTS_PROVIDER", raising=False)
    async def never(*a): raise AssertionError("must not call edge")
    monkeypatch.setattr(main, "edge_synthesize", never)
    for t in ["……", "「」", "———", "。"]:
        r = client.post("/api/v1/tts", json={"text": t})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "ERR_TTS_NO_SPEECH"
    assert main.is_speakable("第2章") and main.is_speakable("Hi.") and not main.is_speakable("…")
