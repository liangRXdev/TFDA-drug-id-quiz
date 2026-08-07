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

增量判定（規格 D10）：一般模式重抓的條件為
「新增 **或** URL 變更 **或** 檔案不存在 **或** 雜湊缺漏／格式不合法」，見 needs_fetch()。
前兩者由 build-pool.mjs 的 carryHashes() 決定——它只對 id 與 src URL 都未變的項目
沿用前版 src_sha256，其餘留 null，於是在這裡自動落入 todo。

**一般模式偵測不到「同 URL 原地換圖」**：要判斷遠端內容是否改變，本質上必須先下載，
那就失去增量的意義。那一半交給每季一次的 --verify-all（完整重抓並比對雜湊）。
規格 D10 原文寫「或 src_sha256 不符」，文字強於可實作範圍，已於 v3 拆分。

解碼驗證（規格 B5）：新寫出的每一張都做完整 Pillow 解碼；
--verify-all 時對內容未變的既有檔案也解碼一次。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
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
BUDGET_BYTES = 200 * 1024 * 1024   # 規格 D10，與 verify-data.mjs 同值
UA = "TFDA-drug-id-quiz/1.0 (+https://github.com/liangRXdev)"

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

_print_lock = threading.Lock()


def is_sha256(v: object) -> bool:
    """
    〔CR-3〕`src_sha256` 的格式判定，與 build-pool.mjs 的 `isSha256` 同一條規則。

    原本只判斷「有值」——截斷、大寫或寫成 "undefined" 的雜湊都算已完成，
    於是那一筆可以**永久**避開一般排程，只有每季一次的 --verify-all 碰得到。
    """
    return isinstance(v, str) and _SHA256_RE.match(v) is not None


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


def verify_asset(dest: Path) -> None:
    """
    對**落地後**的 WebP 做完整解碼，失敗即拋出（規格 B5）。

    to_webp() 的 im.load() 驗的是**來源原圖**，證明不了寫出去的那份完好；
    而 verify-data.mjs 只讀 RIFF 長度與第一個 chunk header，同樣證明不了。
    這裡是「可解碼」這個宣稱唯一真正的證據來源。
    """
    with Image.open(dest) as im:
        im.load()


def needs_fetch(item: dict, verify_all: bool = False) -> bool:
    """
    規格 D10 的重抓判定。抽成具名函式是為了能被測到——
    〔TG-2〕原本內嵌在 main() 的 list comprehension 裡，D10 的這一半完全沒有自動測試，
    反寫成 `if i.get("src_sha256")` 或漏掉缺檔判斷都不會有任何東西轉紅。

    一般模式重抓的條件：**檔案不存在**，或**雜湊缺漏／格式不合法**。
    「新增」與「URL 變更」不在這裡判斷——build-pool.mjs 的 carryHashes() 已經
    把這兩種情形表現為「雜湊留 null」，在這裡自動落入待抓。
    `--verify-all` 則一律重抓（偵測 TFDA 原地換圖）。
    """
    if verify_all:
        return True
    if not (ROOT / "data" / item["img"]).exists():
        return True
    return not is_sha256(item.get("src_sha256"))


def process(item: dict, verify_all: bool) -> tuple[str, str | None, str | None]:
    """回傳 (id, src_sha256, error)。已存在且雜湊已知時跳過。"""
    dest = ROOT / "data" / item["img"]
    try:
        if dest.exists() and is_sha256(item.get("src_sha256")) and not verify_all:
            return item["id"], item["src_sha256"], None
        raw = download(item["src"])
        digest = hashlib.sha256(raw).hexdigest()
        # 內容未變且檔案已在，不重寫（維持 git 冪等）。
        # --verify-all 的季度全驗走這條——重下載證明不了磁碟上那份沒壞，要真的解碼
        if dest.exists() and item.get("src_sha256") == digest:
            if verify_all:
                verify_asset(dest)
            return item["id"], digest, None
        webp = to_webp(raw)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(webp)
        verify_asset(dest)          # 新抓的每一張都驗，成本只有一次解碼
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

    todo = [i for i in items if needs_fetch(i, args.verify_all)]
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

    # 〔CR-1〕容量檢查必須在回寫 pool.json **之前**。
    # 原本的順序是先寫檔再檢查後回 1——非零退出宣稱「這批不發布」，
    # data/pool.json 卻已經被改掉了，下一輪的基線因此是一個從未通過驗收的版本。
    # 資產本身仍是直接寫進正式 data/img/（規格 D9 明文要求可續傳），
    # 完整的 staging 原子性屬獨立一輪，動它要先裁決 D9 續傳與 B1 的衝突。
    total = sum(f.stat().st_size for f in IMG_DIR.glob("*.webp"))
    if total > BUDGET_BYTES:
        log(f"\n✖ 資產總量 {total / 1024 / 1024:.1f} MB 超出 "
            f"{BUDGET_BYTES / 1024 / 1024:.0f}MB 容量預算（規格 D10），需人工決策")
        log("  pool.json 未更新。")
        return 1

    filled = sum(1 for i in payload["items"] if is_sha256(i.get("src_sha256")))
    payload["meta"]["images_bytes"] = total
    POOL.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    log(f"\n✓ 完成。資產 {len(list(IMG_DIR.glob('*.webp'))):,} 張 / "
        f"{total / 1024 / 1024:.1f} MB，pool 已填雜湊 {filled:,}/{len(payload['items']):,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
