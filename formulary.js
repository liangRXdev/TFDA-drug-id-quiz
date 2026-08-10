/**
 * V5 院內清單 — 藥證字號正規化與連結編碼（wire format v1）
 *
 * 規格：`.ai-review/plan-v5-formulary.md` v5.8 的 D34.2／34.2a／34.3／34.4／34.4a、
 *       D35.1／35.1a／35.2。golden vectors：`.ai-review/golden-vectors-v1.md`。
 *
 * **這個檔案為什麼不併進 engine.js**：`engine.js` 的 `normalize()` 正規化的是
 * **英文品名**（產生答案鍵），本檔的 `normalizeLicense()` 正規化的是**藥證字號**。
 * 兩者名字近、語意完全不同，混在一起遲早叫錯。
 *
 * **wire format 是不可變契約**。改動任何一個位元組的意義都必須升 `FORMAT_VERSION`，
 * 且舊 decoder 必須繼續能解舊 payload。golden vectors 是外部 oracle——
 * **實作跑出不同結果時，錯的是實作，不得回頭改 golden**。
 */

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
  if (typeof raw !== 'string') return null;
  // 去掉所有空白（含全形空白）。中文前綴內部不該有空白，但貼上的資料常有
  const s = toHalfWidth(raw).replace(/[\s　]/g, '').toUpperCase();
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
