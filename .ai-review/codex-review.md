# Codex 程式碼獨立覆審報告（原始輸出，未修飾）

| 項目 | 內容 |
|---|---|
| 審查日期 | 2026-07-31 |
| 審查範圍 | 整個 repository |
| commit | `13439f8` |
| Codex CLI 磁碟版本 | `codex-cli 0.146.0`（MCP 常駐 process 實際版本未確認，見 memory `codex-mcp-restart-pending`） |
| 模式 | `sandbox=read-only`、`approval-policy=never` |
| thread | `019fb891-7306-7521-acdb-fc43a4c1383f` |

> 以下為 Codex 原始輸出，**逐字保留、未刪改**（僅還原傳輸過程產生的 `&gt;`／`&lt;` 跳脫）。
> 覆核判定另見 `verdict.md`。

---

審查結論：未發現 Critical；發現 4 項 High、7 項 Medium、4 項 Low。最高風險集中在「既有 ID 的內容大量變更不受門檻攔截」、「圖片一對一驗證名不符實」、「CI 失敗無法成功開 issue」，以及正規化可能剝除實際品牌字。

已以唯讀方式確認 HEAD=`13439f8`，並重跑：

- `node --test "tests/**/*.test.mjs"`：39/39 通過。
- `node tools/verify-data.mjs`：通過。
- 未修改任何檔案。

## 1. Code review

### High

- `tools/build-pool.mjs:245-253 / 嚴重度 High / 變動門檻只比較 ID 新增、移除與總題數；若既有 ID 的 ans、src、full、外觀欄位被大量錯置或交換，removed=0、ratio=0，仍可直接發布。這正好漏掉威脅模型最高順位的「外觀與品名配錯」。 / 建議修法：對相同 ID 比較 ans、src、full、shape、color、score_mark、mark1、mark2、size，統計 changed 數及比例；超過低門檻即要求人工裁決。可完全維持 Node、零依賴架構。`

- `tools/verify-data.mjs:74-85、107-115 / 嚴重度 High / 所謂「一對一驗證」只證明 img 檔名由 ID 雜湊產生，以及 src_sha256 欄位非空；完全沒有驗證本機 WebP 位元組確實是該來源轉出的內容。合法 WebP 被換到另一個正確檔名後仍會全數通過。 / 建議修法：建圖時另存 webp_sha256，verify-data 對本機檔案重算並比對；src_sha256 與 webp_sha256 應在同一次轉檔成功後才一起更新。每季 verify-all 再負責重新下載來源並比對 src_sha256。`

- `.github/workflows/update-pool.yml:22-23、99-109 / 嚴重度 High / workflow 僅授予 contents: write，但失敗步驟呼叫 issues.create 需要 issues: write。排程失敗時開 issue 會收到 403，因此最重要的失敗通知機制本身失敗，形成靜默失敗。 / 建議修法：在 permissions 增加 issues: write；另讓通知步驟在建立 issue 失敗時把醒目訊息寫入 GITHUB_STEP_SUMMARY。`

- `engine.js:34-51；data/pool.json:2763-2764 / 嚴重度 High / normalize 無條件刪除任何 1–25 字元的引號內容。現有題庫已出現 full="\"HC NORITLE\" JOINT PAIN RELIEF..."，答案鍵卻是 JOINT PAIN RELIEF；中文品名中的「諾得」顯示被刪內容可能是品牌而非藥廠。這條規則有把品牌字剝掉的實際路徑。 / 建議修法：不要直接取消引號規則；建立以許可證字號為鍵的少量人工 override／例外表，並把所有「開頭引號＋剩餘內容為通用描述」列成人工覆核清單。這與零建置架構相容，也比全面保留引號內容安全。`

### Medium

- `app.js:120、144-160 / 嚴重度 Medium / img.onerror 沒有綁定題目或預期 src。舊圖片延遲失敗時可能作廢目前的新題；若錯誤發生在該題已 LOCKED 後，transition 會原樣回傳，但 voidCurrent 仍增加 state.voided、加入遞補題並前進，造成原題仍計分、考卷多出一個計分題，分母可能成為 21。 / 建議修法：renderQuestion 建立題目 token 或捕捉 idx、item ID、src，onerror 先確認仍是同題且同 src；transition 後只有結果確實為 VOID 才增加 voided、加入 spare 及前進。`

- `engine.js:114-116、168-185；data/pool.json:2298、76920 / 嚴重度 Medium / judge 把去空白相同的答案視為完全等價，但 drawQuiz 用含空白的 ans 分組。現有題庫有 ANTICOLD／ANTI COLD、SU MIN／SUMIN 等 5 組 squash 後碰撞，因此同一回合可能抽到兩個判定上完全相同的答案鍵；README 所稱答案鍵不重複並不成立。 / 建議修法：drawQuiz、used、no_fuzzy 與題庫唯一性統一以 squash(ans) 作 canonical key；每個 canonical key 內再均勻抽一筆紀錄。`

- `tools/build-pool.mjs:156-163；tools/fetch-images.py:80-87 / 嚴重度 Medium / 每次 build 都把全部 src_sha256 重設為 null，導致 fetch-images 每月重抓全部圖片；verify-all 旗標實質上失去「平時增量、每季全驗」的差異，也放大 TFDA 暫時故障與 Pillow 版本漂移的風險。 / 建議修法：讀取前版後，若相同 ID 且 src URL 未變，沿用前版 src_sha256；新增或 URL 改變才設 null。`

- `tools/verify-data.mjs:27-47、97-111 / 嚴重度 Medium / readWebp 對 VP8、VP8L、VP8X 的寬高位移基本正確，但它只檢查 RIFF 長度、首個 chunk 與尺寸欄位，並未解碼影像，也未驗證 chunk size／padding／後續影像 chunk。只要重寫 RIFF 長度，截斷或損毀的 bitstream 仍可能被宣告為「可解碼」。 / 建議修法：把 Node 檢查名稱改為「WebP 結構檢查」，並在既有 Pillow 管線增加逐檔 Image.verify()/load() 驗收；不需 npm 套件，也不衝突於雙語言分工。`

- `tools/build-pool.mjs:275-276；tools/fetch-images.py:89-92、146-154 / 嚴重度 Medium / 規格宣稱 data/ 全有全無，但 build 直接覆寫 pool.json，圖片也逐張直接覆寫；後續任一步失敗，本機 data/ 已部分改變。CI 因未 git commit 而不會發布，故線上基線尚安全，但程式訊息「data/ 未變更」不實。 / 建議修法：在 data 的同層暫存目錄完成 pool、圖片與驗證，全部成功後再 rename／替換目標；至少 pool.json 應使用同目錄 temp file＋原子 rename。`

- `tools/build-pool.mjs:41-77 / 嚴重度 Medium / 最小 ZIP reader 沒有中央目錄、本地檔頭與資料範圍的顯式 bounds check，也未驗證中央目錄宣告大小、uncompressed size 或 CRC32。多數畸形 ZIP 最終會因 RangeError、inflate 或 JSON parse 而失敗，不太會靜默接受，但錯誤分類不穩定，ZIP bomb 也可能造成記憶體耗盡。 / 建議修法：保留自寫 reader；加入每次 read 前的範圍檢查、中央目錄終點檢查、壓縮／解壓大小上限、uncompressed size 與 CRC32 比對。這不需要 npm 依賴。`

- `app.js:103-130 / 嚴重度 Medium / featureCell 將 shape、color、score_mark、size、mark1、mark2 直接插入 innerHTML，沒有 escapeHtml。資料雖來自政府來源，但來源或管線遭污染時可注入 HTML。依本專案威脅模型，此項不涉及憑證或 PII，故不評為 High。 / 建議修法：featureCell 對 name、val、interp 全部呼叫 escapeHtml，或改用 textContent 建 DOM。`

### Low

- `app.js:13、150-152 / 嚴重度 Low / MAX_VOID=3 卻使用 state.voided > MAX_VOID，實際允許第 3 次失敗並在第 4 次才中止；規格 §6.5 寫的是失敗次數 ≥3 中止。 / 建議修法：若規格文字為準，改為 >= MAX_VOID；若刻意允許三次遞補，則把常數與規格改名為 MAX_REPLACEMENTS 並明確寫「第 4 次中止」。`

- `tools/build-pool.mjs:261-272；app.js:75 / 嚴重度 Low / build 不產生 meta.source_version，因此規格 C6 的資料版本顯示目前永遠缺席；只有不易人工辨識的 content_hash。 / 建議修法：若 ZIP 或 HTTP metadata 有官方版本，保存該來源版本；若沒有可信日期，前端至少顯示 content_hash 短碼，避免拿執行時間冒充資料版本。`

- `app.js:69-75 / 嚴重度 Low / meta.source 與 meta.source_file 直接進 innerHTML，未跳脫。現況由自家管線固定產生，實際風險低，但與其他欄位的 escapeHtml 紀律不一致。 / 建議修法：使用 textContent 組 DOM，或對兩欄套 escapeHtml。`

- `engine.js:207-225 / 嚴重度 Low / transition 對未知 q.state 沒有拒絕；bogus 狀態仍可 hint／submit／fail。正常 UI 不會產生這種物件，因此沒有現成計分繞過，但損毀狀態可能被悄悄「修成」合法終態。 / 建議修法：先驗證 cur 屬於 QState；開發／測試環境可 throw，正式環境至少原樣拒絕並回報。`

專項確認：

- `drawQuiz` 的 partial Fisher–Yates 在 rng 回傳 `[0,1)` 且 n 為合法整數時是無偏的；未發現演算法偏差。
- 建置期與瀏覽器確實 import 同一份 `engine.js`，沒有兩份 normalize 實作漂移。
- `transition` 在合法內部狀態下，LOCKED／VOID 終態能阻止重複送出計分；主要問題在 app 的失敗處理沒有確認 transition 是否真的進入 VOID。
- `state.used` 保留作廢鍵並加入遞補鍵的方向正確；問題是 canonical key 不一致及事件競態。

## 2. Test gap analysis

- `app.js:29-389；tests/engine.test.mjs:1-390 / 嚴重度 High / app.js 完全沒有自動測試，圖片 404、延遲 onerror、LOCKED 後 onerror、三次失敗上限、遞補後題號與計分分母均未被覆蓋；本次發現的分母 21 問題因此未被攔截。 / 建議修法：把 voidCurrent 的狀態運算抽成 engine 純函式並用 node:test 測試；DOM 部分可用手寫最小 fake DOM 測 loadPool／submit／hint／next。引入 Playwright/jsdom 會增加 npm 工具鏈，與前提 (a) 衝突，因此不建議作為第一步。`

- `tools/build-pool.mjs:41-279；tests/engine.test.mjs:1-390 / 嚴重度 High / 規格 B1–B9 幾乎沒有 fixture-based 管線測試；目前 verify-data 只驗證已提交的成功資料，未測非 ZIP、截斷 ZIP、0/2 個 schema 候選、欄位半途缺失、穩定 ID 大量改值、變動門檻、下載失敗後 data 不變。 / 建議修法：匯出或拆出 readZipEntries、pickDataFile、buildPool、delta analyzer，以 node:test 配合小型記憶體 fixture 測試；Python 下載以 monkeypatch／本機假 response 測三次 5xx。均可維持零 npm dependency。`

- `tests/gold-set.json:1；engine.js:34-62 / 嚴重度 High / 47 筆 gold set 有覆蓋常見引號藥廠，但未涵蓋「引號內容其實可能是品牌」及開頭引號後接通用描述；HC NORITLE 案未被人工裁決。 / 建議修法：加入 HC NORITLE、FE YI CHIN、NICE NIGHT 等所有開頭引號案例的人工結論，並新增規則：任何 normalize 變更都必須輸出全題庫答案鍵 diff 供藥師覆核。`

- `tests/engine.test.mjs:127-174、237-294 / 嚴重度 Medium / A4 先把答案鍵 squash 後放進 Set，反而把 ANTICOLD／ANTI COLD 類碰撞消掉；A5 又只檢查原始 ans 的 Set，因此兩組測試共同漏掉「判定等價但抽樣視為不同鍵」。 / 建議修法：新增 canonical-key 唯一性斷言，並要求每卷 new Set(q.map(x => squash(x.ans))).size === 20。`

- `tools/verify-data.mjs:27-47 / 嚴重度 Medium / readWebp 沒有 VP8、VP8L、VP8X、奇數 chunk padding、RIFF 長度錯誤、截斷 bitstream、偽造尺寸等 fixture 測試。 / 建議修法：加入最小合法及逐位破壞 fixture；另用 Pillow 解碼作最終 oracle，不要把檔頭解析通過等同完整解碼。`

- `tests/engine.test.mjs:298-342 / 嚴重度 Low / 狀態機未測 HINTED→submit、HINTED→fail、LOCKED→fail、未知 state、未知 event，以及 transition 回傳同一物件／新物件的契約。 / 建議修法：以狀態×事件表格驅動測試所有組合，並明確定義 LOCKED 後資源失敗的產品行為。`

- `tests/engine.test.mjs:237-294 / 嚴重度 Low / 抽樣只檢查答案鍵出現頻率，未檢查同一答案鍵內不同紀錄是否均勻，也未測 n<0、非整數、n>keys、rng=1 或 NaN 的輸入契約。 / 建議修法：增加每鍵內紀錄分布測試；drawQuiz 開頭驗證 n 為非負整數，並文件化 rng 必須回傳 [0,1)。`

- `tests/engine.test.mjs:29-54；package.json:13-15 / 嚴重度 Low / 測試只在 Node 執行，沒有實際驗證瀏覽器與 Node 的 NFKC/Unicode 行為。程式碼來源確實相同，但不同 JS runtime 的 Unicode 資料版本仍可能對少數 compatibility characters 產生差異。 / 建議修法：維持 Node 為主要驗收，另建立無依賴的瀏覽器手動／CI smoke 頁，對 gold set 在瀏覽器逐筆執行；至少鎖定 CI Node major。`

## 3. Dependency audit

整體而言，瀏覽器 runtime 沒有第三方 JavaScript dependency，攻擊面與長期維護成本很低，符合架構目標。主要供應鏈風險在 CI action 與未鎖定的 Python 建置工具。

- `tools/fetch-images.py:2-5 / 嚴重度 Medium / PEP 723 只指定 pillow>=10、requests>=2.31，沒有上限、精確版本或 lock。未來 Pillow encoder 行為改變可能讓數千張 WebP 出現非資料性 diff；破壞性新版或供應鏈事件也會直接進入具 contents:write 的發布流程。 / 建議修法：使用 uv 的 script lock，或至少精確固定已驗證版本，例如 pillow==X.Y.Z、requests==X.Y.Z，定期由人工 PR 升級並重跑全驗；不需改用 pip。`

- `.github/workflows/update-pool.yml:31-37、101 / 嚴重度 Medium / actions/checkout@v4、setup-node@v4、setup-uv@v5、github-script@v7 都是可移動 major tag，不是不可變 commit SHA。任一上游 tag／release 被污染都可取得 contents:write。 / 建議修法：固定到完整 commit SHA，旁註對應版本；使用 Dependabot 的 github-actions 更新 PR。這不影響純靜態或零建置架構。`

- `.github/workflows/update-pool.yml:22-37 / 嚴重度 Medium / 高權限 contents:write 從 job 一開始即有效，下載、解析 ZIP、執行 Python dependency 與第三方 actions 全程共享權限。 / 建議修法：拆成唯讀 build/verify job 與具 contents:write 的 publish job；用 artifact 傳遞已驗證 data，publish job 僅 checkout、再次驗證摘要後提交。若不拆 job，至少固定 action SHA及依賴版本。`

- `README.md:57-63；repo 根目錄 / 嚴重度 Low / repo 沒有 LICENSE／NOTICE，也未記錄 Pillow、Requests、GitHub Actions及 TFDA 資料集的授權依據。工具依賴通常不隨成品散布，Pillow／Requests 本身為寬鬆授權，沒有明顯 copyleft 衝突；但專案程式碼可否再利用及政府資料的歸屬條款不清楚。 / 建議修法：加入專案 LICENSE、第三方工具授權清單，以及 TFDA 資料集授權名稱／連結與必要 attribution；圖片是否可再散布應另外確認並記錄。`

未建議導入 bundler、React、npm ZIP 套件、Service Worker 或 PWA；所有修法均可在現有純靜態、Node 內建模組與既有 uv/Pillow 架構內完成。
