# Codex 獨立覆審報告 — v3.5 修正

| 項目 | 內容 |
|---|---|
| 審查日期 | 2026-08-03 |
| 覆審員 | Codex（`mcp__codex__codex`，`sandbox: read-only`／`approval-policy: never`） |
| 審查範圍 | commit `f0b7038`（分支 `feat/difficulty-levels`）——遞補 `drawSpareQuestion()` + `validateQuizInvariants()` |
| 比對規格 | `.ai-review/plan-v3-levels.md` v3.5（D19、§4.1 H1–H4、D18 I1–I5、D15、§6.5、A21／A22） |
| 前一輪 | `.ai-review/codex-review-v3.md` ／ 判定 `.ai-review/verdict-v3.md`（本次修的是其 #1、#4） |

> 以下為 Codex 原始輸出，**未經修飾或刪改**。逐項判定見 `verdict-v3.5.md`。

---

結論：commit `f0b7038` 對前輪缺陷 #1 的核心功能修正成立——遞補正解不再可能回溯破壞既有題目的 H2；但缺陷 #4 僅部分修正，`validateQuizInvariants()` 並未如 D19 宣稱完整驗證 H1–H4、I1–I5。

未發現 Critical／High。共識別 3 個 Medium、4 個 Low 的程式／測試問題，以及 2 個規格資料契約落差。唯讀審查，未修改檔案。現有測試結果：136/136 通過。

## 區塊 1 — Code review

### 1.1 Validator 未完整驗證 D19 宣稱的不變量

- 檔案:行號：`engine.js:639-709`
- 嚴重度：Medium
- 問題描述：實作完整檢查 H1、H2、H3、I1，部分檢查 I3/I5，但未真正涵蓋全部 I1–I5：
  - I2 可由 `options[answerIdx] === q.item` 的物件同一性推導，省略獨立檢查尚屬合理，但應明說「由 I1 蘊含」。
  - I3 只檢查 `id` 非空且同題不重複；任意捏造但唯一的 `id` 仍會通過，無法證明是題庫中的原始紀錄身分。
  - I4 是跨渲染快照引用規則，單憑 `Question[]` 無法驗證，目前完全略過。
  - I5 規格要求 `(題目 token, 格位 token, 資產 identity)`，validator 只驗題目 token 唯一，沒有檢查格位與資產 identity。
- 建議修法：將 D19 明確拆成「純題卷可驗不變量」與「UI／事件鏈不變量」；I2 註明由 I1 蘊含，I4/I5 交由 UI validator/C11 驗證。若仍要聲稱 validator 驗 I3，應傳入 `PoolIndex`，確認每個 `id` 實際存在且欄位與索引紀錄一致。皆可用現有 ES module 與 `node --test` 完成，不需要 build pipeline。

### 1.2 H4 檢查驗的是較弱現象，不是 H4 本身

- 檔案:行號：`engine.js:705-708`
- 嚴重度：Medium
- 問題描述：H4 要求位置由 RNG 洗牌決定；實作只在題數 ≥10 且全部 `answerIdx` 相同時判錯。
  - 偽陰性：固定循環 `0,1,2,3,0,1...`、依題號決定位置，或只在兩格間固定交替都會通過。
  - 偽陽性：合法 RNG 仍可能恰好全在同格。20 題機率為 `4^-19 ≈ 3.64×10^-12`，實務可忽略；10 題則為 `4^-9 ≈ 3.81×10^-6`。
  - `questions.length >= 10` 沒有規格依據，只是實作自行加入的統計門檻。
- 建議修法：不要宣稱執行期快照能驗證 RNG 因果。保留 A13 的 controlled-RNG、題號獨立性及分布測試作為 H4 證據；runtime validator 可將此項改名為「疑似未洗牌 heuristic」，不列為完整 H4。零建置架構不受影響。

### 1.3 遞補抽樣不是嚴格均勻，但目前實際偏差極小

- 檔案:行號：`engine.js:735-753`
- 嚴重度：Low
- 問題描述：`shuffle(keys, rng)` 後取第一個成功組出誘答的答案鍵，只有在各鍵成功／失敗為確定且等價時，才等同於對可組鍵均勻抽樣。此處 `buildChoices()` 使用同一 RNG 做貪婪搜尋，不同鍵可能有不同失敗率，因而成功回傳的條件分布會偏向較容易組題的鍵。

  實測目前題庫：
  - L1：11,451 次 record/seed 組合，0 次失敗。
  - L2：10,929 次中 9 次失敗，集中於 3 個答案鍵，約 0.082%。
  - 各 1,000 次遞補的碰撞率接近均勻預期。

  因此規格「均勻抽」在數學上不完全成立，但目前影響幅度不值得升至 Medium。
- 建議修法：若要嚴格符合 D5，先以不使用 RNG 的可行性判定建立「在目前 exclude 集合下可組題的鍵集合」，再均勻抽鍵並組題。若完整掃描造成遞補延遲，可採有限回溯或快取可行性；不需額外套件或建置流程。

### 1.4 Fatal 訊息可能顯示答案鍵

- 檔案:行號：`app.js:193-196`、`app.js:473-477`
- 嚴重度：Low
- 問題描述：validator 的 H1/H2/H3 訊息包含 `ans`，新 fatal 分支會把第一筆違規直接顯示給使用者。內容已經 `escapeHtml()`，不是 XSS；但可能在中止畫面揭露尚未作答題目的藥名。因測驗已終止，實際危害有限。
- 建議修法：使用者畫面只顯示通用錯誤與違規代碼；詳細答案鍵留在開發者診斷資訊或匿名化回報中。

### 其他核對結果

- `seenAnsKeys()` 正確涵蓋現存題目的正解、options、spares。
- 新遞補正解不會回溯破壞既有 H2。
- 新遞補題的誘答經 `excludeAns` 排除所有現存正解，不會等於既有題正解。
- 新遞補誘答可以等於另一題的誘答／備援；H2 與 §4.1 並未禁止跨題誘答重複，因此不是缺陷。
- `voidCurrent()` 驗證失敗時雖保留已增加的 `state.voided` 並消耗 `nextToken`，但隨即進入不可恢復的 fatal 終態，不會形成仍可作答的狀態不一致。若未來加入 fatal 復原功能，才需要 transaction-style rollback。
- 生成路徑對 `INVARIANT_VIOLATED` 不重抽符合 v3.5 決策；除 H4 heuristic 的極低機率偽陽性外，這是合理處理。

## 區塊 2 — Test gap analysis

### 2.1 A21 的「均勻」測試只能排除決定性實作

- 檔案:行號：`tests/levels.test.mjs:839-852`
- 嚴重度：Low
- 問題描述：60 個 seed 至少得到 20 個不同答案鍵只能證明輸出具有多樣性。即使 90% 機率集中於 20 個鍵、其餘鍵極少出現，仍可能通過；不能支持「均勻」結論。
- 建議修法：使用連續 seeded RNG 做較大樣本，對預期機率執行 collision-rate、最大／最小頻率或卡方檢查；另建立少量合成題庫，讓不同候選具有明確不同的 `NO_DISTRACTORS` 路徑，以驗證失敗換鍵不會成為權重。

### 2.2 A22 mutation 未涵蓋完整 I1–I5，部分 I3 弱實作仍可通過

- 檔案:行號：`tests/levels.test.mjs:896-943`
- 嚴重度：Medium
- 問題描述：7 個具名 mutation 涵蓋 H1–H4、I1、I3、I5，但：
  - 缺 I2。
  - 缺 I4。
  - I5 只 mutation 題目 token 重複，未涵蓋格位 token／資產 identity。
  - I3 只測同題重複 `id`；「捏造唯一 id」或「id 與其餘紀錄欄位不一致」會通過。
  - H4 只測所有正解固定第 0 格，固定循環或依題號決定位置的弱實作仍可通過。
- 建議修法：補 fabricated-ID、id/圖片欄位錯配、完整 I5 遲到事件案例；I4/H4 若確認無法由純 validator 驗證，應把驗收責任明確移到 A13/A18/C11，而不是保留「A22 全驗」宣稱。

### 2.3 UI C10 未跟上新遞補與 validate-then-pop 分支

- 檔案:行號：`tests/ui-smoke.test.mjs:274-300`
- 嚴重度：Medium
- 問題描述：目前 C10 只驗證自動前進、作廢數與最終分母 20，沒有驗證：
  - 遞補正解未出現在原卷任何 options/spares。
  - 原作廢題確實維持 `VOID`。
  - 同一錯誤事件重送不會再次作廢／遞補。
  - `>3` 作廢中止回歸。
  - `validateQuizInvariants()` 失敗後執行 `pop()+fatal` 的新分支。

  因此 app 若傳錯 `questions`、未呼叫 validator，或錯誤重送多加一題，現有測試仍可能通過。
- 建議修法：讓 UI smoke 測試取得可檢查的 session snapshot，或在 DOM stub 加只讀診斷 hook；分別注入合法遞補、重送事件、第四次作廢及 validator failure。這可在現有零建置/node-test 架構內完成。

### A21／A22 鑑別力總結

- 有鑑別力：只避開正解集合、按 pool 第一筆決定性選取、validator 永遠回空陣列、H1/H2/H3/I1/重複 id/重複 token、固定第 0 格。
- 可被弱化實作騙過：高度偏斜但有 ≥20 種輸出的抽樣、完整 I2/I4/I5、偽造但唯一的 id、非恆定但仍由題號決定的 answerIdx。
- L3 `eligible: null` 路徑有測到：`tests/levels.test.mjs:822-834` 明確傳 `null`，`866-875` 亦省略 `eligible` 走同一路徑。

## 區塊 3 — Dependency audit

無。

`package.json` 只有 scripts 與 Node ≥20 限制，沒有 `dependencies` 或 `devDependencies`；本 commit 未新增執行期或測試依賴。

## 區塊 4 — 規格符合度稽核

### 4.1 D19「全不變量驗證」宣稱不成立

- 規格／實作：D19 `.ai-review/plan-v3-levels.md:320-346`；`engine.js:639-709`
- 嚴重度：Medium
- 問題描述：規格要求最後驗證 H1–H4、I1–I5；實作只完整驗部分項目，H4 是 heuristic，I4 未驗，I5 只驗 question token。
- 建議修法：修正規格為可驗集合並引用 A13/A18/C11，或擴充 validator 的輸入及 runtime identity 驗證；不得繼續稱為「全不變量驗證」。

### 4.2 §5 宣稱的 `usedAns` 與 `slotAsset[]` 從未產生

- 規格／實作：§5.1/§5.2 `.ai-review/plan-v3-levels.md:526-553`；`app.js:51-64`、`engine.js:242`
- 嚴重度：Low
- 問題描述：
  - 規格宣告 QuizSession 有不可變 `usedAns`，但 v3.5 刪除 `state.used` 後沒有替代欄位。
  - 規格宣告 L2 Question 有 `slotAsset[]`，實作實際以 `q.options[k].id` 即時計算，Question 中沒有該欄位。

  現行行為可由衍生集合與 `options[k].id` 達成，但資料契約文字不實。
- 建議修法：若刻意採衍生值，從 §5 契約移除兩欄並寫明來源；若契約必須保留，再實作欄位。建議前者，較符合現有單一資料來源設計。

### 4.3 A21／v3.5 的「均勻抽」宣稱過強

- 規格／實作：A21、v3.5 `.ai-review/plan-v3-levels.md:637,715`；`engine.js:735-753`
- 嚴重度：Low
- 問題描述：洗牌後第一個成功鍵會受候選特定的組題失敗率影響，不是嚴格等機率；A21 的 ≥20 種輸出也不足以證明均勻。
- 建議修法：改成先決定可行集合再抽樣，或把規格文字精確改為「候選順序均勻隨機；目前題庫下組題失敗造成的偏差低於量測門檻」。

### 4.4 C10 自動驗收宣稱未完整落實

- 規格／實作：C10 `.ai-review/plan-v3-levels.md:647`；`tests/ui-smoke.test.mjs:274-300`
- 嚴重度：Medium
- 問題描述：規格要求遞補正解不重複、錯誤事件重送冪等、保留 `>3` 中止回歸；測試只證明最終作廢 1 題且計分 20 題。
- 建議修法：補齊上述 UI 層斷言，並覆蓋本 commit 新增的 validator failure 分支。

### 4.5 v3.5 逐句查核

- 「遞補移入 engine」：成立。
- 「正解避開所有現存 options/spares」：成立。
- 「回溯 H2 缺陷已修」：成立。
- 「答案鍵均勻抽」：近似成立、嚴格不成立，現況偏差極小。
- 「新增 validator」：成立。
- 「完成 D19 全不變量驗證」：不成立。
- 「生成違規拋 `INVARIANT_VIOLATED` 且不重抽」：成立。
- 「遞補違規中止本回合」：成立。
- 「A21/A22 各以具鑑別力 mutation 驗證」：部分成立；能堵主要舊缺陷，但不能支持完整均勻性與 I1–I5 宣稱。
- 「移除 `state.used`」：成立，但 §5.1 的 `usedAns` 契約未同步修訂。

最終判定：前輪 #1 已實質修復；前輪 #4 未完全修復，應判定為「部分通過，需修正文義或補足 validator／測試」。
