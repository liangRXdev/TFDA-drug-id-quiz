# Codex 獨立覆審 — PR #3（批次 A 覆審修正／管線三缺口／稱號定案）

> **審查日期**：2026-08-06
> **Codex 版本**：`mcp__codex__codex`（thread `019fd6f8-0b40-7770-aeeb-6a37f092c408`）
> **審查範圍**：`git diff origin/main...HEAD`，6 個 commit
> **commit**：`213f478492ff6f8fb5cb7fbf3c1fd3a6543c9543`
> **模式**：`sandbox: read-only`／`approval-policy: never`
>
> **以下為 Codex 原始輸出，未經修飾或刪改**（僅還原傳輸過程的 HTML entity 轉義）。
> 覆核判定另見 `verdict-v4b.md`——原始意見保留可稽核性，判定與意見分開存放。

---

## 區塊 1 — Code review

### CR-1

**tools/fetch-images.py:112-118、163-184 / Medium / 問題描述：失敗時仍會改動 `data/`，未實現發布原子性**

`process()` 直接覆寫正式資產後才執行 `verify_asset()`。若解碼失敗、其他 worker 失敗或最後容量超標：

- 已寫入或被截斷的 `.webp` 不會還原。
- 成功下載的資產明確被保留。
- `pool.json` 會在容量檢查前於第 178 行寫回。
- 與 B1「任一失敗，`data/` 位元組完全不變」不符。

GitHub Actions 因後續不 commit，正式分支通常不會被污染，故不是 High；但腳本本身及本機執行不具宣稱的原子性。

**建議修法：** 不引入新依賴，將新 pool 與資產先輸出到同 workspace 的 staging 目錄；全部下載、Pillow decode、schema、容量及孤兒檢查通過後，才把 staging 結果提升為正式 `data/`。若保留續傳需求，續傳 cache 應與正式 `data/` 分離。

---

### CR-2

**tools/build-pool.mjs:52-57 / Low / 問題描述：`dosDateToISO()` 接受不存在的曆日**

目前只檢查 `1 <= day <= 31`，因此：

- 2026-02-31
- 2026-04-31
- 非閏年的 02-29

都會被輸出為合法-looking 的 `YYYY-MM-DD`，並進入 `meta.source_version`。位元欄位解碼本身正確：年為 bits 9–15、月為 bits 5–8、日為 bits 0–4。

**建議修法：** 以 UTC 日期 round-trip 驗證年月日，例如建立 `Date.UTC(y, m - 1, d)` 後確認取回的年月日完全相同；不合法回 `null`。

---

### CR-3

**tools/build-pool.mjs:72-80、tools/fetch-images.py:102-103、138-141、tools/verify-data.mjs:137-138 / Medium / 問題描述：任何 truthy 的舊雜湊都會被視為已完成**

`carryHashes()` 只判斷 `p.src_sha256` truthy；一般排程的 `todo` 也只判斷欄位是否存在。因此舊 pool 若含：

```json
{ "src_sha256": "corrupt" }
```

仍會沿用並直接跳過下載。`verify-data.mjs` 同樣只檢查 truthy，不驗 `^[0-9a-f]{64}$`。

這使損毀或格式漂移的雜湊可以永久避開一般排程；現有 checked-in pool 雖然實測 `badfmt=0`，但管線沒有守住此契約。

**建議修法：** 三處共用等價的「合法 SHA-256」predicate：只允許 64 位小寫十六進位；不合法即不沿用、落入 todo，且 `verify-data` fail。

---

### CR-4

**tools/fetch-images.py:138-141 / Medium / 問題描述：D10 的一般增量模式實際只做到「新增／URL 變更／缺檔／缺 hash」**

一般排程無法發現「同 URL、來源內容已變、既有 `src_sha256` 仍為 truthy」；它會在第 102–103 行早退。只有 `--verify-all` 會重新下載並比較來源 digest。

這可能是規格文字過強，而非合理實作可低成本完成的功能：要在一般排程判斷遠端內容 hash 是否不符，本質上仍須下載該內容。

**建議修法：** 相容作法是精確修訂 D10：

- 一般模式：新增、URL 變更、缺檔、缺／非法 hash。
- `--verify-all`：偵測同 URL 原地換圖及既有資產損毀。

若堅持「一般模式也檢查 hash 不符」，就只能下載所有來源內容，會失去增量模式的效益。

---

### CR-5

**tools/build-pool.mjs:303-309 / 無缺陷**

module-main guard 的實作正確：

```js
pathToFileURL(process.argv[1]).href === import.meta.url
```

- Windows 路徑、空白與磁碟機代號會經同一套 URL encoding。
- POSIX 絕對路徑成立。
- Node 執行 script 時 `process.argv[1]` 為解析後的 script 路徑。
- `npm run build:pool` 最終仍以 Node 執行同一檔案，guard 會成立。
- import 測試實際未觸發下載。

未發現需要修改之處。

---

### CR-6

**tools/fetch-images.py:98-118 / 無缺陷**

`verify_asset()` 的實際涵蓋完整：

- 一般模式新下載／重寫資產：第 115 行完整 decode。
- `--verify-all` 且來源 digest 未變：第 108–111 行在早退前 decode。
- `--verify-all` 且來源 digest 改變：重編碼後走第 115 行。
- 一般模式已存在且具合法舊 hash：刻意跳過，符合「新資產逐張驗、既有資產季度全驗」的修訂責任分工。

---

## 區塊 2 — Test gap analysis

全套 `node --test "tests/**/*.test.mjs"` 實跑通過，但仍有以下假綠空間。

### TG-1

**tests/pipeline.test.mjs:24-54、158-165 / Medium / 問題描述：SC-2 測試只證明轉換函式，沒有證明欄位真的進入產物**

以下錯誤實作可通過全部 SC-2 測試：

```js
export function dosDateToISO(word) {
  // 保持目前正確實作
}

// pickDataFile 忘記回傳 mtime，或 payload 完全不寫 source_version
```

純函式仍全綠，但功能再次靜默不存在。事實上目前 checked-in `data/pool.json` 就沒有 `source_version`。

**建議修法：** 使用手工建立的小型 ZIP fixture，執行 `build-pool` 到暫存輸出路徑，斷言產物 `meta.source_version`。不需要 ZIP npm 套件；可在測試中用 `Buffer` 組最小 stored-entry ZIP。

---

### TG-2

**tests/pipeline.test.mjs:58-114 / Medium / 問題描述：`carryHashes()` 測得完整，但沒有測 `todo` 與 `process()` 的整體路由**

以下錯誤實作可通過全部 `carryHashes` 測試：

```python
todo = [i for i in items if i.get("src_sha256")]
```

或：

```python
if item.get("src_sha256"):
    return item["id"], item["src_sha256"], None
# 即使檔案不存在也早退
```

測試沒有執行 Python predicate，因此 D10 仍可能再次斷線。

**建議修法：** 把 todo predicate 抽成無副作用 Python 函式，或增加不需網路的 Python self-test 路徑；fixture 至少涵蓋新增、URL 變更後 null、缺檔、缺／非法 hash、正常沿用及 `verify_all=True`。

---

### TG-3

**tests/pipeline.test.mjs:129-145 / Medium / 問題描述：CR-2 靜態斷言可由不可達或吞錯實作通過**

下列錯誤實作仍通過現有測試：

```python
def verify_asset(dest):
    with Image.open(dest) as im:
        if False:
            im.load()
```

另一個可通過的版本：

```python
def verify_asset(dest):
    try:
        with Image.open(dest) as im:
            im.load()
    except Exception:
        return
```

測試只搜尋 `Image.open(dest)`、`.load()` 與呼叫次數，沒有證明損毀檔會使整批 fail。

**建議修法：** 用一個 header 合法但壓縮位元流損毀的暫存 WebP 執行 `verify_asset()`，斷言非零退出；再測 `process()` 回傳 error，且正式檔未被視為成功。可透過既有 locked Pillow 執行，不需新增依賴。

---

### TG-4

**tests/pipeline.test.mjs:158-165 / Low / 問題描述：module-main guard 測試只驗字樣存在**

以下原始碼可通過靜態斷言：

```js
if (true) main().catch(handle);
void import.meta.url;
```

現有 import 行為剛好也間接證明目前實作安全，但沒有覆蓋直接執行與 npm script 兩條路徑。

**建議修法：** 子行程測三案：

- import：不得執行 main。
- `node tools/build-pool.mjs --source <不存在路徑>`：必須進 main 並失敗。
- `npm run build:pool -- --source <不存在路徑>`：同樣必須進 main。

三者都不需寫檔。

---

### TG-5

**tests/engagement.test.mjs:385-399 / Medium / 問題描述：非 rem 的字級覆寫會被靜默忽略**

以下錯誤 CSS 可通過：

```css
.rank-title { font-size: 48px; }
```

`remOf()` 回傳 `null` 後被 `.filter(v !== null)` 排除；既有 rem 宣告仍使 `rankSizes.length > 0`，所以測試全綠，實際稱號可能壓過三級判定。

**建議修法：** 對每個 `.rank-title` 與 `.metric .interp` 的 `font-size` 宣告要求必須能解析；遇到 px、em、calc 或不明值應直接 fail，而不是忽略。這仍是靜態契約，不涉及假 DOM cascade 測試。

---

### TG-6

**tests/engagement.test.mjs:371-372、496-517 / Medium / 問題描述：完整 selector 掃描仍可被較高 specificity selector 繞過**

以下錯誤 CSS 可通過：

```css
body .streak.pop .n { font-size: 2rem; }
body .rank-title { font-size: 3rem; color: var(--accent); }
```

`rulesMatching()` 對 selector 做 anchored exact match，因此這兩條都不會被納入檢查；原本合法規則仍讓 `hit.length` 與存在性斷言通過。

**建議修法：** 靜態解析時將 selector 依 combinator／compound selector 判斷是否能命中目標元素，至少拒絕「以目標 selector 為 suffix」的額外規則。保持原始碼契約＋人工瀏覽器留檔，不改成 stub 行為測試。

---

### TG-7

**tests/engagement.test.mjs:446-459 / Low / 問題描述：D27 條 5 的 JS 動畫禁令只列出部分 API**

以下錯誤實作可通過：

```js
setInterval(() => {
  $('qStreakN').style.transform = 'scale(1.2)';
}, 100);
```

也可使用 `window.scroll({ behavior: 'smooth' })`，現有 regex 不會攔截。這與「JS 不得自帶動畫」的廣義宣稱不一致。

**建議修法：** 若規格真正意圖只是禁止四個列名 API，應收窄「JS 不得自帶」文字；若維持廣義禁令，靜態契約需再掃 JS 對動畫相關 style/class 的計時驅動與 `scroll()` 選項。當前 PR 實作本身未發現 JS 動畫。

---

### TG-8

**tests/engagement-ui.test.mjs:654-692 / Low / 問題描述：C26 同 tick 測試只走 L1 選項路徑**

以下錯誤實作可通過：

```js
if (q.level === Level.L3) {
  queueMicrotask(() => lockAndReveal(locked, correct));
} else {
  lockAndReveal(locked, correct);
}
```

L1 測試仍全綠。雖然目前 L1/L2/L3 共用 `lockAndReveal()`，未來在呼叫端分支即可繞過。

**建議修法：** 以 L1 choice、L2 grid、L3 input 各走一次同 tick 斷言；仍使用現有 harness，不涉及 CSS 或幾何假測試。

---

## 區塊 3 — Dependency audit

### 結果

**package.json:1-17 / 無發現**

- 無 `dependencies`／`devDependencies`，符合零 npm 依賴。
- 測試使用 Node built-in test runner。
- `engines.node >=22`；workflow 使用 Node 24，互相相容。

**tools/fetch-images.py:2-5、tools/fetch-images.py.lock:1-207 / 無發現**

PEP-723 與 lock manifest 一致：

- Pillow constraint：`>=10`；鎖定 `12.3.0`
- Requests constraint：`>=2.31`；鎖定 `2.34.2`
- 傳遞依賴：certifi `2026.7.22`、charset-normalizer `3.4.9`、idna `3.18`、urllib3 `2.7.0`
- sdist 與各平台 wheel 均附 SHA-256。
- workflow 使用 `uv run --locked --script`。
- uv 執行檔另鎖定為 `0.11.8`。

本環境無法連線查詢即時 OSV/GHSA，因此不能對「截至 2026-08-06 無已知漏洞」作肯定宣稱；未臆測漏洞狀態。`uv lock --check` 亦因本機 uv cache 初始化受限而未能完成，但已人工核對 PEP-723 manifest 與 lock manifest 一致。

**.github/workflows/update-pool.yml:36、38、45、118 / 無發現**

全部第三方 Actions 均釘 40 字元 commit SHA：

- `actions/checkout`
- `actions/setup-node`
- `astral-sh/setup-uv`
- `actions/github-script`

尾註版本只是人工說明，不影響 pin。

---

## 區塊 4 — 規格符合度稽核

### SC-2 尚未完整交付

**規格 plan.md:228、C6 plan.md:360 ↔ data/pool.json:2、app.js:157、1246、tools/verify-data.mjs:85-87 / Medium / 問題描述：產生器已修，但本 PR 的正式資料仍沒有 `source_version`**

目前 checked-in `data/pool.json` 實測：

```text
source_version = undefined
```

因此：

- 首頁 `if (m.source_version)` 仍不成立。
- 成績卡 `if (ver)` 仍不成立。
- C6 在這次 PR 合併後依舊靜默不存在。
- `verify-data` 刻意把缺欄位視為資訊訊息而非 failure，使全部測試與驗證仍可綠燈。

`.ai-review/verdict-v4a.md:72` 宣稱「實跑 meta 確實出現該欄位」，但該產物沒有納入 PR。

**建議修法：** 以相同來源快照重建並提交 `data/pool.json`，或至少讓發布驗證在新管線產物缺少合法 ZIP 日期時明確記錄 C6 未達成。若欄位允許永久 optional，則必須同步把 C6 從「顯示」改為條件式承諾。

---

### SC-3 部分修好，但 D10 文字仍強於實作

**規格 D10 plan.md:170-172 ↔ tools/build-pool.mjs:72-80、tools/fetch-images.py:102-103、138-141 / Medium / 問題描述：新增及 URL 變更已修好，但一般模式沒有「hash 不符」判定**

已確認修好的部分：

- 新增 id：hash 留 null，進入 todo。
- URL 變更：不沿用舊 hash，進入 todo。
- 檔案不存在：進入 todo。
- 舊版 id＋URL 未變：沿用 hash，不再全量下載。

尚未做到的宣稱：

- truthy 但錯誤／過期的 `src_sha256` 在一般模式不會比較。
- 同 URL 原地換圖只能由 `--verify-all` 發現。

**建議修法：** 依 CR-4 精確拆分一般模式與季度模式的責任，並增加 hash 格式驗證。

---

### CR-2 責任分工已修好，但 B1 原子性未跟上

**規格 B5 plan.md:345 ↔ tools/fetch-images.py:86-115、tools/verify-data.mjs:23-49、109-135 / 符合**

已確認：

- `verify_asset()` 對落地檔呼叫 Pillow `load()`。
- 新寫資產必驗。
- `--verify-all` 內容未變的早退路徑仍驗。
- `verify-data` 已改稱「容器結構」，不再把 header 檢查宣稱為完整 decode。

但 decode 失敗發生在正式檔被覆寫之後，仍觸發前述 B1 原子性缺口。

---

### D27 條 5 實作符合

**規格 D27 條 5 plan-v4-engagement.md:239-244 ↔ app.js:1061、1147、1292 / 符合**

三處 smooth scroll 均已改為：

```js
window.scrollTo(0, 0)
```

本 PR 實作未發現 `behavior: smooth`、`scrollIntoView` 動畫、Web Animations API 或 `requestAnimationFrame` 視覺補間。測試契約仍有 TG-7 的廣義禁令覆蓋不足，但不是目前實作缺陷。

---

### D24 v4.3 與 12 格三處同步

**規格 D24 plan-v4-engagement.md:101-136 ↔ engine.js:1009-1013 ↔ tests/engagement.test.mjs:183-188、295-312 / 符合**

三處確切一致：

| 分數帶 | L1 | L2 | L3 |
|---|---|---|---|
| ≥95 | 入門攻克 | 辨識高手 | 火眼金睛 |
| ≥80 | 記得住外觀 | 看得出門道 | 一眼認藥 |
| ≥50 | 還在對圖 | 還在比對 | 還在背藥名 |
| <50 | 先從閃卡開始 | 先從閃卡開始 | 先從閃卡開始 |

另確認：

- 「熟手」已納入 L1/L2 精熟意涵黑名單。
- 「高手」未納入，與 v4.3 裁示一致。
- `rank-title-review.md` 涵蓋全部 12 格。
- 稱號未進成績卡 PNG。
- ≥50 的 9 格兩兩相異；最低帶三級刻意相同。

---

### 最終判定

PR 的前端娛樂性修補與 CR-2 decode 責任分工大致正確；目前主要阻塞是：

1. **SC-2 只修產生器、未更新正式 `data/pool.json`，C6 合併後仍不存在。**
2. **B1 全有全無仍未由腳本實現，失敗會留下已修改的正式資產。**
3. **D10 一般模式與 `src_sha256 不符` 的規格文字仍不一致。**

建議 PR 在至少處理第 1 項並明確裁決第 2、3 項後再合併。
