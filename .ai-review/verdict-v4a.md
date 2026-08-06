# 覆核判定 — Codex v4 批次 A 覆審

> **日期**：2026-08-06 ｜ **commit**：`35d05d7` ｜ **分支**：`feat/v4-engagement-batch-a`
> **原始意見**：`.ai-review/codex-review-v4a.md`（未修飾）
> 每一項都已**回讀該檔該行驗證**，不採信 Codex 的描述。

## 統計

| 判定 | 數 |
|---|---|
| 接受 | 10 |
| 部分接受 | 3 |
| 拒絕 | 0 |

**無 Critical／High**，因此嚴格說**沒有必修項**。最高為 Medium。
Codex 未出現幻覺——13 項的檔案、行號與規格條款編號全部核對屬實。

## 判定表

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| CR-1／SC-1 | 三處 `scrollTo({behavior:'smooth'})` 未受 reduced-motion 管控 | Medium | **接受** | 已核對 `app.js:1061`（`finish`）、`:1147`（`finishFlash`）、`:1292`（`backToStart`）三處確實存在。`plan-v4-engagement.md` D27 條 1 寫的是「**全部現存及新增**的動態效果」，JS smooth scroll 是動態效果，未列入窮舉清單也未受 `no-preference` 管控 → 確為未達規格。前庭敏感使用者對捲動動畫的回報最多，屬真實無障礙缺口。修法採「直接移除 `behavior`」較一致：本專案的紀律是動畫集中在 CSS 正向表列，為了保留一個捲動效果而在 JS 引入 `matchMedia` 分支，等於開第二套動畫管控機制 |
| CR-2／SC-4 | `verify-data.mjs` 只驗 WebP header，訊息卻宣稱「可解碼」 | Medium → **Low** | **部分接受** | 問題屬實：`tools/verify-data.mjs:26-47` 的 `readWebp()` 只讀 RIFF 長度、容器標記與第一個 chunk header，`:110` 卻印「全部資產可解碼且為合法 WebP」，而 `:26` 的註解直接寫「證明『可解碼』」——**宣稱強於證據**，正是本 repo 最在意的形態，B5（`plan.md:341`）也確實承諾「每筆資產可解碼」。**但嚴重度過高**：要產生「header 合法、位元流損毀」的檔案，得在 `fetch-images.py` 用 Pillow 編碼落地**之後**發生磁碟或傳輸損壞；且後果是前端走既有的作廢遞補路徑（C5），不是圖名錯位。修法方向正確（沿用已鎖定的 Pillow 加 `--verify-existing`，不引入新依賴），但屬管線加強，非批次 A 的阻塞項 |
| SC-2 | `meta.source_version` 從未產生，前端功能靜默不存在 | Medium | **接受** | 三端全部核對：規格 `plan.md:228` 宣稱 pool 含此欄位、`:360` 的 C6 要求顯示；`tools/build-pool.mjs:156-170` 的 items/meta 從未寫入；實測 `data/pool.json` 的 meta keys 為 `schema, source, source_file, source_rows, content_hash, count, stages, no_fuzzy, images_bytes`——**確實沒有 `source_version`**。`app.js:157` 的 `if (m.source_version)` 與 `:1246` 的成績卡欄位因此永遠不成立。這是命令列舉的「宣稱的欄位從未產生」原型案例。**修法有兩條，都可接受但不可維持現狀**：(a) 由來源 ZIP 的穩定時間戳產生（不可用 job 執行時間，否則破壞 B7 冪等）；(b) 若來源實際沒有穩定版本欄位，改顯示既有的 `content_hash` 前 12 碼並同步修訂 C6 文字。選 (b) 時要注意 `content_hash` 已被 v4 的紀錄 `pool` 欄位使用，語意一致不衝突 |
| SC-3 | D10 的增量模式與季度 `--verify-all` 實際沒有區別 | Medium | **接受** | 鏈路三段全部核對：`tools/build-pool.mjs:163` 對**每一筆**寫死 `src_sha256: null`（`:240-250` 讀前版 pool 只用來算變動幅度，未沿用雜湊）→ `tools/fetch-images.py:114-117` 的 todo predicate 含 `or not i.get("src_sha256")` → `.github/workflows/update-pool.yml` 的順序是 build-pool → fetch-images → verify-data。因此每次排程都全量重抓 3,913 張圖，`--verify-all` 與一般排程無實質差異，D10（`plan.md:170-172`）宣稱的增量判定「新增 or URL 變更 or src_sha256 不符」形同未實作。後果是把 TFDA 暫時性失敗的曝險放大到全量——而本專案的紀律是「發布全有全無」，一失敗就整批不發。修法為純管線改動，不需 build step |
| SC-5 | A28 主文仍寫「12 格兩兩相異」，與 D24 v4.2 裁決矛盾 | Low | **接受** | 屬實，且是**我在 v4.2 裁決時只改了 D24 條 2、漏改 A28 主文**所造成的規格文字矛盾，不是實作缺陷——`engine.js` 的 `RANK_TITLES` 與 `tests/engagement.test.mjs` 的 A28 測試都依 v4.2 的「≥50 的 9 格」實作。依流程「規格文字有歧義時同時修正規格文字」，已直接修訂 A28 文字 |
| TG-1 | C25 只掃 CSS，不掃 JS 動畫入口 | Medium | **接受** | 屬實，且是**已發生的假陰性**——CR-1 的三處 `behavior: 'smooth'` 正好全部通過 C25。`tests/engagement.test.mjs` 的 C25 只對 `index.html` 的 `<style>` 做掃描，而 `_ui-harness.mjs:171` 的 `window.scrollTo` 是空函式，行為測試也抓不到。這條缺口與 CR-1 是同一個洞的兩面，應一起補 |
| TG-2 | C23b 用 `rules.find()` 只取第一條 `.rank-title` | Medium | **接受** | 屬實。`tests/engagement.test.mjs` 的 C23b 確實用 `rules.find((r) => r.sel === '.rank-title')`，只驗第一條宣告。`index.html` 已存在 `@media (max-width: 480px)` block 且該 block 內本來就在覆寫 `font-size`（`.score-big`、`header h1`），**在那裡加一條 `.rank-title` 覆寫是這個檔案的既有編輯習慣**，不是刻意繞過——因此這是會被真實編輯觸發的缺口，Medium 合理。直接關聯到威脅模型第 3 條（誤導使用者高估能力） |
| TG-3 | C27 只檢查 block 內屬性，block 外的狀態 selector 不受管 | Medium → **Low** | **部分接受** | 問題屬實：`.streak.pop .n { font-size: 2rem }` 若寫在 reduced-motion block **之外**，C27 不掃（只迭代 `rulesOf(block.body)`）、C25 也不掃（沒有 `transition`/`animation`）。但與 TG-2 不同，這需要**新造一條原本不存在的狀態規則並刻意放到 block 外**，不是既有編輯習慣會自然產生的；且我已對「block **內**改成 `font-size`」做過變異驗證並確認轉紅。降為 Low。修法與 TG-2 合併：兩者都是「靜態契約的掃描範圍太窄」，一起改成全檔掃描該組 selector |
| TG-4 | `engagement-ui.test.mjs` 的 describe 之間有順序耦合 | Low | **接受** | 屬實。C19 第一個測試直接讀 `stored().L1`，該紀錄由前一個 describe 的 C18 建立；`store.reset()` 只清 localStorage 樁，不重建 app module 與 `state`。另外 `startLevel()` 覆寫 `Math.random` 後從不還原（**既有的 `ui-smoke.test.mjs` 也是同一寫法**，不是這批引入的），因此不是回歸，但補上還原確實更穩 |
| TG-5 | C33 只測一個交叉方向 | Low | **接受** | 屬實。目前只有「另一分頁提高 `bestStreak`／本頁提高 `bestScore`」一例；「只對 streak 重讀、對 score 用舊快照覆寫」的弱化實作可以通過。這與 C18 當初特意補上兩個交叉方向是同一個道理，漏在跨分頁這一層 |
| TG-6 | C20 的 E6／E7 未跑完整回合 | Low | **接受** | 屬實，且是**對規格文字的直接未達**：`plan-v4-engagement.md` 的 C20 明寫「七條**各一個** stub 案例…**每條皆須**：完整回合可走到結算、分數與逐題檢討完整渲染」。實作中 E1／E1b／E2／E3／E4 有跑完整回合並呼叫 `assertResultIntact()`，**E6 只驗起始頁讀取**、E7（在 C21）只驗清除流程。補法便宜（沿用既有 helper），應補 |
| 區塊 3 | 依賴稽核無發現 | — | **接受（無發現）** | 核對屬實：`package.json` 零 npm 依賴；`tools/fetch-images.py.lock` 有版本與 artifact hash；`update-pool.yml` 的第三方 Actions 皆釘 40 字元 SHA。Codex 已誠實聲明離線無法查即時 OSV/GHSA，此結論僅為靜態稽核 |
| 通過摘要 | D23／D24／D25／D32、A23–A29、§11.3 四項決定 | — | **採信** | 抽查 D25 的 predicate 與 E1–E7、D32 的更新時點、D24 的不進成績卡三處，與 Codex 描述一致。Codex 也正確地把 M5（批次 B）與人工稱號覆核排除在缺陷之外 |

## 建議處理順序

1. **CR-1／SC-1 + TG-1（一起做）** — 移除三處 `behavior: 'smooth'`，同時把 C25 的靜態契約擴及 `app.js` 的動畫入口。這是唯一「規格已宣稱做到、實際沒做到」且屬本批次範圍的項目，補完才算 D27 真的收斂。
2. **TG-2 + TG-3（一起做）** — 靜態契約改為全檔掃描 `.rank-title`、`.streak.pop .n`、`.opt.ok/.no`、`.cell.ok/.no`，不只掃第一條規則與 media block 內。TG-2 直接關聯威脅模型第 3 條。
3. **TG-6 + TG-5 + TG-4** — 測試補強，成本低，沿用既有 helper 即可。
4. **SC-2、SC-3、CR-2／SC-4** — 三項皆為 **v2 資料管線的既有缺口，與批次 A 無關**。建議獨立成一輪處理，不要混進本 PR：混做會讓「批次 A 有沒有做對」與「管線有沒有修好」無法歸因（沿用 D30 的分批紀律）。其中 SC-3 對發布穩定性的影響最大，優先。
5. **SC-5** — 已於本次直接修訂規格文字。

## 處理紀錄（2026-08-06 追加）

建議處理順序的 **1–3 已全部完成**，第 4 項（管線三缺口）依判定表意見**未動**，留待獨立一輪。

| 項目 | 修法 | 變異驗證 |
|---|---|---|
| CR-1／SC-1 | `app.js` 三處改 `window.scrollTo(0, 0)`；規格新增 **D27 條 5**「動畫只能由 CSS 產生，JS 不得自帶」，把這條界線寫進規格而非只改程式碼 | M1 加回 `behavior: 'smooth'` → 紅 |
| TG-1 | C25 新增 `app.js` 靜態契約，禁 `behavior:`／`scrollIntoView({…})`／`.animate(`／`requestAnimationFrame` | 同上 M1 |
| TG-2 | C23b 由 `rules.find()` 改 `rulesMatching()` **全檔掃描**（含 `@media` 內），字級比較改「**任一處**稱號 ≤ **任一處**三級判定」的保守契約；color 改為逐條檢查所有 `color:` 宣告 | M2 在 480px block 內放大稱號字級 → 紅；M3 在同處改強調色 → 紅 |
| TG-3 | C27 新增「狀態 selector 全檔不得動到佔位屬性」，涵蓋 `.streak.pop .n`、`.opt.ok/.no`、`.cell.ok/.no`，用**明列的** `FLOW_PROPS` 集合（避免 `^border` 誤命中 `border-color`） | M4 把狀態規則改字級並放到 block 外 → 紅 |
| TG-6 | E6 補完整回合，且刻意選**會破紀錄**的回合——寫回路徑才是風險所在；E7 於 C21 補「清除後走完整回合並重建紀錄」。`assertResultIntact()` 提到模組層（它原本鎖在 C20 內，正是 E7 當初只驗清除流程的直接原因） | M5 寫回時丟掉其他難度 → 紅 4 條 |
| TG-5 | C33 補反向：另一分頁提高 `bestScore`／本頁提高 `bestStreak`，兩者都不得倒退 | M6 分數永遠覆寫、不重讀 → 紅 3 條（含本條） |
| TG-4 | C19 改自備 `before` 前置；C33 改自備 `foreignWrite()` 前置；`Math.random` 於檔尾 `after` 還原（**不**逐次還原——還原了後續作廢遞補就不再是已知序列） | 舊版 C19 單獨跑：3 紅（`TypeError: Cannot read properties of null`）；新版：3 綠 |

**測試數 272 → 276**（全綠）。

**SW `CACHE` 已升 `v2` → `v3`。** 一度誤判為「同一未發布 PR、不必升版」，實際上 **PR#2 已於
2026-08-06 02:40Z merge 進 `main` 並完成 Pages 部署**，`v2` 是**線上版本**，本輪就是不折不扣的新一批。
SW 為 network-first（`sw.js:67`），線上使用者本來就會拿到新的 `app.js`，升版影響的是**離線快取**那一份——
不升的話離線使用者會繼續拿到帶 `behavior:'smooth'` 的舊 `app.js`。
這也正是〔2-7〕寫「**無條件**升版」的理由：不把「這批要不要升」留給人判斷。

### 第二輪：管線三缺口（SC-2／SC-3／CR-2）

建議處理順序的第 4 項已完成，**與批次 A 分開的獨立一輪**（沿用 D30 分批紀律）。

| 項目 | 修法 | 證據 |
|---|---|---|
| **SC-2** | 採 verdict 的修法 (a)。實測確認來源**沒有** `Last-Modified` 也**沒有** `ETag`，但 ZIP 中央目錄的 DOS 日期欄位（`off+14`）標 `2026-08-03`，**比下載當下早 3 天**——是來源端的資料產生日，不是隨請求重編的時間戳，因此可放進 `meta.source_version` 而不破壞 B7。格式取 `YYYY-MM-DD`，與 `plan.md:228` 的範例一致，故**規格文字無須修訂**。ZIP 無合法日期時**不寫欄位**（寫假值比缺欄位更糟，前端的 `if (m.source_version)` 本來就容許缺席） | 實跑：`資料版本 2026-08-03`，meta 確實出現該欄位 |
| **SC-3** | 新增 `carryHashes(items, prevItems)`：`id` 與 `src` URL **都**未變才沿用前版 `src_sha256`。URL 變了不沿用——URL 是 TFDA 換圖時唯一看得見的訊號，沿用舊雜湊會讓 `fetch-images` 直接跳過，新圖永遠抓不進來。前版 pool 的讀取因此提前到寫出前 | 實跑：**沿用 3,913／3,924，待抓 11**（修前是待抓 3,924）。11 筆是來源真的新增的品項 |
| **CR-2** | `fetch-images.py` 新增 `verify_asset()`：對**落地後**的 WebP 做 Pillow 完整 decode。`to_webp()` 既有的 `im.load()` 驗的是**來源原圖**，證明不了寫出去的那份完好。新寫出的每張都驗；`--verify-all` 時對「內容未變因而提早返回」的既有檔案也驗一次（不補這條的話季度全驗一張都沒驗到）。`verify-data.mjs` 的宣稱改為「容器結構合法」，並同步修訂 `plan.md` B5 的責任歸屬 | 見下方變異表 |

**B7 冪等仍成立**：連跑兩次 `build-pool.mjs --out .probe/pool.json`，兩次輸出**位元組完全相同**。

新增 `tests/pipeline.test.mjs`（14 條），八個變異全部確認轉紅：

| 變異 | 結果 |
|---|---|
| 月不補零／拿掉月日範圍檢查 | 紅 3／紅 1 |
| `carryHashes` 只比對 id 不管 URL／前版無雜湊仍計入 | 紅 3／紅 1 |
| `verify_asset` 不開落地檔／季度全驗不解碼既有檔／恢復「可解碼」宣稱 | 各紅 1 |
| 拿掉 module-main guard | **整檔崩**（import 當下就真的去下載 TFDA 來源——這正是加 guard 的理由） |

**測試數 276 → 290**，`npm run verify` 全通過。

**未重建 `data/pool.json`**：實跑導向 `.probe/`，跑完即刪。本輪只改管線程式碼；
順手把資料更新（3,913 → 3,924，+11 筆、幅度 0.28%）混進來，會讓「管線有沒有修好」
與「資料變動對不對」無法歸因。資料更新應由 `update-pool.yml` 的月排程或手動 dispatch 走正常流程。

**未做，且是刻意的：**

- **稱號用字的人工法規覆核**（v4.1 D24 表格）仍未做，與本輪無關。
- **批次 B（M5 錯題再戰）動工前仍須先重跑 `/codex-checkplan`**——D28 換成兩階段組裝、
  新增 D31 session ownership，等於換了架構，沒被審過。

## 邊界聲明

**Codex 的覆審輪**全程唯讀，未修改任何 source code；唯一的寫入是 `.ai-review/` 下的兩份報告，
以及依判定表 SC-5 修訂 `.ai-review/plan-v4-engagement.md` 的 A28 文字（規格文字修正，非程式碼）。

上方兩節「處理紀錄」是**使用者裁示後另行實作**的結果，不屬於覆審本身。
