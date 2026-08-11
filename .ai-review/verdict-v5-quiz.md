# 覆核判定 — Codex 覆審 V5 批次 3

| | |
|---|---|
| 日期 | 2026-08-11 |
| 原始意見 | `.ai-review/codex-review-v5-quiz.md`（codex-cli 0.146.0，read-only） |
| 受審 commit | `669d3a5` |
| 覆核方式 | 每項都回去讀該檔該行；三項爭議點以**實跑**確認，不採信描述 |

## 統計

**接受 4／部分接受 1／拒絕 0**，另有**主持人自查 1 項**（Codex 的發現 1 範圍不足）。

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| 1 | `validatePair()` 未要求 `excluded.items[].id` 為 canonical id | High | **接受** | 已實跑重現：`formulary.js:470` 只驗「非空字串」。餵一筆 `衛署藥製字第21號`（缺前導零）進 `excluded.json`，`validatePair()` 回**空陣列**（通過），`buildExcludedIndex()` 建出索引，而使用者打入正確的 `衛署藥製字第000021號` 經 `classifyFormulary()` 後落入**第三類 UNLISTED**。畫面會對一顆確實在資料集裡的藥說「不在外觀資料集中」——D37.1 明文說那句話對這種藥是不實的。修法（在 `validatePair()` 內 `normalizeLicense(id) === id`）沿用既有純函式，不新增依賴，與 D48 相容。**但範圍不足，見 S-1。** |
| 2 | `probeLevel()` 的 catch 吞掉所有例外，且 `reason` 可能印出「組卷失敗（undefined）」 | Low → **Medium** | **部分接受** | 問題屬實：`formulary.js:722–724` 用 `catch (e)` 全攔，`code: e.code \|\| 'QUIZ_ASSEMBLY_FAILED'` 會把一個 `TypeError` 貼上「組卷失敗」的標籤，`reason` 則插進 `undefined`。**嚴重度應為 Medium 而非 Low**：它同時造成兩件事——(a) 真正的 bug 被降格成「該級不可用」，使用者只看到級別按鈕變灰，而那是本專案「靜默失效」型失效模式；(b) 產生不實的失敗原因文字。修法照 Codex 建議（白名單 `QUIZ_ASSEMBLY_FAILED`／`INSUFFICIENT_KEYS`／`INVARIANT_VIOLATED`，其餘重拋；`reason` 用固定安全文字）。 |
| 3 | D38.3 的可重現性只測 L1，「L2 改用 `Math.random`」的弱化實作全綠 | High | **接受** | **已實跑確認**：把 `formulary.js:718` 改成 `level === Level.L2 ? Math.random : makeRng(...)`，`tests/formulary.test.mjs` **105/105 仍全綠**。原因與 Codex 所述一致——`:754` 的 ≥5 次比對與 `:768` 的 `Math.random` monkeypatch 都只跑 L1；「子集排序」那條的 L2 fixture 恆為不可用所以不比對第一卷；A41／A43 的 L2 只跑一次。D38.3 是「檢查時可用、按下去失敗」的唯一防線，只守住三分之一等於沒守。修法：三級各用一個確定可組卷的 fixture，逐級 ≥5 次比對完整 `quizIdentity`，並逐級在兩組不同 `Math.random` stub 下再比一次。 |
| 4 | A41 的 sentinel 沒有規格要求的「受控 RNG」，「排序靠前」不構成強迫條件 | Medium | **接受** | 讀 `engine.js:444–446`：`pickMutuallyValid()` 進來第一件事就是 `shuffle(c, rng)`，候選順序被洗掉，因此 `tests/formulary.test.mjs:589` 註解宣稱的「排序恆在子集之前 ⇒ 最早被看到」在實作路徑上**不成立**——那段註解描述了一個不存在的機制。Codex 自己實跑洩漏版得到 L1 7/8、L2 8/8 被抽中，所以這條**今天抓得到**洩漏，但那是目前 seed 與 shuffle 的結果，不是設計保證。修法：加一條**正向對照**（反向 sentinel）——以固定 RNG 直接呼叫 `buildChoices()` 餵**全庫 index**，斷言 sentinel 必被選中（證明陷阱有裝上），再由既有子集測試證明它不會觸發。純函式層，不需 jsdom 或新依賴。 |
| — | A42 敵意 fixture「任意 seed 都組不出卷」 | — | **無異議** | Codex 的論證與我設計時的推導一致（含 A 組正解的卷只能用 B1–B3 當候選、B 組彼此 `nameCollides`、純 B 組只有 3 鍵組不成 10 題），與 6 個 payload 的實跑結果相符。 |
| — | 區塊 3 依賴稽核「無」 | — | **無異議** | 本 repo 零 runtime 依賴，本批未動 dependency metadata。 |
| — | A43／A44 無缺口 | — | **無異議** | A44 的 precedence 責任放在管線層（`tests/pipeline.test.mjs:578`）而非分類層，這與「stage 由 `excluded.json` 決定、分類層不得改寫」的設計一致。 |

## 主持人自查

| # | 項目 | 嚴重度 | 說明 |
|---|------|--------|------|
| S-1 | 發現 1 的範圍不足：**`pool.json` 那一側同樣沒有 canonical 保證** | High | Codex 只看 `excluded.json`。實際上 `tools/build-pool.mjs:255` 是 `id: r['許可證字號']`——**直接取來源欄位，連 `.trim()` 都沒有**。非 canonical 的 pool id 後果比 excluded 側更重：那顆藥在資料集裡、可以出題，但教學藥師打對字號永遠比不中，畫面還會說它「不在外觀資料集中」。實測今天 3941＋2354 筆**全部**通過 `normalizeLicense(id) === id`（已跑），所以這是**潛在**而非現行缺陷——但 join key 沒有任何守衛，而月更會換資料。修法：canonical 檢查放在 `validatePair()` 內對**兩份都做**（該函式已同時收到 `pool` 與 `excluded`，管線與前端共用同一份實作），管線側失敗即中止發布，沿用 B13「新前綴一律中止」的同一條紀律。 |
| S-2 | `CATEGORY_LABEL[Category.MATCHED]` 寫「可出題」，與 N／K 的分野打架 | Medium | `formulary.js:532`。規格名詞表明訂「**K ≠ N，任何 UI 文字不得用 N 代替 K**」（判定 1.14）。命中品項數 N 是「在外觀資料集中」，而某級能不能出題是 K 決定的——L2 的 K 常比 N 少三成。把 N 這一類叫「可出題」等於在**資料層**先把兩者混起來，批次 4 的 C43 再怎麼分別斷言都是在下游補救。改成不承諾出題能力的措辭（如「命中院內清單（在外觀資料集中）」）。 |

## 建議處理順序

1. **S-1 ＋ 發現 1**（High，同一處修法）：`validatePair()` 對 pool 與 excluded 兩側都強制 canonical id，加三種損毀 fixture（缺前導零、前後空白、全形數字）。
2. **發現 3**（High）：三級逐級驗可重現性與 `Math.random` 隔離。修完必須**重跑「L2 改用 Math.random」這個變異確認轉紅**——這條是這次唯一被證明能全身而退的弱化實作。
3. **發現 4**（Medium）：加正向對照證明 sentinel 陷阱有裝上，並改掉 `:589` 那段描述錯機制的註解。
4. **發現 2**（Medium）：`probeLevel()` 例外白名單化，`reason` 改固定文字。
5. **S-2**（Medium）：改 `CATEGORY_LABEL[MATCHED]` 措辭。

## 處理結果（2026-08-11 同日完成）

全部 5 項已修，**497 → 507 測試全綠**，`verify-data` 全過，`pool.json` 位元組未動。

| # | 修法 | 對應變異 |
|---|---|---|
| 1＋S-1 | `validatePair()` 對 **pool 與 excluded 兩側**都強制 `normalizeLicense(id) === id`；新增缺前導零／前後空白／全形數字／缺「號」四種損毀 fixture，另加正面案例與真實資料全掃 | M14（拿掉 excluded 側檢查）、M15（拿掉 pool 側檢查）皆轉紅 |
| 3 | 可重現性與 `Math.random` 隔離改成**三級各一個確定可組卷的 fixture**逐級跑；`Math.random` 除了兩個不同 stub 外再加一個**呼叫即拋**的 stub | M13（只有 L2 用 `Math.random`）轉紅——修正前這條 105/105 全綠 |
| 4 | 新增**正向對照**：以固定 RNG 直接呼叫 `buildChoices()` 餵全庫 index，並把整個子集放進 `excludeAns`，斷言誘答**必定全是 sentinel**（證明陷阱是活的）；刪掉 `:589` 那段描述錯機制的註解，改寫成「守備力來自它們不該進索引，而陷阱由正向對照證明」 | 正向對照本身即為檢測器 |
| 2 | `probeLevel()` 例外白名單化（`QUIZ_ASSEMBLY_FAILED`／`INSUFFICIENT_KEYS`／`INVARIANT_VIOLATED`），其餘重拋；`reason` 改固定文字表，不含藥名也不含 `undefined` | M16（例外全攔）轉紅 |
| S-2 | `CATEGORY_LABEL[MATCHED]` 改為「命中：在外觀資料集中」 | M17（改回「可出題」）轉紅 |

**連帶修正**：`tests/pipeline.test.mjs` 的合成 fixture 原本從 `衛部藥輸字第000000號` 起編，
而**號碼 0 在 D34.3 是非法的**（A40 把它列為 grammar-invalid，編不進任何 payload）。
新的 canonical 檢查正確地擋下它——這正是這道守衛要抓的東西，只是第一個被抓到的是我自己的
測試資料。fixture 已改為從 1 起編。

**變異總表：17 條，16 條轉紅。** 唯一不轉紅的仍是 M12（`probeLevel` 內重驗 invariants 的
不可達分支），原因與處置見 `formulary.js` 該處註解——它是「引擎哪天拿掉內部斷言」的第二道
防線，不是本層的實際判定依據，程式碼裡已標明，不宣稱它被測到。

## 這次覆審的觀察

Codex 兩項 High 都落在**我自己驗過但只驗了一半**的地方：

- 發現 3 的形態與批次 1／2 完全相同——我跑了 12 條變異、11 條轉紅，於是相信覆蓋夠了。但**我的變異全是「整支函式一起壞」**（seed 全改 `Math.random`、排序全拿掉），沒有一條是「只有某一個級別壞掉」。分級是這個 repo 的核心維度，**變異卻沒有沿著那個維度切**。
- 發現 4 抓的是**註解描述了一個不存在的機制**：「排序靠前所以會先被看到」在 `pickMutuallyValid` 先 shuffle 的路徑下根本不成立。測試碰巧有效，但理由是錯的——理由錯的測試會在下次重構時無聲失效。這與批次 2 的「〔堵〕註解寫對、斷言沒跟上」是同一族，只是這次反過來：**斷言有效、註解說錯了為什麼**。
