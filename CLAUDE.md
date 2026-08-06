# CLAUDE.md — 藥品辨識王

規格有兩份，**動前端或管線前先讀**：`.ai-review/plan.md`（v2，資料管線與 L3）
與 `.ai-review/plan-v3-levels.md`（v3.6，難度分級；不變量 H1–H4／I1–I5 與其**分層**
寫在 D18／D19，動抽題或選項生成一定要先讀那兩節）。
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

## SW 只快取 app shell —— 題庫與圖片永遠不進快取

2026-08-04 PWA 化。在此之前是「完全不做 SW」，改動的是**可安裝性**，
不是離線策略——**離線仍然不在目標內**，原本的兩個否決理由一個都沒有消失：

1. 「斷網重整後可作答」要兌現得預載全部圖片（約 50MB），與「首屏 <3MB」衝突
2. 快取圖片會製造「新 pool 配舊圖片」的版本錯配——顯示 A 藥的照片、標成 B 藥的名字，
   正好命中本專案最高風險

因此 `sw.js` 的界線是：`data/pool.json` 與 `data/img/**` **連 `respondWith` 都不呼叫**，
行為與沒有 SW 時完全一致；其餘 shell 走 network-first，快取只作為離線兜底。
離線時 app 開得起來但題庫載不到，走既有的 C4 失敗路徑顯示「無法連線讀取題庫」——
那是誠實的降級，不是壞掉。`manifest` 的 description 明寫「需連網使用」。

**這條界線由 `tests/sw.test.mjs` 守著**（真的載入 sw.js 驅動 fetch handler，
不是比對原始碼字串）。要動 SW 的快取範圍前先讀那個檔的檔頭。

圖示由 `tools/make-icons.py` 從 `icon.svg` 的幾何**重繪**而非轉檔
（cairosvg 在 Windows 需要系統 cairo DLL，實測裝不起來）。
**改 `icon.svg` 要一併改該腳本**，兩份幾何定義會漂移且沒有測試會抓到。

house style 的「全部工具都是 PWA」現在適用了，但**僅限可安裝這一層**。

**每一批交付都要升 `sw.js` 的 `CACHE` 版本**，並同步改 `tests/sw.test.mjs` 的 C31
（那條把版本字串釘死，不設條件）。批次一定會動到 shell 內的檔案，
「這批沒新增資源所以不用升」的判斷不留給下一個人。

## CSS 與 layout 不能寫成自動測試

`tests/_ui-harness.mjs` 的 `style` 是純物件，沒有 `getComputedStyle`、
`getBoundingClientRect`、`matchMedia`，而且**刻意不引入 jsdom**（零依賴）。
任何依賴 cascade、media query 或幾何的斷言寫在這個樁上**必然是永遠綠的假斷言**，
比沒有測試更糟——後人會以為那條守住了。

處理方式分兩層：**靜態 CSS 原始碼契約**（自動，見 `tests/engagement.test.mjs`
與 `ui-smoke.test.mjs` 的 C17）＋**人工瀏覽器留檔**（字級對比、reduced-motion
兩態、動畫期間的 flow 位移、375px 版面）。

解析 CSS 前**必須先剝掉註解**：規則前面的說明註解會被當成 selector 的一部分，
而寫著「不做 `@keyframes`」的註解本身會讓「CSS 內不得出現 @keyframes」恆紅。

`getBoundingClientRect` 這條另有一個假陽性：真實的 rect **包含 transform**，
會把刻意允許的 `scale` 誤判成 flow 位移。要驗位移得量相鄰錨點的佔位，不是量矩形。

## 動態效果一律正向表列

`index.html` 內的 `transition`／`animation` 只准出現在
`@media (prefers-reduced-motion: no-preference)` 這一個 block 裡，**含既有的**
button background 與 `.bar > i` width 兩條——reduced-motion 是使用者的無障礙偏好，
對「哪些動畫是哪一批加的」不感興趣。這條由靜態契約 C25／C27 守著，
新增動畫時要一併加進那兩條測試的 selector 清單。

不做 `@keyframes`：作答畫面上一個不會停的動畫是持續的干擾源。

## localStorage：前綴、精確 key、讀不到就不寫

key 是 `tfda-drug-id-quiz:records`。**前綴不可省**——本站與 pharmacy-portal
的十幾個工具同源，storage 是整站共用的。清除只能 `removeItem` 那一個精確 key，
不可 `clear()`、不可前綴掃描（今日無害，新增 `:settings` 那天就會誤刪）。

**讀取失敗時不得寫入**：讀不到不代表沒有紀錄，照寫等於用看不見的舊快照覆蓋掉
更好的成績，而使用者要到下次開啟才會發現最佳成績退步了。同理，讀到壞 JSON
或未來 schema 時**不做任何 mutation**——順手清掉等於把新版本寫的資料靜默刪除。

## 指令

```bash
npm test                 # engine + 難度分級 + 閃卡 + UI 接線 + 娛樂性強化 + SW 界線（272 項）；需 Node ≥22（glob）
npm run build:pool       # 抓來源 → 產 data/pool.json
npm run fetch:images     # 鏡像圖片（uv + Pillow）
npm run verify           # 資料完整性（B 組）
npm run icons            # 由 icon.svg 幾何重繪 PWA 圖示（uv + Pillow）
```

`build:pool` 開發時可加 `--source <本機zip>` 避免重複打 TFDA。
