# Codex 獨立覆審 — V5 批次 4（院內清單 UI）

| | |
|---|---|
| 審查日期 | 2026-08-11 |
| Codex 版本 | codex-cli 0.146.0（MCP，`sandbox: read-only`、`approval-policy: never`） |
| 審查範圍 | commit `c284679` 的 diff：`index.html`、`app.js`、`tests/_ui-harness.mjs`、`tests/formulary-ui.test.mjs`、`sw.js`、`tests/sw.test.mjs` |
| 基準 commit | `71243c9`（main，PR #14 合併點） |
| 規格 | `.ai-review/plan-v5-formulary.md` v5.9 的 §5.2／§5.3／D34.1／D34.2a／D37.1／D39–D47、驗收 C40–C50／C52 |

> 註：Codex 讀的是 `c284679`。之後主持人自查的 S-1／S-2 修正（成績卡母體、
> 院內版重抽失敗不得走 `fatal()`）已另行提交，行號會與下文略有位移。
>
> 以下為 Codex 原始輸出，**未經修飾或刪改**。覆核判定見 `verdict-v5-ui.md`。

---

結論：發現 **3 項 High、5 項 Medium、2 項 Low**。最高風險是：

- localStorage 讀取失敗後仍可能覆寫既有院內清單。
- `excluded.json` 舊 Promise 的失敗結果可以蓋過較新的成功操作。
- 現有測試沒有實際走到院內版的遞補、L2 備援、複習卷與閃卡路徑，仍存在未被變異測試守住的子集洩漏面。

唯讀執行 `node --test tests/formulary-ui.test.mjs tests/sw.test.mjs`：68/68 通過。未修改任何檔案。

## 區塊 1 — Code review

### CR-1

**app.js:402-412、530-539 / High / 問題描述：** `readFormulary()` 用同一個 `null` 表示「key 不存在」及「localStorage access/getItem/JSON/schema/decode 失敗」。`bootFormulary()` 無法區分兩者；若同時有合法 `?fx=`，仍會呼叫 `activateFormulary(...persist:true)`，最後在 504 行執行 `writeFormulary()`。因此讀不到舊值時仍可能覆寫它，直接違反「讀取失敗時不得寫入」，也可能靜默弄丟未來 schema 的 payload。

**建議修法：** 將讀取結果改成 tri-state，例如 `{status:'ok', payload}`、`{status:'absent'}`、`{status:'error'}`。只有 `absent` 才允許 URL payload 寫入；`error` 必須保留 `fx`、顯示錯誤且 mutation 為零。

### CR-2

**app.js:617-650 / High / 問題描述：** `loadExcluded()` 只在成功路徑的 629 行檢查 `op`。若第一次開頁的 request A 尚未完成，返回後再開頁啟動 B；B 先成功後，A 晚到並失敗，A 仍會在 625-627 行寫入 `state.excludedError`。舊操作因而可蓋過較新的成功結果，之後 `analyzeFormulary()` 優先讀到 error，產連結被停用。這違反 D46「只有當前 operation 可以 commit」。

**建議修法：** catch 內也先檢查 `op !== state.fxOp`；所有成功、HTTP/JSON 失敗及 schema 配對失敗的 commit 都必須共用同一個 current-op gate。另以可延遲、可指定完成順序的 fetch 測試覆蓋「A 晚失敗、B 先成功」及反向順序。

### CR-3

**app.js:448-455 / Medium / 問題描述：** 字串層 cleanup 在一般的 `a=1&fx=…&b=2` 正確，也會保留值內的 `=`、fragment、`fxx`、`afx`；但並未完全做到 D44.3 的「其餘 query 精確保留」：

- `filter(kv => kv)` 會刪除原 query 中的空 segment，例如 `?a=1&&fx=…&b=2&` 會變成 `?a=1&b=2`。
- `URLSearchParams.get('fx')` 會把 `%66x` 視為 `fx`，但 cleanup 比對 raw key，無法移除 `%66x`，形成已成功消費卻仍留在 URL 的狀態。

**建議修法：** 在 raw query 上定位「解碼後名稱恰為 `fx`」的 segment，只刪除該 segment及其必要的一個相鄰分隔符；其他字元序列原樣拼回。新增頭／中／尾、空 segment、encoded key、值含 `=`、只有 fragment、`fxx`／`afx`案例。

### CR-4

**app.js:433-436、534-540 / Medium / 問題描述：** `?fx=` 或 `?fx` 會得到空字串，接著被 `if (fx)` 當成沒有參數。結果沒有執行 decoder、沒有錯誤訊息，也沒有明確處理 URL；與 §5.3「含 `?fx=` → 完整解碼，失敗要提示並保留 fx」不符。

**建議修法：** 回傳 `{present, value}`，或分開使用 `searchParams.has('fx')` 與 `get('fx')`。只要參數存在就必須進 decoder，空值應走 decode failure。

### CR-5

**app.js:725-729 / High / 問題描述：** URL 超限訊息把 `cls.matched.length` 稱為「清單 X 品項」。但 URL 實際編入的是 `cls.payloadIds`，其中還包含 `excluded.json` 的來源已知未命中品項；原始相異清單則是 `cls.distinct`。因此畫面上的 X 既不是完整清單數，也不是造成 URL 長度的 payload id 數，屬明確數字誤導。

**建議修法：** 依 D42 定義清楚 X。若指使用者清單，顯示 `cls.distinct`；若要解釋 URL 體積，另列「其中 `cls.payloadIds.length` 筆進入連結」。不要使用 matched 數冒充清單總數。

### CR-6

**app.js:484-501 / Low / 問題描述：** `state.fxOp` 確實在驗證前被遞增，所以若把 D44.1/C42 的「記憶體完全不變」按字面涵蓋所有內部欄位，現況不符合。另一方面，該遞增是 D46 用來立即使舊 operation 失效的 coordination token，不是 active formulary 的發布；把它移到驗證後會削弱 D46。

**建議修法：** 不建議單純下移 `++`。將 operation epoch 移出可發布的 domain state，並在規格明確排除純協調 token；C42 snapshot 應精確列出 `fx/items/index/eligible/lookAlike/questions/storage` 等領域狀態。若規格堅持所有記憶體位元都不變，則須重新協調 D44.1 與 D46。

### 特別路徑核查

- **state.items/state.index 子集接線：無 production 漏接發現。**
  - 正常重抽：app.js:950-953。
  - 圖片作廢遞補：app.js:1296-1312。
  - 閃卡 index／備援：app.js:1587。
  - 複習卷：app.js:1904-1909。
  - `replaceOption()` 使用題目內已由 probe 產生的 `q.spares`，沒有另讀全庫。
  - 成績由 `state.questions` 計算；院內版不寫 record。
  - `poolHash()` 讀全庫 `content_hash`，但只作資料版本診斷，不是抽題來源，且院內版不寫紀錄，不構成子集洩漏。

- **`state.eligible`／`state.lookAlike` 清空時機：無發現。** 兩者只在 storage 成功後的 commit 階段清空；decode、比對、probe 或 storage 失敗都不會清空。

- **5000 行輸入：無 production 缺陷。** 分類雖同步執行，但 probe 的實際 matched subset 上限受 pool 大小限制；DOM 明細又限 50 行。建議補壓力測試，但 5000 行本身不需要引入 worker 或工具鏈。

## 區塊 2 — Test gap analysis

### TG-1

**tests/formulary-ui.test.mjs:569-604 / High / 問題描述：** C48 測試實際沒有注入所宣稱的讀寫失敗：

- 580 行的 setup 隨即被 `boot()` 內 71 行的 `storeControl.reset()` 清掉。
- 583 行重新 setup 時，app 啟動與 URL 寫入早已完成。
- 587 行只檢查 `clear()`，沒有檢查 `setItem`／`removeItem`。
- setItem 案在 598 行注入後，又被第二次 `boot()` reset；603 行反而斷言院內版已發布。
- 完全缺少規格明列的壞 JSON與 schema 不合案例。

弱化實作「讀失敗後照樣 setItem」或「setItem failure 仍發布」都會通過，CR-1 因此未被抓到。

**建議修法：** 讓 `boot()` 接受 storage fault 參數並在 reset 後、import 前套用。每案斷言完整 mutation log 為零、兩個 key 位元組不變、URL 保留且院內版未錯誤發布。

### TG-2

**tests/_ui-harness.mjs:342-356、tests/formulary-ui.test.mjs:173-211 / High / 問題描述：** fetch 樁只能立即完成，無法保留 deferred Promise 或控制 A/B 完成順序；D47 測試只有單次 request。因此 D46 的核心弱化實作「只在 success 檢查 epoch，stale failure 仍 commit」會全綠，正好漏掉 CR-2。

**建議修法：** 增加 deferred fetch control，可個別 resolve/reject；至少測 A→返回→B、B 先成功、A 後失敗，以及 A/B 皆成功但完成順序相反。

### TG-3

**tests/formulary-ui.test.mjs:215-282 / High / 問題描述：** C41 第一卷只檢查 probe 物件已含的 options/spares；第二回合只走 L1 正常重抽。沒有實際觸發：

- `drawSpareQuestion()` 圖片作廢遞補。
- L2 `replaceOption()` 誘答圖片備援。
- `drawSpareCard()` 閃卡遞補。
- `drawRetryQuiz()` 錯題複習卷。

弱化實作可只讓正常 `drawLeveledQuiz()` 使用 `state.items/index`，上述任一路徑改回全庫仍全部通過，屬未守住的子集洩漏。

**建議修法：** 沿用現有 img fault control，逐路徑強迫實際替換，並由渲染結果或載圖 src 證明正解、誘答、spare、flash card、retry option 全部封閉於院內 subset。

### TG-4

**tests/formulary-ui.test.mjs:318-370、466-543、717-765 / High / 問題描述：** 仍有沿級別維度切割不足：

- C45 只驗 L2 禁用；弱化實作可只對 L2 套 `levelOff()`。
- C52 probe identity／零 RNG 只驗 L1；L2 或 L3 可在開始時重抽。
- C46 正常卷只驗 L1、短卷只驗 L3；院內 L2 若仍寫 record 不會被抓。
- C43 結算頁只驗 L1，L2 只驗切換後答題頁，L3 未驗。

**建議修法：** 對 L1/L2/L3 建立表驅動案例。至少每級各驗 disabled guard、probe-first-quiz identity、院內 record mutation 為零及答題／結算 N/K。

### TG-5

**tests/formulary-ui.test.mjs:546-565 / Medium / 問題描述：** C47 規格要求「records 的精確預期更新」，測試只驗有 mutation、key 是 records、key 存在。弱化實作寫入 `{}`、錯誤分數、錯級別或固定假紀錄都會通過。

**建議修法：** 以固定日期/RNG/答案序列建立獨立 expected record，解析 storage 後逐欄精確比對 schema、level、score、streak、date、pool hash。

### TG-6

**tests/_ui-harness.mjs:125-247、tests/formulary-ui.test.mjs:690-713 / Medium / 問題描述：** C50 宣稱完整 sink inventory，但 property assignment 只監控 `img.src`、`a.href`、`a.download`。app.js 實際還使用 `img.alt`、input/textarea `.value`、`.disabled`、`style.width` 等 property sink；generic `setAttribute` 雖有記錄，不能覆蓋 property assignment。這不符合 C50 明列的「各 attribute property assignment」。

**建議修法：** 對樁實際支援、且 app.js 實際使用的 property setter 建立清冊與 sentinel；至少補 `value`、`alt`、`src`、`href`、`download`。純狀態 property 如 `disabled` 可列為非字串 sink並說明排除理由，不能默默漏列。

### TG-7

**tests/formulary-ui.test.mjs:59-83、tests/_ui-harness.mjs:249-373 / Medium / 問題描述：** cache-busting import 只隔離 module state，沒有隔離舊實例的 pending callbacks。每次 `installDom()` 都覆寫 global `document/window/fetch`；舊 module 的 `$()` 在 callback 執行時會讀新的 global document。舊 fetch Promise、圖片 timeout 或 timer 晚到時，可能改到下一個 boot 的 DOM/control。現有 60ms 等待不是生命週期隔離保證。

**建議修法：** 每次 boot 登記並取消 timer/deferred；或讓 harness 使用 per-instance document capture。另加 sentinel 測試：boot A 留一個 pending callback，boot B 後才完成 A，斷言 B 完全不變。

### TG-8

**tests/formulary-ui.test.mjs:123-169 / Low / 問題描述：** §5.2 的不產連結分支未完整驗收：空輸入、三級全不可用、完整 URL 超限及大量輸入都沒有專門測試。弱化實作可對這些分支靜默失敗、留下上一輪連結，或顯示錯誤數字而全綠。

**建議修法：** 增加表驅動拒絕案例；每案斷言原因非空、舊 `fxLinkBox` 被隱藏、數字來源正確。5000 行案例至少驗完成時間在合理門檻、畫面明細最多 50 行、下載仍完整且 UI 不保留舊 draft。

## 區塊 3 — Dependency audit

無。commit 未新增 runtime 或 test dependency；維持零依賴、零建置架構。`formulary.js` 已加入 SW shell，CACHE 由 v4 升至 v5，相關測試通過。

## 區塊 4 — 規格符合度稽核

| 條款 | 結果 | 實作對照 |
|---|---|---|
| §5.2 | 部分符合 | tokenize/classify/render/download/encode/probe/link 流程存在於 app.js:678-800；超限的 X 數字不符，見 CR-5。 |
| §5.3 | 部分符合 | 載入、降級、probe、storage、memory switch、cleanup 及 N/K UI 存在於 app.js:468-599；空 `fx` 與讀失敗後寫入不符，見 CR-1、CR-4。 |
| D34.1 | 符合 | app.js:707-710 使用 `payloadIds + unlistedCount`；接收端 app.js:508-515 保留 payload/unlistedCount。 |
| D34.2a | 符合 | UI 直接使用分類後的 `payloadIds`、`unlistedCount`；超界由 encoder error 分支拒絕，app.js:709-715。 |
| D37.1 | 符合 | app.js:554-557 使用正式 CATEGORY_LABEL；index.html:404-405、490-491、536-537 無「查無此證」。 |
| D39 | 符合 | app.js:885-887 使用 probe `quizLen`；app.js:943-953 使用短卷產物／卷長。 |
| D40 | 符合 | app.js:1658-1663 院內版 `record:false`。 |
| D41 | 符合 | app.js:508-520 只切換 active subset；app.js:569-575 顯示 missing/all-disabled；未覆寫 canonical payload。 |
| D42 | 部分符合 | app.js:725-730 量完整 URL 並硬拒絕；錯誤訊息的「清單 X」錯用 matched，見 CR-5。 |
| D43 | 符合 | URL decode 後只 join pool；原始未命中明細走 app.js:763-770 `textContent`，下載走 Blob。 |
| D44.1 | 部分符合 | storage→memory→cleanup 順序正確；`fxOp` 使「所有記憶體不變」字面不成立，見 CR-6。 |
| D44.2 | 符合 | 產生與 cleanup 都沒有 `v` 參數，app.js:742-745。 |
| D44.3 | 部分符合 | 一般 query/fragment 正確，但空 segment與 encoded key 不精確，見 CR-3。 |
| D45 | 不符合 | schema 寫入格式正確，但讀取失敗與 absent 無法區分，導致後續可能寫入，見 CR-1。 |
| D46 | 不符合 | stale success 有 gate，stale failure 無 gate，見 CR-2。 |
| D47 | 部分符合 | 單次 fetch/schema/hash 失敗可只停用產連結；競態下舊失敗可錯誤停用新版結果，見 CR-2。 |
| C40 | 實作符合；測試大致符合 | 四類 UI/下載同源；大量與拒絕分支缺口見 TG-8。 |
| C41 | 實作符合；測試不足 | 主抽題與所有現有接線使用 subset；runtime 遞補／閃卡／複習未驗，見 TG-3。 |
| C42 | 部分符合 | active formulary/storage 在 decode failure 保留；完整 memory snapshot 的 `fxOp` 語意未釐清，見 CR-6。 |
| C43 | 實作符合；測試維度不足 | index.html:490-491、536-537 與 app.js:592-599 分開產生 N/K；缺級別矩陣見 TG-4。 |
| C44 | 符合 | payload 不覆寫，subset 依當前 pool 重建。 |
| C45 | 實作符合；測試維度不足 | app.js:834-887、930-935 有 semantic disabled 與雙重 guard；只驗 L2，見 TG-4。 |
| C46 | 實作符合；測試維度不足 | app.js:1658-1663 完全以 `!state.fx` 阻擋；缺 L2，見 TG-4。 |
| C47 | 實作符合；驗收較弱 | 通用版仍寫 records；測試未精確驗內容，見 TG-5。 |
| C48 | 不符合 | 讀取失敗後 URL 路徑仍可寫入；測試注入失效，見 CR-1、TG-1。 |
| C49 | 部分符合 | 一般成功/失敗/cleanup failure 正確；特殊 raw query 不精確，見 CR-3、CR-4。 |
| C50 | 實作符合；測試清冊不完整 | raw token只經純文字與 Blob；property sink inventory 缺漏，見 TG-6。 |
| C52 | 實作符合；測試維度不足 | app.js:943-947 直接消費 probe quiz，之後設 null；只驗 L1，見 TG-4。 |

C51 未納入判定，依要求不列為發現。
