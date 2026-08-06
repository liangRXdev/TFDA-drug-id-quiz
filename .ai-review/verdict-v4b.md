# 覆核判定 — Codex PR #3 覆審

> **日期**：2026-08-06 ｜ **commit**：`213f478` ｜ **PR**：#3
> **原始意見**：`.ai-review/codex-review-v4b.md`（未修飾）
> 每一項都已**回讀該檔該行或實跑變異驗證**，不採信 Codex 的描述。

## 統計

| 判定 | 數 |
|---|---|
| 接受 | 9 |
| 部分接受 | 4 |
| 拒絕 | 0 |
| 無缺陷確認（採信） | 5 |

Codex 出現 **1 次事實錯誤**（TG-7 子主張 a），其餘引用的檔案、行號與規格條款編號核對屬實。

## 判定表

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| **SC-2** | 產生器已修，但 `data/pool.json` 仍無 `source_version`，C6 合併後依舊不存在 | Medium → **High** | **部分接受** | **實質主張完全正確且是本輪最重要的一項**，已核對：`data/pool.json` 的 `meta.source_version` 為 `undefined`，`git diff origin/main...HEAD -- data/` 為空。因此 `app.js:157` 的 `if (m.source_version)` 與 `:1246` 的 `if (ver)` **合併後仍不成立**，C6 要求顯示的資料版本對使用者依然靜默不存在——而這正是 SC-2 原本的病徵。**我升級嚴重度**：PR 宣稱修好一個「功能靜默不存在」的缺口，結果使用者端仍然看不到，這比 Codex 給的 Medium 重。**部分接受的部分**：Codex 稱 `verdict-v4a.md:72` 的「實跑 meta 確實出現該欄位」是未納入 PR 的宣稱，但同一份文件下方已明文寫「**未重建 `data/pool.json`**：實跑導向 `.probe/`，跑完即刪」，並列出不重建的理由（避免把資料更新與管線修正混在一起而無法歸因）。文件內部一致，不是虛假宣稱；但該證據欄單獨讀確實強於實情，措辭應收斂 |
| **TG-5** | 非 rem 的字級覆寫被 `remOf()` 靜默忽略 | Medium | **接受** | **已實跑確認**：在 `@media (max-width: 480px)` 內加 `.rank-title { font-size: 48px }`，`node --test tests/engagement.test.mjs` 得 **53 pass / 0 fail**。`remOf()` 對 px 回 `null` → `.filter(v !== null)` 排除 → 既有 rem 宣告仍讓 `rankSizes.length > 0` → 全綠。**這是我本輪修 TG-2 時自己留下的同型缺口**：把「只驗第一條」改成「掃全檔」，卻讓解析不出來的宣告直接消失。修法正確且不涉及假 DOM 測試——解析失敗應 fail 而非忽略 |
| **TG-6** | 全檔掃描仍可被較高 specificity 的 selector 繞過 | Medium | **接受** | **已實跑確認**：加入 `body .rank-title { font-size: 3rem; color: var(--accent) }` 與 `body .streak.pop .n { font-size: 2rem }`，**53 pass / 0 fail**。`rulesMatching()` 用 anchored exact match（`/^\.rank-title$/`），`body .rank-title` 不命中。與 TG-5 同一個病根：**我把「掃描範圍」擴大了，但沒有擴大「什麼算命中」**。至少應拒絕「以目標 selector 為 suffix」的規則 |
| **CR-3** | 任何 truthy 的舊雜湊都被視為已完成 | Medium | **接受** | **已實跑確認**：`carryHashes([{id:'A',src:'u',src_sha256:null}], [{id:'A',src:'u',src_sha256:'corrupt'}])` 回傳沿用數 `1`，結果為 `"corrupt"`。`tools/build-pool.mjs:78` 只判斷 truthy；`fetch-images.py` 的 todo predicate 與 `verify-data.mjs:114` 同樣只判斷存在。損毀或格式漂移的雜湊因此可**永久**避開一般排程。修法（三處共用 `^[0-9a-f]{64}$` predicate）成本低且與零依賴限制相容 |
| **CR-4／SC-3 後半** | D10 一般模式做不到「`src_sha256` 不符」的判定 | Medium | **接受** | 屬實，且 Codex 的診斷方向正確：**要在一般排程判斷遠端內容雜湊是否不符，本質上必須先下載該內容**，那就失去增量的意義。因此這不是實作偷懶，是**規格文字過強**。等待 Codex 期間我自己也推到同一結論。修法為精確拆分 D10：一般模式＝新增／URL 變更／缺檔／缺或非法 hash；`--verify-all`＝偵測同 URL 原地換圖與既有資產損毀 |
| **CR-2** | `dosDateToISO()` 接受不存在的曆日 | Low | **接受** | **已實跑確認**：`2026-02-31 → "2026-02-31"`、`2026-04-31 → "2026-04-31"`、`2025-02-29 → "2025-02-29"`（非閏年）全部輸出合法外觀的字串。位元解碼本身正確（Codex 也確認了年 bits 9–15／月 5–8／日 0–4）。**這直接違反我自己寫在 `build-pool.mjs` 的註解「寫假值比缺欄位更糟」**——range check 擋了 `m>12`／`d>31`，卻放行了曆法上不存在的日。修法（`Date.UTC` round-trip）三行 |
| **TG-1** | SC-2 的測試只證明純函式，沒證明欄位真的進入產物 | Medium | **接受** | 屬實。`tests/pipeline.test.mjs` 只測 `dosDateToISO()`，`pickDataFile()` 漏回傳 `mtime` 或 payload 漏寫 `source_version` 都能全綠。Codex 給的「錯誤實作」成立。**這與 SC-2 是同一個洞的兩面**：功能沒接到產物上，而測試看不出來。修法（用 `Buffer` 手組最小 stored-entry ZIP fixture 跑到暫存輸出）不需新依賴 |
| **TG-2** | 沒有測 Python 端的 todo predicate 與 `process()` 路由 | Medium | **接受** | 屬實。`carryHashes()` 測得完整，但 D10 的另一半在 `fetch-images.py`，完全沒有自動測試。Codex 給的兩個錯誤實作（`todo = [i for i in items if i.get("src_sha256")]`、缺檔仍早退）都能通過現有測試 |
| **TG-3** | `verify_asset()` 的靜態斷言可由不可達或吞錯的實作通過 | Medium | **接受** | 屬實。現有測試只搜尋 `Image.open(dest)`、`.load()` 與呼叫次數，Codex 給的 `if False:` 與 `except: return` 兩版都能過。**這正是本 repo 反覆犯的形態**：斷言了「程式碼長什麼樣」而非「行為是什麼」。修法（用 header 合法但位元流損毀的暫存 WebP 實跑）可用既有 locked Pillow，不需新依賴 |
| **TG-8** | C26 同 tick 測試只走 L1 選項路徑 | Low | **接受** | 屬實。目前 L1／L2／L3 共用 `lockAndReveal()`，所以現況無缺陷；但在呼叫端加一個 level 分支即可繞過，而 L1 測試仍全綠 |
| **CR-1** | 失敗時仍會改動 `data/`，未實現 B1 原子性 | Medium | **部分接受** | 問題屬實且已核對：`fetch-images.py:178` 的 `POOL.write_text()` 在 `:183` 的容量檢查回 `1` **之前**執行；資產也直接寫進正式 `data/img/`。**但嚴重度與歸屬要修正三點**：(1) **這是本 PR 之前就存在的行為**，`process()` 一向直接寫正式路徑，不是本輪引入；(2) 規格內部本來就有張力——D9 明文要求「已下載的檔案保留，重跑可續傳」，與 B1「`data/` 位元組完全不變」直接衝突，Codex 未指出這一點；(3) **解碼失敗會自癒**：`:163` 的 `if failures:` 在回寫雜湊前 `return 1`，該筆 `src_sha256` 維持 `null`，下一輪自動落入 todo 重抓。真正該修的是 Codex 順帶點到的**排序問題**（pool.json 不該在容量檢查前寫回），那個成本低；staging 目錄的重構屬獨立一輪 |
| **TG-4** | module-main guard 測試只驗字樣存在 | Low | **部分接受** | 靜態斷言不足屬實，Codex 給的 `if (true) main(); void import.meta.url;` 確實能過。**但「沒有覆蓋直接執行與 npm script」不完全成立**：我在本 session 已人工實跑四種呼叫（npm script／直接／相對路徑／Windows 反斜線絕對路徑）確認 guard 皆成立，且 `import` 只花 13ms 未觸發下載。缺的是**自動化**，不是驗證本身。修法（子行程三案）成本低，應補 |
| **TG-7** | D27 條 5 的 JS 動畫禁令只列出部分 API | Low | **部分接受** | **子主張 (a) 錯誤**：Codex 稱 `window.scroll({ behavior: 'smooth' })` 攔不到。實跑反證——把 `app.js:1061` 改成該寫法後得 **52 pass / 1 fail**，因為契約用的是 `/behavior\s*:/`，不綁 `scrollTo`。**子主張 (b) 正確**：`setInterval(() => { el.style.transform = ... }, 100)` 實跑 **53 pass / 0 fail**，確實攔不到。修法方向採 Codex 的第一個選項：**收窄規格文字**。「JS 不得自帶動畫」是無法靜態窮舉的廣義宣稱，追每一個向量會變成軍備競賽；D27 條 5 應改為明列禁止的 API 清單，並誠實寫明「計時器驅動的 style 變更由人工瀏覽器留檔把關」 |
| CR-5 | module-main guard 無缺陷 | — | **採信（無缺陷）** | 與我獨立實跑的結果一致（四種呼叫方式皆進 `main()`，`import` 不觸發） |
| CR-6 | `verify_asset()` 兩條路徑涵蓋完整 | — | **採信（無缺陷）** | 已核對 `fetch-images.py:108-111`（`--verify-all` 早退前解碼）與 `:115`（新寫出後解碼）兩處 |
| 區塊 3 | 依賴稽核無發現 | — | **採信（無缺陷）** | 零 npm 依賴、PEP-723 與 lock manifest 一致、Actions 皆釘 40 字元 SHA，與我先前的稽核一致。Codex 誠實聲明離線無法查即時 OSV/GHSA，未臆測 |
| D27 條 5 | 實作符合 | — | **採信（符合）** | 已核對 `app.js:1061`／`:1147`／`:1292` 三處皆為 `window.scrollTo(0, 0)` |
| D24 v4.3 | 12 格三處同步 | — | **採信（符合）** | 已核對 `engine.js:1009-1011`、`tests/engagement.test.mjs:183-188`、規格 D24 表格三處一致；「熟手」已入黑名單、「高手」未入，與裁示相符 |

## 兩個貫穿本輪的教訓

1. **TG-5 + TG-6 是同一個病根**：我上一輪把「只驗第一條規則」改成「掃全檔」，
   卻沒有同步擴大「**什麼算命中**」與「**解析不出來時怎麼辦**」。
   擴大掃描範圍而不處理這兩件事，等於把門開大了但鎖沒換。
2. **TG-1 + SC-2 是同一個洞的兩面**：純函式測得再完整，只要沒有一條測試證明
   「這個值真的進到產物裡」，功能就可以靜默不存在——而這正是 SC-2 原本的病徵。
   **修一個「功能靜默不存在」的缺口時，最該補的測試就是「它現在真的存在」。**

## 建議處理順序

1. **SC-2（唯一的合併阻塞項）** — 必須先決定：重建並提交 `data/pool.json`，
   或把 C6 從「顯示資料版本」降為條件式承諾並同步修訂規格。
   **不處理就合併的話，這個 PR 宣稱修好的東西對使用者仍然不存在。**
   附帶收斂 `verdict-v4a.md` 的 SC-2 證據欄措辭。
2. **TG-5 + TG-6（一起做）** — 同一病根，且是本 PR 自己引入的半開門。
   `remOf()` 解析失敗改 fail；`rulesMatching()` 至少拒絕 suffix 命中。
3. **CR-2 + CR-3（一起做）** — 都是「值的格式沒驗」，各三行。
   `Date.UTC` round-trip；`^[0-9a-f]{64}$` 共用 predicate（三處）。
4. **CR-4 + TG-7（一起做）** — 都是**規格文字強於可實作／可驗證的範圍**，
   修的是 D10 與 D27 條 5 的文字，不是程式碼。
5. **TG-1 + TG-2 + TG-3 + TG-4 + TG-8** — 測試補強，成本低。
   其中 TG-1 直接關聯 SC-2，應與第 1 項一起做。
6. **CR-1** — pool.json 的寫回排序（低成本）現在做；
   staging 目錄重構屬獨立一輪，且動它必須同時裁決 D9 續傳與 B1 原子性的規格衝突。

## 邊界聲明

本輪全程唯讀，**未修改任何 source code**。唯一的寫入是 `.ai-review/` 下的兩份報告
（`codex-review-v4b.md` 原始意見、本判定檔）。修不修、怎麼修由使用者決定。
