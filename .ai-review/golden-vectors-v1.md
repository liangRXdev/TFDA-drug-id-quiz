# V5 連結編碼 golden vectors — wire format v1

| 項目 | 內容 |
|---|---|
| 建立日期 | 2026-08-10 |
| 對應規格 | `.ai-review/plan-v5-formulary.md` v5.5 的 D34.2／D34.2a／D34.3／D34.4／D34.4a |
| `formatVersion` | `0x01` |
| `prefixTableVer` | `0x01` |
| 驗收條件 | A38（golden vectors）、A40（grammar-invalid） |

## 這份檔案存在的理由

驗收條件 A38 明訂：

> golden 的 body bytes 與最終 payload **必須由人工推導或第二來源確認，
> 不得由受測 encoder 產生後抄回測試**——那只是 round-trip 的變形。

因此這份 vectors **在 codec 實作存在之前產出**，獨立性是**結構性保證**的，
不是靠自律。實作者的工作是把下表原封不動抄進 `tests/`，
**不得因為實作跑出不同結果就回頭改這份檔案**——不一致時錯的是實作。

## 推導方法與獨立性聲明

| 步驟 | 來源 | 獨立性 |
|---|---|---|
| LEB128 位元組 | **手算**，再以獨立實作交叉驗證（9/9 一致） | 未使用任何本專案程式碼 |
| 位元組排列 | **手工依 D34.2／D34.3 條文排列** | 同上 |
| CRC-32 | Python 標準庫 `zlib.crc32` | **CPython stdlib**，與本專案無關 |
| base64url | Python 標準庫 `base64.urlsafe_b64encode` | 同上 |
| canonical id 還原 | **手工依 D34.4a 的表** | 同上 |

**CRC variant 驗證**：`zlib.crc32(b"123456789") == 0xCBF43926`，
與 D34.2 指定的 CRC-32/ISO-HDLC 檢查向量相符。**此斷言必須寫進測試。**

每組都另做了兩項回驗：base64url 解碼後位元組相同、CRC 重算相符。全部 OK。

---

## G1 — 單組單筆，最小合法號碼

**用途**：測 `numWidth` 補零。號碼 `1` 必須還原成 `000001` 而非 `1`。

| 輸入 |
|---|
| ids = { `衛署藥製字第000001號` } |
| `count` = 1、`unlistedCount` = 0 |

```
header  01 01              formatVersion=1, prefixTableVer=1
        00 01              count = 1
        00 00              unlistedCount = 0
group   00                 prefixIndex = 0（衛署藥製字第）
        01                 groupCount = 1
        01                 delta[0] = 1（絕對號碼）
CRC     98 98 D2 01        CRC-32 = 0x9898D201
```

| 欄位 | 值 |
|---|---|
| body（完整，13 bytes） | `01 01 00 01 00 00 00 01 01 98 98 D2 01` |
| **payload** | **`AQEAAQAAAAEBmJjSAQ`**（18 字元） |
| 還原 canonical id | `衛署藥製字第000001號` |

---

## G2 — 多個 prefix group ＋ multi-byte varint ＋ `unlistedCount` 非零

**用途**：測跨組排序、3-byte LEB128、以及 `unlistedCount` 真的被寫進 header。

| 輸入 |
|---|
| ids = { `衛署藥製字第000123號`, `衛署藥製字第062392號`, `衛部藥輸字第026789號` } |
| `count` = 3、`unlistedCount` = 5 |

```
header  01 01              版本
        00 03              count = 3
        00 05              unlistedCount = 5
group0  00                 prefixIndex = 0
        02                 groupCount = 2
        7B                 delta[0] = 123（絕對）
        BD E6 03           delta[1] = 62269（= 62392 − 123）
group1  02                 prefixIndex = 2（衛部藥輸字第）
        01                 groupCount = 1
        A5 D1 01           delta[0] = 26789（絕對）
CRC     2B 1C 39 22        CRC-32 = 0x2B1C3922
```

| 欄位 | 值 |
|---|---|
| body（完整，21 bytes） | `01 01 00 03 00 05 00 02 7B BD E6 03 02 01 A5 D1 01 2B 1C 39 22` |
| **payload** | **`AQEAAwAFAAJ7veYDAgGl0QErHDki`**（28 字元） |
| 還原 canonical id | `衛署藥製字第000123號`、`衛署藥製字第062392號`、`衛部藥輸字第026789號` |

---

## G3 — `count = 0` 且 `unlistedCount > 0`（合法空 payload）

**用途**：D34.3 第 7 條明定 `count === 0` 合法。這組同時證明
**`unlistedCount` 不會被 codec 忽略**——若實作根本沒讀這個欄位，這組會失敗。

| 輸入 |
|---|
| ids = {}（空集合） |
| `count` = 0、`unlistedCount` = 42 |

```
header  01 01              版本
        00 00              count = 0
        00 2A              unlistedCount = 42
groups  （空）
CRC     9C 45 92 60        CRC-32 = 0x9C459260（僅涵蓋 6 bytes 的 header）
```

| 欄位 | 值 |
|---|---|
| body（完整，10 bytes） | `01 01 00 00 00 2A 9C 45 92 60` |
| **payload** | **`AQEAAAAqnEWSYA`**（14 字元） |
| 還原 canonical id | 無。載入端走 D38 的三級全禁用路徑，並顯示「另有 42 筆不在外觀資料集中」 |

---

## G4 — 字母前綴 index 16 與 17

**用途**：測 S-1 發現的字母號碼段。這兩筆是**真實資料**（來源 6295 列中的實際 id）。
`numWidth` 為 **5**（`R` 已併入 prefixString）。
本組的 payload 含 base64url 專有字元 **`_`**。

| 輸入 |
|---|
| ids = { `衛署藥輸字第R00063號`, `衛部藥製字第R00042號` } |
| `count` = 2、`unlistedCount` = 0 |

```
header  01 01              版本
        00 02              count = 2
        00 00              unlistedCount = 0
group0  10                 prefixIndex = 16（衛署藥輸字第R）
        01                 groupCount = 1
        3F                 delta[0] = 63
group1  11                 prefixIndex = 17（衛部藥製字第R）
        01                 groupCount = 1
        2A                 delta[0] = 42
CRC     46 B2 8F 4A        CRC-32 = 0x46B28F4A
```

| 欄位 | 值 |
|---|---|
| body（完整，16 bytes） | `01 01 00 02 00 00 10 01 3F 11 01 2A 46 B2 8F 4A` |
| **payload** | **`AQEAAgAAEAE_EQEqRrKPSg`**（22 字元） |
| 還原 canonical id | `衛署藥輸字第R00063號`、`衛部藥製字第R00042號` |

---

## G5 — `numWidth` 邊界：各 index 的最大合法號碼

**用途**：測 D34.4a 的位數上限，以及 3-byte LEB128 的高值。
本組的 payload 含 base64url 專有字元 **`-`**。
G4 與 G5 合起來涵蓋了 `-` 與 `_` 兩個 URL-safe 字元。

| 輸入 |
|---|
| ids = { `衛署藥製字第999999號`（idx 0，numWidth 6 的上限）, `衛署藥輸字第R99999號`（idx 16，numWidth 5 的上限） } |
| `count` = 2、`unlistedCount` = 0 |

```
header  01 01              版本
        00 02              count = 2
        00 00              unlistedCount = 0
group0  00                 prefixIndex = 0
        01                 groupCount = 1
        BF 84 3D           delta[0] = 999999
group1  10                 prefixIndex = 16
        01                 groupCount = 1
        9F 8D 06           delta[0] = 99999
CRC     0E 39 F2 A4        CRC-32 = 0x0E39F2A4
```

| 欄位 | 值 |
|---|---|
| body（完整，20 bytes） | `01 01 00 02 00 00 00 01 BF 84 3D 10 01 9F 8D 06 0E 39 F2 A4` |
| **payload** | **`AQEAAgAAAAG_hD0QAZ-NBg458qQ`**（27 字元） |
| 還原 canonical id | `衛署藥製字第999999號`、`衛署藥輸字第R99999號` |

---

## 涵蓋矩陣（對照 A38 的要求）

| A38 要求 | G1 | G2 | G3 | G4 | G5 |
|---|:-:|:-:|:-:|:-:|:-:|
| 多個 prefix group | | ✔ | | ✔ | ✔ |
| multi-byte varint | | ✔ | | | ✔ |
| 最小號碼 1 | ✔ | | | | |
| 該 index 的最大合法號碼 | | | | | ✔ |
| 新增的 index 11–17 | | | | ✔ | ✔ |
| CRC byte order | ✔ | ✔ | ✔ | ✔ | ✔ |
| `count = 0 且 unlistedCount > 0` | | | ✔ | | |
| 兩者皆非零 | | ✔ | | | |
| 由 D34.4a 重建的 canonical id | ✔ | ✔ | —(空) | ✔ | ✔ |
| base64url 的 `-` 與 `_` | | | | `_` | `-` |

**尚未涵蓋、留給 A40 grammar-invalid 類的**（那些是「必須被拒絕」的向量，不屬 golden）：
號碼 0、`prefixIndex` 越界（> 17）、非最短 varint、`count` 與實際不符、
組內 delta 為 0、空組、trailing bytes、提前耗盡、
base64url 尾端未用 bits 非零、兩個 uint16 欄位超界、
`formatVersion`／`prefixTableVer` 未知。

---

## 推導過程的結論：D34 可以凍結

**這次推導的真正目的，是檢驗「規格是否精確到兩個獨立實作者會產出位元組相同的 payload」**
（Codex 第三輪的第 1 個提問）。

**推導全程沒有撞到任何需要自行補假設的地方。** 每一個位元組都能追溯到規格的某一條：

| 推導時的疑問 | 由哪一條解答 |
|---|---|
| 號碼要不要補零、補幾位 | D34.4a 的 `numWidth` 欄 |
| 前綴字串含不含「第」 | D34.4a 的 `prefixString` 欄（含） |
| 組內第一個 delta 是絕對值還是差分 | D34.3 第 2 條（絕對） |
| 組間如何排序 | D34.3 第 1 條（prefixIndex 嚴格遞增） |
| `count = 0` 時 groups 與 CRC 怎麼算 | D34.3 第 7 條 ＋ D34.2（CRC 涵蓋 header‖groups） |
| CRC 用哪個 variant | D34.2（ISO-HDLC ＋ 檢查向量） |
| base64url 要不要 padding、尾端 bits | D34.2（無 padding、未用 bits 須為 0） |
| `unlistedCount` 算什麼 | D34.2a |

**因此建議：`formatVersion = 0x01` 與 `prefixTableVer = 0x01` 即可凍結。**

反過來說，若日後有人在實作時發現本檔某個位元組推不出來，
那代表規格仍有缺口——**應該修規格並重推這份檔案，而不是遷就實作**。
