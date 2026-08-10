# Codex 程式碼覆審 — V5 批次 2（管線 excluded.json）

| 項目 | 內容 |
|---|---|
| 審查日期 | 2026-08-10 |
| 覆審員 | Codex（`mcp__codex__codex`，`sandbox: read-only`、`approval-policy: never`） |
| thread | `019fead1-5b46-7682-843c-4b083bd34559` |
| 審查範圍 | `feat/v5-pipeline` 相對 `feat/v5-codec`：`tools/build-pool.mjs`、`tests/pipeline.test.mjs` |
| commit | `a404afd` |
| 規格 | `.ai-review/plan-v5-formulary.md` v5.8（區塊 4 已啟用） |

> 以下為 Codex 原始輸出，**未修飾、未刪改、未重排**。

---

結論：**本批目前不建議合併**。有兩項 High：`excluded.json` schema 與 D49 不符，以及正式 `data/excluded.json` 未隨分支送達。另有數個驗證缺口會造成假綠燈。

## 1. Code review

### 發現 1

**tools/build-pool.mjs:432 / High / `excluded.json` 頂層 schema 與 D49 不符 / 將 `schema`、`source_version`、`content_hash`、`count` 移到 JSON 頂層，並同步修正測試**

D49 明定：

```json
{
  "schema": 1,
  "source_version": "...",
  "content_hash": "...",
  "count": 2354,
  "items": [...]
}
```

目前卻產生：

```json
{
  "meta": {
    "schema": 1,
    "source_version": "...",
    "content_hash": "...",
    "count": 2354
  },
  "items": [...]
}
```

而測試在 `tests/pipeline.test.mjs:522` 與第 594–596 行也跟著驗錯誤的 `excluded.meta.*`，因此全綠不能證明 D49 契約相容。後續若依 v5.8 實作讀取端 schema validator，這份產物會整份被判為不可用，產連結功能將永久停用。

### 發現 2

**tools/build-pool.mjs:466 / High / 產生器已能產出檔案，但分支未包含 `data/excluded.json`，屬 SC-2「功能未送達」 / 以真實來源重建並將 `data/excluded.json` 納入本批提交，確認其 hash 與已提交的 `pool.json` 配對**

`feat/v5-pipeline` 的 Git tree 中沒有 `data/excluded.json`，而 diff 也只有產生器與測試。合併後 GitHub Pages 不會立即提供該資源；必須等下次 workflow 成功執行，甚至可能因其他管線條件而長期不存在。

這正是規格 §5.1 宣稱「新增 `data/excluded.json`」但使用者端實際拿不到的 SC-2 形態。

### 發現 3

**tools/build-pool.mjs:460 / Medium / `content_hash` 不一致檢查是不可達分支，沒有真正驗證一對獨立產物 / 抽出 `validatePair(poolPayload, excludedPayload, srcIds)`，由寫出前及 `verify-data` 共用，測試直接傳入合法但 hash 不同的兩份 payload**

第 439 行先直接指定：

```js
content_hash: payload.meta.content_hash
```

第 460 行隨即比較兩者，因此在沒有記憶體遭外力修改的正常 JavaScript 執行中條件永遠不成立。它沒有涵蓋：

- 已存在但配錯版本的兩份檔案。
- 產物被手動修改。
- workflow 或後續步驟只更新其中一份。
- 讀取端取得不同部署版本的兩檔。

這是「宣稱的失敗處理未實際觸發」。

### 發現 4

**tools/build-pool.mjs:466 / Medium / CLI 寫出本身不是成對原子操作，第二次寫檔失敗會留下新 pool 與舊／缺失 excluded / 依 D48 在 workflow 使用 staging 目錄完成生成與成對驗證，再將 staging 內容交給提交步驟**

目前順序是先寫 `pool.json`、再寫 `excluded.json`。若第二次寫入失敗，本機工作樹確實會成為半更新狀態，且錯誤訊息「data/ 未變更」不實。

實際 workflow 的保護情況需區分：

- 好的一面：build step exit 1 後，預設會跳過 fetch、test、verify、commit，因此**半對不會被 Git commit/push 發布**。
- 不足之處：`.github/workflows/update-pool.yml:46-47` 直接寫正式 `data/`，沒有 D48 所宣稱的 Actions staging；B12 的「失敗後 sentinel 兩檔位元組不變」也沒有模擬第二次 `writeFileSync` 失敗。

因此目前有 commit-level 的發布保護，但沒有規格宣稱的 staging，也沒有本機檔案位元不變保證。建議不需後端或依賴，單純使用 `$RUNNER_TEMP` staging 即可，符合既有架構限制。

### 其餘重構判斷

`partition` 重構本身未發現行為回歸：

- Q1、Q2 的元素是原始列，`markOut` 走 `r`。
- Q3、Q4、Q5 的元素是 `{r, ans}`，`markOut` 走 `r.r`。
- Q3 起所有 predicate 與 item mapping 都正確使用 `x.r`。
- Q5 衝突群組整組標為 Q5，與原先整組排除一致。
- 最後用存活 `items` 刪除 `excludedBy`，正確實現「任一列存活即 matched」。

`(r.r ?? r)` 理論上會把帶有額外 `r` 欄位的原始來源列誤認為 wrapper，但 TFDA schema 未包含該欄位，現有來源亦無此情形，不列為本批缺陷。

`checkPrefixTable()` 的正規式採 fail-closed：

- 號碼段全非數字：無法 match，中止。
- 空 id：無法解析，中止。
- 不含「字第」：無法解析，中止。
- 「字第」以前含數字：仍由 `.+?` 包含在完整前綴，不會因數字提前截斷。
- `R00001` 類型：`\D*` 會把 `R` 納入前綴，符合 D34.4。

未發現非貪婪量詞會把目前 18 種合法前綴誤切的案例。

空 id 在 `markOut` 雖會被跳過，但正式主流程先經 `checkPrefixTable()`，所以目前會在 buildPool 前中止；不會實際走到聯集檢查。

關於「拿掉聯集完整性檢查仍綠」：作者判斷正確。單獨移除第 454–459 行不會改變任何成功產物或退出行為，因為目前產物建構本身已維持該不變量，測試又獨立斷言聯集。只有同時引入第二個破壞分流的 mutation 才有可觀察差異，屬高階 mutation，不能要求單一 mutation 必然轉紅。

## 2. Test gap analysis

### 發現 5

**tests/pipeline.test.mjs:592 / Medium / B12 沒有規格要求的「除 hash 外完全合法但 hash 不一致」fixture / 對抽出的 pair validator 傳入兩份完整合法 payload，只改 excluded 的 hash，斷言特定錯誤且兩個 sentinel 不變**

目前 B12 的失敗案例在第 603–606 行注入的是未知前綴，實際死於 B13，完全沒有走到 hash mismatch 分支。

可讓現有測試全綠的弱化版本：

```js
// 完全刪除 content_hash 不一致檢查
```

成功案例仍因產生器直接複製 pool hash 而全綠；失敗案例仍由未知前綴轉紅。

### 發現 6

**tools/verify-data.mjs:64 / Medium / workflow 的獨立正式資料驗證完全不知道 `excluded.json` / 加入無依賴的成對 validator，驗頂層 D49 schema、hash、count、id 唯一／非空、互斥、stage 封閉**

目前正式 artifact 即使出現以下問題，`verify-data` 仍會成功：

- `excluded.json` 不存在。
- JSON 損毀。
- 使用錯誤的 `meta` schema。
- hash 與 pool 不一致。
- stage 為 `Q6`、`null` 或缺欄位。
- id 重複或同時存在於 pool。

這使 pipeline fixture 測試只能證明「測試執行時產生器曾經正確」，不能證明即將 commit 的正式資料仍正確。

### 發現 7

**tests/pipeline.test.mjs:632 / Medium / B13 的「18 種前綴全數存在」正面測試實際只檢查 log 中集合大小為 18 / 建立表驅動 fixture，逐一放入 D34.4 的 18 種前綴，並確認管線成功**

`stageRows()` 實際只涵蓋少數前綴；第 635 行只是比對：

```js
/前綴皆在 D34\.4 的 18 種表內/
```

該數字來自 `KNOWN_PREFIXES.size`，不是 fixture 的觀察結果。

可讓測試全綠的弱化版本：保留 fixture 使用的 2–3 個正確前綴，把其餘表項換成任意假前綴，只要 Set 大小仍為 18，所有現有測試仍綠。

### 發現 8

**tests/pipeline.test.mjs:515 / Medium / B10 沒有注入空 id，聯集測試的母集合也未採正式程式的 `trim().filter(Boolean)` 定義 / 加入空 id 的 Q1 淘汰列與存活列，兩者都必須明確 fail**

目前正面輸出只驗結果沒有空 id。可讓現有測試全綠的弱化版本：

```js
// checkPrefixTable 中新增
if (!id) continue;
```

若空 id 列在 Q1 被淘汰：

- `markOut` 跳過。
- `srcIds.filter(Boolean)` 跳過。
- 聯集 cardinality 仍相等。
- 管線成功但來源列靜默消失。

這正是「母集合定義排除了錯誤資料，導致完整性斷言看不見它」。

### 發現 9

**.github/workflows/update-pool.yml:78 / Low / always-run 摘要只讀 pool，半寫入或 excluded 驗證失敗時仍可能顯示看似成功的題庫統計 / 摘要同時讀取兩檔，顯示 excluded count、stage 分布、hash 是否成對；任一缺失時明示「產物不完整／未發布」**

這不會使 commit 成功，但會造成操作層面的虛假完成感。建議仍保持零依賴，以現有 `node -e` 即可完成。

## 3. Dependency audit

本批未新增 runtime、dev 或 workflow 依賴，未發現 dependency audit 問題。現有實作與建議修法都可維持 Node built-ins、零 jsdom、零框架及 `data/` 不進 SW 的限制。

## 4. 規格符合度稽核

| 條款 | 實際狀態 |
|---|---|
| **D49**（規格 626–650）＋ **tools/build-pool.mjs:432** | **不符合**：規格要求 metadata 位於頂層，實作放在 `meta`；測試亦驗錯誤 schema。其他不變量如 count、id 唯一、互斥、stage、非空有在產生器內驗證。 |
| **D47**（規格 613–624）＋ **tools/build-pool.mjs:464** | 本批只有產生端，沒有任何 consumer 或失敗降級；因此不能宣稱 D47 已送達。若批次 3 明確負責前端讀取，屬待辦而非本批額外架構缺陷。 |
| **D48**（規格 652–661）＋ **update-pool.yml:46** | **部分符合**：失敗會阻止 commit/push，外部發布是全有全無；但未採規格指定的 Actions staging，CLI 工作樹仍可能半更新。 |
| **§5.1**（規格 680–700）＋ **tools/build-pool.mjs:200** | 分階段聚合、first-wins、存活 id 從 excluded 扣除、結果排序均符合。正式 `data/excluded.json` 未提交，故資料流尚未實際送達。 |
| **D34.4**（規格 157–194）＋ **tools/build-pool.mjs:293** | 未知前綴掃來源全部列、在 allowlist 前獨立抽取並中止，實作方向符合。正面測試沒有真的覆蓋 18 種前綴。 |
| **B10**（規格 864–872）＋ **tests/pipeline.test.mjs:491** | Q1–Q5、survivor、逐筆歸屬、重複 id、最早 stage、順序獨立均有覆蓋；缺空 id 注入與一致的母集合定義。 |
| **B11**（規格 874–877）＋ **tests/pipeline.test.mjs:572** | 僅驗產生結果為 Q1–Q5；規格要求的未知、缺欄、`null`、非字串、大小寫與空白負面案例全數缺少。註解將其延後到批次 3，但以 v5.8 B11 本身衡量仍是未完成。 |
| **B12**（規格 879–884）＋ **tests/pipeline.test.mjs:591** | **不符合**：沒有 hash mismatch fixture；失敗 sentinel 測的是 B13 前綴錯誤。產生器 hash check 亦不可達。 |
| **B13**（規格 886–897）＋ **tests/pipeline.test.mjs:613** | 負面 fixture 良好：3 筆、Q1 淘汰、精確筆數、明確中止。正面案例是假綠：未讓 18 種前綴逐一出現在來源。 |

修正優先順序：

1. 修正 D49 頂層 schema及相關測試。
2. 重建並提交正式 `data/excluded.json`。
3. 讓 `verify-data` 驗證兩檔與 hash 配對。
4. 補真正的 B12 mismatch、B13 十八前綴與 B10 空 id fixture。
5. 落實 workflow staging，補強摘要。
