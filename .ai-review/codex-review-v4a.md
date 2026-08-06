# Codex 獨立覆審 — v4 批次 A（娛樂性強化 M1–M4）

> **審查日期**：2026-08-06
> **覆審員**：Codex（`mcp__codex__codex`，`sandbox: read-only`、`approval-policy: never`）
> **審查範圍**：整個 repository，重點為 v4 批次 A 交付
> **commit**：`35d05d7`（分支 `feat/v4-engagement-batch-a`）
> **前置規格**：`.ai-review/plan.md`(v2)、`plan-v3-levels.md`(v3.6)、`plan-v4-engagement.md`(v4.2)
>
> 本檔為 **Codex 原始輸出，未經修飾或刪改**，供稽核。
> 主持人的逐項判定見 `.ai-review/verdict-v4a.md`。

---

覆審結論：未發現 Critical／High。發現 5 項實作／規格落差與 5 項測試缺口，最高為 Medium。v4 批次 A 的 streak、稱號、localStorage 合併與遞補接線本身未發現會造成錯誤藥品辨識或紀錄倒退的實作錯誤。

唯讀驗證結果：

- `node --test`：272/272 通過，約 72.8 秒。
- `node tools/verify-data.mjs`：通過；但其 WebP 驗證強度不足，詳見 CR-2。
- 覆審前後 `git status --short` 皆無輸出，未修改任何檔案。

## 區塊 1 — Code review

### CR-1

- 檔案:行號：`app.js:1061,1147,1292`
- 嚴重度：Medium
- 問題描述：三處 `window.scrollTo({ behavior: 'smooth' })` 是 JavaScript 動畫，未尊重 `prefers-reduced-motion`。這也繞過 D27「允許效果窮舉」及全部動畫正向表列於 `no-preference` block 的設計。使用者選擇 reduced motion 後，完成閃卡、進入結算、返回起始頁仍會平滑捲動。
- 建議修法：最相容且不需 build step 的作法是移除 `behavior: 'smooth'`，改成 `window.scrollTo({ top: 0 })`。若確實要保留，則以 `matchMedia('(prefers-reduced-motion: reduce)')` 選擇 `auto`／`smooth`，並同步修訂 D27 的允許清單；依現有「動畫一律 CSS 正向表列」前提，直接移除較一致。

### CR-2

- 檔案:行號：`tools/verify-data.mjs:26-47,97-106`
- 嚴重度：Medium
- 問題描述：`readWebp()` 只驗 RIFF 長度、容器標記及第一個 VP8/VP8L/VP8X header，沒有解碼影像位元流。只要偽造合法 header、RIFF 長度與尺寸，即使壓縮資料損毀仍可能通過並印出「全部資產可解碼」。瀏覽器端之後會把這些圖片作廢，嚴重時中止整回合。
- 建議修法：沿用現有已鎖定的 Pillow，不引入新依賴或 build chain；替 `fetch-images.py` 加唯讀 `--verify-existing` 模式，逐檔執行 `Image.open(...).verify()`，再重新開檔 `load()`，由 workflow 的資料驗收步驟呼叫。Node header 檢查可保留作快速結構檢查，但不能再宣稱等同完整解碼。

其餘重點結論：

- `longestStreak()`／`currentStreak()` 對答錯切段、提示答對、VOID 跳過、非終態跳過及 exclusive `upTo` 的處理一致，未發現漏掉的可達狀態組合。
- `refreshStreak()` 的 `pop` class 會在下一題 `renderQuestion()`、答錯或 VOID 時同步移除；最後一題雖留在已隱藏的 quiz DOM，下一回合首次 render 會移除，未形成可見殘留。
- `writeRecords()` 寫前重讀、分數與 streak 獨立合併、嚴格大於更新，以及寫入成功後才顯示「新紀錄！」均正確。
- 清除僅呼叫精確 key 的 `removeItem()`；未發現 `clear()` 或前綴掃描。
- 遲到圖片事件、ready-gate 與 `voidCurrent()` 不會回溯改變已鎖定題或額外遞補。

## 區塊 2 — Test gap analysis

### TG-1

- 檔案:行號：`tests/engagement.test.mjs:389-410`
- 嚴重度：Medium
- 問題描述：C25 只掃描 CSS 的 `transition:`、`animation:`、`@keyframes`，完全不掃 JavaScript 動畫。因此目前 `app.js` 三處 `behavior: 'smooth'` 全部通過測試，實際功能卻違反 reduced-motion。這是已發生的假陰性。
- 建議修法：新增靜態契約，掃描 `app.js` 的 `behavior: 'smooth'`、Web Animations API、`requestAnimationFrame` 等動畫入口。依目前規格，至少應明確禁止 `behavior: 'smooth'`。

### TG-2

- 檔案:行號：`tests/engagement.test.mjs:358-376`
- 嚴重度：Medium
- 問題描述：C23b 用 `rules.find()` 只取得第一條 `.rank-title` 規則。以下壞實作仍會全綠：

  ```css
  .rank-title { font-size: .68rem; color: var(--text-muted); }
  @media (max-width: 480px) {
    .rank-title { font-size: 3rem; color: var(--danger); }
  }
  ```

  真實 cascade 下稱號會壓過專業三級判定，與「避免高估能力」的風險直接相關。
- 建議修法：靜態契約要求 `.rank-title` 的 `font-size`／`color` 全檔只能宣告一次，或列舉所有命中規則並逐一檢查不得放大／提高對比。真實 cascade 與對比仍維持規格指定的人工瀏覽器留檔，不需引入 jsdom/headless browser。

### TG-3

- 檔案:行號：`tests/engagement.test.mjs:414-445`
- 嚴重度：Medium
- 問題描述：C27 只檢查 `no-preference` block 內的屬性，以及第一條基礎 `.streak .n` 規則。以下會通過全部測試，但套用 `pop` 時會改字級並推動 document flow：

  ```css
  .streak.pop .n { font-size: 2rem; }
  ```

  因為它沒有 `transition:`，C25 也抓不到。
- 建議修法：對所有動畫狀態 selector（尤其 `.streak.pop .n`、`.opt.ok/.no`、`.cell.ok/.no`）做全檔屬性白名單，不只檢查 media block。人工 flow 留檔仍保留。

### TG-4

- 檔案:行號：`tests/engagement-ui.test.mjs:120-227`
- 嚴重度：Low
- 問題描述：C19、C33 依賴前面 C18 留下的 storage、DOM 與 result 狀態。C19 第一個測試直接讀 `stored().L1`；若只用 name pattern 執行 C19，或測試日後重排，前置紀錄不存在即失敗。`store.reset()` 只重設 localStorage 樁，沒有重建 app module、DOM 或 `state`，形成檔內順序耦合。
- 建議修法：每個 `describe` 自行建立明確基線；C19 開頭先跑一次 L1 建立紀錄，不借用 C18。每個案例也應保存並恢復 `Math.random`。這不需要更換 DOM 樁。

### TG-5

- 檔案:行號：`tests/engagement-ui.test.mjs:210-227`
- 嚴重度：Low
- 問題描述：C33 只測「另一分頁提高 `bestStreak`，本頁提高 `bestScore`」一個方向。若弱化實作只對 streak 重讀合併、卻以舊快照覆寫 score，此測試仍會通過。
- 建議修法：新增反向案例：另一分頁提高 `bestScore`，本頁只創下較高 `bestStreak`，並逐欄斷言另一分頁的 score、date、pool 均保留；再加一例另一分頁同時提高兩項、本頁兩項都較低，要求零倒退。

### TG-6

- 檔案:行號：`tests/engagement-ui.test.mjs:299-334,357-418`
- 嚴重度：Low
- 問題描述：規格 C20 宣稱 E1–E7 每一條都要完成整回合並驗分數與逐題檢討，但 E6 只測起始頁讀取，E7 只測清除流程。弱化實作可以「E6 顯示正常，但完成回合寫入時因 corruption 中斷」仍通過。
- 建議修法：E6 corruption 與 E7 清除成功／失敗後，各再跑完整回合並呼叫既有 `assertResultIntact()`；同時確認其他合法難度在寫入後仍逐欄保留。

沒有發現把 CSS cascade、media query 或幾何直接斷言在 `_ui-harness.mjs` 上的恆真假綠燈；本次缺口主要是靜態契約的掃描範圍不完整，而不是違反既定的 DOM 樁限制。

## 區塊 3 — Dependency audit

未發現需要回報的依賴漏洞、非必要 runtime 套件或授權衝突。

- `package.json:1-16`：無 `dependencies`／`devDependencies`，runtime 與測試均零 npm 依賴。
- `tools/fetch-images.py.lock:12-205`：鎖定 `Pillow 12.3.0`、`requests 2.34.2`、`urllib3 2.7.0`、`certifi 2026.7.22`、`idna 3.18`、`charset-normalizer 3.4.9`，並含 artifact hash。
- `.github/workflows/update-pool.yml:31-49`：第三方 Actions 皆釘 40 字元 commit SHA；`uv` 版本也固定為 `0.11.8`。
- 授權面：上述 Python 套件採常見 permissive／Mozilla CA bundle 授權，未見與靜態教育工具分發衝突。

限制：環境網路受限，本次無法連線查詢即時 OSV/GHSA/CVE 資料庫；結論是依 repository 鎖檔與版本的靜態稽核，不代表即時漏洞資料庫證明。

## 區塊 4 — 規格符合度稽核

### SC-1 — D27 未完整實作

- 規格條款：`.ai-review/plan-v4-engagement.md:205-229`（D27）、`:414-416`（C25–C27）
- 實作檔案:行號：`app.js:1061,1147,1292`
- 嚴重度：Medium
- 問題描述：D27 宣稱允許的動態效果為窮舉，且全部效果須受 reduced-motion 正向表列控制；實作另有三個未列出的 smooth-scroll 動畫。
- 建議修法：移除 `behavior: 'smooth'`。若規格決定保留，必須先修改 D27 的允許清單並新增 reduced-motion 分支及測試。

### SC-2 — v2 宣稱的 `source_version` 從未產生

- 規格條款：`.ai-review/plan.md:221-241`（pool 結構）、`:351-360`（C6）
- 實作檔案:行號：`tools/build-pool.mjs:261-274`、`app.js:157,1246-1247`
- 嚴重度：Medium
- 問題描述：規格宣稱 pool 會含 `meta.source_version`，頁面與成績卡也應顯示；但建置管線的 meta 從未寫入此欄位，目前 `data/pool.json` 也沒有。前端只有 `if (m.source_version)`，因此功能靜默不存在。
- 建議修法：由來源資料或 ZIP 內穩定的來源版本欄位產生 `source_version`；不得用 job 執行時間，以免破壞 B7 冪等。另在 `verify-data.mjs` 驗證欄位存在及格式，C6 測試應直接斷言實際頁面顯示，而非只檢查條件分支存在。

### SC-3 — D10 的增量模式與季度 `verify_all` 實際沒有區別

- 規格條款：`.ai-review/plan.md:168-176`（D10）
- 實作檔案:行號：`tools/build-pool.mjs:156-164`、`tools/fetch-images.py:81-88,114-119`
- 嚴重度：Medium
- 問題描述：每次 `build-pool` 都把所有項目的 `src_sha256` 設為 `null`。隨後 `fetch-images.py` 的 todo predicate 因 `not i.get("src_sha256")` 將全部項目列入重抓。因此所謂增量模式實際每月全量下載，`--verify-all` 與一般排程沒有實質差異。這增加 TFDA 暫時性失敗導致整批發布失敗的機率。
- 建議修法：建置時讀取前版 pool，以 `id + src URL` 配對沿用既有 `src_sha256`；新增項目、URL 改變或資產不存在時才清為 `null`。`--verify-all` 才強制全量重抓。這是純 Node/Python 管線修改，不需 build step。

### SC-4 — B5 驗證的是較弱性質

- 規格條款：`.ai-review/plan.md:208-212`、`:337-349`（B5）
- 實作檔案:行號：`tools/verify-data.mjs:26-47,88-115`
- 嚴重度：Medium
- 問題描述：規格承諾「每張資產可解碼」，實作只驗 header 與尺寸。合法 header 不等於壓縮位元流可解碼；驗證成功訊息強於實際證據。
- 建議修法：加入 Pillow 完整 decode 驗證，並保留現有 Node 結構檢查。

### SC-5 — v4.2 規格內部仍有 A28 文字矛盾

- 規格條款：`.ai-review/plan-v4-engagement.md:119-124`（D24 v4.2 裁決）、`:393`（A28）
- 實作檔案:行號：`engine.js:999-1012`、`tests/engagement.test.mjs:209-219`
- 嚴重度：Low
- 問題描述：D24 v4.2 明確裁決只有 ≥50 的 9 格須相異，&lt;50 三級必須相同；但 A28 主文仍寫「12 格兩兩相異且各級詞彙不相交」。實作與測試依 D24 v4.2，屬規格文字矛盾，不是實作缺陷。
- 建議修法：把 A28 改成「≥50 的 9 格兩兩相異且跨級不相交；&lt;50 三格正面斷言相同」，與現有測試一致。

### 條款通過摘要

- D23：`engine.js:956-985` 符合四種 streak 語意、回傳契約與最早同長段規則。
- D24：`engine.js:1008-1028`、`app.js:1106-1110`、`index.html:408-417` 符合查表唯一真相、實際 level/score 接線、徽章同框、DOM 順序及不進成績卡。人工稱號法規覆核仍為 §11.4 已明列的未關閉項目，不列為本次缺陷。
- D25：`app.js:237-330,1132-1145,1323-1333` 符合 predicate、嚴格大於、獨立指標、跨分頁重讀合併、E1–E7 與精確清除 key。
- D32：`app.js:458-473,696-708,745-766,1071-1110` 與 `index.html:360-418` 符合 live streak、VOID 不變、0 隱藏、結算提示數、稱號及紀錄區塊契約。
- A23–A29：行為測試完整，未發現會讓「答對總數冒充最長段」「hinted 算全卷」「固定稱號」通過的弱化實作。
- C18–C27、C31–C33：實作大致符合；自動測試的證據缺口見 TG-1 至 TG-6。C28–C30 與 A30–A35 屬批次 B，未列缺陷。
- §11.3 四項決定均未與其他條款衝突：E2 不寫與防紀錄倒退一致；無紀錄整塊隱藏與 E1/UI 降級一致；單難度任一項損毀即整級降級符合 D25 predicate；本地日期不違反日期格式契約。
