#!/usr/bin/env python
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10", "requests>=2.31"]
# ///
"""
fetch-images.py 的行為探針 — 由 tests/fetch-images.test.mjs 以子行程驅動

    uv run --locked --script tests/fetch_images_probe.py [--keep <dir>]

〔TG-2〕D10 的增量判定有一半在 Python 端（`needs_fetch()` 與 `process()` 的路由），
        原本完全沒有自動測試：把 predicate 反寫、或讓缺檔仍走早退，都不會有東西轉紅。
〔TG-3〕`verify_asset()` 原本只有「原始碼裡有沒有出現 Image.open(dest).load()」的
        靜態斷言——`if False:` 與 `except: return` 兩種寫法都能通過。
        真正的證據只有一種：**餵一張容器合法但位元流損毀的 WebP，看它會不會拋。**

每通過一項印一行 `OK <case>`；任一 assert 失敗即非零退出並帶 traceback。
不觸網（download 由探針換掉）、不寫 repo（ROOT 指向暫存目錄）。
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import struct
import sys
import tempfile
from pathlib import Path

from PIL import Image, UnidentifiedImageError

REPO = Path(__file__).resolve().parent.parent


def load_tool():
    """以模組載入 tools/fetch-images.py（檔名帶連字號，不能直接 import）"""
    spec = importlib.util.spec_from_file_location(
        "fetch_images_under_test", REPO / "tools" / "fetch-images.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cases: list[str] = []


def ok(name: str) -> None:
    cases.append(name)
    print(f"OK {name}", flush=True)


# ── 素材 ──────────────────────────────────────────────────────────────

def make_webp(size=(64, 48), color=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "WEBP", quality=80, method=0)
    return buf.getvalue()


def corrupt_webp(raw: bytes) -> bytes:
    """
    截掉位元流尾段，並把 RIFF／chunk 長度改成與新長度自洽。

    產出的檔案**容器結構完全合法**——RIFF 長度對得上、chunk header 正確、
    VP8 sync code 與尺寸都讀得出來，所以 verify-data.mjs 的 readWebp() 會放行。
    壞掉的是壓縮位元流本身，只有真的解碼才看得見。這正是 CR-2 的分工邊界。
    """
    chunk_size = struct.unpack_from("<I", raw, 16)[0]
    cut = chunk_size // 2
    new_chunk = chunk_size - cut
    out = bytearray(raw[: len(raw) - cut])
    struct.pack_into("<I", out, 4, len(out) - 8)      # RIFF size
    struct.pack_into("<I", out, 16, new_chunk)        # chunk size
    return bytes(out)


def assert_container_looks_valid(raw: bytes) -> None:
    """比照 verify-data.mjs 的 readWebp()：只讀容器，不碰位元流"""
    assert raw[0:4] == b"RIFF", "非 RIFF"
    assert raw[8:12] == b"WEBP", "非 WEBP"
    assert struct.unpack_from("<I", raw, 4)[0] + 8 == len(raw), "RIFF 長度與實際不符"
    assert raw[12:16] == b"VP8 ", f"chunk 不是 VP8：{raw[12:16]!r}"
    assert raw[23:26] == b"\x9d\x01\x2a", "VP8 sync code 不對"


# ── TG-2 增量判定 ─────────────────────────────────────────────────────

def test_needs_fetch(mod, root: Path) -> None:
    mod.ROOT = root
    img_dir = root / "data" / "img"
    img_dir.mkdir(parents=True, exist_ok=True)
    (img_dir / "present.webp").write_bytes(make_webp())
    H = "a" * 64

    present = {"id": "P", "img": "img/present.webp", "src_sha256": H}
    absent = {"id": "A", "img": "img/absent.webp", "src_sha256": H}

    assert mod.needs_fetch(present) is False, "檔在且雜湊合法卻仍重抓 → 增量判定形同未實作"
    ok("needs_fetch 檔在且雜湊合法 → 跳過")

    assert mod.needs_fetch(absent) is True, "檔案不存在卻早退 → 該題永遠沒有圖"
    ok("needs_fetch 缺檔 → 重抓（即使雜湊看起來完整）")

    assert mod.needs_fetch({**present, "src_sha256": None}) is True
    assert mod.needs_fetch({**present, "src_sha256": ""}) is True
    ok("needs_fetch 無雜湊（新增或 URL 變更）→ 重抓")

    for bad in ("corrupt", H[:63], H.upper(), "undefined", 0, {}):
        assert mod.needs_fetch({**present, "src_sha256": bad}) is True, \
            f"格式不合法的雜湊 {bad!r} 被當成已完成 → 這一筆永久避開一般排程"
    ok("needs_fetch 雜湊格式不合法 → 重抓（CR-3）")

    for item in (present, absent):
        assert mod.needs_fetch(item, True) is True
    ok("needs_fetch --verify-all → 一律重抓")


# ── TG-2 process() 路由 ───────────────────────────────────────────────

def test_process_routing(mod, root: Path) -> None:
    mod.ROOT = root
    img_dir = root / "data" / "img"
    img_dir.mkdir(parents=True, exist_ok=True)

    raw = make_webp()
    digest = mod.hashlib.sha256(raw).hexdigest()
    dest = img_dir / "routed.webp"
    dest.write_bytes(mod.to_webp(raw))
    item = {"id": "R", "img": "img/routed.webp", "src": "https://example.invalid/r.jpg",
            "src_sha256": digest}

    calls: list[str] = []
    verified: list[Path] = []
    real_download, real_verify = mod.download, mod.verify_asset
    mod.verify_asset = lambda p: (verified.append(p), real_verify(p))[1]
    try:
        mod.download = lambda url: (calls.append(url), raw)[1]

        calls.clear(); verified.clear()
        assert mod.process(item, False) == ("R", digest, None)
        assert calls == [], "一般模式對已完成的項目仍然下載 → 每次排程全量重抓"
        ok("process 一般模式：檔在且雜湊合法 → 不下載")

        calls.clear(); verified.clear()
        assert mod.process(item, True) == ("R", digest, None)
        assert len(calls) == 1, "--verify-all 沒有重新下載，偵測不到原地換圖"
        assert verified == [dest], "--verify-all 對內容未變的既有檔案沒有解碼驗證"
        ok("process --verify-all：重新下載且對既有檔案解碼")

        # 〔CR-4〕格式合法但過時的雜湊，一般模式**分辨不出來**——要判斷遠端內容
        # 是否改變，本質上必須先下載該內容，那就失去增量的意義。
        # 這不是實作偷懶，是 D10 的文字原本強於可實作的範圍；修訂後由 --verify-all 負責
        calls.clear(); verified.clear()
        stale = {**item, "src_sha256": "b" * 64}
        assert mod.process(stale, False) == ("R", "b" * 64, None)
        assert calls == [], "一般模式為了比對雜湊而下載 → 增量判定失去意義"
        ok("process 一般模式：偵測不到原地換圖（D10 的已知邊界，交給 --verify-all）")

        calls.clear(); verified.clear()
        assert mod.process(stale, True) == ("R", digest, None), \
            "--verify-all 必須回報**實際下載內容**的雜湊，不是沿用 pool 裡那個舊值"
        assert len(calls) == 1, "--verify-all 沒有重新下載"
        assert verified == [dest], "雜湊不符而重寫後沒有解碼驗證"
        ok("process --verify-all 且雜湊不符 → 重寫並解碼驗證（偵測原地換圖）")

        calls.clear(); verified.clear()
        missing = {**item, "img": "img/gone.webp"}
        rid, rdigest, err = mod.process(missing, False)
        assert err is None and rdigest == digest, f"缺檔路徑失敗：{err}"
        assert (img_dir / "gone.webp").exists(), "缺檔卻沒有寫出新檔"
        assert verified == [img_dir / "gone.webp"], "新寫出的檔案沒有解碼驗證"
        ok("process 缺檔 → 下載並寫出，且解碼驗證")

        def boom(url):
            raise RuntimeError("重試 3 次仍失敗：HTTP 500")
        mod.download = boom
        rid, rdigest, err = mod.process({**item, "src_sha256": None}, False)
        assert rid == "R" and rdigest is None and "HTTP 500" in err, \
            "下載失敗必須回報錯誤字串，由 main() 整批中止（規格 D9）"
        ok("process 下載失敗 → 回報錯誤而非拋出（整批中止交給 main）")
    finally:
        mod.download, mod.verify_asset = real_download, real_verify


# ── TG-3 verify_asset 真的解碼 ────────────────────────────────────────

def test_verify_asset(mod, root: Path, keep: Path | None) -> None:
    good = root / "good.webp"
    bad = root / "corrupt.webp"
    raw = make_webp(size=(96, 72))
    good.write_bytes(raw)
    bad.write_bytes(corrupt_webp(raw))

    mod.verify_asset(good)
    ok("verify_asset 合法 WebP → 通過")

    assert_container_looks_valid(bad.read_bytes())
    ok("損毀檔的容器結構仍然合法（verify-data.mjs 的 header 檢查會放行）")

    try:
        mod.verify_asset(bad)
    except (OSError, UnidentifiedImageError, ValueError) as e:
        ok(f"verify_asset 位元流損毀 → 拋出（{type(e).__name__}）")
    else:
        raise AssertionError(
            "verify_asset 對位元流損毀的 WebP 沒有拋出——"
            "`if False:` 或 `except: return` 這類實作會通過現有的靜態斷言")

    if keep:
        keep.mkdir(parents=True, exist_ok=True)
        (keep / "good.webp").write_bytes(good.read_bytes())
        (keep / "corrupt.webp").write_bytes(bad.read_bytes())


# ── CR-1 寫回排序（靜態）──────────────────────────────────────────────

def test_write_order() -> None:
    src = (REPO / "tools" / "fetch-images.py").read_text(encoding="utf-8")
    budget = src.index("if total > BUDGET_BYTES:")
    write = src.index("POOL.write_text(")
    assert budget < write, (
        "容量檢查排在 pool.json 回寫之後——非零退出宣稱這批不發布，"
        "data/pool.json 卻已經被改掉，下一輪的基線是一個從未通過驗收的版本（CR-1）")
    ok("CR-1 容量檢查排在 pool.json 回寫之前")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", type=Path, default=None,
                    help="把 good/corrupt 素材複製到這個目錄（供 node 端交叉驗證）")
    args = ap.parse_args()

    mod = load_tool()
    real_root = mod.ROOT
    with tempfile.TemporaryDirectory(prefix="idquiz-probe-") as tmp:
        root = Path(tmp)
        try:
            test_needs_fetch(mod, root)
            test_process_routing(mod, root)
            test_verify_asset(mod, root, args.keep)
        finally:
            mod.ROOT = real_root
    test_write_order()

    print(f"\n{len(cases)} 項全部通過", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
