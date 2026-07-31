# CLAUDE.md — 藥品辨識王

規格是 `.ai-review/plan.md`（v2，已過 `/codex-checkplan`）。**動前端或管線前先讀它**，
底下只記「從 code 看不出來、但改錯會出事」的部分。

## 資料源的三個坑（實測，別重踩）

| 坑 | 實測結果 |
|---|---|
| `export/42/json` 回傳的是 **ZIP** 不是 JSON | 內含 `42_5.json`，**檔名帶版本號會變** → 必須依 schema 辨識，不可 glob 取第一個 |
| 帶 `Origin` header 即 **403** | 前端絕對不能直接 fetch，只能由 Actions 端抓 |
| 圖檔主機 **無 CORS header** | 跨域圖片進 canvas 會 taint、`toDataURL()` 直接爆 → 成績卡只能用純 Canvas 繪製，不可含任何跨域圖片 |

## 正規化只有一份

`engine.js` 的 `normalize()` 同時被**建置管線**（`tools/build-pool.mjs` import 它）和**前端**使用。
管線刻意用 Node 而非 Python 就是為了這件事——兩份實作必然漂移，漂移的後果是答案判定不一致。
`tools/fetch-images.py` 只做圖片下載轉檔，不碰任何品名邏輯。

**改 `normalize()` 必然改變答案鍵**，一定要重跑 `npm run build:pool` 並檢查變動幅度。

## 兩個容易寫錯的地方

**劑型縮寫只能整 token 比對。** 曾經用 `\b` 比對 `S.C.`，把 `O.G.S.C. TABLETS "JOHNSON"`
正規化成 `O G`——品牌字被吃掉。gold set 有這條回歸案例，別改掉。

**`pool.json` 的 `img` 是相對於 `data/`**，不是相對於頁面。前端要用 `DATA_DIR + it.img`。
曾經直接塞給 `img.src` 導致全部 404（但失敗路徑正確攔下來了，只是題目全作廢）。

## 判定紀律：寧可誤判為錯，不可誤判為對

題庫實測有 **276 個答案鍵**與其他藥名僅差 1 字元（SOLAXIN⇄BOLAXIN、PISTON⇄POSTON…）。
容錯開著會把「打成另一顆藥的名字」判成正確——這會強化錯誤記憶，是本專案最怕的失效模式。

處理方式是 `meta.no_fuzzy` 清單（管線自動產出），**不是調整全域門檻**。
`A4` 驗收條件會強制驗證套用後誤接受數為 0。新藥名進來若造成新碰撞，A4 會紅燈，
此時要確認 `no_fuzzy` 有涵蓋，不要去放寬 `FUZZY_MIN_LEN`。

## 發布是全有全無

暫時性下載失敗**不可**用「把該筆剔除」吸收——那會讓題目因網路問題無聲消失，
而縮水後的數字會變成下次比較的新基線。`fetch-images.py` 重試 3 次仍失敗就整批 exit 1。

變動幅度 >±3% 或單次移除 >50 題時，`build-pool.mjs` 會拒絕發布並要求人工裁決
（CI 會自動開 issue）。確認差異無誤後才用 `--allow-any-delta` 重跑。

## 沒有 Service Worker，是刻意的

離線不在目標內。曾經寫進驗收條件，覆審時發現「斷網重整後可作答」要兌現
就得預載全部圖片（約 50MB），與「首屏 <3MB」直接衝突，且 SW 會製造
「新 pool 配舊圖片」的版本錯配——那正好命中答案與圖片對應錯誤的最高風險。
`manifest.webmanifest` 保留（theme-color／icon），但不註冊 SW、不宣稱離線。

house style 的「全部工具都是 PWA」對本專案不適用。

## 指令

```bash
npm test                 # engine + 題庫驗收（A 組，39 項）
npm run build:pool       # 抓來源 → 產 data/pool.json
npm run fetch:images     # 鏡像圖片（uv + Pillow）
npm run verify           # 資料完整性（B 組）
```

`build:pool` 開發時可加 `--source <本機zip>` 避免重複打 TFDA。
