# Codex 程式碼覆審 — V5 批次 1（codec）

| 項目 | 內容 |
|---|---|
| 審查日期 | 2026-08-10 |
| 覆審員 | Codex（`mcp__codex__codex`，`sandbox: read-only`、`approval-policy: never`） |
| thread | `019feab0-fbe4-7113-9868-02d3e45f8d27` |
| 審查範圍 | `feat/v5-codec` 相對 `main`（PR #12）：`formulary.js`、`tests/formulary.test.mjs`、`tests/_license-fixtures.mjs` |
| commit | `eb81d66` |
| 規格 | `.ai-review/plan-v5-formulary.md` v5.8（區塊 4 已啟用） |

> 以下為 Codex 原始輸出，**未修飾、未刪改、未重排**。

---

## 1. Code review

- `formulary.js:155-167 / Low / 多欄偵測直接搜尋原始字串中的任一分隔符，沒有排除引號內的 delimiter。因此 tokenize('"A,B"') 會拋 COLUMN_NOT_SPECIFIED；但 D35.1a 明定引號內 delimiter 不算分欄。這是明顯拒絕，不會造成藥品靜默錯配，但違反輸入契約。 / 建議修法：將「是否存在頂層 delimiter」改為 quote-aware 掃描，沿用 splitRow 的引號狀態機；不需新增依賴。`

其餘指定重點未發現實作缺陷：

- `normalizeLicense()` 第 94–97 行確實選最長前綴，`衛署藥輸字第R` 不會被較短前綴吃掉。缺「第」分支中第 108 行條件寫得多餘，但在目前 v1 表內不會造成誤判：短前綴遇 R 時，剩餘字串不符合純數字。
- `lebDecode()` 對最大合法值 `0xFFFFFFFF` 與第五 byte overflow 的數值計算精確；最大中間值仍遠低於 JavaScript safe integer。非最短編碼判定也正確。
- `b64urlDecode()` 的 `length % 4 === 1` 判定正確；餘 2 字元檢查低 4 bits、餘 3 字元檢查低 2 bits，涵蓋完整。
- `splitCanonical()` 由後往前可讓 R 型先於其一般型；即使先碰一般型，完整正規式也不會接受帶 R 的 rest。目前固定表下可靠。
- `decodeFormulary()` 的 `ids.length < count`、groupCount 上界及 `pos === covered.length` 組合未找到可繞過 payload。`count=0` 帶 group、少資料、多資料、空 group 都會拒絕。
- CRC 是完整性檢查而非對抗性 MAC；在既定低敏感度威脅模型下符合規格。

## 2. Test gap analysis

- `tests/formulary.test.mjs:53-63 / High / 測試名稱宣稱驗證 18 種 wire index，但實際只做 encode→decode round-trip。G1–G5 只獨立釘住 index 0、2、16、17，index 11–15 沒有獨立 wire oracle。具體弱化版本：encoder 將 11↔12 對調、decoder 做相反對調，PREFIX_TABLE 保持不變；現有測試仍全綠，但跨版本連結會靜默解成錯藥。 / 建議修法：保留既有 frozen index，新增獨立、硬編碼 payload/body vector，至少逐一涵蓋 index 11–15；不得由受測 encoder 動態產生。`

- `tests/formulary.test.mjs:66-75,130-143 / High / 93 組撞號只驗「非 null 且組內相異」，沒有逐筆斷言 normalizeLicense(id) === id；「任兩個不同合法 id」也只取每種前綴一筆，完全沒有同一前綴、不同號碼的 pair。弱化 normalizer 可保留前綴但把大部分號碼改成另一個號碼，93 組仍因前綴不同而相異，既有少數精確樣本則特判通過。 / 建議修法：93 組每筆加上 norms[i] === group[i]；另加入至少數組同前綴不同號碼，例如 00123 與 01230，逐筆驗精確輸出及彼此不等。`

- `tests/formulary.test.mjs:265-284 / Medium / A40 明列的「varint 超過 5 bytes／overflow」完全沒有 fixture。具體弱化版本：lebDecode 移除第五 byte 32-bit overflow 與五 byte 上限，現有測試仍全綠。 / 建議修法：以正確 CRC 分別加入：合法 0xFFFFFFFF 邊界、第五 byte 資料超過 0x0F、以及六 byte varint，釘住拒絕行為。`

- `tests/formulary.test.mjs:286-290 / Medium / base64url 只測餘 2 字元的低 4 bits；未測餘 3 字元的低 2 bits，也未測 length % 4 === 1。具體弱化版本：decoder 只保留 n===2 尾 bits 檢查並移除 mod-1 長度檢查，現有測試全綠；甚至可能接受在合法 payload 後追加一個不產生 byte 的字元。 / 建議修法：用 G5 最後字元構造 n===3 非零尾 bits；另在長度為 4k 的合法 payload 後追加一個 base64url 字元，斷言 BAD_BASE64_LENGTH。`

- `tests/formulary.test.mjs:309-312 / Medium / 測試名稱宣稱 count 與 unlistedCount 都驗超界，實際只有 unlistedCount。具體弱化版本：刪除 encodeFormulary 的 uniq.length > 65535 檢查並將 count 靜默截成低 16 bits，現有測試仍全綠。 / 建議修法：提供 65,536 個相異 canonical id，斷言 COUNT_OUT_OF_RANGE；可由固定規則在測試記憶體中產生，不需 fixture 檔或依賴。`

- `tests/formulary.test.mjs:187-210 / Low / A39 要求至少三組 permutation 的集合整體涵蓋最小值 1；目前真正做 permutation 的 G2、G4、G5 都不含 1，G1 只做單元素精確輸出。弱化 encoder 可僅在含號碼 1 的多元素集合保留輸入順序，現有測試仍全綠。 / 建議修法：增加含號碼 1 與另一號碼的多元素 golden，至少跑三種順序。`

- `tests/formulary.test.mjs:316-340 / Low / A45 第 2 案規格是「只有空白與分隔符」，測試實際只有空白、換行與 Tab，未涵蓋逗號、分號、全形逗號。A45 所稱各分類精確 membership 亦尚未存在。 / 建議修法：本批可先補四種 delimiter-only 的 tokenizer 精確結果；分類 membership 屬已聲明的後續四分類批次，應標示 deferred，不應在本 PR 假稱完整通過 A45。`

測試結果：

- `node --test tests/formulary.test.mjs`：59/59 通過。
- 全套測試：430 通過；3 failed、3 cancelled，原因是唯讀環境禁止建立 uv cache／系統暫存目錄，不是本批回歸。
- `git diff --check` 無輸出。

## 3. Dependency audit

本批沒有新增 package、runtime 或 test dependency，符合零依賴、無 build step、無 jsdom 的架構限制。無 dependency finding。

## 4. 規格符合度稽核

### D 條款

- `D34.2 + formulary.js:213-292,333-392 / 符合 / unsigned LEB128、CRC-32/ISO-HDLC、big-endian checksum、無 padding base64url、版本欄位及解碼終止條件均依規格實作。`

- `D34.2a + formulary.js:319-336,365-366 / 部分符合 / count 取去重後 canonical id 數，兩欄均使用 uint16；unlistedCount 的語意計算由呼叫端負責，符合純 codec 分層。但 A40 未驗 count 超界。 / 建議修法：補 COUNT_OUT_OF_RANGE 測試；後續分類層須負責按 D35.1/D35.2 後相異 token 計算 unlistedCount。`

- `D34.3 + formulary.js:338-347,368-392 / 符合 / prefix 嚴格遞增、組內排序與正 delta、非空 group、count 總數、提前耗盡及 trailing bytes 均 fail-closed；count=0 合法。`

- `D34.4 + formulary.js:16-52 / 符合 / v1 表的 18 個 index、字串與 numWidth 和規格一致，且陣列及 entry 均 frozen。`

- `D34.4a + formulary.js:380-389 / 符合 / decode 依 prefixString、numWidth、零填補與固定「號」重建；prefix 越界及位數上限拒絕。`

- `D35.1 + formulary.js:145-187 / 部分符合 / BOM、三種換行、空行、trim、明確多欄指定及空輸入皆實作；但第 159 行把引號內 delimiter 也視為多欄。 / 建議修法：採 quote-aware 頂層 delimiter 掃描。`

- `D35.1a + formulary.js:171-205 / 部分符合 / 固定 delimiter、1-based column、header、ragged rows、未閉引號及欄位越界均實作；引號內 delimiter 的 splitRow 正確，但在較早的第 159 行可能已被誤判。 / 建議修法同上。`

- `D35.2 + formulary.js:86-127 / 符合 / 長前綴優先、R 型、缺第／號、空白、全形、大小寫、前導零及未知前綴 fail-closed 均正確。`

### 驗收條件

- `A36 + tests/formulary.test.mjs:42-85 / 部分符合 / 93 組及 18 種 prefix fixture 齊全，但撞號未逐筆驗「命中自己」，index 11–15 也沒有獨立 wire golden。`

- `A37 + tests/formulary.test.mjs:89-143 / 部分符合 / 容忍、拒絕、組合、冪等都有測；缺同一前綴不同合法號碼的不碰撞反例。`

- `A38 + tests/formulary.test.mjs:19-35,145-184 / 部分符合 / G1–G5 是正確的外部 oracle，CRC、版本、unlistedCount 與補零均被驗證；但規格宣稱涵蓋新增 index 11–17，實際只涵蓋 16、17，11–15 未涵蓋。`

- `A39 + tests/formulary.test.mjs:187-210 / 部分符合 / 有三組多元素 golden 的三種順序及最大值，但最小號碼 1 沒有出現在 permutation 集合。`

- `A40 + tests/formulary.test.mjs:214-313 / 部分符合 / CRC 全 byte mutation、正確 CRC grammar fixtures、部分結果禁止及多數錯誤類型均完成；缺 varint >5 bytes、varint overflow、count 超界、base64url mod-1、以及餘 3 字元尾 bits。`

- `A45 + tests/formulary.test.mjs:316-340 / 部分符合／已知 deferred / 空字串與重複 20 次有精確結果；delimiter-only 覆蓋不足，分類 membership 尚屬後續批次。依題目前提，不將後者列為本批功能缺陷，但目前不能宣稱完整滿足 A45。`

## 合併結論

`formulary.js` 的核心 codec 邏輯目前看來正確，沒有發現會直接造成現版靜默錯配的實作錯誤；但我不建議 PR #12 以「A36–A40、A45 已完整驗收」的狀態直接合併。至少應先補：

1. index 11–15 的獨立 wire vectors。
2. 撞號逐筆 self-identity 與同前綴不同號碼測試。
3. A40 明列但缺少的 varint、count 及 base64url fixtures。
4. 引號內 delimiter 的 tokenizer 修正。

以上修正均可維持零依賴、既有 wire format、外部 golden 與純函式批次邊界。
