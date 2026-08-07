# Codex 程式碼覆審原文 — 批次 B（M5 錯題再戰）實作

> **審查日期**：2026-08-07
> **審查工具**：Codex（`mcp__codex__codex`，`sandbox: read-only`、`approval-policy: never`）
> **thread**：`019fdb78-1ef3-7f31-91bb-11108624ad3b`
> **審查範圍**：`feat/v4-m5-retry` 相對 `main` 的兩個 commit
> — `f7e76d4`（engine 層）、`3b242d9`（app 層）
> **對照規格**：`.ai-review/plan-v4-engagement.md` v4.6
> **判定**：見 `verdict-m5.md`
>
> 本檔為 **Codex 原始輸出，未修飾、未刪改**。表格內的 `&amp;&amp;` 是原輸出即有的
> HTML 轉義。事實正確性由判定檔逐項回讀該檔該行核對，**不在此檔修正**。

---

以下為唯讀覆審結果。結論：M5 主要成功流程可運作，未發現目前程式直接用 `drawSpareQuestion()` 產生複習題；但有 2 項 High 規格／測試缺口，會讓「原子發布」與「混入非錯題」防線呈現假綠。

## 1. Code review

### 發現

- `app.js:1335-1349` / **High** / `startRetry()` 在 L2 四張圖片 ready 之前，就先設定 `state.origin`、切換 `mode='retry'`、隱藏原結算頁並顯示答題頁。真正的 L2 ready-gate 要到 `renderGrid()`／`loadCell()` 的非同步載入後才成立（`app.js:632-710`）。這違反 D28.1「資源前置條件成立後才發布」，也使圖片失敗實際成為「先發布再回滾」 / **建議修法：**在 app 層增加 L2 候選卷資源預載階段；全部必要圖片 ready 後才執行現有 `state.origin = …` 發布區塊。失敗時只顯示 `retryFailed()`，不得切換畫面。此作法不把 DOM/state 帶進 engine，也不需第三方套件。

- `engine.js:563-608,830-877` / **Medium** / 規格與註解宣稱正常卷、retry 卷只有階段 1 不同，階段 2、3「完全共用同一條路徑」；實際上 `drawRetryQuiz()` 複製了組題迴圈、`buildChoices()`、`assertQuizInvariants()` 與錯誤處理。兩份實作目前語意相近，但已是第二套可漂移的組裝程式 / **建議修法：**在 engine 內抽出純函式內部 helper，接收已決定的正解紀錄／答案鍵，統一執行階段 2、3；`drawLeveledQuiz()` 與 `drawRetryQuiz()` 只各自負責階段 1。

- `app.js:741-749,1359-1366` / **Medium** / 正常生命週期可收斂，但狀態損毀路徑不收斂：`voidCurrent()` 遇到 `mode='retry'` 且 `origin=null` 時直接 `fatal()`，沒有清除 retry state；`exitRetry()` 同情境則直接 no-op。結果仍留在 `mode='retry'` / **建議修法：**兩個防禦分支都先 `clearRetryState()`，再進 fatal 或可恢復提示；測試直接注入不一致狀態，斷言最後 `mode='quiz' && origin===null`。

- `index.html:374` / **Medium** / D33 要求複習答題頁任何時候都看得出「複習、不計入紀錄」，但 `#qRetryTag` 只顯示「錯題複習」，未寫「不計入紀錄」。現有靜態測試也只檢查 `/複習/` / **建議修法：**改為「錯題複習（不計入紀錄）」；C39 同時釘住「複習」及「不計入紀錄」。

- `index.html:449,454`、`app.js:1155-1156,1213` / **Medium** / D33、C30、C38 明寫控制項在 DOM 中「不存在」，實作只是套用 `hidden` class；節點與 click listener 始終存在。handler 的 mode/零錯題守衛目前可避免實害，但不符合既有承諾 / **建議修法：**若「不存在」是硬契約，動態插入／移除控制項；若產品決策其實是「不可見且程式化呼叫 no-op」，應先修訂規格與驗收文字，不應讓測試把 hidden 當不存在。

- `app.js:1157-1167` / **Low** / D29 說複習結算頁「只顯示」三項內容，但 retry 分支仍寫入並顯示 `resultBadge` 的級別徽章；C36 未檢查它 / **建議修法：**retry 時隱藏 `resultBadge`，或明確把級別徽章加入 D29 正面契約。

### 已確認符合

- `state.origin` 正常成功路徑：發布時建立、`exitRetry()` 與 retry 圖片失敗時恢復原卷後清空、`backToStart()` 清空。
- 建構器同步拋錯時只改回 `retryBuilding=false`，未切換 mode、origin 或原結算內容。
- retry 不會呼叫 `writeRecords()`：`finish()` 傳入 `record:false`，retry `renderResult()` 提前 return，`exitRetry()` 亦用 `record:false`。未發現 localStorage mutation 或 `state.records` 污染路徑。
- `renderReview()` 欄數正確：
  - 正常 L1/L2：5 欄。
  - 正常 L3：4 欄，既有「你的作答」仍放答對／答錯。
  - retry L1/L2：4 欄；retry L3：3 欄。
- Canvas 成績卡仍為純文字／圖形，未新增藥品圖片繪製。

## 2. Test gap analysis

指定的 M5/SW 測試共 68 條全部通過。以下逐條回答「何種壞實作仍可通過」。

### `tests/retry.test.mjs`：30 條

| 檔案:行號 / 嚴重度 | 可通過但壞掉的弱化實作 / 建議修法 |
|---|---|
| `retry.test.mjs:43` / Low | 針對這組固定答案字串硬編碼；其他 LOCKED malformed input 行為仍錯。加入動態產生答案與缺 `item` 契約。 |
| `:62` / Low | 只特判 `mark===0.5` 的 A/B fixture。與第一條高度重疊；改由真實 `transition(hint→submit)` 產生狀態。 |
| `:69` / Low | 只特判 VOID，不保證其他非 LOCKED 狀態被排除。與混合 fixture 合併做表驅動。 |
| `:74` / Low | 只對 X/Y 保序；其他輸入可排序。改用隨機但固定 seed 的唯一鍵序列。 |
| `:86` / Low | 對所有 nullish／空陣列回空，但正常輸入完全錯，仍可通過本條；由其他正向測試補足。 |
| `:92` / Low | 只辨識「兩題全對」fixture。加入不同長度與提示後答對。 |
| `:152` L1 / Medium | 只抽每層約 6 個、且 items 只比前 50 筆；可破壞其他鍵或後段資料。依 A31 每 strata ≥20 distinct，完整深比 items/index。 |
| `:152` L2 / Medium | 同上；L2 特有資料分布仍可在未抽中的 strata 壞掉。 |
| `:152` L3 / Medium | 同上；且不驗傳入 token，實作固定從 1 起仍過。 |
| `:187` / Medium | 建構器可不呼叫 validator，只要目前 fixture 天然合法；測試最後自行呼叫 validator 仍綠。須注入違規 validator。 |
| `:205` / Medium | 只測不存在的假鍵；實作可忽略傳入 eligible、接受「index 中存在但不在 eligible」的真鍵。加入真實 excluded key，並驗輸入零副作用。 |
| `:217` / Low | 只守空集合；非空但部分失敗時靜默剔除由此條看不到。 |
| `:234` L1 / Medium | 容許 5 鍵中 1 鍵正解位置固定，違反 A32「同一鍵」性質；仍使用 80% 統計門檻。對每個指定鍵個別要求 ≥3。 |
| `:254` L1 / Medium | 只驗第一個 sampled key，且只比三個欄位，不是完整深相等。 |
| `:267` L1 / Medium | 只驗第一鍵且先排序；選項順序永遠固定、只換一個誘答仍可過。應逐欄驗選項順序與內容。 |
| `:234` L2 / Medium | 同 L1，允許 20% 鍵固定位置。 |
| `:254` L2 / Medium | 同 L1，只守單一鍵與部分欄位。 |
| `:267` L2 / Medium | 同 L1；無法證明圖片紀錄及排列都受 RNG 控制。 |
| `:282` / High | 假鍵在組題前就被 eligible precheck 擋下，並未真的測「組到中途才失敗」；先把部分結果寫入共享區再 precheck 仍可能過。注入某合法鍵的 `NO_DISTRACTORS`。 |
| `:301` / High | 只產生 H1；只攔 H1 的 validator allowlist 即可通過。注入任意未知違規碼。 |
| `:319` / Medium | 只比較 `index.keys` 與 bucket 長度；可改動 `items`、byAns 內容、eligible 或紀錄欄位而不被發現。完整深比。 |
| `:339` L1 / Low | 只涵蓋 sampled 單筆鍵；其他單筆鍵可失敗。增加規格要求的分層數量。 |
| `:354` L1 / Medium | 混合 2–4 與 ≥5 類、只要求 80% 變化；可能完全沒測恰 2 筆。分兩類各自斷言指定 seed 產生不同 id。 |
| `:339` L2 / Low | 同 L1 單筆。 |
| `:354` L2 / Medium | 同 L1 多筆；全域計數器若針對呼叫節奏設計仍可能假綠。 |
| `:339` L3 / Low | 同 L1 單筆。 |
| `:354` L3 / Medium | 同 L1 多筆；`one(5)===one(5)` 不是完整 deep reproducibility。 |
| `:388` L1 / Low | 只用 eligible 集合前 20 鍵；其他合法鍵或排列可壞。 |
| `:388` L2 / Low | 同上。 |
| `:388` L3 / Low | 同上；外部再呼叫 validator 不能證明正式建構器有接 validator。 |

A31 的規格要求每級每 strata ≥20 distinct；目前 `perStratum=6`，最短／最長更各只有 3，是明確未達標。

### `tests/retry-ui.test.mjs`：25 條

| 檔案:行號 / 嚴重度 | 可通過但壞掉的弱化實作 / 建議修法 |
|---|---|
| `:112` / Medium | 只走 L3 且全答錯；實際題卷可錯、最後偽造 review HTML 為 K 仍過。至少增加 L1/L2，並以真實答對驗 judge 與題卷一致。 |
| `:149` / Medium | N=1 不驗鍵等於 K，也不驗 D29 全契約。 |
| `:163` / Medium | N=20 同樣不驗 K、順序、逐題可答與返回完整欄位。 |
| `:179` / Medium | 只驗未提示答對；D29 明訂「提示後答對計入 M」仍未測。加入 hint→correct。 |
| `:195` / **High** | 可先呼叫 `drawSpareQuestion()` 混入非錯題，再立即回原卷；最終 DOM／列數仍完全相同。必須觀測遞補呼叫次數為 0，並在失敗當下記錄 retry 鍵集合從未新增。 |
| `:229` / Medium | 只用原摘要辨識 origin；其他原卷欄位仍可能來自 retry。 |
| `:267` / High | 靜態掃描只找幾個 literal；可由 helper、alias、computed property 在 build 前改狀態／DOM。應由正式入口注入失敗並做行為斷言。 |
| `:282` / High | 只匹配 catch 原始碼形狀；`finally` 或 helper 可照樣發布。未知 violation 未實際注入。 |
| `:296` / High | `doesNotMatch(validateQuizInvariants)` 只能證明 app 沒重複驗，完全不能證明完整候選卷送進 engine validator。需可觀測 validator spy。 |
| `:308` / Medium | 只驗已知容器 hidden；可把分數／稱號輸出到其他元素。也未驗提示後答對的 M。 |
| `:325` / Medium | 只走 L3 前 3 題、無提示；L1/L2 retry live streak、提示路徑可壞。 |
| `:347` / Low | 只觀測 Canvas `fillText`；若錯誤實作仍建立空 blob／觸發下載但不畫文字，可能通過。記錄 anchor click、toBlob 呼叫。 |
| `:365` / **High** | 名稱宣稱「不延後寫入」，實際未清空 timers/microtasks 後再查；延遲 storage mutation 可通過。加入完整排程 drain。 |
| `:384` / **High** | 後續正常卷是 100 分，高於原 25 分；retry 若把最佳分污染成 60，100 仍會覆寫，看不出污染。依 C28 分別設計低於 retry 的 bestScore 與 bestStreak。 |
| `:403` / High | 測試名稱宣稱級別、提示不同，實際 origin/retry 都是 L3、retry 全答錯且無提示；也無法直接驗 origin 唯讀與清空。 |
| `:428` / High | 只驗成績卡含 `25.0` 與「困難級」，未驗全部繪製內容、逐題、提示、基線、題數。 |
| `:442` / Medium | 名稱說「成績卡」，實際只檢查 DOM metrics，殘留 origin 僅影響 downloadCard 的實作仍可通過。應真的下載並驗繪製內容。 |
| `:457` / High | 只驗 hidden，不是 DOM 不存在；也沒有 spy 證明未啟動重建。handler 可建構後丟棄而全部斷言仍過。 |
| `:486` / High | 第二次 click 發生在同步建構已完成、`mode='retry'` 之後，沒有測到「建構中再次觸發」。需可暫停的建構 seam。 |
| `:501` / Medium | 控制項仍在 DOM，只是父層 hidden；因此未驗 C38 的「DOM 不存在」。 |
| `:522` / Low | 只驗返回後可再次啟動，沒有直接量測同時 retry session 數量。 |
| `:538` / Medium | 名稱包含「沒有被隱藏」，實際只檢查 ID 字串存在；CSS 由另一條守，命名與證據不一致。 |
| `:547` / Medium | `qRetryTag` 只要求含「複習」，所以缺「不計入紀錄」仍綠。 |
| `:561` / High | CSS scanner 漏掉 `.retry-note.foo`、attribute selector、`:is()`、巢狀規則、`opacity:calc(0)` 等；解析失敗也沒有 fail-closed。應用受限但明確的 selector tokenizer，遇到無法解析規則直接失敗。 |
| `:580` / Medium | regex 可被註解、重複假節點或不合法巢狀 markup 騙過；不保證實際唯一節點關係。可用既有零依賴 HTML token 掃描器，並拒絕 duplicate id。 |

### 尚未涵蓋的重要流程

- L1、L2 完整 retry UI 流程完全未執行；`playL1()` 定義於 `retry-ui.test.mjs:59`，但沒有任何測試呼叫。
- L2 正解格、誘答格、備援耗盡三種 retry 圖片失敗路徑未測。
- L2/L3 retry 提示功能未測。
- 建構失敗與任意 validator 違規沒有從正式 app 入口行為注入。
- `backToStart()` 從 retry 狀態被程式化觸發的生命週期未測。
- `origin=null && mode='retry'` 的防禦分支未測。

## 3. Dependency audit

- `package.json` 無 `dependencies`、`devDependencies`，符合零 npm 依賴與無建置步驟。
- Python 正式圖片管線使用 `uv run --locked --script tools/fetch-images.py`，並存在 `tools/fetch-images.py.lock`；套件版本、wheel/sdist URL 與 SHA-256 均鎖定。
- `tools/make-icons.py` 由 `uv run --script` 執行但不是正式更新 workflow 的網路供應鏈路徑；若要求所有 Python 工具完全可重現，可另替它建立 lock，但不屬 M5 缺陷。
- `.github/workflows/update-pool.yml` 的 4 個 action 均釘 40 字元 commit SHA：
  - `actions/checkout`
  - `actions/setup-node`
  - `astral-sh/setup-uv`
  - `actions/github-script`
- localStorage key 為 `tfda-drug-id-quiz:records`，符合與 pharmacy-portal 同源時的 repo 前綴要求。
- 本環境離線且網路受限，無法查詢即時 OSV／GHSA；因此不能聲稱鎖檔套件目前無已知漏洞，也未臆測任何 CVE。

## 4. 規格符合度稽核

### D 條款

| 條款 + 實作 | 結論 |
|---|---|
| **D28** + `engine.js:807-877` | **部分符合。**K 定義、固定正解鍵、H2 exclude set、紀錄重抽及 validator 都正確；但階段 2/3 是複製程式，不是宣稱的共用同一路徑。 |
| **D28.1** + `app.js:1300-1349,620-710` | **不符合。**純建構與 invariant 通過後才改 mode/origin；但 L2 ready-gate 尚未成立就已發布。 |
| **D29** + `app.js:1132-1231,1371-1376` | **大致符合。**零 storage mutation、無稱號／分數 metrics／成績卡、M 用答對題數、live streak 隱藏。偏差是 retry 結算仍顯示級別 badge，且答題頁標示沒寫「不計入紀錄」。 |
| **D30** + commits `f7e76d4`、`3b242d9` | **符合。**engine 與 app 分兩 commit 交付，沒有把 app state/DOM 帶進 engine。 |
| **D31** + `app.js:86-100,1273-1366,1508-1516` | **正常路徑符合；防禦路徑部分不符合。**origin 只存 questions/quizLevel，返回走同一 renderResult；但 origin 遺失時的 void/exit 不收斂。 |
| **D33** + `index.html:370-456`, `app.js:1151-1214` | **部分符合。**控制項接線、N、頁面切換及失敗提示都有；答題標示未說「不計入紀錄」，且「DOM 不存在」被實作成 hidden。 |

### A30–A35

| 條款 | 結論 |
|---|---|
| **A30** + `retry.test.mjs:43-97` | **符合。**六類反例、順序、重複長度都有。 |
| **A31** + `:102-224` | **不符合。**每 strata 僅 6，最短／最長各 3，未達各 ≥20；items/index 也非完整深比，noneligible 失敗未驗零副作用。 |
| **A32** + `:228-275` | **不符合完整承諾。**三級位置邏輯目前可變，但驗收仍用 80% 統計門檻，並非逐鍵 controlled reachability；reproducibility 也非完整 deep equal。 |
| **A33** | **已移至 C34，無獨立實作要求。** |
| **A34** + `:279-331` | **不符合。**沒有注入 NO_DISTRACTORS 與任意 validator 非空兩類；輸入深度不變只驗部分結構。 |
| **A35** + `:335-379` | **部分符合。**三級、單筆、多筆皆有跑，但未分別保證「恰 2 筆」與「≥5 筆」，仍採 80% 門檻。 |

### C28–C31、C34–C39

| 條款 | 結論 |
|---|---|
| **C28** + `retry-ui.test.mjs:365-397` | **不符合。**未 drain 排程；下一正常卷用更高 100 分，且未分別驗 bestScore/bestStreak 低於 retry 的情境。 |
| **C29** + `:403-452` | **不符合。**沒有刻意做不同級別／提示，沒有逐欄檢查成績卡全部內容、question id、提示標記與 origin 唯讀。另需指出：C29 要 origin/retry「級別不同」與 D28 以原級別重建的產品流程互相衝突；建議將驗收改成可注入不同 level 的測試 seam，或刪除「級別必須不同」而改驗 `quizLevel` 從 origin 恢復。 |
| **C30** + `:457-477` | **不符合。**只驗 hidden，不是 DOM 不存在；也未證明未呼叫建構器。 |
| **C31** + `sw.js:14-51`, `sw.test.mjs:138-180` | **符合。**install 實際開啟 v4、shell 檔存在、data namespace 含巢狀/query/不存在路徑均零 `respondWith`。 |
| **C34** + `retry-ui.test.mjs:267-303` | **不符合。**全是靜態 source-shape 契約，沒有向正式入口注入具名與未知違規，也沒 spy 完整候選卷。 |
| **C35** + `:195-251` | **不符合。**只驅動圖片失敗，缺重建失敗與 validator 違規；也沒有直接證明遞補呼叫為 0、鍵集合從未增加、排程清空後仍不變。 |
| **C36** + `:308-359` | **部分符合。**主要正負 UI 有驗；缺提示後答對計入 M，且「不存在」多以 hidden 代替。 |
| **C37** + `:112-189` | **部分符合。**L3 成功鏈與 N=1/N=20 可走完；只有主 N=15 案驗 K，邊界未驗 K，且沒有 L1/L2 跨層成功流程。 |
| **C38** + `:486-532` | **不符合建構中場景。**所謂雙擊第二次發生時建構已同步完成，只測到 retry 中 no-op；複習結算按鈕也只是 hidden。 |
| **C39** + `:538-593` | **部分符合／人工部分無法驗證。**有靜態 CSS 掃描，但命中規則不足且解析未 fail-closed。repo 中未找到本批真實瀏覽器截圖／PDF 留檔，因此實際可見性、對比、觸控尺寸無法確認；不應在目前 DOM stub 上補 layout/media assertion。 |

### v4.6 的 LOCKED 白名單推論

**推論正確。**

- `newQuestion()` 在 `engine.js:242-250` 將 `correct` 預設為 `false`。
- `transition(hint)` 在 `engine.js:211-222` 只改 state、mark、chance，`correct` 仍為 false。
- `transition(submit)` 在 `:224-226` 才把題目鎖定並寫入真假。
- `transition(fail)` 在 `:228-229` 產生 VOID、correct false。

因此舊條件 `state !== VOID && correct === false` 確實會誤收 PENDING 與 HINTED。新條件 `state === LOCKED && correct === false` 精確收錄未提示／提示後答錯，排除未作答、提示未答、作廢、答對及 nullish correct。

未發現改為 LOCKED 白名單後漏掉合法錯題情境；前提是作答狀態只能經既有 `transition()` 進入終態。 malformed 外部物件不是正式 session 可達狀態，測試亦已排除 LOCKED + null／undefined。

### 測試執行狀態

- `node --test tests/retry.test.mjs tests/retry-ui.test.mjs tests/sw.test.mjs`：**68/68 通過**。
- 完整 `node --test "tests/**/*.test.mjs"`：357 通過；另 6 條失敗／取消，原因是唯讀環境禁止建立 uv cache 與 Temp 目錄，集中於 `fetch-images`／pipeline 測試，與 M5 邏輯無關。
- 未修改任何檔案。
