# Codex 規格覆審（第三輪）— V5 院內清單客製化

| 項目 | 內容 |
|---|---|
| 審查日期 | 2026-08-10 |
| 覆審員 | Codex（`sandbox: read-only`、`approval-policy: never`） |
| thread | `019fe9ba-58bc-77f3-8ea8-f907cd78ad6b` |
| 規劃文件 | `.ai-review/plan-v5-formulary.md` **v5.4** |
| 前兩輪 | `plan-review-v5.md`／`-v5-r2.md` 與對應判定書 |
| 本輪重點 | 判斷是否可凍結 D34（不可變 wire contract）並動工 |

> 以下為 Codex 原始輸出，**未修飾、未刪改、未重排**。

---

結論：**v5.4 沒有新的 Blocker，整體方向已收斂；但 D34 尚未精確到可立即凍結。** 目前仍有 2 項 High 契約缺口，建議先補規格再開始 codec／golden vectors；D38、D44 與其他非 codec 準備工作不必推翻。

五個重點答案：

1. **D34：否。** 二進位 layout、LEB128、CRC 與 base64url 已足夠精確；但 canonical id 重建、`unlistedCount` 的計數母集合與 uint16 邊界仍未封閉，兩個獨立實作者未必得到相同 payload。
2. **D38.1 算術正確。** 跨題可以重用同一批誘答鍵；H2 只禁止誘答屬於整卷正解集合，沒有禁止不同題共用誘答。因此 L1/L2 上限分別是 `K−3`／`K−5`，最低 K 為 13／15；L3 為 10。
3. **D38.3 尚未形成可重現協定。** 引擎內部沒有漏網隨機來源：只要傳入同一 `rng`，`MAX_QUIZ_ATTEMPTS`、每題貪婪重試、抽正解、抽紀錄及洗牌都使用同一 RNG。但規格沒有釘死 seed 導出、PRNG、seed 數量／順序及輸入排序。
4. **D44 的三段語意可由平台提供。** 單一 localStorage 寫入失敗可維持不變；成功後同步切換純記憶體狀態；`history.replaceState` 留在交易外並允許失敗。沒有再要求跨三介面的虛假 transaction。
5. **A36 的正確母集合是來源 6295 列所形成的 `pool ∪ excluded`，不是 pool。** 因此 93 組是規格上正確的驗證範圍。repo 現有 `pool.json` 可獨立重算出 27 組／54 筆；本輪 repo 尚無 `excluded.json` 或來源快照，受限於網路亦無法獨立重算完整 93 組數值，但母集合選擇沒有問題。

# 需求與邊界缺漏

## R3-1

- **嚴重度：High**
- **問題：** D34 沒有定義 decoded canonical id 的精確文字重建。D34.4 說前綴包含「`…字第`＋非數字部分」，但表中 index 0–15 寫成不含「第」的 `衛署藥製字`，index 16–17 卻寫成含「第R」的字串。號碼整數化後也未指定補零規則。來源實際號碼段固定六字元：一般型為六位數，`R` 型為 `R` 加五位數。若不補零，decoded id 無法與 `pool.json`／`excluded.json` 的 join key 相等。
- **為什麼現在不修之後會更貴：** encoder 可能看似正常，但 decoder 產生 `衛署藥製字第123號` 而非 `衛署藥製字第000123號`，全部比對為未命中。發布後補定義會改動 decoder、golden vectors 與跨實作相容判準。
- **建議修法：** 在 D34 明列 18 個 index 對應的**精確 canonical 固定字串**，並釘死解碼重建規則：是否包含「第」、數字補零寬度、`號`、大小寫與 Unicode 字形。另明定 prefixIndex 超出該版本表範圍必須拒絕。

## R3-2

- **嚴重度：High**
- **問題：** D38.3 的「規格化固定 seed 序列」仍未規格化。缺少：

  - payload 與 level 如何導出 seed；
  - 使用哪個 PRNG；
  - 是一個 RNG stream 交給 `drawLeveledQuiz` 的三次內部重試，還是多個 top-level seeds；
  - 若為多個 seeds，數量、順序與第一個成功者的選擇；
  - matched subset／`buildIndex` 的輸入排序。

- **為什麼現在不修之後會更貴：** 兩個實作者可以都完全不使用 `Math.random`，卻仍對同一 payload 判出不同 availability 或備妥不同第一卷。之後修正會改 ready state、測試 oracle 與使用者重整後看到的狀態。
- **建議修法：** 把 seed protocol 定為封閉契約：canonical seed input、固定 PRNG、固定有界嘗試策略、固定 subset 排序，以及「按順序取第一個成功產物」。現有 `MAX_QUIZ_ATTEMPTS` 可保留，無須改組卷模型。

## R3-3

- **嚴重度：Medium**
- **問題：** `unlistedCount` 的語意與 uint16 邊界未完全封閉。第三類沒有 canonical id；目前未說明它是原始非空 token 數、正規化後的不同值數，或去重後院內品項數。亦未定義 `count`／`unlistedCount > 65535` 時拒絕、截斷或其他行為。
- **為什麼現在不修之後會更貴：** 不同實作者可能因重複列、全半形或空白差異產生不同 `unlistedCount`，直接造成 header 與 CRC 不同。若先凍結 golden，之後只能重做 vectors。
- **建議修法：** 指定第三類去重 identity 與計數時點；兩個 uint16 欄位超界一律拒絕，不得截斷或 modulo。

## R3-4

- **嚴重度：Low**
- **問題：** D44 的「結果相同（冪等）」可能被誤讀成 storage 位元組冪等；但 D45 的 `savedAt` 會讓同一 `fx` 重播時產生不同 storage 位元組。
- **為什麼現在不修之後會更貴：** 驗收可能要求平台與 schema 本來就沒承諾的 byte-identical replay。
- **建議修法：** 明確寫成「URL cleanup 操作冪等；重播同一 payload 的 active formulary 語意相同」，不宣稱含 `savedAt` 的 storage bytes 不變。

# 架構風險

本區**未發現新的架構風險或 Blocker**。

- D38.1 的算術成立，前提是跨題可重用誘答鍵；現行 H2 與 `validateQuizInvariants()` 都沒有禁止跨題重用。
- `K−3`／`K−5` 只是必要上限，不保證每個正解都能共用那 3／5 個鍵；D38.2 的實際組卷 probe 正確補足了充分性問題。
- D44 已移除平台做不到的三介面原子交易。其提交順序在單一同步工作內可實現，且不依賴多分頁交易保證。
- D34 的 binary＋CRC＋版本化 prefix table 仍是合適方向，不建議改回文字格式、pool index 或移除 checksum。

# 驗證策略缺口

## R3-5

- **嚴重度：Medium**
- **問題：** A39 要求涵蓋「邊界號碼 0」，但 D34.3 明定第一個絕對號碼 `≥1`，A38 也以最小合法號碼 1 為準。合法編碼與驗收互相矛盾。
- **為什麼現在不修之後會更貴：** 測試作者只能放行非法 0，或讓規格要求的 positive fixture 永遠失敗。
- **建議修法：** A39 的合法 permutation 邊界改為 1；號碼 0 移到 A40 grammar-invalid，且重算正確 CRC 後斷言拒絕。

## R3-6

- **嚴重度：Medium**
- **問題：** A43 要求 L2 在 `K=14` 時產出卷長 `≤9` 並驗 options／spares；但 D38.1 已明定 L2 最低 K=15、最低卷長 10，`K=14` 應直接禁用。
- **為什麼現在不修之後會更貴：** 實作無法同時滿足 A42 的「K=14 禁用」及 A43 的「K=14 有可驗題卷」。
- **建議修法：** A43 的 L2 fixture 改用 `K=15`，預期 10 題；`K=14` 只留在 A42 驗禁用。L1 `K=14 → 11 題`、L3 `K=14 → 14 題` 可保留。

## R3-7

- **嚴重度：Medium**
- **問題：** 現有驗收沒有明確證明「probe 成功產物就是使用者按開始後的第一卷」。A42 只驗 availability 可重現；C41 只驗出題封閉性。實作仍可在按開始時重新用 `Math.random` 抽一次。
- **為什麼現在不修之後會更貴：** 會重新出現第二輪指出的「檢查時成功、開始時失敗」，而所有既有封閉性測試仍可能全綠。
- **建議修法：** 增加跨層驗收：記錄 probe 題卷的完整穩定 identity，開始後逐題斷言使用同一產物，且開始動作沒有第二次組卷或額外 RNG 消耗。

## R3-8

- **嚴重度：Medium**
- **問題：** A38／A40 尚未覆蓋 D34 新增欄位與表界線的關鍵案例：正值 `unlistedCount`、其最大合法值、超界拒絕，以及合法 CRC 下的 prefixIndex 越界。
- **為什麼現在不修之後會更貴：** codec 可完全忽略 `unlistedCount` 或接受不存在的 prefix index，現有主要 golden 仍可能通過。
- **建議修法：** golden 至少加入 `count=0, unlistedCount>0` 與一般非零兩者；grammar-invalid 加入兩個 uint16 邊界與 prefixIndex 越界。

# 更簡單的替代方案

## R3-9

- **嚴重度：Low**
- **問題：** 「固定 seed 序列」容易被理解成在 `drawLeveledQuiz` 外再建一層多 seed 重試，與既有三次內部重試形成兩層策略。
- **為什麼現在不修之後會更貴：** 會增加 availability 成本與「到底哪層決定第一個成功產物」的狀態。
- **建議修法：** 最簡契約是從 payload＋level 導出一個固定 32-bit seed，以指定 PRNG 建立單一 stream，交由既有 `MAX_QUIZ_ATTEMPTS` 消耗。若確實需要多個 top-level seeds，才明列固定數量及順序。

## R3-10

- **嚴重度：Low**
- **問題：** D34 的算法文字已足夠長，但 prefix 字串與補零規則仍散落在 D34.4、D35.2 與例子中。
- **為什麼現在不修之後會更貴：** 人工推 golden 時容易各自補上不同假設。
- **建議修法：** 不改 wire layout，只新增一張 normative 表：每個 index 的精確 prefix bytes、numeric width、最小／最大值及一個 reconstructed canonical id。這比再增加敘述更容易稽核。

最終判定：**沒有第三個 Blocker，但 v5.4 原文尚不可宣告 D34 frozen，也不建議先開始 codec 實作。** 先補 R3-1～R3-3 與兩條矛盾驗收 R3-5／R3-6；完成後即可明確判定：**可以動工**。
