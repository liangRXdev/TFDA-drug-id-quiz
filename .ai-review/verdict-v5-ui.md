# 覆核判定 — Codex 覆審 V5 批次 4（院內清單 UI）

| | |
|---|---|
| 日期 | 2026-08-11 |
| 原始意見 | `.ai-review/codex-review-v5-ui.md`（codex-cli 0.146.0，read-only） |
| 受審 commit | `c284679`（＋主持人自查 S-1／S-2 的後續修正） |
| 覆核方式 | 每項都回去讀該檔該行；CR-2／CR-4／CR-5／TG-1 逐條在程式碼上確認過 |

## 統計

**接受 7／部分接受 5／拒絕 0**。Codex 零幻覺；`區塊 1` 的「特別路徑核查」結論與我自己
grep `state.pool` 的結果一致（production 沒有子集漏接，缺的是測試）。

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| CR-1 | `readFormulary()` 用同一個 `null` 表示「沒有」與「讀失敗」，導致讀失敗後仍可能覆寫 | High → **Medium** | **部分接受** | 屬實：`readFormulary()` 的四種失敗（access／getItem／壞 JSON／未知 schema／payload 解不開）全部回 `null`，`bootFormulary()` 接著就用 `persist: true` 呼叫 `activateFormulary()`，於是把一份**讀不出來的**清單覆寫掉。違反 CLAUDE.md 白紙黑字的「讀取失敗時不得寫入」。**降為 Medium 的理由**：這裡的寫入不是「由過期讀值推導出來的回寫」（那才是該紀律最初要防的成績退步），而是使用者主動點開一條新連結；損失是「一份本來就讀不出來的舊清單」。但紀律是硬性的，且未來 schema 那個情境確實會靜默毀資料。**修法要補一段 Codex 沒講的**：`error` 時不 persist，就**必須連帶不做 URL cleanup**（保留 `fx`），否則重整後使用者連剛開的那份也沒了——cleanup 本來就只是「成功提交後」的動作（D44.1 第 3 段）。 |
| CR-2 | `loadExcluded()` 的失敗路徑沒有 current-op gate，舊操作的失敗可蓋掉新操作的成功 | High → **Medium** | **部分接受** | 屬實：`app.js` 的 catch 直接寫 `state.excludedError` 就 `return`，op 檢查在它**後面**（成功路徑才有）。違反 D46「只有當前 operation 可以 commit」。**降為 Medium**：要觸發需要「開產連結頁 → 返回 → 再開」且第一次 fetch 慢且失敗；後果是產連結被誤停用到重新整理為止，出題不受影響。修法照 Codex：catch 內先檢查 op。 |
| CR-3 | cleanup 會吃掉空 segment；encoded key `%66x` 消費了卻移不掉 | Medium → **Low** | **接受** | 兩點都屬實。`filter((kv) => kv && …)` 會把 `?a=1&&b=2` 正規化成 `?a=1&b=2`；而 `searchParams.get('fx')` 會解碼 key，`%66x` 讀得到卻刪不掉。後者比較實在（「已消費卻留在網址上」違反 C49），前者是字面上的不精確。**降為 Low**：兩者都需要刻意構造的網址，且不造成資料錯配。修法便宜，一起做。 |
| CR-4 | `?fx=`（空值）被當成沒有參數，不進 decoder、不提示 | Medium | **接受** | 屬實：`fxFromUrl()` 回 `''`，`bootFormulary()` 的 `if (fx)` 判偽。§5.3 明寫「含 `?fx=` 的網址 → 完整解碼（失敗 → 提示、保留 fx）」。修法：改用 `has()` 判存在，空值走 decode 失敗路徑。 |
| CR-5 | URL 超限訊息把 `matched.length` 稱作「清單 X 品項」 | High | **接受** | 屬實。進 payload 的是 `payloadIds`（命中 ∪ Q1–Q5），使用者貼的是 `distinct`，而訊息印的是 `matched`——**三個數字都不一樣**，而教學藥師正是靠這個數字決定要縮減多少。這是本專案風險權重最高的一類（數字誤導）。修法：講清楚「清單 `distinct` 筆，其中 `payloadIds.length` 筆進入連結」。 |
| CR-6 | `state.fxOp++` 在驗證前，字面上違反「記憶體位元組完全不變」 | Low | **部分接受** | 現象屬實，但 Codex 自己也說不該把 `++` 下移（那會削弱 D46 的即時失效）。判定為**文件問題不是程式問題**：`fxOp` 是協調用的 epoch，不屬於「可發布的領域狀態」。處理方式是在 `activateFormulary()` 的註解與 C42 的斷言裡**明列 snapshot 涵蓋的欄位**（`fx`／`items`／`index`／`eligible`／`lookAlike`／`questions`／兩個 storage key），不要用「所有記憶體」這種驗不了也守不住的說法。 |
| TG-1 | C48 的 fault 注入被 `boot()` 的 reset 清掉，等於完全沒測 | High | **接受** | **屬實，而且這是我自己犯的最重一條**。三個讀取失敗案例的 `setup()` 在 `boot()` **之前**呼叫，而 `boot()` 開頭就 `storeControl.reset()`；`boot()` 之後再 setup 時，啟動與寫入都跑完了。斷言只看 `clear()`，沒看 `setItem`／`removeItem`。`setItem 拋錯`那條更糟：注入後又被第二次 `boot()` reset，最後斷言的是「院內版**已發布**」——**與測試名稱主張的相反**。而我當時還在程式碼裡寫了註解「setup 會被 boot 內的 reset 清掉，所以改由 href 帶 fx」——**發現了問題卻繞過去，沒有修**。這正是 memory 裡記著的「注入點在防線前面等於沒測」，第三次。 |
| TG-2 | fetch 樁無法 defer，D46 的競態根本測不到 | High → **Medium** | **接受** | 屬實：樁的 `fetch` 一律立即 resolve。沒有 deferred control 就寫不出「A 晚失敗、B 先成功」，CR-2 那個弱化實作因此全綠。修法照 Codex，加 deferred fetch control。降為 Medium 是因為它是「為了測 CR-2 而必須先有的能力」，本身不是缺陷。 |
| TG-3 | 遞補、L2 備援、閃卡、複習卷四條路徑的子集封閉性沒被驗到 | High → **Medium** | **部分接受** | 測試缺口屬實。但**production 沒有漏接**——Codex 自己逐行核過（`drawSpareQuestion`／`drawSpareCard`／`drawRetryQuiz` 都吃 `state.items`／`state.index`，`replaceOption` 只用題目內的 `q.spares`），我 grep `state.pool` 的結果相同。所以這是「今天是對的、但沒有防線守著」，不是現行缺陷 → Medium。修法：用既有的 `imgControl.fail` 強迫實際替換，逐路徑斷言封閉。 |
| TG-4 | 級別維度切割不足：C45 只驗 L2、C52 只驗 L1、C46 缺 L2、C43 結算頁只驗 L1 | High | **接受** | 屬實，逐條核對過。**這是上一輪（批次 3）那條教訓的復發**——上一輪 Codex 抓到「只有 L2 用 `Math.random` 的變異全綠」，我把可重現性改成三級逐級跑，卻**只修了那一條，沒有把同一個問題推廣到本批新寫的每一條**。修法：C43／C45／C46／C52 全部改成表驅動的三級矩陣。 |
| TG-5 | C47 只驗「有寫、key 對」，沒驗寫進去的內容 | Medium | **接受** | 屬實。寫入 `{}`、錯分數、錯級別都會通過。這與「一條測不出東西的斷言比沒有更糟」同族。修法：固定日期與 RNG，逐欄比對。 |
| TG-6 | sink 清冊漏了 property assignment（`value`、`alt` 等） | Medium → **Low** | **部分接受** | 清冊確實不完整。但要分清楚：`value` 與 `alt` 是**字串 sink**，該補並附 sentinel；`disabled` 是布林狀態、`style.width` 是數值字串且不接受使用者輸入，**列為排除項並寫明理由**即可，不必為湊數而監控。C50 的原意是「不得默默漏列」，不是「什麼都要監控」。 |
| TG-7 | `boot()` 只隔離 module state，沒有隔離舊實例的 pending callback | Medium → **Low** | **部分接受** | 風險屬實（舊 fetch／timer 晚到時會讀到新的 global `document`）。但要做到真正的生命週期隔離，等於在樁裡實作一套 per-instance document capture 與 timer 登記——那是為了測試而長出的第二套執行環境，代價高於收益。判定：**加 Codex 建議的 sentinel 測試**（boot A 留一個 pending callback，boot B 之後才完成，斷言 B 不變），證明現有隔離對本檔用到的情境夠用；不做全面改造。 |
| TG-8 | §5.2 的不產連結分支（空輸入／三級全禁／超限／大量）沒有專門測試 | Low | **接受** | 屬實。四個分支規格都明寫「每一種都要說明原因，不得靜默失敗」，而目前只有「命中 0 筆」被間接覆蓋。修法：表驅動拒絕案例，每案斷言原因非空且舊連結被隱藏。 |

## 主持人自查（本輪覆審期間發現，已修）

| # | 項目 | 嚴重度 | 狀態 |
|---|------|--------|------|
| S-1 | 成績卡在院內版仍印「題庫 3,941 題」——那一卷其實抽自 N 個院內品項 | Medium | **已修**：院內版改印「院內清單 N 品項」，兩種模式各一條測試 |
| S-2 | 院內版第二回合重抽失敗走 `fatal()`，整個 app 只剩「無法開始測驗」 | High | **已修**：實測 30 品項清單在 probe 判定可用後，**200 次重抽失敗 105 次**（52.5%）。改為退回起始頁說明原因，`state.level` 保留，再按一次即可重抽 |

S-2 值得單獨記一筆：**第一回合有 probe 的確定性產物護著，第二回合起是擲硬幣**。
D38.2 早就寫明組卷是有限重試的隨機貪婪，可預期的隨機失敗不該用致命錯誤路徑處理。
`fatal()` 這條分支是 v2 為「題庫載不到」寫的，被批次 4 沿用到一個語意完全不同的情境。

## 建議處理順序

1. **CR-5**（High，數字誤導）：超限訊息講清楚三個數字。最便宜、風險最高。
2. **TG-1 ＋ CR-1**（High）：先讓 `boot()` 能真的注入 storage fault，再改 tri-state 讀取；
   兩者要一起做，否則修了 CR-1 也沒有東西守著。
3. **TG-4**（High）：C43／C45／C46／C52 改三級矩陣。**這是上一輪教訓的復發，優先於其他測試缺口。**
4. **CR-2 ＋ TG-2**（Medium）：deferred fetch control ＋ catch 內的 op gate，一起做。
5. **TG-3**（Medium）：遞補／備援／閃卡／複習卷四條路徑的封閉性。
6. **CR-4、CR-3**（Medium／Low）：`?fx=` 空值走 decoder；cleanup 改成解碼後比對 key、保留空 segment。
7. **TG-5、TG-8**（Medium／Low）：records 內容逐欄比對；不產連結的四個分支。
8. **CR-6、TG-6、TG-7**（Low）：文件與清冊層面——明列 C42 snapshot 欄位、補 `value`／`alt` sentinel
   並寫明排除項、加 boot 隔離的 sentinel 測試。

## 處理結果（2026-08-11 同日完成）

12 項全部處理完畢，**562 → 599 測試全綠**，`verify-data` 全過，`pool.json` 位元組未動。
**變異驗證 17 條全部轉紅**（腳本涵蓋每一條修正的回退版本）。

| # | 修法 | 對應變異 |
|---|---|---|
| CR-5 | 超限訊息改成「清單 `distinct` 筆相異字號，其中 `payloadIds.length` 筆進入連結，網址 N 字元」 | P7 |
| CR-1 | `readFormulary()` 改 tri-state；`error` 時**不 persist 也不 cleanup**（保留 `fx`），並在畫面說明「不會保存」 | P1、P2 |
| TG-1 | C48 整組重寫：fault 由 `boot({ store })` 在 reset 之後、import 之前注入；六種讀取失敗 ＋ 寫入失敗 ＋ 正向對照，逐條斷言零 mutation、兩個 key 位元組不變、`fx` 保留、出題不受影響 | P1、P2 |
| TG-4 | C43／C45／C46／C52 全部改成**三級矩陣**；C45 另備三份 fixture 讓不同級別各自不可用（16／30／9 品項） | P9、P10、P11 |
| CR-2 | `loadExcluded()` 的 catch 也過 current-op gate | P3 |
| TG-2 | 樁新增 deferred fetch control；三條競態測試（B 先成功 A 晚失敗／A 先失敗 B 後成功／單一失敗仍須生效） | P3 |
| TG-3 | 四條執行期路徑各補一條封閉性測試：L1 遞補、L2 備援替換、閃卡遞補、錯題複習卷 | P12–P15 |
| CR-4 | `fxFromUrl()` 回 `{present, value}`；`?fx=` 空值走 decoder 並提示 | P6 |
| CR-3 | cleanup 比對**解碼後**的 key（`%66x` 也刪得掉），且不再過濾空 segment | P4、P5 |
| TG-5 | C47 逐欄比對 `schema`／級別／`bestScore`／`bestStreak`／`date`／`pool` | — |
| TG-8 | 四種拒絕情形表驅動 ＋ 5000 行輸入；`fxError()` 另外明確收掉舊連結 | P8 |
| CR-6／TG-6／TG-7 | C42 的 snapshot 欄位明列；樁補 `value`／`alt` property sink 與 sentinel，排除項寫明理由；加 boot 之間無殘留 pending 請求的哨兵 | — |

### 修正過程中被自己抓到的兩個假斷言

1. **閃卡遞補測試原本沒有觸發遞補。** 第一版在圖片**載入成功之後**才把它加進 fail 清單，
   `onerror` 早就不會來了，`drawSpareCard()` 一次都沒被呼叫——而 `notEqual` 因為我
   預測錯 deck 而碰巧成立。改成「先跑一趟記下第一張，再重開一次讓它注定失敗」。
2. **改對之後變異仍然存活，因為運氣。** 300 品項的子集下，誤用全庫索引仍有
   300/3941 ≈ 7.6% 機率剛好抽回子集內——實測就這麼發生了。
   改用 **40 品項子集 ＋ 3 個 seed**（三次都碰巧的機率約 1e-6）才真的把它擋住。
   這正是 A41 的〔堵〕(b)「隨機抽樣可能剛好沒抽到洩漏品項」，換一個位置又出現一次。

## 這次覆審的觀察

- **同一條教訓在同一個專案連續兩輪成立（TG-4）。** 上一輪學到「變異要沿核心維度切」，
  我在修批次 3 時把可重現性改成三級逐級——**但只修了被抓到的那一條**。
  批次 4 全部新寫的 C 條又回到「挑一個級別驗」。
  **教訓要當成不變量往前套，不是當成待辦清單勾掉。**
- **TG-1 是「發現了卻繞過去」。** 我在測試裡寫下註解說明 fault 會被 reset 清掉，
  然後改成一個看起來還能跑的寫法，而沒有問「那這條還在測什麼」。
  註解誠實地記錄了缺陷，卻沒有阻止缺陷被提交——**寫得出那句註解，就有義務停下來修**。
- **12 條變異全紅仍漏掉整片區域。** 我的變異全部針對「已經有測試的行為」，
  而 CR-1／CR-2 所在的失敗路徑**根本沒有對應測試**，變異自然無從轉紅。
  **變異驗證證明的是既有斷言的守備力，不是覆蓋率。** 這兩件事我又混為一談了一次。
