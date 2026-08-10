# V5 批次 1（codec）覆審判定書

| 項目 | 內容 |
|---|---|
| 判定日期 | 2026-08-10 |
| 覆審報告 | `.ai-review/codex-review-v5-codec.md`（Codex，thread `019feab0`） |
| 受審範圍 | PR #12 / `feat/v5-codec` @ `eb81d66` |
| 規格 | `.ai-review/plan-v5-formulary.md` v5.8 |

## 統計

**接受 7／部分接受 1／拒絕 0**，共 8 項。**Codex 零幻覺。**

**Codex 宣稱的五個弱化實作，我逐一實跑驗證，四個確實仍全綠。**

| Codex 宣稱的弱化 | 實跑結果 |
|---|---|
| wire index 11↔12 對稱對調 | **仍全綠** ✅ 屬實 |
| 拿掉 varint 5-byte 上限與 overflow | **仍全綠** ✅ 屬實 |
| 拿掉 base64 `n===3` 尾 bits 與 mod-1 長度檢查 | **仍全綠** ✅ 屬實 |
| `count` 超界靜默截斷 | **仍全綠** ✅ 屬實 |
| 號碼 +1（前綴保留、樣本特判） | **轉紅 2 條** —— 被 A37 的冪等性攔下 |

**沒有一項實作邏輯錯誤**。全部八項都落在**測試強度**與**一個輸入契約偏差**上。

---

## 最重要的一項：R-1

### R-1 「wire index 正確」這個測試不驗 wire index — **接受（High）**

**這一項打在我自己寫來防假綠燈的測試上，而且我在它的測試名稱裡就寫了「wire index 正確」。**

`tests/formulary.test.mjs:53-63` 做的是：

```js
const { ids } = decodeFormulary(encodeFormulary([id], 0));
assert.deepEqual(ids, [id]);                       // ← round-trip
assert.ok(id.startsWith(PREFIX_TABLE[i].prefix));  // ← 只驗 fixture 自己
```

**兩條都不驗 wire index。** encoder 與 decoder 做對稱對調時，round-trip 恆等成立。
G1–G5 只獨立釘住 index **0、2、16、17**，11–15 完全沒有外部 oracle。

**實跑確認**：把 encode/decode 對 index 11↔12 做對稱對調 → **59/59 仍全綠**。

後果不是「測試不夠漂亮」而是：**已分享出去的舊連結會靜默解成不同的藥**——
正是本專案最怕的失效模式，而 wire format 是不可變契約，發布後改不了。

這是**「規格說驗證 A 與 B 一一對應、實作只檢查較弱性質」的教科書案例**，
而我在寫這條測試時的意圖恰恰是要防它。**〔堵〕註解寫對了，斷言沒跟上。**

---

## 逐項判定

| # | 項目 | 嚴重度 | 判定 | 理由（皆已回讀檔案並實跑驗證） |
|---|---|---|---|---|
| **R-1** | 18 種 wire index 未獨立驗證，11–15 無 oracle | High | **接受** | 見上。實跑對稱對調 → 仍全綠 |
| **R-2** | 93 組撞號未逐筆驗 `normalizeLicense(id) === id`；缺同前綴不同號碼的反例 | High | **部分接受** | **缺口屬實**：`tests/formulary.test.mjs:66-75` 只驗「非 null 且組內相異」。**但 Codex 描述的那個弱化被攔下了**——我實跑「號碼 +1、樣本特判」→ 轉紅 2 條，是 A37 的**冪等性**斷言抓到的（`N(N(x)) !== N(x)`）。所以嚴重度應降為 Medium。修法仍照做：逐筆加 self-identity，並補同前綴不同號碼（如 `第000123號` vs `第001230號`）的不碰撞反例——**冪等性是碰巧攔到，不是設計來攔這個的** |
| **R-3** | A40 明列的 varint >5 bytes／overflow 完全沒有 fixture | Medium | **接受** | 屬實。實跑拿掉 5-byte 上限與 overflow 檢查 → **仍全綠**。規格 A40 白紙黑字列了這兩項，實作沒寫 |
| **R-4** | base64url 只測 `n===2` 的尾 bits，未測 `n===3` 與 `length % 4 === 1` | Medium | **接受** | 屬實。實跑拿掉這兩項檢查 → **仍全綠**。其中「合法 payload 後追加一個不產生 byte 的字元」那條特別要補——那會讓同一 body 有多個字串表示，破壞 canonical 唯一性 |
| **R-5** | 測試名稱宣稱 count 與 unlistedCount 都驗超界，實際只驗 unlistedCount | Medium | **接受** | 屬實。實跑刪掉 `count > MAX_U16` 檢查 → **仍全綠**。**這是「測試名稱宣稱強於斷言」的形態**——比沒有名稱更誤導，因為後人會相信它 |
| **R-6** | A39 的 permutation 集合不含最小號碼 1 | Low | **接受** | 屬實。真正做 permutation 的 G2／G4／G5 都不含 1，而 G1 是單元素（無順序可言）。補一組含 1 的多元素 golden |
| **R-7** | A45 第 2 案「只有空白與分隔符」只測了空白與 Tab，未測逗號／分號／全形逗號 | Low | **接受** | 屬實。規格 A45 明寫「只有空白**與分隔符**」 |
| **R-8** | `tokenize` 的多欄偵測不是 quote-aware，違反 D35.1a | Low | **接受** | 屬實，已實跑確認：`tokenize('"A,B"')` 拋 `COLUMN_NOT_SPECIFIED`，而 D35.1a 明定「引號內的 delimiter **不算分欄**」。嚴重度 Low 正確——這是**明顯拒絕**而非靜默錯配，使用者看得到錯誤訊息。修法：頂層 delimiter 偵測沿用 `splitRow` 的引號狀態機 |

### Codex 的兩項正確澄清（無需動作）

- **CRC 是完整性檢查而非對抗性 MAC** —— 在本專案「無認證、無機密、payload 只是一組 id」的威脅模型下正確。**它沒有建議改用 HMAC**，這個克制是對的
- **`normalizeLicense` 缺「第」分支第 108 行的條件寫得多餘**，但在 v1 表內不會誤判。判定：**不改**——那行是防禦性寫法，改動反而增加風險，且沒有可觀察的行為差異

### 關於全套測試結果的差異

Codex 報「全套 430 通過、3 failed、3 cancelled」，並自行判斷成因是唯讀環境禁止建立 uv cache。
**本機實跑為 436 通過、0 失敗**（`npm test` 需要 uv 跑 Pillow 解損毀 WebP，唯讀沙箱跑不了）。
Codex 的歸因正確，**不是本批回歸**。

---

## 建議處理順序

1. **R-1**（唯一 High，且是 wire contract 層級）—— 為 index 11–15 補獨立硬編碼 wire vectors
2. **R-3 ＋ R-4 ＋ R-5**（三個「拿掉檢查仍全綠」）—— 成本低、各補一組 fixture
3. **R-2** —— 93 組逐筆 self-identity ＋ 同前綴不同號碼反例
4. **R-8** —— tokenize 改 quote-aware（唯一動到 source 的一項）
5. **R-6 ＋ R-7** —— 補 golden 與 delimiter-only 案例

## 這一輪的教訓

**一、`〔堵〕` 註解寫對了，斷言沒跟上。**
R-1 的測試名稱叫「wire index 正確」、註解寫著「〔堵〕只驗『解析得出來』而不驗 wire index」——
**我在註解裡精準描述了要堵的弱化，然後寫了一條堵不住它的斷言。**
通則：**寫完〔堵〕註解後，要用它描述的那個弱化實跑一次變異驗證**，
否則註解只是意圖聲明，不是防線。

**二、變異驗證的涵蓋面取決於我想得到哪些弱化。**
批次 1 我做了 7 個變異全部轉紅，因此對測試強度過度自信。
Codex 一口氣提出 5 個我沒想到的弱化，其中 4 個全綠。
**「我的變異全轉紅」只證明我想到的那些被擋住了**——這正是 repo 既有的
「變異驗證只驗得到我想得到的那個弱化，驗不出我沒想到的那個位置」再次成立。

**三、測試名稱會變成後人相信的承諾。**
R-5 的測試叫「uint16 邊界：count 與 unlistedCount 超界一律拒絕」但只驗了後者。
名稱過度宣稱比沒有名稱更糟——**與「註解宣稱的性質比實作強，比沒有註解更糟」同型**。

## 邊界聲明

覆審輪全程唯讀，**未修改任何 source code**。寫入僅限 `.ai-review/` 下的兩份報告。
判定者與實作者為同一人；Codex 的獨立性正是為此存在。

---

## 處理結果（2026-08-10，同分支 `feat/v5-codec`）

**8 項全部處理完畢。測試 59 → 68（全套 436 → 445），全綠。**

| # | 處置 | 落點 |
|---|---|---|
| **R-1** | 已修 | golden 新增 **G6**（index 11–15 各一筆，手推＋Python stdlib oracle，見 `golden-vectors-v1.md`）。原本的「wire index 正確」測試**整條改寫**：不再走 round-trip，改為解 9 個**硬編碼 payload** 並逐一斷言解出的 id 對應到指定的 `PREFIX_TABLE[idx]`。**變異驗證**：index 11↔12 對稱對調 → 轉紅 4 條（修前全綠） |
| **R-2** | 已修 | 93 組撞號改為**逐筆** `assert.equal(norms[i], group[i])`；另新增「同一前綴、不同號碼不得碰撞」三對。**變異驗證**：號碼整批 +1（樣本特判）→ 轉紅 4 條 |
| **R-3** | 已修 | A40 grammar-invalid 新增兩條：6-byte varint → `VARINT_TOO_LONG`；第 5 byte 超出 32 bits → `VARINT_OVERFLOW`。**變異驗證**：拿掉兩個檢查 → 轉紅（修前全綠） |
| **R-4** | 已修 | 新增餘 3 字元的尾端 bits（用 G7 的尾字元 `8`→`9`）與 `length % 4 === 1`（G2 後追加一字元）。**變異驗證**：拿掉兩個檢查 → 轉紅 2 條（修前全綠） |
| **R-5** | 已修 | 測試名稱改為只宣稱 `unlistedCount`；另新增獨立一條，用 65536 筆合成 id 斷言 `COUNT_OUT_OF_RANGE`，並釘住 65535 筆合法的另一側。**變異驗證**：刪掉 count 檢查 → 轉紅（修前全綠） |
| **R-6** | 已修 | golden 新增 **G7**（含最小號碼 1 的多元素集合），A39 的 permutation 迴圈自動涵蓋 |
| **R-7** | 已修 | A45 第 2 案補 `,`／`;`／全形逗號三種 delimiter-only。**過程中發現 Tab 本身是空白**，整行只有 Tab 會被 `trim()` 清成空行而略過——已另立一條斷言明確表達這條路徑 |
| **R-8** | 已修（動 source） | 新增 `hasTopLevelDelim()`，沿用 `splitRow` 的引號狀態機。**另修一個由此引入的回歸**：引號未閉合時偵測不到頂層分隔符，會讓 `UNCLOSED_QUOTE` 被 `UNEXPECTED_DELIMITER` 蓋掉——改為**呼叫端明確指定 `delimiter` 時一律走多欄路徑**，偵測只用來決定「未指定時要不要要求指定」 |

### 變異驗證總表（修後）

**10/10 全部轉紅**，包含 Codex 提出而修前存活的四個：

| 變異 | 修前 | 修後 |
|---|---|---|
| wire index 11↔12 對稱對調 | 全綠 | **RED (4)** |
| 拿掉 varint 5-byte 上限與 overflow | 全綠 | **RED (1)** |
| 拿掉 base64 `n===3` 尾 bits 與 mod-1 | 全綠 | **RED (2)** |
| `count` 超界靜默截斷 | 全綠 | **RED (1)** |
| 號碼整批 +1（樣本特判） | RED (2) | RED (4) |
| tokenize 退回非 quote-aware | — | **RED (1)** |
| 正規化丟掉前綴 | RED | RED (16) |
| decode 不補前導零 | RED | RED (7) |
| 忽略 `unlistedCount` | RED | RED (3) |
| encode 不排序 | RED | RED (1) |

### 明列未做

**index 1、3–10 仍只由 `PREFIX_SAMPLES` 的 round-trip 覆蓋**，沒有獨立 wire vector。
R-1 的修法只補了 11–15，因為那是 v5.2／v5.3 新增、最可能被錯抄的區段。
**這是已知缺口，已寫進 `golden-vectors-v1.md` 的涵蓋矩陣，列入下一批。**
不宣稱 A38 已完整涵蓋全部 18 個 index。
