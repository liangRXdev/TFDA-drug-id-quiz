# Codex 覆審報告 — v3 難度分級

> **審查日期**：2026-08-01
> **Codex 版本**：codex-cli 0.146.0（`codex exec -s read-only`）
> **審查範圍**：`feat/difficulty-levels` 相對 `main` 的 4 個 commit
> **commit hash**：`151539e` 基礎建設、`8ca1b57` L1、`e39146d` L2、`8806bef` 真機測試修正
> **落檔說明**：以下為 Codex 原始輸出，**未經修飾或刪改**。逐項判定見 `verdict-v3.md`。

---

結論：**目前不建議合併**。沒有發現 Critical，但有 2 項 High：G1 的 80% 可解性門檻從未實際量測，以及資源失敗遞補會重新破壞 D19/H2。

唯讀驗證結果：

- `git diff main...HEAD`：12 個檔案、3,773 行新增、61 行刪除。
- `npm.cmd test`：119/119 通過。
- `npm.cmd run verify`：3,913 筆、圖片一對一、WebP 解碼、尺寸、雜湊、孤兒資產均通過。
- `git diff --check`：通過。
- 工作樹維持乾淨，未修改檔案。

## 1. Code review

- [app.js:109](C:/Users/liang/projects/TFDA-drug-id-quiz/app.js:109) / Low / `meta.source`、`source_file` 與 `featureCell()` 的題庫欄位在 [app.js:266](C:/Users/liang/projects/TFDA-drug-id-quiz/app.js:266) 未 escape 即寫入 `innerHTML`。本案無憑證且資料同源，依威脅模型評為 Low；但污染題庫可藉事件屬性偽造題目 UI。 / 所有題庫文字先經 `escapeHtml()`；需要結構的部分改用 DOM API 或只對固定模板使用 `innerHTML`。

- [app.js:470](C:/Users/liang/projects/TFDA-drug-id-quiz/app.js:470) / High / `drawSpare()` 逐筆選第一個未使用答案鍵，只以目前正解集合呼叫 `buildChoices()`，沒有排除「已出現在既有題目 options/spares 的答案鍵」。以真實題庫可重現：L1 seed 29、L2 seed 59 的遞補正解 `SODIUM BICARBONATE` 已存在於原卷誘答，破壞 H2；同時答案鍵與同鍵紀錄都不是均勻抽樣。 / 從「未使用且未出現在任何現存 options/spares」的可用答案鍵中均勻抽樣，再於該鍵紀錄中均勻抽一筆；加入後重驗整卷 H2 與身分不變量。若無候選，明確中止，不可逐筆補抽。

## 2. Test gap analysis

119 項全綠，但下列驗收只測到較弱性質：

- [tests/ui-smoke.test.mjs:244](C:/Users/liang/projects/TFDA-drug-id-quiz/tests/ui-smoke.test.mjs:244) / Medium / C9 只測單一誘答首次失敗；未測規格指定的兩格同時失敗、替換圖再次失敗、兩個備援耗盡。C10 亦未重送同一錯誤事件，也未斷言遞補正解不撞既有誘答。 / 在 harness 增加可依「請求次數」失敗的控制，覆蓋完整 C9/C10 失敗矩陣及更新後全卷 H2。

- [tests/ui-smoke.test.mjs:306](C:/Users/liang/projects/TFDA-drug-id-quiz/tests/ui-smoke.test.mjs:306) / Medium / C11 四種反例只測「LOCKED 後」與「已換題」；缺少最重要的「同題同格已換 src」及「同題其他格」。測試也只比較 DOM，沒有比較完整題目快照與分數。 / 保存失敗前深層快照，手動重送舊 `<img>` 事件，逐一驗證 token、格位、asset id 任一不符時狀態完全不變。

- [tests/ui-smoke.test.mjs:216](C:/Users/liang/projects/TFDA-drug-id-quiz/tests/ui-smoke.test.mjs:216) / Medium / C8 將長度小於 2 的值過濾掉，因此 `白`、`紅` 等單字顏色即使洩漏也會假綠；也未遍歷 `title`、button `aria-label` 等完整 accessibility attributes。 / 不得依字串長度排除特徵值；逐節點檢查可見文字、`alt`、`title`、`aria-label`。目前產品碼的中性 `alt` 本身符合規格。

- [tests/_ui-harness.mjs:160](C:/Users/liang/projects/TFDA-drug-id-quiz/tests/_ui-harness.mjs:160) / Medium / C13 的「實際 blob」被固定 `{size:1}` 取代，只驗證 `fillText` 出現字串；未驗 MIME、非空 PNG、可解碼、1440×1800、檔名、文字座標是否在畫布內、兩種分數或三個級別的實際輸出。 / 使用真 Canvas 實作產生 PNG，解析檔頭與尺寸；記錄 `fillText(text,x,y)`、色彩及字型，斷言內容位於可視範圍，並攔截 `drawImage`。

- [tests/ui-smoke.test.mjs:55](C:/Users/liang/projects/TFDA-drug-id-quiz/tests/ui-smoke.test.mjs:55) / Medium / C16 宣稱三級 e2e，但 L3 全程沒有答對、提示及重複送出；L2 完整回合也未使用提示。 / 每級建立可預知答案的最小回合，明確包含答對、答錯、重複送出；L2/L3 各使用一次提示並驗證最終分數與基線。

- [tests/levels.test.mjs:456](C:/Users/liang/projects/TFDA-drug-id-quiz/tests/levels.test.mjs:456) / Medium / A18 的具名身分鏈只跑 L1 engine 快照，沒有驗證 L2 題幹 `full/zh`、DOM 正解圖、替換後 asset、判定與逐題檢討都指向同一 `correctItem.id`。 / 補一個 L2 全鏈路案例，從 engine 快照一路查到 DOM 與 review。

- [tests/levels.test.mjs:508](C:/Users/liang/projects/TFDA-drug-id-quiz/tests/levels.test.mjs:508) / Low / A20 只證明 L1 的 22 鍵被拒絕；沒有驗證 L1 23 鍵、L2 24/25/26 鍵及門檻通過後確實進入階段 2。 / 依實際門檻加入 L1 22/23/24、L2 24/25/26、L3 19/20/21 邊界。

- [tests/ui-smoke.test.mjs:177](C:/Users/liang/projects/TFDA-drug-id-quiz/tests/ui-smoke.test.mjs:177) / Low / C17 regex 漏掉 `maximum-scale=0.5`，卻把合法且明確允許 pinch zoom 的 `touch-action: pinch-zoom` 當成失敗。 / 解析 CSS/meta 值並判斷數值 `<5`；只拒絕 `none`、阻擋祖先手勢的設定，不拒絕 `pinch-zoom`。

## 3. Dependency audit

- [package.json:1](C:/Users/liang/projects/TFDA-drug-id-quiz/package.json:1) / Low / 沒有 `dependencies` 或 `devDependencies`，符合零執行期依賴；本次 diff 也未新增依賴或 lockfile，未發現 npm 授權問題或可供 `npm audit` 稽核的套件。 / 無需導入套件或 bundler。

- [.github/workflows/update-pool.yml:32](C:/Users/liang/projects/TFDA-drug-id-quiz/.github/workflows/update-pool.yml:32) / High / 既有資料更新 workflow 具有 `contents: write`，卻使用可變且已落後的 `actions/checkout@v4`、`setup-node@v4`、`setup-uv@v5`、`github-script@v7`；Python 的 Pillow/requests 也只有下限、沒有 lock。這是污染題庫的供應鏈入口，故依專案威脅模型評為 High。此問題已存在於 `main`，不是本分支新增。官方現行範例已使用 [checkout v7](https://github.com/actions/checkout)、[setup-node v7](https://github.com/actions/setup-node)、[setup-uv v9 的完整 SHA](https://github.com/astral-sh/setup-uv)；`github-script` 現行 release 亦已到 [v9](https://github.com/actions/github-script/releases)。 / 將 Actions 固定到審核過的完整 commit SHA；以 `uv lock --script` 或精確版本鎖定 Pillow/requests，workflow 使用 frozen 模式。這只影響維護管線，不增加前端執行期依賴。

## 4. 規格符合度稽核

### 實質不符合

- [.ai-review/plan-v3-levels.md:40](C:/Users/liang/projects/TFDA-drug-id-quiz/.ai-review/plan-v3-levels.md:40) / High / G1 規定通過必須達 24/30，但同檔 [第 57–65 行](C:/Users/liang/projects/TFDA-drug-id-quiz/.ai-review/plan-v3-levels.md:57) 明確承認沒有跑 30 題計分、沒有正確率數字，卻仍宣告 gate 通過並解除 D12 阻擋。這是最高權重的「可解性保證」未被兌現。 / 由獨立檢視者完成固定 seed 的 30 題逐題作答紀錄；只有 ≥24/30 才能關閉 gate。未達門檻須依 §0 回到 D12，不可只以主觀目視結案。

- [.ai-review/plan-v3-levels.md:320](C:/Users/liang/projects/TFDA-drug-id-quiz/.ai-review/plan-v3-levels.md:320) + [app.js:470](C:/Users/liang/projects/TFDA-drug-id-quiz/app.js:470) / High / D19 禁止逐題抽＋失敗補抽並要求完整正解集合先確定；初始生成符合，但資源作廢後又退回局部逐筆補抽，且已實證會讓新正解撞上既有誘答，回溯破壞 H2。 / 將遞補也視為兩階段更新：先從不會撞現有誘答的答案鍵集合均勻選正解，再組選項並做整卷驗證。

- [.ai-review/plan-v3-levels.md:313](C:/Users/liang/projects/TFDA-drug-id-quiz/.ai-review/plan-v3-levels.md:313) + [engine.js:490](C:/Users/liang/projects/TFDA-drug-id-quiz/engine.js:490) / Medium / D18/D19 定義 `E` 為每筆紀錄都能組出合法題；L1 eligibility 卻只計算各候選對正解是否合法，沒有驗證候選彼此 H3。測試甚至刻意接受 `eligibleKeys()` 判可用、階段 2 才因 H3 失敗的 fixture。 / L1 階段 1 應以確定性搜尋證明至少存在 3 個兩兩符合 H1/H3 的誘答；階段 2 失敗只保留給 H2 整卷組合衝突。

- [.ai-review/plan-v3-levels.md:340](C:/Users/liang/projects/TFDA-drug-id-quiz/.ai-review/plan-v3-levels.md:340) + [engine.js:591](C:/Users/liang/projects/TFDA-drug-id-quiz/engine.js:591) / Medium / D19 明定回傳前執行整卷 H1–H4、I1–I5 驗證；實作直接 `map()` 後回傳，沒有執行期 validator。測試驗證正常輸出，不能取代規格要求的最後防線。 / 新增純函式 `validateQuizInvariants()`，於初始成卷及每次遞補後執行；失敗歸類為 `QUIZ_ASSEMBLY_FAILED`。

- [.ai-review/plan-v3-levels.md:550](C:/Users/liang/projects/TFDA-drug-id-quiz/.ai-review/plan-v3-levels.md:550) + [engine.js:591](C:/Users/liang/projects/TFDA-drug-id-quiz/engine.js:591) / Medium / D18/§5.2 宣稱 Question 具有 `slotAsset[]`，但 `newQuestion()`、`buildChoices()`、`replaceOption()` 均未產生或更新該欄位；目前只臨時以 `options[k].id` 代替。這正是「規格宣稱欄位存在、實際從未產生」。 / 建題時建立 `slotAsset = options.map(o => o.id)`，替換時與 `options[slot]` 原子更新；L2 load/error event 必須比對 question token、slot token、`slotAsset[k]` 三者。

- [.ai-review/plan-v3-levels.md:360](C:/Users/liang/projects/TFDA-drug-id-quiz/.ai-review/plan-v3-levels.md:360) + [app.js:380](C:/Users/liang/projects/TFDA-drug-id-quiz/app.js:380) / Medium / D21 將解碼失敗列為五種資源失敗之一，且 ready 必須代表「載入並解碼成功」；實作只等待 `onload` 並檢查 `naturalWidth`，從未呼叫或等待 `img.decode()`，測試 harness 也沒有 decode 失敗模式。 / `src` 設定後以同一個 `settled` guard 等待 `img.decode()`；reject、零尺寸、onerror、網路錯誤與 8 秒 timeout 全部走相同替換／作廢路徑。

- [.ai-review/plan-v3-levels.md:626](C:/Users/liang/projects/TFDA-drug-id-quiz/.ai-review/plan-v3-levels.md:626) + [engine.js:404](C:/Users/liang/projects/TFDA-drug-id-quiz/engine.js:404) / Medium / A10 要求空集合反例必須被拒絕；`disjoint([], set)` 目前回傳 true，所以空 `shape` 或 `color` 會成為合法 L1 候選，對應測試也漏掉此例。 / `candidateOk()` 先拒絕正解或候選的非陣列／空 shape、color，再做集合不相交判定。

- [.ai-review/plan-v3-levels.md:650](C:/Users/liang/projects/TFDA-drug-id-quiz/.ai-review/plan-v3-levels.md:650) + [.ai-review/HANDOFF-v3.md:26](C:/Users/liang/projects/TFDA-drug-id-quiz/.ai-review/HANDOFF-v3.md:26) / Medium / C14 要求正式 GH Pages、冷快取、實際 transfer bytes；交接文件承認只在 localhost 量測，尚未於正式站複驗。因此 2.16MB 是有利證據，但不能宣稱 C14 已驗收。 / 部署 preview 或正式 Pages 後停用快取重跑 trace，列出資源清單與 transferred bytes，再保存可重現證據。

- [.ai-review/plan-v3-levels.md:458](C:/Users/liang/projects/TFDA-drug-id-quiz/.ai-review/plan-v3-levels.md:458) / Low / §4.4 的品質紅線仍寫 3,000，但 v3.4 的 A9 與 [tests/levels.test.mjs:597](C:/Users/liang/projects/TFDA-drug-id-quiz/tests/levels.test.mjs:597) 已改為 2,850；同一份規格有兩個發布門檻。 / 將 §4.4 與風險表同步改為已批准的 2,850，保留 F7 實測 2,902。

### 關鍵條款判定摘要

| 範圍 | 判定 |
|---|---|
| A8–A9、A11–A17、A19 | 核心 engine 性質大致符合；A18 全鏈路、A10 空集合與部分指定 RNG/邊界仍不足 |
| A20 | 實作門檻正確：L1 23、L2 25、L3 20；測試邊界不完整 |
| C7–C17 | C8、D16、ready-gate、LOCKED 忽略及 C17 現況正確；C9/C11/C13/C16 測得較弱，C14 未正式驗收 |
| D11–D17 | D14 逐題 `chance`、L2 提示 0.1667、`scoreQuiz()` 不知 level、L1 聯集/L2 單筆層級、5 誘答兩兩合法均符合 |
| D18–D22 | D20、D22 符合；D18 缺 `slotAsset`、D19 遞補破壞 H2、D21 未明確驗證 decode |
| Canvas／路徑 | 成績卡未繪圖片、`DATA_DIR + it.img`、無 Service Worker、pinch-zoom 未停用，均符合既定限制 |

## 總結

**不可合併進 `main`。**

必須先修，依嚴重度排序：

1. High：實際完成 G1 的 30 題量化驗證，證明 ≥24/30。
2. High：重做資源作廢後的遞補選擇，守住 D19/H2、答案鍵均勻與整卷最終驗證。
3. Medium：補齊 D18 `slotAsset` 身分鏈及 C11 同格換資產遲到事件。
4. Medium：讓 D21 明確等待並處理解碼結果。
5. Medium：修正 L1 eligibility 的兩兩 H3 判定與 A10 空集合。
6. Medium：補齊 C9/C10/C11/C13/C16 指定反例，並在正式 GH Pages 完成 C14 trace。

資料管線依賴未固定是 `main` 已存在的 High 風險，不是這 4 個 commit 造成；不影響本次回歸歸責，但應在下一次自動題庫更新前處理。
