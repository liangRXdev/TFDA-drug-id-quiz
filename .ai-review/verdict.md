# 覆核判定（Claude 主持）

| 項目 | 內容 |
|---|---|
| 覆核日期 | 2026-07-31 |
| 對象 | `codex-review.md`（27 項發現） |
| commit | `13439f8`（已部署至 GitHub Pages） |
| 驗證方式 | 逐項回讀該檔該行；資料層指控以 `data/pool.json` 實跑統計驗證 |

## 統計

| 判定 | 數 |
|---|---|
| 接受 | 23 |
| 部分接受 | 4 |
| 拒絕 | 0 |
| **合計** | **27** |

**本輪無幻覺、無範圍蔓延、無與架構衝突的建議。** Codex 明確聲明未建議導入 bundler／React／npm ZIP 套件／Service Worker，前提 (a) 全部被尊重。嚴重度調整 2 項（皆為上調）。

---

## 1. Code review

| # | 項目 | Codex | 覆核 | 判定 | 理由 |
|---|---|---|---|---|---|
| C1 | 變動門檻只比較 ID 集合 | High | High | **接受** | 已回讀 `tools/build-pool.mjs:240-256`。確實只計算 `added`／`removed`／總數 `ratio`。**既有 ID 的 `ans`、`src`、外觀欄位全部被換掉時三個指標皆為 0，直接發布。** 這正是威脅模型第一順位「外觀與品名配錯」的無防護路徑。修法（比對相同 ID 的欄位變更數）零依賴可行。 |
| C2 | 「一對一驗證」名不符實 | High | High | **接受** | 已回讀 `tools/verify-data.mjs:74-85、107-115`。`assetKey(it.id)` 只證明**檔名**由 ID 推導；`src_sha256` 只檢查非空。本機 WebP 位元組與來源之間**沒有任何驗證鏈**。規格 B6 寫的是「一對一關係驗證」，實作沒做到——是我方高估了自己的驗收條件。 |
| C3 | CI 缺 `issues: write` | High | High | **接受** | 已回讀 `.github/workflows/update-pool.yml:22-23`（僅 `contents: write`）與 `:105`（`github.rest.issues.create`）。排程失敗時開 issue 必然 403 → **失敗通知機制本身靜默失敗**，直擊「次怕靜默失敗」。 |
| C4 | 正規化剝除實際品牌字 | High | High | **接受（Codex 低估）** | 實測確認並**比 Codex 描述更嚴重**。題庫 28 筆開頭帶引號者中：<br>• `"HC NORITLE" JOINT PAIN RELIEF F.C. TABLETS 400MG` → `JOINT PAIN RELIEF`（中文為「"諾得" 消炎治痛關節膜衣錠」，**諾得是品牌**，答案鍵變成通用描述，藥師不可能打出來）<br>• `"C.M." VIT. ANTI-COLD CAPSULES` → `VIT ANTI COLD`（同類）<br>• **另發現 Codex 未提的缺口**：`“T.F.”Su-min F.C.T 180mg` → `SU MIN F C T`，`F.C.T` 不在 `FORM_ABBR` 集合內，劑型字尾沒被剝除。 |
| C5 | `img.onerror` 未綁題，LOCKED 後作廢使分母變 21 | Medium | **High** | **接受（升級）** | 已回讀 `app.js:143-162`。`transition` 對 LOCKED 回傳原物件（`engine.js` 終態保護正確），**但 `voidCurrent` 沒有檢查回傳結果**：仍執行 `state.voided++`、`push(newQuestion(spare))`、`state.idx++`。結果為原題維持 LOCKED 且照常計分，考卷卻多一題 → `counted` 變 21。**這會產生錯誤成績，且已部署上線**，故由 Medium 升為 High。 |
| C6 | squash 碰撞使同卷出現等價答案 | Medium | Medium | **接受** | 實測確認 **5 組**：`ANTICOLD`／`ANTI COLD`、`ANTI COUGH`／`ANTICOUGH`、`METHYLTESTOSTERONE`／`METHYL TESTOSTERONE`、`U CLOR`／`UCLOR`、`SU MIN`／`SUMIN`。`judge` 的規則 (b) 視兩者等價，`drawQuiz` 卻以含空白的 `ans` 分組 → 同一卷可能出現兩題答案實質相同。README 宣稱的「答案鍵不重複」在這 5 組上不成立。 |
| C7 | `src_sha256` 每次 build 歸零 | Medium | Medium | **接受** | 已回讀 `tools/build-pool.mjs:163`（`src_sha256: null` 無條件寫入）與 `tools/fetch-images.py:105-108`（`todo` 含 `not i.get("src_sha256")`）。**每月排程都會重抓全部 3,913 張圖**（約 1.5GB），`--verify-all` 旗標形同虛設，`CLAUDE.md` 寫的「CI 只做增量」不實。 |
| C8 | `readWebp` 非真解碼 | Medium | Medium | **部分接受** | 問題屬實但 Codex 少看了一處：`tools/fetch-images.py:71` 的 `im.load()` 已對**來源**強制解碼，截斷來源會在該處爆。未被驗證的是**輸出的 WebP**。故正確修法是：(a) 把 Node 端檢查誠實改名為「WebP 結構檢查」，(b) 在 Python 端轉檔後對輸出再跑一次 `Image.open(out).verify()`。不需要把整個驗證搬去 Python。 |
| C9 | 非原子寫入，且錯誤訊息不實 | Medium | Medium | **接受** | 已回讀 `tools/build-pool.mjs:275`（直接 `writeFileSync` 覆寫）與錯誤處理列印的「data/ 未變更」。**該訊息在寫出後才失敗的情境下是假的。** 線上基線因 CI 不 commit 而安全，但本機會處於半更新狀態，且訊息誤導。 |
| C10 | ZIP reader 缺 bounds check | Medium | Medium | **接受** | 已回讀 `tools/build-pool.mjs:41-79`。確實無範圍檢查、無 uncompressed size／CRC32 比對、無解壓上限。畸形 ZIP 多半會拋例外（不致靜默接受），但錯誤訊息會變成 RangeError 而非可讀的「非合法 ZIP」，且 ZIP bomb 可耗盡記憶體。 |
| C11 | `featureCell` 未跳脫 | Medium | Medium | **接受** | 已回讀 `app.js:103-108、124-130`。`shape`／`color`／`size`／`mark1`／`mark2` 直接進 `innerHTML`。Codex 依本專案風險軸正確地**沒有**把它評為 High——但與同檔 `escapeHtml` 的紀律不一致，且管線受污染時是注入點，應修。 |
| C12 | `MAX_VOID` 差一 | Low | Low | **接受** | 已回讀 `app.js:13、150`。`MAX_VOID = 3` 搭配 `state.voided > MAX_VOID`，實際第 4 次才中止；規格 §6.5 寫「≥3 則中止」。程式與規格不一致，擇一對齊。 |
| C13 | `meta.source_version` 從未產生 | Low | **Medium** | **接受（升級）** | 實測確認 `meta` 實際欄位為 `schema, source, source_file, source_rows, content_hash, count, stages, no_fuzzy, images_bytes`，**沒有 `source_version`**。`app.js:75` 的 `if (m.source_version)` 永遠為 false → 頁尾資料版本永遠不顯示。**規格驗收條件 C6 實際上未滿足**，而我先前回報時聲稱前端已完成——由 Low 升為 Medium。 |
| C14 | `meta.source` 未跳脫 | Low | Low | **接受** | 已回讀 `app.js:70-74`。與 C11 同源，一併處理。 |
| C15 | `transition` 不拒絕未知 state | Low | Low | **接受** | 已回讀 `engine.js:207-225`。`switch` 前只檢查 LOCKED／VOID，未知狀態會落入正常分支。現行 UI 不產生此類物件，無現成繞過路徑，屬防禦性強化。 |

## 2. Test gap analysis

| # | 項目 | Codex | 覆核 | 判定 | 理由 |
|---|---|---|---|---|---|
| T1 | `app.js` 零自動測試 | High | High | **接受** | 屬實且**已被本輪證實有代價**：C5 的分母 21 缺陷正是因為沒有任何 `voidCurrent` 測試才漏到上線。Codex 主動指出引入 Playwright/jsdom 與前提 (a) 衝突並改提「抽成純函式 + 手寫最小 fake DOM」，是相容修法。 |
| T2 | 管線 B1–B9 無 fixture 測試 | High | High | **接受** | 屬實。規格 B 組寫了 9 條，但 `verify-data.mjs` 只驗證**已成功產出**的資料，等於只測 happy path。B1（非法 ZIP）、B2（0/2 個 schema 候選）、B3（變動門檻）、B8（三次 5xx）全部沒有自動測試——這些正是規格審查時最在意的失敗路徑。 |
| T3 | gold set 未涵蓋「引號即品牌」 | High | High | **接受** | 屬實。我建 gold set 時把引號一律當藥廠處理，47 筆全部是「剝掉引號是對的」的案例，**沒有一筆是反例**。這是取樣偏誤，C4 因此漏網。Codex 額外提的「normalize 變更須輸出全題庫答案鍵 diff 供覆核」是好建議。 |
| T4 | A4／A5 未涵蓋 canonical key | Medium | Medium | **部分接受** | 分兩半：**A4 的 squash 去重是正確的**——`judge` 規則 (b) 刻意讓 squash-equal 判對，所以它們在「誤接受掃描」中本來就該視為同一鍵，不是缺陷。**A5 才是真缺口**：唯一性斷言用原始 `ans`，應改用 `squash(ans)` 作 canonical key。修法只需改 A5 與 `drawQuiz`／`used`。 |
| T5 | `readWebp` 無破壞性 fixture | Medium | Medium | **接受** | 屬實。我手寫了 VP8／VP8L／VP8X 三種 chunk 的位移解析卻一個測試都沒寫，錯誤的位移常數不會被發現（目前全部檔案都是 Pillow 產的 VP8，另兩條分支從未被執行過）。 |
| T6 | 狀態機未做完整組合測試 | Low | Low | **接受** | 屬實。現有 A7 測了 6 個情境，但 HINTED→fail、LOCKED→fail（正是 C5 的情境）未測。表格驅動測試成本低。 |
| T7 | 抽樣輸入契約未測 | Low | Low | **接受** | 屬實。`drawQuiz` 未驗證 `n` 為非負整數，`rng` 契約（須回傳 `[0,1)`）只寫在註解。 |
| T8 | 未驗證瀏覽器與 Node 的 NFKC 差異 | Low | Low | **部分接受** | 理論成立但**實際風險極低**：本專案 NFKC 只用於全形英數字母與數字（U+FF21–FF5A、U+FF10–FF19），這段對應關係自 Unicode 早期即穩定，不屬於會版本漂移的 compatibility 區段。建議降為最低優先，且以「gold set 瀏覽器 smoke 頁」實作即可，不需鎖 Node major。 |

## 3. Dependency audit

| # | 項目 | Codex | 覆核 | 判定 | 理由 |
|---|---|---|---|---|---|
| D1 | PEP 723 未鎖版本 | Medium | Medium | **接受** | 已回讀 `tools/fetch-images.py:3-4`（`pillow>=10`、`requests>=2.31`）。Pillow encoder 行為若改變，會讓數千張 WebP 產生**非資料性 diff**——那會直接觸發 C1 的變動門檻並造成誤判，兩者交互作用比單獨看更糟。 |
| D2 | Action 未固定 commit SHA | Medium | Medium | **接受** | 已回讀 workflow。四個 action 皆用可移動 major tag，而該 job 具 `contents: write`。屬標準供應鏈強化，與純靜態架構無衝突。 |
| D3 | 高權限橫跨全 job | Medium | Medium | **部分接受** | 風險判斷正確，但「拆成唯讀 build job + 具寫入權的 publish job」對這個規模的專案偏重（要處理 artifact 傳遞約 50MB 圖片）。**先做 D2 的 SHA pin + D1 的版本鎖**已消除主要攻擊面；拆 job 列為後續。 |
| D4 | 無 LICENSE／授權標註 | Low | Low | **接受** | 已確認 repo 根目錄無 LICENSE。**且此項比 Codex 說的更需要處理**：repo 鏡像了 3,913 張政府資料集圖片並公開散布，TFDA opendata 的授權條款與必要 attribution 應明確記載，不能只靠 README 一行「題庫來源」。 |

---

## 必修項（Critical/High，判定為接受或部分接受）

依「已上線且會產生錯誤結果」→「會誤導」→「靜默失敗」排序：

| 順序 | # | 項目 | 為何排這個位置 |
|---|---|---|---|
| 1 | **C5** | LOCKED 後作廢使分母變 21 | **唯一會讓已上線站台算出錯誤分數的缺陷** |
| 2 | **C4** | 正規化剝除品牌字（含 `F.C.T` 缺口） | 產生藥師不可能答對的題目，直接違反「不可誤導」 |
| 3 | **C1** | 變動門檻不看既有 ID 內容變更 | 威脅模型第一順位的無防護路徑 |
| 4 | **C3** | CI 缺 `issues: write` | 失敗通知本身失敗＝靜默失敗；一行修好 |
| 5 | **C2** | 圖片一對一驗證名不符實 | 規格宣稱有、實際沒有；需加 `webp_sha256` |
| 6 | **T1／T2／T3** | app.js、管線、gold set 三個測試缺口 | C5 與 C4 漏網的直接原因 |

**建議先做 C3（一行）與 C5（十行內），這兩項成本最低但一個修掉線上錯誤成績、一個修掉靜默失敗。**
C4 需要人工裁決 28 筆開頭引號案例，應與 T3 一起做。
