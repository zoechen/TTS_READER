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
    assert main.ensure_adobe_activation() is False  # adept_activate absent locally

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
    monkeypatch.delenv("TTS_UPSTREAM_URL", raising=False)
    assert client.get("/api/v1/tts/config").json() == {"enabled": False}
    r = client.post("/api/v1/tts", json={"text": "hi"})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "ERR_TTS_NOT_CONFIGURED"

def test_tts_proxies_with_server_side_key(monkeypatch):
    import main
    monkeypatch.setenv("TTS_UPSTREAM_URL", "https://up.example/tts")
    monkeypatch.setenv("TTS_API_KEY", "secret")
    monkeypatch.setenv("TTS_DEFAULT_VOICE", "alloy")
    seen = {}
    def handler(req: httpx.Request):
        seen["auth"] = req.headers["authorization"]; seen["body"] = _json.loads(req.content)
        return httpx.Response(200, content=b"AUDIO", headers={"content-type": "audio/mpeg"})
    monkeypatch.setattr(main, "make_tts_client", _mock_client(handler))
    assert client.get("/api/v1/tts/config").json() == {"enabled": True}
    r = client.post("/api/v1/tts", json={"text": 'say "hi"', "rate": 1.2})
    assert r.status_code == 200 and r.content == b"AUDIO" and r.headers["content-type"] == "audio/mpeg"
    assert seen["auth"] == "Bearer secret"
    assert seen["body"] == {"input": 'say "hi"', "voice": "alloy"}

def test_tts_upstream_failure_and_limits(monkeypatch):
    import main
    monkeypatch.setenv("TTS_UPSTREAM_URL", "https://up.example/tts")
    monkeypatch.setattr(main, "make_tts_client", _mock_client(lambda r: httpx.Response(401)))
    r = client.post("/api/v1/tts", json={"text": "hi"})
    assert r.status_code == 502 and r.json()["detail"]["code"] == "ERR_TTS_UPSTREAM"
    assert client.post("/api/v1/tts", json={"text": "x" * 1001}).status_code == 413
    assert client.post("/api/v1/tts", json={"text": ""}).status_code == 422
