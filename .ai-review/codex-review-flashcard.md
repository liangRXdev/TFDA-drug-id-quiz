# Codex 獨立覆審 — 快速閃卡（flashcard）

| 項目 | 內容 |
|---|---|
| 審查日期 | 2026-08-04 |
| Codex 版本 | codex-cli 0.146.0 |
| 模式 | `sandbox: read-only` / `approval-policy: never` |
| 審查範圍 | commit `00a393d`（分支 `feat/flashcard-mode`）的閃卡功能 |
| commit hash | `00a393d894a964493c396269982943b70aaf4f87`（2026-08-04 09:03:43 +0800） |
| 涉及檔案 | `engine.js`（閃卡段）、`app.js`（閃卡段與綁定）、`index.html`（`#flash`／`#flashDone`／閃卡 CSS）、`tests/flashcard.test.mjs`（新增）、`tests/_ui-harness.mjs`（修改） |
| 需求基準 | **無正式規格文件**；Q1–Q5 決策與 F1–F6 條目來自動工前的需求確認對話（證據等級低於 `.ai-review/` 下的規格文件） |

> 以下為 Codex 原始輸出，**未經修飾或刪改**，供稽核用。
> 覆核判定見 `.ai-review/verdict-flashcard.md`。

---

# 獨立覆審報告

審查對象：commit `00a393d`，分支 `feat/flashcard-mode`
結論：**建議 Request changes**。未發現 Critical，但有 **2 項 High**，均涉及閃卡最重要的圖片／藥名一致性與遞補承諾。

已執行完整測試：

- `node --test "tests/**/*.test.mjs"`
- 164 tests / 164 pass
- `flashcard.test.mjs` 共 25 項測試，全部通過
- 通過不代表下列競態與連續遞補缺陷已被涵蓋

---

## 區塊 1 — Code review

### CR-1：圖片尚未確認載入成功就允許翻面，可能造成舊圖配新藥名

**app.js:644–672 / High / 問題描述**

`renderCard()` 一開始就顯示並啟用 `btnFlip`，設定新 `src` 後沒有 `onload` ready-gate。換卡時，使用者可以在新圖片仍 pending 時立即翻面。

這會產生兩種風險：

- 瀏覽器仍暫時呈現上一張已解碼 bitmap 時，可能出現「上一張圖片＋新卡藥名」。
- 圖片最終失敗前，使用者已經看到藥名，等於先對尚未成功顯示的圖片建立記憶。

這直接命中最高風險「圖片與藥名錯位」。現有 L2 已有 ready-gate，但閃卡沒有。

**建議修法**

在每次 `renderCard()`：

1. 先清除或隱藏舊圖片。
2. 將 `btnFlip.disabled = true`。
3. 圖片 `onload` 通過目前卡片身分檢查後才顯示圖片並啟用翻面。
4. `onerror` 維持遞補流程。
5. ready-gate 應留在 `app.js`；不需改變 engine 純函式分層。

---

### CR-2：遞補只避開「目前仍在 deck」的答案，會抽回先前被換掉的卡

**engine.js:897–908、app.js:735–742 / High / 問題描述**

`drawSpareCard()` 每次重新執行：

```js
const seen = new Set(deck.map((c) => c.item.ans));
```

但 `replaceCard()` 隨即以 spare 覆蓋原卡。原本失敗卡的答案鍵因此從 `deck` 消失，下一次遞補就重新成為候選。

例如：

```text
原卡 A 失敗 → 換 B
B 失敗 → A 已不在目前 deck，可再次抽回 A
```

因此實際只避開「目前 deck 的 20 個答案鍵」，沒有避開「本疊歷史上曾出現過的所有答案鍵」，不符合 F4 的明確承諾。圖片持續失敗時也可能在有限候選間循環，削弱候選耗盡的終止語意。

**建議修法**

增加本疊生命週期的歷史集合，例如 `state.fSeenAnswers`：

- `startFlash()` 時以原始 20 張初始化。
- 每次抽到 spare 後立即加入。
- `drawSpareCard()` 接受明確的 `excludedAnswers`，不要只由可變的 `deck` 推導。
- 測試需真的依序覆蓋 deck 後再抽下一張，驗證所有歷史答案皆不可回流。

---

### CR-3：宣稱的 token + src stale-event 守門對同一 `<img>` 的 property handler 並不充分

**app.js:634、662–668 / Medium / 問題描述**

`fImg.onerror` 在每次 render 都被覆寫。若舊請求的錯誤事件已排入 event queue，事件實際 dispatch 時可能執行的是目前最新的 `img.onerror`，而非舊請求建立時的 closure。

此時最新 handler 內：

- `myToken` 是目前卡片 token。
- `expected` 是目前卡片 src。
- `state.deck[state.fIdx]` 也是目前卡片。

因此三者可以全部相符，舊事件仍會誤傷新卡。另 `fNextToken` 每疊重設為 21，也無法提供跨疊唯一性。

現有 harness 在 `_ui-harness.mjs:117–120` 主動丟棄 src 已變更的舊 microtask，正好避開了這種瀏覽器事件競態，因此沒有證明實際守門有效。

**建議修法**

相容於零依賴靜態架構的做法：

- 每次卡片 render 建立新的 `<img>` DOM node，handler 與該 node/request 固定綁定；或
- 使用獨立 `Image` loader，讓 request handler closure 不會被下一次 render 覆寫，成功後才提交到畫面。
- token 改為整個頁面生命週期單調遞增，不要每疊重設。

不需要改動 engine/app 分層或導入套件。

---

### CR-4：第三次失敗進警示時，背面不保證為空

**app.js:689–713、735–753 / Medium / 問題描述**

由於 CR-1 沒有 ready-gate，使用者可在圖片 settle 前翻面。若之後發生 `onerror`：

- 第 1、2 次失敗會呼叫 `renderCard()`，背面因而清空。
- 第 3 次失敗則先把 `state.deck[fIdx]` 換成 spare，直接進警示，不呼叫 `renderCard()`。
- 原失敗卡的 `fBack` 仍可能保持可見，DOM 內仍是舊答案，但 state 已經指向新 spare。

這使「翻面前背面為空」在警示路徑不成立，也造成 DOM 與狀態不同步。

**建議修法**

進入警示前明確執行：

- `fBack.innerHTML = ''`
- 隱藏 `fBack`
- 清除舊 features 或明確標示目前沒有可用卡片
- 配合 CR-1，圖片未 ready 前禁止翻面

---

### CR-5：無 spare 時的完成訊息自相矛盾

**app.js:738–739、765–775 / Low / 問題描述**

若題庫剛好只有 20 個答案鍵，任何圖片失敗都會讓 `drawSpareCard()` 回傳 `null`。畫面會顯示「本疊提前結束」，但摘要仍固定寫：

```text
本疊 20 張
```

其中還包含失敗且未完成學習的卡，不能代表實際看過的有效卡數。

目前正式題庫很大，實務觸發機率低，但這是合法邊界值。

**建議修法**

另外記錄：

- 已成功載入或已呈現的卡數
- 因資源失敗跳過／未完成的卡數

提前結束時用實際完成數產生摘要，不要只讀 `deck.length`。

---

### 正向確認

- **engine.js:848–857 / 無問題**：`buildLookAlikeIndex()` 為線性掃描加小群組排序，3,913 筆實測約 5.7 ms；124 個多品名群組、最大 9 個品名，與註解一致。
- **engine.js:392–394、848–869 / 無問題**：使用既有 `l2Key`，刻意排除 `score_mark`、`size`，符合照片弱訊號的既有 D12 定義。
- **app.js:58–78 / 無問題**：`deck/fIdx` 與 `questions/idx` 確實分離。
- **app.js:707–712 / 無問題**：藥名、完整品名、中文名、許可證字號及相似品名均使用 `escapeHtml`。
- **app.js:664、671–672 / 無問題**：圖片路徑正確使用 `DATA_DIR + it.img`。

---

## 區塊 2 — Test gap analysis

### 現有 25 項覆蓋內容

目前涵蓋：

- 純函式：
  - `l2Key` 分組及去重
  - `lookAlikesOf()` 排除自己
  - card 不含計分欄位
  - immutable flip
  - 20 張唯一答案與 token
  - 答案不足
  - 單次 spare 排除目前 deck
  - 無 spare 回傳 `null`
- UI smoke：
  - 不選難度即可進入
  - 離開、回開始頁與難度重設
  - 初始背面空白
  - 翻面欄位與相似品項清單
  - 20 張完成頁
  - 圖片失敗、三次警示、繼續／停止
  - 閃卡後測驗分母仍為 20
- 行動版靜態契約：
  - `.q-img` responsive 規則
  - 全域 44px `min-height`
  - 長品名斷行
  - viewport 未設定 `user-scalable=no`

### TG-1：遞補測試只重複呼叫函式，沒有真的依序替換 deck

**tests/flashcard.test.mjs:92–105 / High / 問題描述**

測試執行 30 次 `drawSpareCard()`，但每次傳入的都是完全相同、從未被修改的 `deck`。

所以它只能證明「每次 spare 不在原始 20 張」，無法證明：

- 第一次 spare 被放進 deck 後，第二次不會抽回被換掉的原卡。
- 多次失敗後，所有歷史答案鍵仍被排除。

這正是假綠燈：測試名稱宣稱「整疊已出現」，實際驗證的是「目前傳入的固定 deck」。

**建議修法**

每輪應：

1. 記錄完整歷史集合。
2. 將 spare 真正寫回指定 deck slot。
3. 下一輪以更新後 deck 與歷史集合抽 spare。
4. 斷言 spare 不在完整歷史集合。

---

### TG-2：三次失敗測試含恆為真的斷言

**tests/flashcard.test.mjs:304–315 / Low / 問題描述**

`deck` 是測試自己用 `drawDeck()` 建立的本地變數，沒有交給 app，也不會被 UI 流程修改。因此：

```js
assert.ok(deck.length === DECK_SIZE);
```

無論 app 是否把 deck 清空、縮短或污染，都恆為真，沒有測到任何產品性質。

**建議修法**

改驗證可觀察產品行為，例如：

- UI 仍顯示第 1 / 20 張。
- 警示前沒有進完成頁。
- 失敗三次沒有增加 `fIdx`。
- 若需檢查內部 deck，應透過測試用唯讀快照介面，而不是檢查測試自己的 fixture。

---

### TG-3：「resume 後計數歸零」的核心斷言被新開一疊掩蓋

**tests/flashcard.test.mjs:320–340 / Medium / 問題描述**

測試按 Resume 後，在第 338 行又按 `btnFlash` 重新開一疊。`startFlash()` 本身會把 `fFails` 重設為 0，因此即使 `resumeFlash()` 完全沒有重設計數，測試仍會通過。

這是明確假綠燈。

**建議修法**

Resume 後留在同一疊：

1. 再製造 1 次失敗，斷言不出警示。
2. 第 2 次仍不出警示。
3. 第 3 次才再次出現警示。

---

### TG-4：harness 主動吞掉 stale src microtask，無法驗證真正的 stale event

**tests/_ui-harness.mjs:115–123 / Medium / 問題描述**

以下判斷讓舊 src 對應的 microtask直接 return：

```js
if (this._attrs.src !== v) return;
```

因此 harness 模擬的是「瀏覽器一定取消舊事件」，不是需求要求的「舊事件真的到達，但 app 必須擋住」。

目前 flashcard 測試也沒有保存舊 handler 或舊 image request，再於 replacement／下一疊後觸發。

**建議修法**

保持最小 DOM 樁，不需引入 jsdom：

- 加入可控的 request/event queue。
- 允許測試保存特定 src 的舊失敗事件並強制 late-dispatch。
- 至少涵蓋換卡後、下一張後、停止後再開新疊，以及相同 src 再次出現。

---

### TG-5：沒有測試圖片 pending 時不可翻面

**app.js:644–672、tests/flashcard.test.mjs:174–197 / High / 問題描述**

所有翻面測試都先 `await dom.settle()`，所以完全略過「圖片尚未 settle」的時間窗，測不出 CR-1。

**建議修法**

利用 harness 已有的 `imgControl.pending`：

- 將第一張圖片設為 pending。
- 斷言圖片 ready 前 `btnFlip.disabled === true`。
- 強制成功後才允許翻面。
- 失敗時不得短暫顯示答案。

---

### TG-6：未涵蓋翻面後才發生 onerror、第三次警示與背面殘留

**app.js:689–753 / Medium / 問題描述**

現有失敗測試都是讓 microtask settle 後再操作按鈕，沒有涵蓋：

- 使用者先翻面。
- 圖片之後才失敗。
- 第三次失敗進警示。
- `fBack` 是否清空。

**建議修法**

新增受控順序測試，警示時斷言：

- `fBack.innerHTML === ''`
- `fBack` hidden
- 舊藥名不存在於 DOM
- Resume 後仍是未翻面的新卡

---

### TG-7：「進度正確」測試沒有檢查進度條

**tests/flashcard.test.mjs:244–261、app.js:648–649 / Low / 問題描述**

測試名稱宣稱「進度與統計正確」，實際只檢查 `fIdx` 與完成摘要，沒有斷言 `fBar.style.width`。

因此即使進度條恆為 0%、倒退或使用錯誤分母，測試仍會通過。

**建議修法**

逐張檢查 `fBar.style.width` 的定義，並明確決定它代表：

- 已完成張數；或
- 目前所在張數。

最後一張及完成頁也應有斷言。

---

### TG-8：所謂 mobile 層實際是 HTML/CSS regex，無法驗證真實溢出與觸控版面

**tests/flashcard.test.mjs:374–405 / Medium / 問題描述**

這四項能守住部分靜態 CSS 契約，但沒有 layout engine，測不到：

- 320/360/375 px viewport 下的實際 overflow
- 九個相似品名時卡片高度與按鈕可達性
- 長 `full/zh/id` 的組合排版
- 圖片載入、警示與鍵盤 focus 在手機 viewport 的互動

因此 Q5「unit + smoke + mobile 三層」目前較準確的描述是「unit + 自製 DOM smoke + CSS 靜態檢查」，不是完整 mobile 驗收。

另外，`tests/flashcard.test.mjs:404` 把 `touch-action: pinch-zoom` 也視為違規；但它本身是允許 pinch zoom 的值，真正硬性違規是 `touch-action: none`。

**建議修法**

考量零依賴取捨：

- 保留現有 regex 作為 CSS contract test。
- 增加無新依賴的人工 mobile smoke checklist，固定 320/360/375 px、長品名、最大相似群組、失敗警示與 pinch zoom。
- 若未來要求自動化真實 layout，需明確承認會與「零測試依賴」取捨衝突，再決定是否例外導入 browser runner。

---

### 其他未覆蓋邊界

- 題庫恰好 20 個相異答案時，第一張失敗且無 spare 的 UI 行為。
- spare 多次失敗後的真正候選耗盡與終止。
- 新疊開始時舊圖片事件遲到。
- HTML 特殊字元在 `ans/full/zh/id` 與相似品名清單中的 escaping。
- 最大 9 個相似品名與極長品名的實際 mobile 排版。
- 圖片成功後又收到遲到 error 時，不得替換已翻面卡。

---

## 區塊 3 — Dependency audit

**無問題。**

- `git diff main..HEAD` 未修改 `package.json`。
- 本次 production code 只增加 `engine.js` 內部 export/import，未引入 runtime dependency。
- 測試僅使用 `node:test`、`node:assert`、`node:fs`、`node:path` 等 Node built-ins。
- `package.json` 已要求 Node `>=22`。
- CI 使用 Node 24，支援目前 `node --test "tests/**/*.test.mjs"` glob 行為。
- `.github/workflows/update-pool.yml` 已執行全部 `tests/**/*.test.mjs`，新增測試會自動納入。
- 不需要調整 package、Node 版本或 CI。

---

## 區塊 4 — 需求符合度稽核

需求來源為動工前對話紀錄，證據等級低於正式規格文件；以下仍依題示將其視為本次驗收基準。

| 條目 | 判定 | 實作證據與說明 |
|---|---|---|
| Q1 先學習、不是評量 | 符合 | `index.html:269–273` 明確標示不作答、不計分；`engine.js:872–877` card 無計分欄位。 |
| Q2 有限 20 張 | 符合 | `engine.js:834、893–895` 使用 `DECK_SIZE = QUIZ_SIZE`；`app.js:722–725` 完成後進完成頁。 |
| Q3 列出同外觀其他品名 | 符合 | `engine.js:848–869` 建索引並排除自己；`app.js:695–705` 逐一輸出 `<li>`，不是籠統警語。 |
| Q4 失敗遞補、累積數次詢問 | **部分不符合** | `app.js:735–755` 有遞補與三次警示；但 `engine.js:904–908` 未避開歷史上已被換掉的答案，且 `app.js:644–672` 在圖片成功前即可翻面。 |
| Q5 unit + smoke + mobile | **部分符合** | `tests/flashcard.test.mjs` 有 unit 與 UI smoke；`tests/flashcard.test.mjs:374–405` 只是 CSS regex，尚非真實 mobile layout/interaction 驗收。 |
| F1 不需難度、狀態分離 | 符合 | `app.js:58–78` 分離 `questions/idx` 與 `deck/fIdx`；`app.js:1000–1002` 閃卡不讀 `state.level`。 |
| F2 20 張後完成頁 | 符合 | `engine.js:834、893–895`；`app.js:722–725、765–776`。 |
| F3 翻前背面空、翻後顯示品名與字號 | **部分不符合** | 正常路徑由 `app.js:651–658、707–712` 達成；但圖片 pending 時可先翻面，第三次失敗警示路徑 `app.js:741–753` 不清空既有背面。 |
| F4 遞補、避開整疊歷史答案、3 次詢問 | **不符合完整承諾** | 三次詢問成立：`app.js:742–753`。歷史排除不成立：`engine.js:904–908` 只看目前 deck；測試 `tests/flashcard.test.mjs:92–105` 也只驗固定 deck。 |
| F5 手機可用 | 實作大致符合，驗收不足 | `.q-img` responsive：`index.html:82–85、349`；44px：`index.html:63–67`；斷行：`index.html:210–220`；viewport 未停用縮放：`index.html:5`。但缺真實 mobile layout smoke。 |
| F6 不計分、不污染測驗分母 | 符合 | 狀態分離於 `app.js:58–78`；測驗仍只計 `state.questions`：`app.js:786–795`；整合測試 `tests/flashcard.test.mjs:351–368` 驗證分母 20。 |

### 最終判定

- Q1、Q2、Q3、F1、F2、F6：符合。
- F5：程式碼符合，mobile 驗收層不足。
- Q4、F3、F4：未完整符合。
- 合併前至少應修正：
  1. 圖片 ready-gate。
  2. 整疊歷史答案集合。
  3. 警示路徑清空背面。
  4. 對應的非假綠燈測試。
