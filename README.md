# 藥品辨識王

[![Live Demo](https://img.shields.io/badge/Live%20Demo-Click%20Here-blue?style=for-the-badge)](https://liangrxdev.github.io/TFDA-drug-id-quiz/)
藥師外觀辨識自我測驗。以衛福部食藥署「藥品外觀資料集」出題，依實拍圖與外觀特徵辨識英文品名。

- 每回合隨機 **20 題**，答案鍵不重複
- 卡關可看提示（首字母＋字數），該題滿分由 1.0 降為 0.5
- 完成後產生總分與逐題檢討，成績卡可下載為 PNG
- 純靜態、零建置、無後端、無帳號

## 題庫

| 篩選階段 | 剩餘 |
|---|---|
| 來源（opendata 42） | 6,251 |
| Q1 固體口服劑型 | 5,680 |
| Q2 有圖檔 | 5,679 |
| Q3 答案鍵長度 ≥3 | 5,671 |
| Q4 有刻字標記 | 4,083 |
| **Q5 外觀特徵可與他品區分** | **3,913** |

Q4 與 Q5 是刻意的：只憑「圓形／白色／無刻痕」無法唯一辨識，
而外觀特徵完全相同卻品名不同的群組（實測 83 組）會讓藥師給出「對另一顆藥而言正確」的答案卻被判錯——
那會強化錯誤記憶。**寧可少 170 題，不可誤判。**

## 開發

```bash
npm test                 # engine 與題庫驗收（39 項）
npm run build:pool       # 抓取來源 → data/pool.json
npm run fetch:images     # 鏡像圖片 → data/img/*.webp（需 uv）
npm run verify           # 資料完整性驗證
```

本機預覽需經 HTTP（ES module 與 fetch 不支援 `file://`）：

```bash
python -m http.server 8000
```

## 架構

```
engine.js              純函式：正規化、判定、抽題、計分、狀態機（有測試）
app.js                 DOM 與事件、資源失敗處理
index.html             單檔內嵌樣式
tools/build-pool.mjs   資料管線（Node，import engine.js 共用正規化）
tools/fetch-images.py  圖片鏡像轉檔（uv + Pillow）
tools/verify-data.mjs  資料完整性驗證
tests/gold-set.json    47 筆人工確認的品名 → 答案鍵對照
.ai-review/plan.md     規格（v2，已過獨立規格審查）
```

圖片鏡像進 repo 而非外連，有三個獨立理由：原圖 140KB–6MB、
圖檔主機無 CORS（跨域圖片進 canvas 會 taint，成績卡截圖會失敗）、
以及避免每位使用者都去打食藥署主機。轉 WebP 後約 27 倍壓縮。

## 資料來源與免責

題庫來源：衛生福利部食品藥物管理署「藥品外觀資料集」（opendata 42）。

本工具為藥學教育／自我練習用，**非臨床調劑或給藥的辨識依據**。
實務辨識藥品請以原廠包裝、標籤與院內藥品品項資料為準。
題庫為特定時間點之快照，不代表藥品現行供應或許可狀態。
