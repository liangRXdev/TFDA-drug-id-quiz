# 覆核判定 — 快速閃卡 Codex 覆審

| 項目 | 內容 |
|---|---|
| 日期 | 2026-08-04 |
| 對象 | `.ai-review/codex-review-flashcard.md`（codex-cli 0.146.0） |
| commit | `00a393d`（分支 `feat/flashcard-mode`） |
| 覆核方式 | 每項回讀該檔該行驗證，未僅憑 Codex 描述判斷 |

## 統計

| 判定 | 數量 |
|---|---|
| 接受 | 11 |
| 部分接受 | 3 |
| 拒絕 | 0 |

**行號引用全部正確，本輪未發現幻覺。** Codex 引用的 `app.js:58–78`、`app.js:644–672`、
`engine.js:897–908`、`app.js:735–755`、`app.js:1000–1002`、`index.html:269–273` 逐一回讀均屬實。

---

## 區塊 1 — Code review

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| CR-1 | 圖片未 ready 即可翻面 | High | **接受** | `app.js:655-656` 在設定 `src` 之前就 `show(btnFlip)` 且 `disabled = false`，`app.js:661-672` 只綁 `onerror`、無 `onload` gate。L2 有 ready-gate（`app.js:420-433` `updateGate()`），閃卡沒有。直接命中最高風險「圖片與藥名錯位」：使用者可在空白／舊 bitmap 上翻出新藥名。修法（gate 留在 app.js、不動 engine 分層）與架構相容。 |
| CR-2 | 遞補只避開目前 deck，會抽回被換掉的卡 | High | **接受** | `engine.js:905` `const seen = new Set(deck.map((c) => c.item.ans))` 讀的是**當下**的 deck；`app.js:737-741` 先 `drawSpareCard()` 再 `state.deck[state.fIdx] = spare` 覆蓋原卡。單次遞補確實含「自己」（呼叫時原卡仍在 deck），但第二次失敗時原卡的 ans 已從 deck 消失 → 可被抽回。`engine.js:898-900` 的註解宣稱「避開整疊已出現的答案鍵」，實作只做到「避開目前在架上的 20 個鍵」——**註解與行為不符**，且圖源持續失敗時可在少數候選間循環，削弱 `null` 的終止語意。 |
| CR-3 | 單一 `<img>` 的 property handler 擋不住真正的遲到事件 | Medium | **部分接受** | 形態屬實：`app.js:661` 每次 render 覆寫 `img.onerror`，舊請求的事件若真的 dispatch，執行的是最新 closure，`myToken`／`expected`／`state.deck[fIdx]` 三者同時指向新卡而全數相符 → 誤傷新卡。**但三點修正**：(1) 真實瀏覽器改 `src` 會 abort 舊請求且不再對該請求觸發 error，觸發窗極窄；(2) 危害是「無辜多換一張卡」，不是圖名錯位，嚴重度應為 **Low–Medium**；(3) **關鍵**：L1/L3 的 `qImg`（`app.js:271-278`）是完全相同的單一 node + 覆寫 handler 寫法，已過 v3 兩輪覆審——只改閃卡會生出兩套慣例，要改應三處一起改，屬既有架構層級變更，不該掛在本 PR。**子項「`fNextToken` 每疊重設為 21、跨疊不唯一」（`app.js:723`）接受**，改為頁面生命週期單調遞增即可，成本極低。 |
| CR-4 | 警示路徑不清空背面 | Medium | **接受** | `app.js:744-753` 達上限分支直接 `return`，未清 `fBack`；而 `state.deck[state.fIdx]` 已在 `app.js:741` 換成 spare → DOM 顯示舊卡藥名、state 指向新卡。若 CR-1 修好（翻面必在 onload 之後），觸發前提會大幅收窄，但仍應顯式清空以維持「翻面前背面為空」在所有路徑成立。 |
| CR-5 | 無 spare 時完成訊息自相矛盾 | Low | **接受** | `app.js:773` 固定讀 `state.deck.length`（遞補是覆蓋不是 push，恆為 20），與 `app.js:738` 的「本疊提前結束」並列時語意衝突。正式題庫 3,913 筆不會觸發，但屬合法邊界值。優先度低。 |

### 正向確認（覆核同意）

Codex 列的 5 項正向確認全部回讀屬實：`buildLookAlikeIndex` 線性掃描（`engine.js:848-857`）、
沿用 `l2Key` 排除弱訊號（`engine.js:392-394`）、狀態分離（`app.js:58-78`）、
`escapeHtml` 一致套用（`app.js:707-712`）、`DATA_DIR + it.img`（`app.js:664`）。

---

## 區塊 2 — Test gap analysis

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| TG-1 | 遞補測試 30 次都傳同一個未修改的 deck | High | **接受** | `tests/flashcard.test.mjs:92-105` 迴圈內從未把 spare 寫回 deck，只證明「不在原始 20 張」。測試名稱寫「避開整疊已出現的答案鍵，含被替換的那張自己」——**斷言弱於名稱所宣稱的性質**，正是它讓 CR-2 全綠通過。假綠燈成立。 |
| TG-2 | `assert.ok(deck.length === DECK_SIZE)` 恆為真 | Low | **接受** | `tests/flashcard.test.mjs:313` 的 `deck` 是測試本地 `drawDeck()` 產物，從未交給 app，app 無論如何都改不到它。此斷言測不到任何產品性質，應刪除或改為對 `fIdx`／完成頁的可觀察斷言。 |
| TG-3 | resume 歸零的斷言被新開一疊掩蓋 | Medium | **接受** | `tests/flashcard.test.mjs:334-340`：按 Resume 後又 `$('btnFlash').click()` 開新疊，而 `app.js:719-721` 的 `startFlash()` 本身就把 `fFails` 歸零 → 即使 `resumeFlash()`（`app.js:759-764`）完全不歸零，斷言仍過。明確假綠燈。 |
| TG-4 | harness 吞掉 stale src microtask | Medium | **部分接受** | 問題屬實（`tests/_ui-harness.mjs:117` `if (this._attrs.src !== v) return;` 模擬的是「瀏覽器一定取消舊事件」）。**但修法過重**：不需要「加入可控 request/event queue」。既有 C11（`tests/ui-smoke.test.mjs`「換題後舊格的錯誤不得影響新題」）已示範更輕的作法——保存舊 `img` 引用後手動 `img.onerror?.()` 強制 late-dispatch，繞過樁的 src 檢查。閃卡只有單一 `fImg` node，照 C11 同款寫就會直接暴露 CR-3。**採 C11 慣例，不改 harness 架構。** |
| TG-5 | 未測圖片 pending 時不可翻面 | High | **接受** | `tests/flashcard.test.mjs` 所有翻面測試都先 `await dom.settle()`，完全略過 pending 時間窗。harness 已有 `imgControl.pending`（`_ui-harness.mjs:27`）可用，成本很低。與 CR-1 綁定：CR-1 的修法必須有這條測試才算兌現。 |
| TG-6 | 未涵蓋「先翻面、圖片後失敗」與背面殘留 | Medium | **接受** | 與 CR-4 綁定。現有失敗測試都在 settle 後操作，測不到該順序。 |
| TG-7 | 「進度正確」未斷言進度條 | Low | **接受** | `tests/flashcard.test.mjs:244-261` 只檢查 `fIdx` 與完成摘要，未碰 `fBar.style.width`（`app.js:649`）。名稱宣稱「進度與統計正確」而未驗進度條，屬名實不符。 |
| TG-8 | mobile 層實為 CSS regex，非真實 layout 驗收 | Medium | **部分接受** | 主論點接受：Q5 承諾的「mobile」目前的準確描述是「CSS 契約檢查」，證據等級不足，我在完工回報中也應如此表述。**但修法應照本 repo 既有慣例**：v3 是用**同源 iframe 固定 375×812** 做真機測試並把結果落檔到 `HANDOFF-v3.md`（因 Chrome 視窗有最小寬度限制，拿不到真 375px 視埠），不是「人工 checklist」，也不需要導入 browser runner。**`touch-action: pinch-zoom` 子項不採納 Codex 的理由**：該值確實允許縮放，但**禁止單指平移**，放大後無法平移看刻字，對 L2／閃卡可解性同樣有害，本專案不該出現此值。既有 `tests/ui-smoke.test.mjs:186` 用同一正則——保留正則，但測試名稱／註解應改為「縮放與平移未被停用」以名實相符，且兩處要一起改。 |

---

## 區塊 3 — Dependency audit

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| DA-1 | 無問題 | — | **接受** | 回讀驗證屬實：`git diff main..HEAD` 未含 `package.json`；新測試只用 `node:test`／`node:assert`／`node:fs`／`node:path`；`.github/workflows` 的 `node-version: '24'` 確認無誤（`setup-node@49933ea` v4.4.0），支援 `node --test` 的 glob。無需調整。 |

---

## 區塊 4 — 需求符合度稽核

Codex 對 Q1/Q2/Q3/F1/F2/F6「符合」的判定，逐條回讀後同意。
Q4／F3／F4 的「不符合」實質內容已由 CR-1／CR-2／CR-4 涵蓋，不重複計列。以下只列獨立項：

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| SP-1 | Q5／F5 的 mobile 驗收層證據不足 | Medium | **接受**（2026-08-04 部分解除，見下方真機測試紀錄） | 屬實。`tests/flashcard.test.mjs:374-405` 是靜態 CSS 契約檢查，不是 layout 驗收。**但這不是實作缺陷**——`index.html` 的 responsive／44px／斷行／viewport 四項實作本身 Codex 也確認符合。缺的是驗收證據。已補：三項互動行為的真機目視；仍缺：375px 的 layout 量測。 |
| SP-2 | `engine.js:898-900` 註解與實作不符 | Medium | **接受** | 併入 CR-2 一起修。註解宣稱的性質比實作強，這比沒有註解更糟——後續維護者會據此假設歷史排除已成立。 |

---

## 必修項（合併 main 前）

依「先擋住錯誤記憶、再補測試證據」排序。**全部已修，commit `8c7f5f6`。**

| # | 項目 | 修法 | 變異驗證 |
|---|---|---|---|
| 1 | **CR-1 + TG-5**（High） | ready-gate：`onload` 通過身分檢查才啟用翻面，`state.fReady` 為真守門；連帶加逾時（沿用 `L2_LOAD_TIMEOUT_MS`），否則永久 pending 會鎖死翻面 | ✅ 回退後轉紅 |
| 2 | **CR-2 + TG-1 + SP-2**（High） | `drawSpareCard` 改收 `exclude`，`app.js` 維護 `state.fSeen`（只增不減）；測試改為真的寫回 deck 再抽；修正過強的註解 | ✅ 回退後轉紅（2 項） |
| 3 | **CR-4 + TG-6**（Medium） | `replaceCard` 進警示前 `clearBack()` | ⚠️ 見下方「測不到的兩條」 |
| 4 | **TG-3**（Medium） | resume 測試留在同一疊，用警示訊息的張數辨別歸零與否 | ✅ 回退後轉紅 |
| 5 | **CR-3 子項**（Low） | `fNextToken` 頁面生命週期單調遞增，`drawDeck` 收 `startToken` | ⚠️ 見下方 |

### 測不到的兩條（已在程式碼與測試註解標明，不假裝有守住）

- **CR-4 的 `clearBack`**：變異驗證拿掉它，測試仍全綠。ready-gate 讓「翻面後同一張才失敗」這條路徑走不到，背面已由 `renderCard` 保證清空，因此它是純防禦性的第二道。
- **`fNextToken` 遞增**：變異驗證改回每疊重設，測試仍全綠。單一 `<img>` node、handler 每次 render 被覆寫，帶著舊 token 的 handler 根本不存在，撞號觀察不到。它是 CR-3 主體修好後才會兌現的前置條件。

## 可延後項 — 全部已清，commit `62fe5e3`

| 項目 | 處理 | 變異驗證 |
|---|---|---|
| **CR-5**（Low） | `finishFlash` 改收 `shown`，摘要為「看過 N / 20 張」；相似品項統計只算看過的 | ✅ 回退後轉紅 |
| **TG-7**（Low） | 補進度條斷言，釘死語意為「已完成張數」（第 1 張 0%） | ✅ 回退後轉紅 |
| **TG-2**（Low） | 刪恆真斷言，改驗警示未進完成頁、未偷推進張數 | ✅ 回退後轉紅（**第一版仍是假斷言**，見下） |
| **TG-8**（Medium） | `touch-action` 測試正名為「未停用縮放，也未停用放大後的平移」，本檔與 `ui-smoke.test.mjs` 同條一併加註 `pinch-zoom` 禁止單指平移、不是誤擋 | 靜態契約，無行為可變異 |

> **TG-2 的替代斷言第一版寫錯**：直接讀 `$('fIdx').textContent`，但警示路徑不走 `renderCard`，DOM 恆為 1 → 變異驗證仍綠。改為 resume 重繪後才斷言，重跑即轉紅。同一個坑本輪踩了兩次（TG-1 是 Codex 抓到的），已把「為什麼不能直接讀 DOM」寫進測試註解。

測試 164 → 171，全綠。

## 真機測試紀錄（2026-08-04）

| 項目 | 內容 |
|---|---|
| 環境 | GitHub Pages 正式站 `https://liangrxdev.github.io/TFDA-drug-id-quiz/`，commit `62fe5e3` |
| 裝置 | 使用者手機實機（機型／瀏覽器未記錄） |
| **證據等級** | **目視判定，無量測數字**。與 G1 gate 同一等級 |

| 檢查項 | 結果 |
|---|---|
| B1 ready-gate：圖片載入中「翻開看藥名」停用 | ✅ 通過 |
| B2 失敗警示：連續失敗後停下來詢問、可繼續 | ✅ 通過 |
| B3 pinch-zoom 可縮放且放大後可單指平移 | ✅ 通過 |

**未執行的部分（如實標註）**：

- **A 段自動量測未跑** — iframe 375×812 的 `scrollWidth`／溢出元素數／觸控目標尺寸皆無數字。
  因此「375px 無橫向捲動」在閃卡三個畫面上**沒有量測證據**，僅有整體目視無異常。
- **C 段最大群組排版未驗** — 9 個相似品名 + 極長品名的卡片排版未特意構造檢視。
  該情境涵蓋題庫 7.9% 的題目中的極端值，實機隨機翻牌不保證遇到。

> 這對後續的意義：若日後回報「手機上版面破了」或「相似品項清單撐破卡片」，
> **不可**視為「真機測試漏抓」，而應視為 **A/C 兩段從未執行**——
> 屆時要跑的是 `verdict` 對應段落的量測腳本，而不是質疑目視結論。
> 此處紀律沿用 v3 G1 gate 的處理方式（`plan-v3-levels.md` §0）。

### SP-1 狀態更新

原判定「Q5／F5 的 mobile 驗收層證據不足」**部分解除**：
互動行為（B1–B3）已有真機目視證據；版面量測（A／C）仍為空白。
`Q5` 承諾的「mobile」目前準確描述是
**「unit + 自製 DOM smoke + CSS 靜態契約 + 三項真機目視」**，不含 layout 量測。

## 不在本 PR 處理

- **CR-3 主體** — 單一 `<img>` + 覆寫 handler 是 L1/L3/閃卡共用的既有慣例，要改應三處一起改並重跑 C5/C11 回歸，屬獨立議題。`fNextToken` 的單調遞增已先鋪好。
