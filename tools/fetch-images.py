#!/usr/bin/env python
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10", "requests>=2.31"]
# ///
"""
圖片鏡像管線 — 規劃文件 §5 步驟 8–10

    uv run tools/fetch-images.py [--limit N] [--workers 8] [--verify-all]

刻意鏡像而非外連（規格 D2）：原圖 140KB～6MB、主機無 CORS header
（跨域圖片進 canvas 會 taint，成績卡截圖會爆），且對方有 WAF。

失敗紀律（規格 D9）：暫時性下載失敗**不得**用刪題吸收。
重試 3 次仍失敗即整批中止，pool.json 不更新——已下載的檔案保留，可續跑。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
POOL = ROOT / "data" / "pool.json"
IMG_DIR = ROOT / "data" / "img"

MAX_EDGE = 640
WEBP_QUALITY = 78
RETRIES = 3
TIMEOUT = 60
UA = "TFDA-drug-id-quiz/1.0 (+https://github.com/liangRXdev)"

_print_lock = threading.Lock()


def log(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


def download(url: str) -> bytes:
    """下載原圖，重試 RETRIES 次。全部失敗則拋出。"""
    last = None
    for attempt in range(1, RETRIES + 1):
        try:
            r = requests.get(url, timeout=TIMEOUT, headers={"User-Agent": UA})
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}")
            if not r.content:
                raise RuntimeError("空回應")
            return r.content
        except Exception as e:  # noqa: BLE001 — 任何失敗都要重試
            last = e
    raise RuntimeError(f"重試 {RETRIES} 次仍失敗：{last}")


def to_webp(raw: bytes) -> bytes:
    """轉 WebP，長邊上限 MAX_EDGE。解碼失敗會拋出（規格 B5）。"""
    im = Image.open(io.BytesIO(raw))
    im.load()                      # 強制解碼，截斷檔會在此爆
    if max(im.size) > MAX_EDGE:
        im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    out = io.BytesIO()
    im.save(out, "WEBP", quality=WEBP_QUALITY, method=5)
    return out.getvalue()


def process(item: dict, verify_all: bool) -> tuple[str, str | None, str | None]:
    """回傳 (id, src_sha256, error)。已存在且雜湊已知時跳過。"""
    dest = ROOT / "data" / item["img"]
    if dest.exists() and item.get("src_sha256") and not verify_all:
        return item["id"], item["src_sha256"], None
    try:
        raw = download(item["src"])
        digest = hashlib.sha256(raw).hexdigest()
        # 內容未變且檔案已在，不重寫（維持 git 冪等）
        if dest.exists() and item.get("src_sha256") == digest:
            return item["id"], digest, None
        webp = to_webp(raw)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(webp)
        return item["id"], digest, None
    except Exception as e:  # noqa: BLE001
        return item["id"], None, str(e)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="只處理前 N 筆（開發用）")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--verify-all", action="store_true",
                    help="重抓全部並比對雜湊，偵測 TFDA 原地換圖（規格 D10，每季一次）")
    args = ap.parse_args()

    if not POOL.exists():
        print(f"✖ 找不到 {POOL}，請先執行 npm run build:pool", file=sys.stderr)
        return 1

    payload = json.loads(POOL.read_text(encoding="utf-8"))
    items = payload["items"]
    if args.limit:
        items = items[: args.limit]

    todo = [i for i in items
            if args.verify_all
            or not (ROOT / "data" / i["img"]).exists()
            or not i.get("src_sha256")]
    log(f"題庫 {len(items):,} 筆，需處理 {len(todo):,} 筆"
        f"（已完成 {len(items) - len(todo):,}）")
    if not todo:
        log("無待處理項目")
        return 0

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    results: dict[str, str] = {}
    failures: list[tuple[str, str]] = []
    done = 0

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for item_id, digest, err in pool.map(lambda i: process(i, args.verify_all), todo):
            done += 1
            if err:
                failures.append((item_id, err))
            else:
                results[item_id] = digest
            if done % 100 == 0 or done == len(todo):
                log(f"  {done:,}/{len(todo):,}  成功 {len(results):,}  失敗 {len(failures):,}")

    if failures:
        log(f"\n✖ {len(failures)} 筆下載/轉檔失敗，整批中止（規格 D9：不得用刪題吸收）")
        for item_id, err in failures[:15]:
            log(f"    {item_id}  {err}")
        log("  pool.json 未更新。已下載的檔案保留，重跑可續傳。")
        return 1

    # 全部成功才回寫雜湊
    by_id = {i["id"]: i for i in payload["items"]}
    for item_id, digest in results.items():
        by_id[item_id]["src_sha256"] = digest

    total = sum(f.stat().st_size for f in IMG_DIR.glob("*.webp"))
    filled = sum(1 for i in payload["items"] if i.get("src_sha256"))
    payload["meta"]["images_bytes"] = total
    POOL.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    log(f"\n✓ 完成。資產 {len(list(IMG_DIR.glob('*.webp'))):,} 張 / "
        f"{total / 1024 / 1024:.1f} MB，pool 已填雜湊 {filled:,}/{len(payload['items']):,}")
    if total > 200 * 1024 * 1024:
        log("✖ 超出 200MB 容量預算（規格 D10），需人工決策")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
