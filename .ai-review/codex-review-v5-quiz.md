# Codex 獨立覆審 — V5 批次 3（四分類／級別可用性／子集出題）

| | |
|---|---|
| 審查日期 | 2026-08-11 |
| Codex 版本 | codex-cli 0.146.0（MCP，`sandbox: read-only`、`approval-policy: never`） |
| 審查範圍 | commit `669d3a5` 的 diff：`formulary.js`、`tests/formulary.test.mjs`、`tools/build-pool.mjs` |
| 基準 commit | `58cb648`（main，PR #13 合併點） |
| 規格 | `.ai-review/plan-v5-formulary.md` v5.9 的 D34.1／D34.2a／D36／D37／D37.1／D38.1–38.3／D39／D41／D43／D47／D49、驗收 A41–A44 |

> 以下為 Codex 原始輸出，**未經修飾或刪改**。覆核判定見 `verdict-v5-quiz.md`。

---

以下為 commit `669d3a5` 的唯讀覆審報告。未修改任何檔案。

## 區塊 1 — Code review

### 發現 1

`formulary.js:470 / High / validatePair() 只驗 excluded.items[].id 為非空字串，未驗它是 canonical id。`

例如 `衛署藥製字第00021號` 或前後帶空白的 id 可通過 D49 驗證、成功建立 `excludedStages`，但 `classifyFormulary()` 會先把輸入正規化成 `衛署藥製字第000021號`，Map lookup 因字串不同而失敗，最後誤歸 `UNLISTED`。我已用這兩種輸入實跑，`validatePair()` 都回空陣列，分類則錯誤落入第三類。這正是威脅模型所列的 High 分類錯誤。

建議修法：在 `validatePair()` 加入：

```js
const canonical = normalizeLicense(it.id);
if (canonical !== it.id) {
  bad(`${JSON.stringify(it.id)} 不是 canonical id`);
}
```

同時加入「缺前導零、前後空白、全形數字」三種損毀 fixture。此修法完全沿用既有純函式，不增加依賴或模組。

### 發現 2

`formulary.js:720 / Low / probeLevel() 捕捉所有例外，非預期程式錯誤也會被降格成級別不可用，且 reason 可能出現「組卷失敗（undefined）」。`

D38 預期處理的是有限重試失敗與 invariants 失敗；目前 TypeError、索引結構損毀或未來新增但沒有 `code` 的錯誤都會被吞掉。這會掩蓋真正 bug，並產生不具體的失敗原因。

建議修法：只攔截已知且可降級的錯誤代碼，例如 `QUIZ_ASSEMBLY_FAILED`、`INSUFFICIENT_KEYS`、`INVARIANT_VIOLATED`；未知錯誤重新拋出。顯示原因使用固定、不含藥名的安全文字，不直接插入可能不存在的 `e.code`。

### 特別核對結果

- 去重鍵沒有 canonical/fallback 跨域碰撞：若某折疊字串本身可正規化，`normalizeLicense()` 必定回 canonical id，不會走 fallback。
- 不同失敗 token 若只差全半形 ASCII、ASCII 大小寫或空白，會被合併；這與目前 D35.2 的折疊語意一致。未做 Unicode normalization 的相容字元可能分列，但不在現行 canonical 契約內。
- 空 token 在正式路徑已由 D35.1 略過，因此 `blank` 在正常呼叫端恆為 0；直接呼叫分類函式時則另計 `blank`，不會污染 `unlistedCount`。數字不會與規格定義對不上。
- `K_BELOW_MIN` 與引擎門檻等價。通過前置門檻後：
  - L1/L2：`n=min(20,K−need)`，引擎要求 `K≥n+need`
  - L3：`n=min(20,K)`，引擎要求 `K≥n`

  因此正常一致的 `(items,index)` 不存在前置放行後再拋 `INSUFFICIENT_KEYS` 的縫。
- `byCodePoint` 對現行 canonical id 正確，因字元只含 BMP 中文、ASCII 數字及 `R`。未來若新增含 supplementary-plane 字元的前綴，UTF-16 lexical order 才可能不等於 code-point order，屆時升 prefix table 版本時需同步處理。
- `TextEncoder` 在 Node ≥22 與現代瀏覽器均為 global API；非 ASCII 會依 UTF-8 編碼。合法 payload 與 level 都是 ASCII，因此目前不存在跨平台差異。

## 區塊 2 — Test gap analysis

### 發現 3

`tests/formulary.test.mjs:754 / High / D38.3 的重複判定及 Math.random 隔離只測 L1，L2 的非決定性可讓 A41–A44 全綠。`

具體弱化實作：在 `probeLevel()` 中讓 L2 使用 `Math.random`，L1/L3 繼續使用 `makeRng(formularySeed(...))`。

現有測試仍可全綠，原因是：

- ≥5 次相同第一卷只跑 L1。
- monkeypatch `Math.random` 的 probe 也只跑 L1。
- 子集排序測試中的 L2 fixture固定不可用，不比較第一卷。
- A41、A43 的 L2 可用案例只執行一次。

這會違反 D38.3，讓 L2 重整後第一卷或可用性發生變化，屬於題目開始頁的 High 風險。

建議修法：對 L1、L2、L3 各使用一個確定可組卷的 fixture，逐級執行至少 5 次並比較完整 `quizIdentity`；逐級在兩個不同 `Math.random` stub 下再比較一次。

### 發現 4

`tests/formulary.test.mjs:589 / Medium / A41 宣稱以「受控 RNG＋排序靠前」強迫 sentinel 被抽中，但實際沒有注入受控 RNG，且候選會先 shuffle，排序靠前不構成強迫條件。`

我以錯誤的「正解仍取子集、誘答 index 卻使用全庫」路徑實跑目前固定 seed：

- L1 抽中 7/8 個 sentinel。
- L2 抽中 8/8 個 sentinel。

所以 sentinel 目前不是純裝飾，確實能抓到直接的全庫索引洩漏；但成功是目前 seed 與 shuffle 結果，不是註解所稱的候選順序保證。改變 RNG 消耗順序或候選選取策略後，可能失去守備力。

建議修法：讓受測入口可接受測試用 RNG，或增加一個更低層的純函式測試，直接以固定 RNG 序列驗證錯誤 full index 必定選中 sentinel。這不需要 jsdom、bundler 或新依賴。

### A42 敵意 fixture 結論

此 fixture 確實是「任意 seed 都組不出卷」，不是只在列出的 seed 失敗：

- 任何包含 A 組正解的 10 題卷，都只能以 B1–B3 作其 L1 候選。
- B1–B3 彼此 `nameCollides`，不能同時湊成 3 個兩兩合法誘答。
- 只選 B 組又只有 3 個答案鍵，不可能形成 10 題。

因此列出 6 個 payload 只是在驗 deterministic failure，並非 fixture 正確性的必要前提。

### A43

無。三級的卷長、真子集條件、options/spares 封閉性及獨立重建 index 的 invariants 均有實質斷言。

### A44

無實質缺口。`tests/formulary.test.mjs` 本身沒有重建多重失敗 precedence，但 `tests/pipeline.test.mjs:548–560` 已用實際管線 fixture 斷言最早失敗 Q1 優先於後續 Q4；把責任放在產生 stage 的管線層比在分類層重寫 precedence 更合理。

## 區塊 3 — Dependency audit

無。

- `package.json` 沒有 runtime dependencies 或 devDependencies。
- 本 commit 未改 dependency metadata。
- `formulary.js` 未引入 `node:*`，仍可由瀏覽器直接 import。
- `tools/build-pool.mjs` 的 import＋re-export 沒有形成新 runtime 依賴。
- Python 工具仍使用 PEP 723/uv 宣告的 Pillow、requests，與本批 diff 無關。

## 區塊 4 — 規格符合度稽核

| 條款 | 結果 | 實作對照 |
|---|---|---|
| D34.1 | 符合 | `formulary.js:610–613` 產生 matched＋Q1–Q5 的 `payloadIds`，第三類只產 `unlistedCount` |
| D34.2a | 符合 | `formulary.js:574–582` 正規化後去重；`612–617` 分開回報第三類、distinct、blank |
| D36 | 符合 | `formulary.js:677–685` 先 filter 成 matched subset，再以該 subset 建 index |
| D37 | 符合 | `formulary.js:539–545` 精確映射 Q1 與 Q2–Q5；`591–601` 執行四分類 |
| D37.1 | 符合 | `formulary.js:515–536` 內部代碼與顯示名稱分離，措辭與規格一致 |
| D38.1 | 符合 | `formulary.js:624–650` 實作 10 題下限、need 3/5/0 與 `min(20,K−need)` |
| D38.2 | 符合，另有 Low 例外處理問題 | `formulary.js:704–737` 先拒絕、實際組卷並驗 invariants；重驗分支雖不可達，但引擎 `engine.js:575` 已以同組參數硬中止，規格性質仍成立 |
| D38.3 | 實作符合，測試不足 | `formulary.js:658–661` CRC-32 seed；`677–681` 排序；`718–721` 單一 seeded stream；`737` 回傳第一卷。測試缺口見發現 3 |
| D39 | 純函式層符合 | `formulary.js:650` 決定短卷長度；A43 驗證 L1/L2 真子集及 L3 全集合 |
| D41 | 符合本批範圍 | `formulary.js:681–688` 計算現存 items 與 missing，不修改 payload；`746–752` 以縮水後子集重新 probe |
| D43 | 符合本批範圍 | 出題資料只取 `poolItems` 中 id 命中的完整 record；DOM sink 屬批次 4 |
| D47 | 符合本批純函式責任 | `formulary.js:501–509` 任一配對錯誤即拒絕建立 excluded index；UI 降級屬批次 4 |
| D49 | 部分符合 | `formulary.js:457–479` 有驗 schema、count、唯一、交集、stage、非空及 hash；但未拒絕非 canonical id，會導致錯誤分類，見發現 1 |
| A41 | 功能斷言目前會抓到直接洩漏，但未完全符合「受控 RNG」要求 | `tests/formulary.test.mjs:585–630`；見發現 4 |
| A42 | 邊界與敵意 fixture 符合；三級可重現測試不完整 | `tests/formulary.test.mjs:674–805`；見發現 3 |
| A43 | 符合 | `tests/formulary.test.mjs:819–867` |
| A44 | 符合整體測試配置 | `tests/formulary.test.mjs:870–1013` 加上 `tests/pipeline.test.mjs:548–560` |

### 規格發現摘要

`.ai-review/plan-v5-formulary.md:D34.1（第 66 行）＋D49（第 653–663 行） / formulary.js:470 / High / D49 接受非 canonical excluded id，來源已知 id 無法以 canonical join key 命中，會被錯標 UNLISTED / 在 validatePair() 強制 normalizeLicense(id) === id，並加入非 canonical 損毀測試。`

`.ai-review/plan-v5-formulary.md:A42（第 844–858 行）＋D38.3（第 448–460 行） / tests/formulary.test.mjs:754 / High / 可重現性測試只覆蓋 L1，L2 使用 Math.random 的弱化實作仍可全綠 / 對三個級別逐級重跑並逐級 monkeypatch Math.random。`

`.ai-review/plan-v5-formulary.md:A41（第 836–842 行） / tests/formulary.test.mjs:589 / Medium / 規格要求受控 RNG 強迫 sentinel 洩漏，但測試只有 derived seed，候選排序又會被 shuffle 消除 / 加入可注入的固定 RNG 或低層受控候選測試。`

驗證結果：`tests/formulary.test.mjs` 105/105 通過；`node tools/verify-data.mjs` 通過，3,941 筆 pool 與 2,354 筆 excluded 成對。
