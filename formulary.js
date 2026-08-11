/**
 * V5 院內清單 — 藥證字號正規化、連結編碼（wire format v1）、四分類與級別可用性
 *
 * 規格：`.ai-review/plan-v5-formulary.md` v5.9 的 D34.2／34.2a／34.3／34.4／34.4a、
 *       D35.1／35.1a／35.2（批次 1–2）與 D36／D37／D37.1／D38.1–38.3／D49（批次 3）。
 *       golden vectors：`.ai-review/golden-vectors-v1.md`。
 *
 * **這個檔案為什麼不併進 engine.js**：`engine.js` 的 `normalize()` 正規化的是
 * **英文品名**（產生答案鍵），本檔的 `normalizeLicense()` 正規化的是**藥證字號**。
 * 兩者名字近、語意完全不同，混在一起遲早叫錯。
 *
 * **wire format 是不可變契約**。改動任何一個位元組的意義都必須升 `FORMAT_VERSION`，
 * 且舊 decoder 必須繼續能解舊 payload。golden vectors 是外部 oracle——
 * **實作跑出不同結果時，錯的是實作，不得回頭改 golden**。
 */

import {
  Level, QUIZ_SIZE, CHOICE_COUNT, DISTRACTOR_COUNT,
  buildIndex, eligibleKeys, drawLeveledQuiz, validateQuizInvariants, makeRng,
} from './engine.js';

export const FORMAT_VERSION = 0x01;
export const PREFIX_TABLE_VERSION = 0x01;

/**
 * D34.4／D34.4a 前綴表 v1 —— **不可變**。
 *
 * 「前綴」＝ `…字第` ＋ 號碼段的非數字前置部分（實測有 4 筆 `第R000xx號`）。
 * `numWidth` 是號碼段的**固定字元寬度**：實測來源 6295 列 100% 為 6 字元，
 * 一般型 6 位數字、R 型 `R` ＋ 5 位數字。
 *
 * **絕對不得重排既有 index**——重排會讓舊連結靜默解成不同藥證，
 * 風險與當初被否決的 bitmap-over-index 完全同型。新增前綴只能在表尾追加並升
 * `PREFIX_TABLE_VERSION`。
 *
 * 本表**從來源資料集導出，不是從 pool.json 導出**：v5.1 曾只列 11 種，
 * 因為那是 3924 筆存活品項的前綴分布；來源 6295 列實際有 16 種（＋2 種字母變體）。
 */
export const PREFIX_TABLE = Object.freeze([
  { prefix: '衛署藥製字第', numWidth: 6 },      // 0
  { prefix: '衛部藥製字第', numWidth: 6 },      // 1
  { prefix: '衛部藥輸字第', numWidth: 6 },      // 2
  { prefix: '衛署藥輸字第', numWidth: 6 },      // 3
  { prefix: '內衛藥製字第', numWidth: 6 },      // 4
  { prefix: '衛部罕藥輸字第', numWidth: 6 },    // 5
  { prefix: '衛署罕藥輸字第', numWidth: 6 },    // 6
  { prefix: '衛署罕藥製字第', numWidth: 6 },    // 7
  { prefix: '衛部罕藥製字第', numWidth: 6 },    // 8
  { prefix: '衛部菌疫輸字第', numWidth: 6 },    // 9
  { prefix: '內衛成製字第', numWidth: 6 },      // 10
  { prefix: '衛署菌疫輸字第', numWidth: 6 },    // 11
  { prefix: '衛部成製字第', numWidth: 6 },      // 12
  { prefix: '衛署成製字第', numWidth: 6 },      // 13
  { prefix: '衛部罕菌疫輸字第', numWidth: 6 },  // 14
  { prefix: '衛部成輸字第', numWidth: 6 },      // 15
  { prefix: '衛署藥輸字第R', numWidth: 5 },     // 16
  { prefix: '衛部藥製字第R', numWidth: 5 },     // 17
].map(Object.freeze));

/** 前綴字串 → index，供 O(1) 查表 */
const PREFIX_INDEX = new Map(PREFIX_TABLE.map((e, i) => [e.prefix, i]));

export class FormularyError extends Error {
  constructor(code, msg) {
    super(msg);
    this.name = 'FormularyError';
    this.code = code;
  }
}
const fail = (code, msg) => { throw new FormularyError(code, msg); };

// ── D35.2 藥證字號正規化 ────────────────────────────────────────────

/** 全形數字／全形英文 → 半形。只轉這兩類，不做整體 Unicode 正規化 */
function toHalfWidth(s) {
  return s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

/**
 * 折疊：全形→半形、去掉所有空白、轉大寫。**正規化與分類去重共用這一套**。
 *
 * 抽出來的理由（D37）：正規化失敗的 token（未知前綴、垃圾字串）沒有 canonical id，
 * 去重只能靠原字串。若那裡用**另一套**折疊規則，`衛署藥XX字第1號` 與
 * `衛署藥ＸＸ字第１號` 會被算成兩筆 UNLISTED，而它們正規化成功時會被算成一筆——
 * 同一份清單的 `unlistedCount` 就依「有沒有踩到未知前綴」而有兩套語意。
 */
function foldToken(raw) {
  if (typeof raw !== 'string') return '';
  return toHalfWidth(raw).replace(/[\s　]/g, '').toUpperCase();
}

/**
 * 把任意 token 正規化成 canonical 藥證字號，失敗回 `null`。
 *
 * **容忍**：全形數字與字母、前後與內部空白、大小寫、前導零、`第`／`號` 缺漏。
 * **不容忍**：缺前綴、前綴錯字 —— 一律回 `null`（歸 UNLISTED），**不做任何猜測**。
 *
 * 為什麼比對必須整串：實測來源 6295 列中，忽略前綴只比號碼會撞號 **93 組、186 筆**，
 * 例如 `衛署藥製字第020174號 (LOTINTON)` 與 `衛署藥輸字第020174號 (BETALOC ZOK)`
 * 是完全不同的藥。這與 repo 既有的「劑型縮寫只能整 token 比對」同源。
 *
 * 本函式**冪等**：`normalizeLicense(normalizeLicense(x)) === normalizeLicense(x)`。
 */
export function normalizeLicense(raw) {
  // 去掉所有空白（含全形空白）。中文前綴內部不該有空白，但貼上的資料常有
  const s = foldToken(raw);
  if (!s) return null;

  // 逐一試前綴。長前綴優先，否則 `衛署藥輸字第` 會先吃掉 `衛署藥輸字第R…`
  let best = -1;
  for (let i = 0; i < PREFIX_TABLE.length; i++) {
    const p = PREFIX_TABLE[i].prefix;
    if (s.startsWith(p) && (best < 0 || p.length > PREFIX_TABLE[best].prefix.length)) best = i;
  }

  let idx = best, rest;
  if (idx >= 0) {
    rest = s.slice(PREFIX_TABLE[idx].prefix.length);
  } else {
    // 容忍缺「第」：`衛署藥製字012345號` → 補回來再試一次
    for (let i = 0; i < PREFIX_TABLE.length; i++) {
      const p = PREFIX_TABLE[i].prefix;
      const noDi = p.endsWith('第') ? p.slice(0, -1)
                 : p.replace('第', '');           // 字母型：`衛署藥輸字R`
      if (s.startsWith(noDi) && (idx < 0 || noDi.length > 0)) {
        const cand = s.slice(noDi.length);
        if (/^\d+號?$/.test(cand)) { idx = i; rest = cand; break; }
      }
    }
    if (idx < 0) return null;
  }

  // 容忍缺「號」
  const m = /^(\d+)號?$/.exec(rest);
  if (!m) return null;

  const { prefix, numWidth } = PREFIX_TABLE[idx];
  const digits = m[1];
  const n = Number(digits.replace(/^0+/, '') || '0');
  // 號碼 0 非法（D34.3 第 2 條：絕對號碼 ≥1）；位數超過 numWidth 亦非法
  if (!Number.isSafeInteger(n) || n < 1) return null;
  if (String(n).length > numWidth) return null;

  return prefix + String(n).padStart(numWidth, '0') + '號';
}

// ── D35.1／D35.1a tokenization ──────────────────────────────────────

const DELIMS = Object.freeze({ ',': ',', ';': ';', '\t': '\t', '，': '，' });

/**
 * 把原始輸入切成 token。**正式格式：純文字，每行一個 token。**
 *
 * 多欄輸入（CSV）必須由呼叫端明確指定 `delimiter` 與 1-based 的 `column`；
 * **未指定即整份拒絕，不得猜測**——猜錯欄位會靜默產出一份錯誤的清單，
 * 而使用者無從得知。同理，欄數不一致、引號未閉合一律**整份拒絕**而非略過。
 *
 * @param {string} text 原始輸入
 * @param {{delimiter?: string, column?: number, hasHeader?: boolean}} [opts]
 * @returns {string[]} 未經正規化的 token（順序保留，未去重）
 */
export function tokenize(text, opts = {}) {
  if (typeof text !== 'string') fail('BAD_INPUT', '輸入必須是字串');
  const { delimiter, column, hasHeader = false } = opts;

  const body = text.replace(/^﻿/, '');            // 剝 BOM
  let lines = body.split(/\r\n|\n|\r/);
  if (hasHeader) lines = lines.slice(1);

  const kept = [];
  const multi = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;                                     // 空行／純空白行：略過
    kept.push({ raw: t, lineNo: i + (hasHeader ? 2 : 1) });
    if (hasTopLevelDelim(t)) multi.push(kept.length - 1);
  });

  if (!kept.length) fail('EMPTY_INPUT', '整份輸入沒有任何 token');

  // **呼叫端明確指定 delimiter 就一律走多欄路徑**，不看偵測結果。
  // 偵測只用來決定「未指定時要不要要求指定」——否則引號未閉合的一行會因為
  // 偵測不到頂層分隔符而掉進單欄路徑，把 UNCLOSED_QUOTE 蓋成別的錯誤。
  if (delimiter === undefined) {
    if (!multi.length) return kept.map((k) => stripQuotes(k.raw));
    fail('COLUMN_NOT_SPECIFIED',
      `輸入含分隔符（第 ${kept[multi[0]].lineNo} 列起），必須指定 delimiter 與 column`);
  }
  if (column === undefined) fail('COLUMN_NOT_SPECIFIED', '指定 delimiter 時必須一併指定 column');
  if (!(delimiter in DELIMS)) fail('BAD_DELIMITER', `不支援的分隔符：${JSON.stringify(delimiter)}`);
  if (!Number.isInteger(column) || column < 1) fail('BAD_COLUMN', 'column 必須是 ≥1 的整數');

  const rows = kept.map((k) => splitRow(k.raw, delimiter, k.lineNo));
  const width = rows[0].length;
  rows.forEach((r, i) => {
    if (r.length !== width) {
      fail('RAGGED_ROWS',
        `第 ${kept[i].lineNo} 列有 ${r.length} 欄，與第 ${kept[0].lineNo} 列的 ${width} 欄不一致`);
    }
  });
  if (column > width) fail('COLUMN_OUT_OF_RANGE', `指定第 ${column} 欄，但只有 ${width} 欄`);
  return rows.map((r) => r[column - 1]);
}

/**
 * 這一行有沒有**頂層**分隔符（引號內的不算）。
 *
 * D35.1a 明定「引號內的 delimiter 不算分欄」。若這裡用 `includes()` 直接搜原始字串，
 * `"A,B"` 這種單一欄位會被誤判成多欄而整份拒絕——**契約說可以，實作卻擋掉**。
 * 沿用 `splitRow` 的同一套引號狀態機，不新增依賴。
 *
 * 引號未閉合時後半段都算「在引號內」，因此不會偵測到頂層分隔符 → 走單欄路徑，
 * 該 token 最終會正規化失敗並歸入 UNLISTED。這是安全的降級（明顯失敗而非靜默錯配）。
 */
function hasTopLevelDelim(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c in DELIMS) return true;
  }
  return false;
}

/** RFC 4180 行為：引號內的分隔符不算分欄；引號未閉合即整份拒絕 */
function splitRow(line, delim, lineNo) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) { if (line[i + 1] === q) { cur += c; i++; } else q = null; }
      else cur += c;
    } else if (c === '"' || c === "'") q = c;
    else if (c === delim) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (q) fail('UNCLOSED_QUOTE', `第 ${lineNo} 列有未閉合的引號`);
  out.push(cur.trim());
  return out;
}

const stripQuotes = (s) =>
  (/^"(.*)"$/.exec(s) || /^'(.*)'$/.exec(s) || [null, s])[1].trim();

// ── D34.2 低階原語：LEB128、CRC-32/ISO-HDLC、base64url ──────────────

/** unsigned LEB128，最短編碼，最多 5 bytes */
function lebEncode(n, out) {
  do {
    const b = n & 0x7F;
    n >>>= 7;
    out.push(n ? (b | 0x80) : b);
  } while (n);
}

/** 回傳 [值, 新游標]。非最短編碼、超過 5 bytes、overflow 一律拒絕 */
function lebDecode(buf, pos) {
  let val = 0, shift = 0, i = pos;
  for (;;) {
    if (i >= buf.length) fail('TRUNCATED', 'varint 在資料結束前被截斷');
    const b = buf[i++];
    const nbytes = i - pos;
    if (nbytes > 5) fail('VARINT_TOO_LONG', 'varint 超過 5 bytes');
    val += (b & 0x7F) * 2 ** shift;
    if (!(b & 0x80)) {
      // 最短編碼：多於一個 byte 時，最後一個 byte 不得為 0
      if (nbytes > 1 && (b & 0x7F) === 0) fail('NON_CANONICAL_VARINT', 'varint 非最短編碼');
      if (val > 0xFFFFFFFF) fail('VARINT_OVERFLOW', 'varint 超出 32 bits');
      return [val, i];
    }
    shift += 7;
  }
}

/** CRC-32/ISO-HDLC：poly 0xEDB88320(reflected)、init/xorout 0xFFFFFFFF */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INV = (() => { const m = new Map(); for (let i = 0; i < 64; i++) m.set(B64[i], i); return m; })();

function b64urlEncode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes.length - i;
    const a = bytes[i], b = n > 1 ? bytes[i + 1] : 0, c = n > 2 ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    if (n > 1) out += B64[((b & 15) << 2) | (c >> 6)];
    if (n > 2) out += B64[c & 63];
  }
  return out;
}

/** 尾端未使用的 bits 必須全為 0，否則同一 body 會有多個字串表示 → 破壞 canonical 唯一性 */
function b64urlDecode(str) {
  if (typeof str !== 'string' || !str.length) fail('BAD_PAYLOAD', 'payload 為空');
  for (const ch of str) if (!B64_INV.has(ch)) fail('BAD_BASE64', `payload 含非 base64url 字元：${ch}`);
  if (str.length % 4 === 1) fail('BAD_BASE64_LENGTH', 'payload 長度不合法');

  const out = [];
  for (let i = 0; i < str.length; i += 4) {
    const n = Math.min(4, str.length - i);
    const v = [0, 1, 2, 3].map((k) => (k < n ? B64_INV.get(str[i + k]) : 0));
    const bits = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (n >= 2) out.push((bits >> 16) & 0xFF);
    if (n >= 3) out.push((bits >> 8) & 0xFF);
    if (n >= 4) out.push(bits & 0xFF);
    // 尾端未用 bits 檢查
    if (n === 2 && (v[1] & 0x0F)) fail('NON_CANONICAL_BASE64', 'base64url 尾端未使用的 bits 不為 0');
    if (n === 3 && (v[2] & 0x03)) fail('NON_CANONICAL_BASE64', 'base64url 尾端未使用的 bits 不為 0');
  }
  return out;
}

// ── D34.2／34.3 encode / decode ─────────────────────────────────────

const MAX_U16 = 0xFFFF;

/** canonical id → { idx, num }。非法一律拋錯（呼叫端應先過 normalizeLicense） */
function splitCanonical(id) {
  for (let i = PREFIX_TABLE.length - 1; i >= 0; i--) {
    const { prefix, numWidth } = PREFIX_TABLE[i];
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    const m = new RegExp(`^(\\d{${numWidth}})號$`).exec(rest);
    if (!m) continue;
    const num = Number(m[1]);
    if (num >= 1) return { idx: i, num };
  }
  fail('NOT_CANONICAL', `不是 canonical 藥證字號：${id}`);
}

/**
 * 把一組 canonical id 編成 payload。
 *
 * @param {Iterable<string>} ids canonical id（會去重並排序，**輸入順序不影響輸出**）
 * @param {number} unlistedCount 第三類筆數（D34.2a）
 * @returns {string} base64url payload
 */
export function encodeFormulary(ids, unlistedCount = 0) {
  const uniq = [...new Set(ids)];
  if (!Number.isInteger(unlistedCount) || unlistedCount < 0 || unlistedCount > MAX_U16) {
    fail('UNLISTED_OUT_OF_RANGE', `unlistedCount 超出 uint16：${unlistedCount}`);
  }
  if (uniq.length > MAX_U16) fail('COUNT_OUT_OF_RANGE', `count 超出 uint16：${uniq.length}`);

  const groups = new Map();
  for (const id of uniq) {
    const { idx, num } = splitCanonical(id);
    if (!groups.has(idx)) groups.set(idx, []);
    groups.get(idx).push(num);
  }

  const body = [
    FORMAT_VERSION, PREFIX_TABLE_VERSION,
    (uniq.length >> 8) & 0xFF, uniq.length & 0xFF,
    (unlistedCount >> 8) & 0xFF, unlistedCount & 0xFF,
  ];
  for (const idx of [...groups.keys()].sort((a, b) => a - b)) {
    const nums = groups.get(idx).sort((a, b) => a - b);
    lebEncode(idx, body);
    lebEncode(nums.length, body);
    let prev = 0;
    for (const n of nums) { lebEncode(n - prev, body); prev = n; }
  }
  const crc = crc32(body);
  body.push((crc >>> 24) & 0xFF, (crc >>> 16) & 0xFF, (crc >>> 8) & 0xFF, crc & 0xFF);
  return b64urlEncode(body);
}

/**
 * 解 payload。**任一條件不成立即拋錯，絕不回傳部分結果。**
 * @returns {{ids: string[], unlistedCount: number}}
 */
export function decodeFormulary(payload) {
  const buf = b64urlDecode(payload);
  if (buf.length < 10) fail('TOO_SHORT', 'payload 過短');

  const crcGiven = ((buf[buf.length - 4] << 24) | (buf[buf.length - 3] << 16) |
                    (buf[buf.length - 2] << 8) | buf[buf.length - 1]) >>> 0;
  const covered = buf.slice(0, buf.length - 4);
  if (crc32(covered) !== crcGiven) fail('CRC_MISMATCH', 'CRC 不符，payload 已損毀');

  if (covered[0] !== FORMAT_VERSION) fail('UNKNOWN_FORMAT_VERSION', `未知的 formatVersion：${covered[0]}`);
  if (covered[1] !== PREFIX_TABLE_VERSION) fail('UNKNOWN_PREFIX_TABLE_VERSION', `未知的 prefixTableVer：${covered[1]}`);
  const count = (covered[2] << 8) | covered[3];
  const unlistedCount = (covered[4] << 8) | covered[5];

  const ids = [];
  let pos = 6, lastIdx = -1;
  while (ids.length < count) {
    let idx, groupCount;
    [idx, pos] = lebDecode(covered, pos);
    if (idx <= lastIdx) fail('PREFIX_NOT_ASCENDING', 'prefixIndex 未嚴格遞增');
    if (idx >= PREFIX_TABLE.length) fail('PREFIX_OUT_OF_RANGE', `prefixIndex 越界：${idx}`);
    lastIdx = idx;
    [groupCount, pos] = lebDecode(covered, pos);
    if (groupCount < 1) fail('EMPTY_GROUP', 'groupCount 不得為 0');
    if (ids.length + groupCount > count) fail('COUNT_MISMATCH', 'groups 的總數超過 count');

    const { prefix, numWidth } = PREFIX_TABLE[idx];
    const max = 10 ** numWidth - 1;
    let cur = 0;
    for (let k = 0; k < groupCount; k++) {
      let d;
      [d, pos] = lebDecode(covered, pos);
      if (d < 1) fail('BAD_DELTA', k === 0 ? '絕對號碼須 ≥1' : 'delta 須 ≥1（號碼須嚴格遞增）');
      cur += d;
      if (cur > max) fail('NUMBER_TOO_LARGE', `號碼 ${cur} 超過 index ${idx} 的 ${numWidth} 位上限`);
      ids.push(prefix + String(cur).padStart(numWidth, '0') + '號');
    }
  }
  if (pos !== covered.length) fail('TRAILING_BYTES', 'groups 解完後仍有多餘位元組');

  return { ids, unlistedCount };
}

// ── D49 `excluded.json` 的資料契約 ──────────────────────────────────

/**
 * D49 的成對不變量。**回傳錯誤清單（空陣列＝通過），不拋例外**——
 * `verify-data` 要一次列出全部問題，不是遇到第一個就停。
 *
 * 抽成純函式的理由（批次 2 覆審發現 3／5／6）：原本內聯在 `build-pool.mjs` 的
 * `main()` 裡，而 `excludedPayload` 的 `content_hash` 是**上一行才從 `payload`
 * 複製過去的**，於是「兩檔 hash 不一致」這條檢查在正常執行中**永遠不成立**——是死碼。
 * 抽出來後它才有真實輸入：`verify-data` 與前端餵的都是**兩份各自獨立讀進來的檔案**。
 *
 * 放在 `formulary.js` 而不是管線的理由（批次 3）：前端載入 `excluded.json` 時要做
 * 同一套檢查（D47），而管線那個檔 import 了 `node:fs`，瀏覽器 import 不了。
 *
 * @param {object} pool      `pool.json` 的完整內容
 * @param {object} excluded  `excluded.json` 的完整內容
 * @param {Set<string>|null} srcIds 來源去重後的 id 集合；`null` 表示跳過聯集檢查
 * @returns {string[]} 錯誤訊息清單
 */
export function validatePair(pool, excluded, srcIds = null) {
  const errs = [];
  const bad = (m) => errs.push(m);

  if (!excluded || typeof excluded !== 'object') return ['excluded.json 不是物件'];
  const meta = excluded.meta;
  if (!meta || typeof meta !== 'object') return ['excluded.json 缺 meta（D49 要求 { meta, items }）'];
  if (meta.schema !== 1) bad(`excluded.json 的 schema 未知：${JSON.stringify(meta.schema)}`);
  if (!Array.isArray(excluded.items)) return ['excluded.json 的 items 不是陣列'];
  if (meta.count !== excluded.items.length) {
    bad(`excluded.json 的 count(${meta.count}) 與 items.length(${excluded.items.length}) 不符`);
  }

  // **join key 必須是 canonical**（依 codex-review 發現 1 與主持人自查 S-1 新增）。
  //
  // D34 的比對是**整串字串相等**：使用者輸入先過 `normalizeLicense()`，再與這兩份檔案的
  // id 做 Set／Map lookup。任一側存了非 canonical 的寫法（缺前導零、前後空白、全形數字），
  // 那筆藥就**永遠比不中**，而畫面會說它「不在外觀資料集中」——D37.1 明文說那句話
  // 對確實在資料集裡的藥是不實的。已實跑重現：`衛署藥製字第21號` 進 excluded 後，
  // 使用者打對的 `衛署藥製字第000021號` 被分到第三類。
  //
  // **兩份都要驗，不是只驗 excluded**：`tools/build-pool.mjs` 的 `id` 直接取來源的
  // `許可證字號` 欄位（連 trim 都沒有）。pool 側若非 canonical 後果更重——那顆藥
  // 可以出題，卻永遠進不了任何一份院內清單。2026-08-10 實測 3941＋2354 筆全部通過，
  // 因此這是**潛在**而非現行缺陷；但月更會換資料，join key 不能沒有守衛。
  const notCanonical = (where, id) =>
    bad(`${where} 的 id 不是 canonical 藥證字號：${JSON.stringify(id)}`);

  const poolIds = new Set();
  for (const it of pool?.items ?? []) {
    const id = it?.id;
    if (typeof id !== 'string' || !id) { bad(`pool.json 含空或非字串 id：${JSON.stringify(id)}`); continue; }
    if (normalizeLicense(id) !== id) notCanonical('pool.json', id);
    poolIds.add(id);
  }

  const seen = new Set();
  for (const it of excluded.items) {
    if (!it || typeof it !== 'object') { bad('excluded.json 含非物件項目'); continue; }
    if (typeof it.id !== 'string' || !it.id.trim()) { bad(`excluded.json 含空或非字串 id：${JSON.stringify(it.id)}`); continue; }
    if (normalizeLicense(it.id) !== it.id) notCanonical('excluded.json', it.id);
    if (seen.has(it.id)) bad(`excluded.json 的 id 重複：${it.id}`);
    seen.add(it.id);
    if (!/^Q[1-5]$/.test(it.stage)) bad(`${it.id} 的 stage 值域外：${JSON.stringify(it.stage)}`);
    if (poolIds.has(it.id)) bad(`${it.id} 同時出現在 pool 與 excluded，違反互斥`);
  }

  // 配對識別以 content_hash 為準，不是日期——同日重編日期不變而內容變了
  if (meta.content_hash !== pool?.meta?.content_hash) {
    bad(`兩檔的 content_hash 不成對：pool=${pool?.meta?.content_hash} excluded=${meta.content_hash}`);
  }

  if (srcIds) {
    const union = poolIds.size + seen.size;
    if (union !== srcIds.size) {
      bad(`pool(${poolIds.size}) + excluded(${seen.size}) = ${union}，` +
          `與來源去重後的 ${srcIds.size} 不符——有品項在兩份輸出中都不見了`);
    }
  }
  return errs;
}

/**
 * 驗證成對後建 `id → stage` 索引。**任一不變量不成立即拋錯，不回傳半套索引**。
 *
 * D49：單筆損毀＝整份不可用。半套的分類資料會產生錯誤的排除原因，比沒有分類更糟——
 * 少掉的那幾筆會靜默落入第三類，畫面上顯示「不在外觀資料集中」，
 * 而它們其實在資料集裡、只是被某個 Q stage 篩掉。
 *
 * @throws {FormularyError} code = 'EXCLUDED_UNUSABLE'，`.errors` 帶完整清單
 */
export function buildExcludedIndex(pool, excluded) {
  const errs = validatePair(pool, excluded, null);
  if (errs.length) {
    const e = new FormularyError('EXCLUDED_UNUSABLE',
      `excluded.json 不可用（${errs.length} 項）：${errs[0]}`);
    e.errors = errs;
    throw e;
  }
  return new Map(excluded.items.map((it) => [it.id, it.stage]));
}

// ── D37／D37.1 四分類 ───────────────────────────────────────────────

/** 內部代碼。**「查無此證」這個措辭在任何使用者可見之處都不得出現**（D37.1） */
export const Category = Object.freeze({
  MATCHED: 'MATCHED',
  NON_SOLID_ORAL: 'NON_SOLID_ORAL',   // 第一類：Q1
  LOW_QUALITY: 'LOW_QUALITY',         // 第二類：Q4／Q5／Q3／Q2
  UNLISTED: 'UNLISTED',               // 第三類
});

/**
 * D37／D37.1 的顯示名稱。**措辭是規格的一部分，不得就地改寫**。
 *
 * 第二類的名稱必須如實涵蓋 Q3（品名過短），不得只寫「無圖或無刻字」；
 * 措辭順序依實際規模排列（Q4 佔第二類 90%，排最前）。
 * 第三類**絕對不能**暗示「使用者打錯了」——來源是一份**口服**藥品外觀資料集，
 * 針劑／外用／眼藥完全不在其中，教學藥師會看到數百筆天天在用的針劑被標成「請核對」。
 * 且本工具**無法區分**「合法但非口服」與「字號真的打錯」，做不到的區分就不得假裝做得到。
 */
export const CATEGORY_LABEL = Object.freeze({
  // **不得寫「可出題」**（主持人自查 S-2）：這是 N（命中品項數）的標籤，而能不能出題
  // 是各級的 K 決定的，L2 的 K 常比 N 少三成。規格名詞表明訂「任何 UI 文字不得用 N 代替 K」。
  [Category.MATCHED]: '命中：在外觀資料集中',
  [Category.NON_SOLID_ORAL]: '口服但非固體（液劑／糖漿用粉劑／顆粒散劑等）',
  [Category.LOW_QUALITY]: '題目品質不足（無刻字／外觀與他藥不可區分／品名過短／無外觀圖）',
  [Category.UNLISTED]:
    '不在外觀資料集中（多為針劑、外用、眼藥等非口服劑型；也可能是已下市或字號誤植）',
});

/** stage → 類別。值域封閉於 Q1–Q5（D49 不變量 5，由 `validatePair` 把關） */
const STAGE_CATEGORY = Object.freeze({
  Q1: Category.NON_SOLID_ORAL,
  Q2: Category.LOW_QUALITY,
  Q3: Category.LOW_QUALITY,
  Q4: Category.LOW_QUALITY,
  Q5: Category.LOW_QUALITY,
});

/** canonical id 為 BMP 字元，code unit 序即 code point 序（D38.3 的子集排序同此） */
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * D37 四分類。**先切 token（D35.1）再呼叫本函式**，本函式不負責 tokenize。
 *
 * 去重時點依 D34.2a：**正規化之後、編碼之前**。去重鍵為 canonical id；
 * 正規化失敗者退回 `foldToken()` 的結果（見該函式的說明）。
 *
 * 第三類的顯示字串：正規化成功者用 canonical id，失敗者用**原 token**（trim 過）。
 * D43 要求「未命中的 id 若要顯示或下載須經 D35.2 正規化」——但未知前綴的 token
 * 正規化不出東西，而 C50 明定它仍必須出現在畫面與下載資料中，
 * 因此保留原字串並由呼叫端**只經純文字 sink** 輸出。
 *
 * `excludedStages` **必填**。少了它，全部 Q1–Q5 品項會靜默落入第三類，
 * 而第三類的顯示名稱是「不在外觀資料集中」——那對那些藥是不實的。
 *
 * @param {Iterable<string>} tokens D35.1 切出的 token（未正規化、未去重）
 * @param {{poolIds: Set<string>, excludedStages: Map<string,string>}} refs
 */
export function classifyFormulary(tokens, { poolIds, excludedStages } = {}) {
  if (!(poolIds instanceof Set)) fail('BAD_POOL_IDS', 'poolIds 必須是 Set');
  if (!(excludedStages instanceof Map)) {
    fail('BAD_EXCLUDED_INDEX', 'excludedStages 必須是 Map（缺它會讓 Q1–Q5 品項全被誤歸第三類）');
  }

  // 去重：鍵 → { id, raw }。同一 id 的多個寫法只留第一次出現的原字串
  const seen = new Map();
  let blank = 0;
  for (const raw of tokens) {
    const folded = foldToken(raw);
    if (!folded) { blank++; continue; }          // 空 token 不是品項，不計入任何類別
    const id = normalizeLicense(raw);
    const key = id ?? folded;
    if (!seen.has(key)) seen.set(key, { id, raw: String(raw).trim() });
  }

  const matched = [];
  const nonSolidOral = [];
  const lowQuality = [];
  const unlisted = [];
  const byStage = { Q1: [], Q2: [], Q3: [], Q4: [], Q5: [] };

  for (const key of [...seen.keys()].sort(byCodePoint)) {
    const { id, raw } = seen.get(key);
    // pool 優先於 excluded：兩者交集為空是 D49 不變量 4，但這裡不假設它成立——
    // 真的重疊時把該品項當可出題（保守方向：不會把出得了題的藥標成排除）
    if (id && poolIds.has(id)) { matched.push(id); continue; }
    const stage = id ? excludedStages.get(id) : undefined;
    if (stage === undefined) { unlisted.push(id ?? raw); continue; }
    const cat = STAGE_CATEGORY[stage];
    if (!cat) fail('BAD_STAGE', `stage 值域外：${JSON.stringify(stage)}（id ${id}）`);
    byStage[stage].push(id);
    (cat === Category.NON_SOLID_ORAL ? nonSolidOral : lowQuality).push(id);
  }

  return {
    matched,
    nonSolidOral,
    lowQuality,
    unlisted,
    byStage,
    /** D34.1：payload 只帶「來源已知」的 id ＝ 命中 ∪ excluded 內的 */
    payloadIds: [...matched, ...nonSolidOral, ...lowQuality].sort(byCodePoint),
    /** D34.2a：去重後既不在 pool 也不在 excluded 者的個數 */
    unlistedCount: unlisted.length,
    /** 相異非空 token 數。四類之和恆等於此值 */
    distinct: seen.size,
    /** 折疊後為空的 token 數。**不屬於任何一類**，但也不靜默丟掉 */
    blank,
  };
}

// ── D38 級別可用性＝實際組得出卷 ─────────────────────────────────────

/** D38.1：最小卷長。短於此就不值得出（一回合太短，逐題檢討沒有意義） */
export const MIN_QUIZ_LEN = 10;

/**
 * 該級每題需要的**卷外**誘答鍵數（D38.1）。
 *
 * **不直接用 `engine.js` 的 `needDistractors`**：那支對 L3 回 3（它只在非 L3 路徑
 * 被呼叫，所以引擎內沒問題），這裡的語意是「卷長要扣掉幾個鍵」，L3 必須是 0。
 * 常數本身仍取自引擎的 `CHOICE_COUNT`／`DISTRACTOR_COUNT`，不另抄數字。
 */
export function distractorNeed(level) {
  if (level === Level.L3) return 0;
  if (level === Level.L2) return DISTRACTOR_COUNT;
  if (level === Level.L1) return CHOICE_COUNT - 1;
  return fail('BAD_LEVEL', `未知級別：${JSON.stringify(level)}`);
}

/** D38.1：該級的最小可用 K（L1 13／L2 15／L3 10） */
export const minUsableK = (level) => MIN_QUIZ_LEN + distractorNeed(level);

/**
 * D38.1：該級在 K 個可出題答案鍵下的目標卷長 `min(20, K − need)`。
 *
 * 為什麼不是 K：`buildChoices` 的 `excludeAns` 恆為**整卷正解集合**（H2），
 * 誘答只能從卷外的答案鍵取。卷長＝K 時 `excludeAns` 吃掉全部 K 個鍵，
 * 誘答一個都抽不到——而規格同時禁止重複題與跨子集誘答，那條路是死的。
 */
export const quizLenFor = (level, K) => Math.min(QUIZ_SIZE, K - distractorNeed(level));

/**
 * D38.3 seed 協定（封閉契約）：`CRC-32(payload ‖ "|" ‖ level)`，與 `Math.random` 無關。
 *
 * 相同 payload ＋ 相同 pool ＋ 相同 level 必須得到相同的可用性判定與**相同的第一卷**。
 * 否則會出現「檢查時可用、按下去失敗」與「重整後按鈕忽隱忽現」。
 */
export function formularySeed(payload, level) {
  if (typeof payload !== 'string') fail('BAD_PAYLOAD', 'seed 需要 payload 字串');
  distractorNeed(level);                       // 級別值域檢查（未知級別直接拋）
  return crc32(new TextEncoder().encode(`${payload}|${level}`));
}

/**
 * 由當前 `pool.json` 與清單 id 集合準備出題子集（D36 ＋ D41）。
 *
 * **子集化是 D36 的核心**：誘答與正解都只從院內品項抽——院內藥師真正會混淆的，
 * 是架上同時存在的兩顆藥。因此本函式回傳的 `index` 是**只含子集**的索引，
 * 出題路徑一律走它，全庫索引不得洩漏進來。
 *
 * D41：`missing` 是清單中已不在最新資料的 id。**呼叫端不得用它覆寫持久化的 payload**
 * ——覆寫會讓品項日後重新出現時也回不來。
 *
 * @param {object[]} poolItems 當前 `pool.json` 的 `items`（全庫）
 * @param {Iterable<string>} matchedIds 清單解出的 canonical id
 */
export function prepareFormulary(poolItems, matchedIds) {
  const want = matchedIds instanceof Set ? matchedIds : new Set(matchedIds);
  // D38.3：餵進 buildIndex 前依 canonical id 昇冪排序——buildIndex 的
  // `byAns` 陣列順序會影響 RNG 的取樣結果，輸入順序不定就談不上可重現
  const items = poolItems.filter((it) => want.has(it.id)).sort((a, b) => byCodePoint(a.id, b.id));
  const present = new Set(items.map((it) => it.id));
  return {
    items,
    index: buildIndex(items),
    N: items.length,
    missing: [...want].filter((id) => !present.has(id)).sort(byCodePoint),
  };
}

/**
 * 可以合理降級成「該級不可用」的失敗代碼。**不在表內的一律重拋**——
 * 未知錯誤是 bug，把它降格成「該級不可用」會讓 bug 以一顆變灰的按鈕呈現。
 */
const DEGRADABLE_CODES = new Set(['QUIZ_ASSEMBLY_FAILED', 'INSUFFICIENT_KEYS', 'INVARIANT_VIOLATED']);

/** 固定文字，**不含藥名**（引擎的錯誤訊息帶藥名，不可直接給使用者） */
const DEGRADE_REASON = Object.freeze({
  QUIZ_ASSEMBLY_FAILED: '這份清單湊不出足夠的誘答，無法組出整卷',
  INSUFFICIENT_KEYS: '這份清單可出題的品項不足',
  INVARIANT_VIOLATED: '組出的題卷未通過完整性檢查',
});

/**
 * D38.2 單一級別的可用性判定。**`eligibleKeys().size` 不是可用性證據。**
 *
 * `eligibleKeys()` 是逐鍵局部判定（`recordEligible` 不看整卷脈絡），而
 * `drawLeveledQuiz` 的 `excludeAns` 恆為整卷正解集合（H2）——因此
 * `.size ≥ n` 與「能組出 n 題」之間**沒有蘊含關係**。真正的證據只有一個：
 * **實際組出來，且 `validateQuizInvariants()` 回空**。
 *
 * 成功時回傳的 `quiz` **就是使用者按下開始後要用的那一卷**（D38.3），
 * 不得在開始時重抽——重抽等於把這裡的判定作廢，「檢查時成功、開始時失敗」會復發。
 *
 * @returns {{level, K, quizLen, available, quiz, code, reason, violations?}}
 */
export function probeLevel({ payload, level, items, index }) {
  const idx = index || buildIndex(items);
  const eligible = eligibleKeys(idx, level);
  const K = eligible.size;
  const minK = minUsableK(level);
  const out = { level, K, quizLen: 0, available: false, quiz: null, code: null, reason: null };

  // 1. 快速前置拒絕（便宜，不必組卷）
  if (K < minK) {
    return { ...out, code: 'K_BELOW_MIN', reason: `可出題答案鍵 ${K} 個，未達最低 ${minK} 個` };
  }

  // 2. 真正的證據：以目標卷長實際組卷
  const n = quizLenFor(level, K);
  const rng = makeRng(formularySeed(payload, level));
  let quiz;
  try {
    quiz = drawLeveledQuiz(items, { level, n, rng, index: idx, eligible });
  } catch (e) {
    // 組卷在允許的重試次數內仍失敗 → 該級禁用。**不得以重複題或跨子集誘答救場**。
    //
    // **只降級白名單內的失敗**（依 codex-review 發現 2）：原本 `catch (e)` 全攔，
    // 於是 `TypeError`、索引結構損毀這類**真 bug** 會被貼上「該級不可用」的標籤，
    // 使用者只看到級別按鈕變灰——那正是本專案最怕的靜默失效。
    // 未知錯誤一律重拋，讓它以真面目炸出來。
    if (!DEGRADABLE_CODES.has(e?.code)) throw e;
    return { ...out, quizLen: n, code: e.code, reason: DEGRADE_REASON[e.code] };
  }
  // D38.2 明定「成功**且** validateQuizInvariants() 回空」才算可用，所以這道檢查留著。
  // **誠實標明**：它今天不可能觸發——`drawLeveledQuiz` 內部的 `assertQuizInvariants`
  // 已用同一組 (level, index) 硬中止，違規會以 `INVARIANT_VIOLATED` 從上面的 catch 出去。
  // 變異驗證確認過這條分支無法被任何輸入轉紅（M12），它是「引擎哪天拿掉內部斷言」
  // 的第二道防線，不是本層的實際判定依據。測試側改以**獨立重建的 index** 驗證題卷，
  // 那條才是真的會紅的斷言。
  const violations = validateQuizInvariants(quiz, { level, index: idx });
  if (violations.length) {
    // 訊息本身含藥名，不可直接給使用者——只回代碼，明細留在 violations
    return { ...out, quizLen: n, code: 'INVARIANT_VIOLATED', reason: `不變量違規 ${violations.length} 項`, violations };
  }
  return { ...out, quizLen: n, available: true, quiz };
}

/**
 * 三級一起判定（D38）。三級全部禁用時呼叫端才拒絕產生連結／要求重新產生。
 *
 * 為什麼不用統一門檻：實測 L2 在 60 品項以下就撐不住，L1／L3 到 20 品項都還可用。
 * 統一硬擋會讓「換廠批次 30 品項」這個真實情境永遠用不了。
 */
export function probeFormulary({ payload, poolItems, matchedIds, levels = [Level.L1, Level.L2, Level.L3] }) {
  const prep = prepareFormulary(poolItems, matchedIds);
  const byLevel = {};
  for (const lv of levels) {
    byLevel[lv] = probeLevel({ payload, level: lv, items: prep.items, index: prep.index });
  }
  return { ...prep, levels: byLevel, anyAvailable: Object.values(byLevel).some((r) => r.available) };
}
