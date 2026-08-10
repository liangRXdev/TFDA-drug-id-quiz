# V5 批次 2（管線）覆審判定書

| 項目 | 內容 |
|---|---|
| 判定日期 | 2026-08-10 |
| 覆審報告 | `.ai-review/codex-review-v5-pipeline.md`（Codex，thread `019fead1`） |
| 受審範圍 | `feat/v5-pipeline` @ `a404afd` 相對 `feat/v5-codec` |
| 規格 | `.ai-review/plan-v5-formulary.md` v5.8 |

## 統計

**接受 8／部分接受 1／拒絕 0**，共 9 項。**Codex 零幻覺（第三度）。**

**Codex 指出的三個假綠，我逐一實跑變異驗證，三個都確實仍全綠。**

| 弱化 | 實跑 |
|---|---|
| 表中 11 種前綴換成假的（`Set` 大小仍 18） | **仍全綠** ✅ |
| `checkPrefixTable` 跳過空 id | **仍全綠** ✅ |
| 拿掉 `content_hash` 不一致檢查 | **仍全綠** ✅（確認是死碼） |

**Codex 也主動確認了我的一項判定是對的**：「拿掉聯集完整性檢查仍綠」屬預期，
因為那是防禦性檢查、產物建構本身已維持該不變量，
**「只有同時引入第二個破壞分流的 mutation 才有可觀察差異，屬高階 mutation，
不能要求單一 mutation 必然轉紅」**。外部覆審替既有判斷背書，比它挑毛病更有訊息量。

---

## 兩項 High

### 發現 2｜`data/excluded.json` 沒有隨分支送達 — **接受（High）**

**這是 SC-2 形態的重演，而 SC-2 的教訓就寫在我的記憶裡。**

`feat/v5-pipeline` 的 tree 裡**沒有 `data/excluded.json`**，diff 只有產生器與測試。
合併後 GitHub Pages 不會提供這個資源，前端的三分類**靜默不存在**，
要等下個月 1 日的排程才可能出現。

當初 SC-2 的結論原文是：
> **歸因乾淨與功能真的送達是兩件事，不能用前者換掉後者而不說代價。**

當時採的解法是「PR 維持純程式碼，合併後**手動觸發** workflow」並跑完 4 步確認清單。
本批可用同一條路，**但那是一個必須被執行的動作，不是可以省略的**。

**本批採更直接的解法**：`carryHashes()` 會沿用既有 `pool.json` 的 `src_sha256`，
因此以同一份來源在本機重跑，`pool.json` 會**位元組不變**，只新增 `excluded.json`——
沒有「資料變更混進程式碼 PR」的歸因問題。這比 SC-2 當時的情境更乾淨。

### 發現 1｜`excluded.json` 的 schema 與 D49 不符 — **部分接受（High → 仍須解決）**

**問題屬實，已回讀兩端確認**：

- 規格 `plan-v5-formulary.md:630-638` 的 D49 範例把 `schema`／`source_version`／
  `content_hash`／`count` 放在**頂層**
- `tools/build-pool.mjs` 產出的是 `{ meta: {...}, items: [...] }`
- 而 `tests/pipeline.test.mjs` 驗的是 `excluded.meta.*`——**測試跟著實作走，
  所以全綠證明不了 D49 相容**

**但修法方向相反：應該修規格，不是修實作。**

`data/pool.json` 的既有慣例就是 `{ meta: {...}, items: [...] }`（實測頂層只有 `meta`、`items`）。
兩份資料檔放在同一個目錄、由同一個前端載入，卻用兩套 metadata 慣例，
是明確的維護陷阱——下一個人讀 `pool.meta.count` 之後很自然會寫 `excluded.meta.count`，
然後在 D49 那邊踩到。

D49 的範例是我在 v5.3 補寫時憑空畫的，**沒有對照 `pool.json` 的實際形狀**。
這與本專案反覆出現的「從已處理的產物回推來源性質」是同一族：
**寫規格時沒去讀手邊已經存在的權威樣本**。

**因此判定部分接受**：Codex 指出的不一致成立且必須解決，
但正確作法是把 D49 的範例與不變量描述改成 `meta` 形式，與 `pool.json` 對齊，
並在規格中明寫「兩份資料檔的 metadata 慣例必須一致」。

---

## 逐項判定

| # | 項目 | 嚴重度 | 判定 | 理由（皆已回讀檔案，三項另做變異驗證） |
|---|---|---|---|---|
| **1** | `excluded.json` schema 與 D49 不符 | High | **部分接受** | 見上。不一致屬實，但**改規格**（對齊 `pool.json` 的 `{meta, items}`），不改實作 |
| **2** | `data/excluded.json` 未送達（SC-2 形態） | High | **接受** | 見上。分支 tree 內確實沒有該檔 |
| **3** | `content_hash` 不一致檢查是不可達分支 | Medium | **接受** | 屬實。`build-pool.mjs` 先 `content_hash: payload.meta.content_hash` 再比較兩者——**恆等**。**變異驗證**：拿掉整段檢查 → 仍全綠，確認是死碼。Codex 建議抽 `validatePair()` 由寫出前與 `verify-data` 共用，正確——那才讓這條檢查有真實輸入 |
| **4** | CLI 寫出非成對原子；workflow 無 D48 宣稱的 staging | Medium | **接受** | 屬實，且 Codex 的分層分析精準：**commit-level 保護存在**（build 失敗會跳過後續步驟，半對不會被 push），**但 D48 白紙黑字寫的 Actions staging 並不存在**，`update-pool.yml:46-47` 直接寫正式 `data/`。另：本機失敗時錯誤訊息「data/ 未變更」在半寫入情形下**不實**。修法用 `$RUNNER_TEMP` staging，零依賴，相容架構 |
| **5** | B12 沒有真正的 hash mismatch fixture | Medium | **接受** | 屬實。我的失敗案例注入未知前綴，**死在 B13**，根本沒走到 hash 檢查。這條與發現 3 是同一個洞的兩面：檢查不可達 ＋ 測試也沒真的走到 |
| **6** | `verify-data.mjs` 完全不知道 `excluded.json` | Medium | **接受** | 屬實（我送審前已自查到，Codex 補上了嚴重度與清單）。關鍵論點：**pipeline fixture 測試只能證明「測試執行時產生器曾經正確」，不能證明即將 commit 的正式資料正確**。`verify-data` 是 workflow 裡的獨立關卡，不認這個檔案就等於少一道 |
| **7** | B13 的正面測試是假綠 | Medium | **接受** | **最尖銳的一項**。我斷言的是 stdout 的 `/18 種表內/`，而那個 18 來自 `KNOWN_PREFIXES.size`，**不是 fixture 的觀察結果**。**變異驗證**：把表中 11 種換成假前綴（Set 大小仍 18）→ **仍全綠**。這是「驗證某物而非驗證某性質」的教科書案例 |
| **8** | B10 沒有注入空 id，母集合定義不一致 | Medium | **接受** | 屬實。**變異驗證**：`checkPrefixTable` 加 `if (!id) continue;` → **仍全綠**。因為 `markOut` 跳過空 id、`srcIds` 也 `filter(Boolean)`，**兩邊同時把錯誤資料排除在母集合外，完整性斷言就看不見它**。Codex 的措辭精準：「母集合定義排除了錯誤資料，導致完整性斷言看不見它」 |
| **9** | workflow 摘要只讀 `pool.json` | Low | **接受** | 屬實。不影響 commit 正確性，但會造成操作層面的虛假完成感——而虛假完成感正是本專案明列的次要風險 |

### Codex 的三項正確澄清（無需動作）

- **`partition` 重構無行為回歸** —— 它逐階段核對了 `markOut` 對原始列與 `{r, ans}` 包裝物的解包路徑，結論與我的實測（`items` 位元組不變）一致
- **`checkPrefixTable()` 的正規式 fail-closed** —— 逐一列舉了空 id／無「字第」／號碼段全非數字／前綴含數字／R 型五種情形，未發現非貪婪量詞誤切
- **`(r.r ?? r)` 的理論風險** —— 若來源列本身有 `r` 欄位會被誤認為 wrapper。TFDA schema 無此欄位，Codex 自己判定不列為本批缺陷。**同意**：加防禦反而增加複雜度，且沒有可觀察行為

---

## 建議處理順序

1. **發現 1**（改規格對齊 `{meta, items}`）＋ **發現 2**（本機重跑並提交 `data/excluded.json`）
   —— 兩項 High，且發現 2 要等 schema 定案才產得出正確的檔
2. **發現 3 ＋ 5**（抽 `validatePair()`，讓 hash 檢查有真實輸入並補 mismatch fixture）
3. **發現 6**（`verify-data.mjs` 認兩檔並共用 `validatePair()`）
4. **發現 7 ＋ 8**（B13 十八前綴表驅動 fixture、B10 空 id 注入）
5. **發現 4 ＋ 9**（workflow staging 與摘要）

## 這一輪的教訓

**一、「驗證某物」與「驗證某性質」的差別，在測試裡也成立。**
發現 7 的斷言比對的是 stdout 印出的數字 18，而那個數字**來自被驗證的那份表自己**。
等於問「你有幾種前綴」然後相信它的回答。
**通則：斷言的期望值不得由受測程式產生。** 這與 A38 的
「golden 不得由受測 encoder 產生後抄回」是同一條，只是換了個位置出現。

**二、母集合定義會決定完整性斷言看得見什麼。**
發現 8：`markOut` 與 `srcIds` 兩邊都 `filter(Boolean)`，
於是空 id 從兩個集合中同時消失，`|pool| + |excluded| === |src|` 照樣成立。
**完整性斷言只在「母集合定義涵蓋錯誤資料」時才有守備力。**

**三、SC-2 形態會重演，因為它不在程式碼裡。**
發現 2 不是任何一行寫錯，而是**該產生的檔案沒有被產生並提交**。
測試全綠、管線實跑正確、變異驗證全紅——**沒有任何一道自動關卡看得到這件事**，
因為它發生在「產物有沒有進 git tree」這一層。
`/codex-review` 的區塊 4 之所以要問「產生了但沒送達」，就是為了這一層。

## 邊界聲明

覆審輪全程唯讀，**未修改任何 source code**。寫入僅限 `.ai-review/` 下的兩份報告。
判定者與實作者為同一人；Codex 的獨立性正是為此存在。

---

## 處理結果（2026-08-10，同分支 `feat/v5-pipeline`）

**9 項全部處理完畢。測試 455 → 460（管線測試 34 → 40），全綠；`verify-data` 全過。**

| # | 處置 | 落點 |
|---|---|---|
| **1** | **改規格**（非改實作） | D49 的 JSON 範例改為 `{ meta, items }`，與 `data/pool.json` 的既有慣例對齊；新增硬性規則「`data/` 底下的資料檔一律採 `{ meta, items }`」。規格升 **v5.9** |
| **2** | 已修 | 本機以同一份來源快照重跑管線產出 `data/excluded.json`（2,354 筆／152 KB）並納入本批提交。**`pool.json` 位元組還原**——重跑會掉 `meta.images_bytes`（那是 `fetch-images.py` 寫的，build-pool 單獨跑本來就沒有），故 `git checkout` 還原後只留 `excluded.json`。兩檔 `content_hash` 實測相同，是合法的一對 |
| **3＋5** | 已修 | 抽出 **`validatePair(pool, excluded, srcIds)`** 純函式並 export。原本 hash 檢查的兩邊是**上一行才互相複製**的，是死碼；抽出後 `verify-data` 餵的是磁碟上兩份**各自獨立讀進來**的檔案，那裡的 hash 真的可能不一致。新增 B12b 四條測試，含「除 hash 外完全合法但不一致」與其餘 D49 不變量逐條觸發 |
| **4** | **部分採納，改用不同修法** | **不採 Codex 的「workflow 用 `$RUNNER_TEMP` staging」**——`carryHashes()` 從 `--out` 路徑讀前版，建到 staging 就讀不到，`src_sha256` 全成 `null`，`fetch-images.py` 會全量重抓 3,941 張圖，**那正是 SC-3 那個回歸**。改為**兩檔各寫 `.tmp`、兩份都成功才 `rename`**，同時保護 CI 與本機 CLI 且不動 workflow 接力鏈。D48 同步改寫並誠實標明「兩次 rename 之間的微秒級窗口」這個已知限制 |
| **6** | 已修 | `verify-data.mjs` 新增 **B14**：`excluded.json` 必須存在、合法 JSON、且透過 `validatePair()` 與 pool 成對。實跑通過（`✓ excluded.json 與 pool 成對（2,354 筆）`） |
| **7** | 已修 | B13 正面案例改**表驅動**：`PREFIX_TABLE` 逐一產生探針列放進來源，並斷言每一種前綴的探針**都真的出現在 excluded**。**變異驗證**：表中 11 種換成假前綴 → 轉紅（修前全綠） |
| **8** | 已修 | 母集合不再 `filter(Boolean)`，改為明確 `if (srcIds.has('')) die(...)`；新增空 id（`''` 與 `'   '`）注入測試 |
| **9** | 已修 | workflow 摘要同時讀兩檔，顯示 excluded 筆數、成對與否、淘汰階段分布；缺檔時明示「未命中三分類會靜默失效」 |

### 變異驗證（修後）

| 變異 | 修前 | 修後 |
|---|---|---|
| 表中 11 種換成假前綴（Set 仍 18） | 全綠 | **RED (1)** |
| 拿掉 `validatePair` 的 hash 檢查 | 全綠 | **RED (1)** |
| `validatePair` 的 stage 值域檢查拿掉 | — | **RED (1)** |
| `validatePair` 的互斥檢查拿掉 | — | **RED (1)** |
| stage 改 last-wins | RED | RED (1) |
| excluded 不扣除已進 pool 的 id | RED | RED (1) |
| B13 條件恆假 | RED | RED (2) |

**空 id 的兩個單獨變異仍綠，但那是正確的**：`checkPrefixTable` 與 `srcIds.has('')`
是**兩道互為備援的關卡**，拿掉任一道性質仍成立。
**組合變異（兩道同時拿掉）→ RED (1)**，已實跑確認。
這與 Codex 自己對聯集檢查的推理同一條：
「只有同時引入第二個破壞分流的 mutation 才有可觀察差異，屬高階 mutation」。

### 明列未做

- **B11 的「注入未知 stage 必須 fail」** 現在由 `validatePair()` 在**讀取端**實作並測到
  （B12b 的「stage 值域外」案例）。管線產生端仍不可能注入未知 stage，該方向依舊不適用。
- **兩次 `rename` 之間的微秒級窗口**未關閉，已在 D48 誠實標明。
  不為此引入交易性檔案系統。
