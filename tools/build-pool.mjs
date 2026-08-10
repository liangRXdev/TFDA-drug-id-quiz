#!/usr/bin/env node
/**
 * 題庫建置管線 — 規劃文件 §5 步驟 1–7
 *
 *   node tools/build-pool.mjs [--source <本機 zip>] [--out data/pool.json] [--allow-any-delta]
 *
 * 刻意用 Node 而非 Python：正規化必須與前端共用**同一份** engine.js normalize（規格 D3）。
 * 兩份實作必然漂移，而漂移的後果是答案判定不一致。
 * 圖片下載與轉檔另由 tools/fetch-images.py 負責（Pillow）。
 *
 * 失敗即中止，不寫出任何檔案（規格 D9 全有全無）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalize, squash, editDistance, FUZZY_MIN_LEN } from '../engine.js';
import { PREFIX_TABLE } from '../formulary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_URL = 'https://data.fda.gov.tw/data/opendata/export/42/json';

/** 規格 D4 Q1：固體口服劑型 */
const SOLID_SHAPES = new Set([
  '圓形', '膠囊', '橢圓形', '四邊形', '三角形',
  '六邊形', '八邊形', '水滴形', '雙圓形', '五邊形',
]);

/** 資料檔必備欄位（用於 schema 辨識，非依檔名）— 規格 B2 */
const REQUIRED_FIELDS = ['許可證字號', '英文品名', '外觀圖檔連結', '形狀', '顏色', '刻痕', '標註一'];

const MIN_SOURCE_ROWS = 5000;   // 規格 §5 步驟 4
const MAX_DELTA_RATIO = 0.03;   // 規格 D9：±3%
const MAX_DELTA_REMOVED = 50;   // 規格 D9：單次移除上限

class PipelineError extends Error {}
const die = (msg) => { throw new PipelineError(msg); };

// ── 最小 ZIP 讀取器（不引入 npm 依賴）─────────────────────────────────

/**
 * ZIP 中央目錄的 DOS 日期欄位 → `YYYY-MM-DD`，不合法回 `null`。
 *
 * **這是來源端的資料產生時間，不是執行時間**——實測 TFDA 的 ZIP entry 標
 * `2026-08-03`，而下載當下是 `2026-08-06`，相差 3 天，不可能是隨請求重編的。
 * 來源沒有 `Last-Modified` 也沒有 `ETag`（實測皆無），這是唯一的穩定版本欄位。
 * 因此可安全放進 `meta.source_version` 而不破壞 B7 冪等（規格 `plan.md:228`）。
 *
 * 只取日期：DOS 格式不帶時區，時分秒對使用者無意義；
 * 同日重編有 `content_hash` 分辨得出來。
 */
export function dosDateToISO(dateWord) {
  const y = ((dateWord >> 9) & 0x7f) + 1980;
  const m = (dateWord >> 5) & 0x0f;
  const d = dateWord & 0x1f;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // 〔CR-2〕range check 擋得掉 m>12／d>31，卻放行曆法上不存在的日：
  // 2026-02-31、2026-04-31、非閏年的 2025-02-29 都會輸出「看起來合法」的字串。
  // 這直接違反本檔下方自己寫的紀律——**寫假值比缺欄位更糟**。
  // round-trip 才是真的驗：Date.UTC 會把不存在的日進位到下個月
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * 〔CR-3〕`src_sha256` 的格式判定。**三處共用同一條規則**
 * （這裡、`fetch-images.py` 的 `is_sha256()`、`verify-data.mjs`）。
 *
 * 原本三處都只判斷 truthy，於是損毀或格式漂移的值（截斷、大寫、字串 `"undefined"`）
 * 一律被當成「已完成」：carryHashes 沿用它 → fetch-images 的 todo 不收它 →
 * verify-data 也放行。結果是這一筆可以**永久**避開一般排程，
 * 只有每季一次的 `--verify-all` 才碰得到。
 * 沒驗格式的欄位只證明「有東西」，不證明「是雜湊」。
 */
export const isSha256 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/**
 * 規格 D10 的增量判定：沿用前版的 `src_sha256`。
 *
 * 〔SC-3〕原本對每一筆寫死 `null`，而 `fetch-images.py` 的 todo predicate 含
 * `or not i.get("src_sha256")`——恆真，於是每次排程都全量重抓 3,913 張圖，
 * `--verify-all` 與一般排程毫無差異，D10 宣告的增量判定形同未實作。
 * 後果是把 TFDA 暫時性失敗的曝險放大到全量，而發布紀律是全有全無。
 *
 * **URL 變了就不沿用**——URL 是 TFDA 換圖時唯一看得見的訊號；
 * 沿用舊雜湊會讓 fetch-images 直接跳過，新圖永遠抓不進來。
 * 檔案是否真的在磁碟上由 fetch-images 的 predicate 另外把關，這裡不重複判斷。
 */
export function carryHashes(items, prevItems) {
  const prev = new Map((prevItems ?? []).map((p) => [p.id, p]));
  let carried = 0;
  for (const it of items) {
    const p = prev.get(it.id);
    // 〔CR-3〕格式不合法的舊雜湊不沿用——沿用等於讓損毀的那一筆永久避開重抓
    if (p && p.src === it.src && isSha256(p.src_sha256)) {
      it.src_sha256 = p.src_sha256;
      carried++;
    }
  }
  return carried;
}

function readZipEntries(buf) {
  // End of Central Directory：簽章 0x06054b50，自尾端回掃（含 comment 情形）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) die('回應不是合法 ZIP：找不到 End of Central Directory（可能是 WAF 錯誤頁或截斷）');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) die(`ZIP 中央目錄第 ${n} 筆簽章錯誤`);
    const method = buf.readUInt16LE(off + 10);
    const mtime = dosDateToISO(buf.readUInt16LE(off + 14));   // 來源資料產生日（SC-2）
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    // 本地檔頭的 extra 長度可能與中央目錄不同，必須重讀
    if (buf.readUInt32LE(localOff) !== 0x04034b50) die(`ZIP 本地檔頭簽章錯誤：${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let content;
    if (method === 0) content = raw;
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else die(`ZIP 使用不支援的壓縮方式 ${method}：${name}`);

    entries.push({ name, content, mtime });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

// ── 取得來源 ──────────────────────────────────────────────────────────

async function fetchSource(localPath) {
  if (localPath) {
    console.log(`[1/8] 使用本機來源 ${localPath}`);
    return fs.readFileSync(localPath);
  }
  console.log(`[1/8] 下載 ${SOURCE_URL}`);
  // 注意：不可帶 Origin header，實測會被回 403
  const res = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'TFDA-drug-id-quiz/1.0' } });
  if (!res.ok) die(`來源回應 HTTP ${res.status}，中止（不覆蓋既有 data/）`);
  return Buffer.from(await res.arrayBuffer());
}

/** 依 schema 辨識資料檔，而非依檔名或 glob 順序（規格 B2） */
function pickDataFile(entries) {
  const candidates = [];
  for (const e of entries) {
    if (!/\.json$/i.test(e.name)) continue;
    let parsed;
    try { parsed = JSON.parse(e.content.toString('utf8')); } catch { continue; }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    const keys = Object.keys(parsed[0]);
    if (REQUIRED_FIELDS.every((f) => keys.includes(f))) candidates.push({ name: e.name, rows: parsed, mtime: e.mtime });
  }
  if (candidates.length === 0) die('ZIP 內找不到符合 schema 的資料檔');
  if (candidates.length > 1) {
    die(`ZIP 內有 ${candidates.length} 個符合 schema 的資料檔（${candidates.map((c) => c.name).join(', ')}），` +
        '無法判定該用哪個，中止');
  }
  return candidates[0];
}

// ── 篩選與正規化 ──────────────────────────────────────────────────────

const splitMulti = (v) => [...new Set(String(v ?? '').split(';;;').map((s) => s.trim()).filter(Boolean))].sort();
const sq = (v) => String(v ?? '').replace(/\s+/g, '').toUpperCase();

/** 規格 D8：資產鍵。不可由字號去中文或只留數字產生（實測 27 組碰撞） */
const assetKey = (id) => crypto.createHash('sha1').update(id, 'utf8').digest('hex').slice(0, 16);

function buildPool(rows) {
  const stages = { 來源: rows.length };

  /**
   * id → **首次**淘汰階段（規格 §5.1／D37 的 stage precedence，固定 Q1→Q5）。
   *
   * 同一 id 多列時：**任一列存活即算 matched**（見 main() 末段的扣除），
   * 全數淘汰才取最早失敗階段。`if (!has)` 配合階段的處理順序即實現「最早」，
   * 且同階段內的列彼此同 stage，因此**結果不依來源列順序改變**。
   *
   * 實測 2026-08-10 的來源 6295 列 id 全部唯一，此規則目前不會被觸發；
   * 仍實作出來，未來資料變動時行為才是確定的而不是碰運氣。
   */
  const excludedBy = new Map();
  const markOut = (rs, stage) => {
    for (const r of rs) {
      const id = String((r.r ?? r)['許可證字號'] ?? '').trim();
      if (id && !excludedBy.has(id)) excludedBy.set(id, stage);
    }
  };
  /** 一次走訪切成 [通過, 淘汰]，避免跑兩次 predicate */
  const partition = (arr, pred) => {
    const pass = [], drop = [];
    for (const x of arr) (pred(x) ? pass : drop).push(x);
    return [pass, drop];
  };

  let cur, out;
  [cur, out] = partition(rows, (r) => splitMulti(r['形狀']).some((s) => SOLID_SHAPES.has(s)));
  markOut(out, 'Q1');
  stages['Q1 固體口服'] = cur.length;

  [cur, out] = partition(cur, (r) => String(r['外觀圖檔連結'] ?? '').trim());
  markOut(out, 'Q2');
  stages['Q2 有圖檔'] = cur.length;

  const withKey = cur.map((r) => ({ r, ans: normalize(r['英文品名']) }));
  [cur, out] = partition(withKey, (x) => squash(x.ans).length >= 3);
  markOut(out, 'Q3');
  stages['Q3 答案鍵 ≥3'] = cur.length;

  [cur, out] = partition(cur, (x) => String(x.r['標註一'] ?? '').trim());
  markOut(out, 'Q4');
  stages['Q4 有刻字'] = cur.length;

  // Q5：外觀判別特徵衝突則整組排除（規格 D4）
  const groups = new Map();
  for (const x of cur) {
    const k = JSON.stringify([
      splitMulti(x.r['形狀']), splitMulti(x.r['顏色']), splitMulti(x.r['刻痕']),
      sq(x.r['標註一']), sq(x.r['標註二']), String(x.r['外觀尺寸'] ?? '').trim(),
    ]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  let ambiguousGroups = 0;
  const kept = [];
  for (const members of groups.values()) {
    if (new Set(members.map((m) => m.ans)).size > 1) {
      ambiguousGroups++;
      markOut(members, 'Q5');
      continue;
    }
    kept.push(...members);
  }
  stages['Q5 外觀可區分'] = kept.length;

  const items = kept.map(({ r, ans }) => ({
    id: r['許可證字號'],
    ans,
    full: String(r['英文品名']).trim(),
    zh: String(r['中文品名'] ?? '').trim(),
    img: `img/${assetKey(r['許可證字號'])}.webp`,
    src: r['外觀圖檔連結'],
    src_sha256: null,          // 由 tools/fetch-images.py 填入
    shape: splitMulti(r['形狀']),
    color: splitMulti(r['顏色']),
    score_mark: splitMulti(r['刻痕']),
    size: String(r['外觀尺寸'] ?? '').trim() || null,
    mark1: String(r['標註一'] ?? '').trim() || null,
    mark2: String(r['標註二'] ?? '').trim() || null,
  }));

  // §5.1 的聚合規則：任一列存活 → 該 id 算 matched，不得同時出現在 excluded
  for (const it of items) excludedBy.delete(it.id);

  return { items, stages, ambiguousGroups, excludedBy };
}

/** D34.4 的 18 種前綴（`…字第` ＋ 號碼段的非數字前置部分） */
const KNOWN_PREFIXES = new Set(PREFIX_TABLE.map((e) => e.prefix));

/**
 * D49 的成對不變量。**回傳錯誤清單（空陣列＝通過），不拋例外**——
 * `verify-data` 要一次列出全部問題，不是遇到第一個就停。
 *
 * 抽出來的理由（覆審發現 3／5／6）：原本這段內聯在 `main()` 裡，而 `excludedPayload`
 * 的 `content_hash` 是**上一行才從 `payload` 複製過去的**，於是「兩檔 hash 不一致」
 * 這條檢查在正常執行中**永遠不成立**——是死碼。拿掉它整段，測試仍全綠（已實跑確認）。
 *
 * 抽成純函式後它才有真實輸入：`verify-data` 餵的是**磁碟上兩份獨立讀進來的檔案**，
 * 那裡的 hash 真的可能不一致（只更新其中一份、手動改過、部署到不同版本）。
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

  const poolIds = new Set((pool?.items ?? []).map((i) => i.id));
  const seen = new Set();
  for (const it of excluded.items) {
    if (!it || typeof it !== 'object') { bad('excluded.json 含非物件項目'); continue; }
    if (typeof it.id !== 'string' || !it.id.trim()) { bad(`excluded.json 含空或非字串 id：${JSON.stringify(it.id)}`); continue; }
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
 * B13 前綴表完整性 —— **掃來源全部列，不是掃存活品項**。
 *
 * 規格 v5.1 的前綴表只有 11 種，正是因為從 `pool.json` 的存活品項導出；
 * 來源實際有 18 種（含兩種字母變體）。**存活品項的前綴分布是來源的真子集**，
 * 從它導出必然漏。
 *
 * 前綴抽取刻意用**寬鬆**的正規式而非 `normalizeLicense()`：後者遇到未知前綴會回
 * `null`，未知前綴就會被自己丟掉而永遠掃不到——**驗證器不能用被驗證的那套規則**。
 *
 * 遇到未知前綴一律**中止**而非警告：新前綴代表 wire contract 需要升版，
 * 那是人必須介入的決策（升 `prefixTableVer`、在表尾追加 index、確認舊連結相容）。
 * 月更因此中斷是可接受的代價——沿用「發布是全有全無」的既有紀律。
 */
function checkPrefixTable(rows) {
  const unknown = new Map();
  for (const r of rows) {
    const id = String(r['許可證字號'] ?? '').trim();
    const m = /^(.+?字第\D*)\d/.exec(id);
    const p = m ? m[1] : `(無法解析：${id})`;
    if (!KNOWN_PREFIXES.has(p)) unknown.set(p, (unknown.get(p) ?? 0) + 1);
  }
  if (unknown.size) {
    const detail = [...unknown.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `${p} × ${n} 筆`)
      .join('；');
    die(`來源含 ${unknown.size} 種不在 D34.4 前綴表中的前綴：${detail}。\n` +
        '  這代表連結編碼的 wire contract 需要升版（升 prefixTableVer 並在表尾追加 index，\n' +
        '  絕不可重排既有 index）。請人工確認後再發布。');
  }
  return KNOWN_PREFIXES.size;
}

/**
 * 規格 6.2 碰撞處理：**不調整全域門檻**，改對涉及碰撞的個別答案鍵停用容錯。
 *
 * 實測題庫中有數百組僅差 1 字元的相異藥名（SOLAXIN⇄BOLAXIN、PISTON⇄POSTON…）。
 * 容錯開著會把「打成另一顆藥的名字」判為正確——正是威脅模型第一順位的「誤判為對」。
 * 寧可要求這些藥名必須完全拼對。
 */
function computeNoFuzzy(items) {
  const keys = [...new Set(items.map((i) => squash(i.ans)))].filter((k) => k.length >= FUZZY_MIN_LEN);
  const byLen = new Map();
  for (const k of keys) {
    if (!byLen.has(k.length)) byLen.set(k.length, []);
    byLen.get(k.length).push(k);
  }
  const flagged = new Set();
  for (const k of keys) {
    for (const L of [k.length - 1, k.length, k.length + 1]) {
      for (const other of byLen.get(L) || []) {
        if (other === k) continue;
        if (editDistance(k, other, 1) <= 1) { flagged.add(k); flagged.add(other); }
      }
    }
  }
  return [...flagged].sort();
}

// ── 主流程 ────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  // resolve 而非 join：相對路徑照樣以 ROOT 為基準，絕對路徑（測試的暫存輸出）才不會被接成廢字串
  const outPath = path.resolve(ROOT, arg('--out') || 'data/pool.json');
  const allowAnyDelta = argv.includes('--allow-any-delta');

  const buf = await fetchSource(arg('--source'));
  console.log(`[2/9] 取得 ${buf.length.toLocaleString()} bytes，驗證 ZIP 結構`);
  const entries = readZipEntries(buf);

  console.log(`[3/9] ZIP 內 ${entries.length} 個檔案，依 schema 辨識資料檔`);
  const { name, rows, mtime } = pickDataFile(entries);
  console.log(`      → ${name}（${rows.length.toLocaleString()} 筆）　資料版本 ${mtime ?? '(ZIP 無合法日期)'}`);

  if (rows.length < MIN_SOURCE_ROWS) die(`來源僅 ${rows.length} 筆，低於下限 ${MIN_SOURCE_ROWS}，中止`);
  const missing = REQUIRED_FIELDS.filter((f) => !(f in rows[0]));
  if (missing.length) die(`來源缺欄位：${missing.join(', ')}`);

  console.log('[4/9] 驗證前綴表完整性（B13）');
  const nPrefix = checkPrefixTable(rows);
  console.log(`      來源全部 ${rows.length.toLocaleString()} 列的前綴皆在 D34.4 的 ${nPrefix} 種表內 ✓`);

  console.log('[5/9] 套用資格條件 Q1–Q5');
  const { items, stages, ambiguousGroups, excludedBy } = buildPool(rows);
  for (const [k, v] of Object.entries(stages)) console.log(`      ${k.padEnd(16)} ${v.toLocaleString()}`);
  console.log(`      （Q5 排除 ${ambiguousGroups} 個外觀不可區分群組）`);

  console.log('[6/9] 計算容錯停用清單');
  const noFuzzy = computeNoFuzzy(items);
  console.log(`      ${noFuzzy.length} 個答案鍵停用容錯（與他鍵編輯距離 ≤1，開容錯會誤判為對）`);

  console.log('[7/9] 斷言資產鍵唯一');
  const keys = new Map();
  for (const it of items) {
    const k = it.img;
    if (keys.has(k)) die(`資產鍵碰撞：${keys.get(k)} 與 ${it.id} 皆映射到 ${k}`);
    keys.set(k, it.id);
  }
  console.log(`      ${keys.size.toLocaleString()} / ${items.length.toLocaleString()} 唯一 ✓`);

  console.log('[8/9] 比對變動幅度，沿用未變動項目的來源雜湊');
  let prev = null;
  if (fs.existsSync(outPath)) {
    try { prev = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { /* 損毀視同無前版 */ }
  }
  // D10 增量判定（SC-3）：前版雜湊必須在寫出前沿用，否則 fetch-images 會全量重抓
  const carried = carryHashes(items, prev?.items);
  console.log(`      沿用來源雜湊 ${carried.toLocaleString()} / ${items.length.toLocaleString()}`
    + `　→ 待抓 ${(items.length - carried).toLocaleString()}`);
  if (prev?.items) {
    const before = new Set(prev.items.map((i) => i.id));
    const after = new Set(items.map((i) => i.id));
    const removed = [...before].filter((i) => !after.has(i)).length;
    const added = [...after].filter((i) => !before.has(i)).length;
    const ratio = Math.abs(items.length - prev.items.length) / prev.items.length;
    console.log(`      前版 ${prev.items.length} → 本版 ${items.length}（新增 ${added}／移除 ${removed}，幅度 ${(ratio * 100).toFixed(2)}%）`);
    if (!allowAnyDelta && (ratio > MAX_DELTA_RATIO || removed > MAX_DELTA_REMOVED)) {
      die(`變動幅度超出門檻（±${MAX_DELTA_RATIO * 100}% 或移除 >${MAX_DELTA_REMOVED} 題），` +
          '不發布。確認無誤請加 --allow-any-delta');
    }
  } else {
    console.log('      無前版，視為首次建置');
  }

  console.log('[9/9] 寫出 pool.json 與 excluded.json');
  // meta 不含執行時間：否則來源未變仍會產生 diff，違反冪等（規格 B7）
  const payload = {
    meta: {
      schema: 1,
      source: 'TFDA 藥品外觀資料集 (opendata 42)',
      source_file: name,
      // 來源 ZIP 內含的資料產生日，非執行時間（SC-2，規格 plan.md:228）。
      // ZIP 沒有合法日期時寧可不寫欄位——寫個假值比缺欄位更糟，
      // 前端的 `if (m.source_version)` 本來就容許缺席
      ...(mtime ? { source_version: mtime } : {}),
      source_rows: rows.length,
      content_hash: 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex'),
      count: items.length,
      stages,
      // 去空白形式；判定時若答案鍵在此清單內則停用編輯距離容錯（規格 6.2）
      no_fuzzy: noFuzzy,
    },
    items,
  };
  // ── D49：excluded.json ──────────────────────────────────────────
  // 前端靠它把「未命中」分成「口服非固體」「題目品質不足」「不在資料集中」三類。
  // 沒有它，第 1／2 類與第 3 類**無法區分**，D37 只能退化成兩類。
  const excludedItems = [...excludedBy.entries()]
    .map(([id, stage]) => ({ id, stage }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));   // 排序後輸出才冪等
  const excludedPayload = {
    meta: {
      schema: 1,
      ...(mtime ? { source_version: mtime } : {}),
      // **配對識別以 content_hash 為準，不是日期**：同日重編日期不變而內容變了。
      // 這條規則本檔第 51 行的既有註解早就寫過，v5.1 的規格卻用 source_version，
      // 由 codex-checkplan 第二輪抓出來（判定 r2-2.4）
      content_hash: payload.meta.content_hash,
      count: excludedItems.length,
    },
    items: excludedItems,
  };

  // ── 成對驗證：**兩份都通過才寫，任一不成立則兩份都不寫** ──────────
  // 母集合刻意**不過濾空 id**（覆審發現 8）：原本兩邊都 `filter(Boolean)`，
  // 空 id 於是從 pool、excluded、srcIds 三個集合中同時消失，
  // `|pool| + |excluded| === |src|` 照樣成立——**完整性斷言看不見錯誤資料**。
  // 空 id 本來就會先被 checkPrefixTable 擋下，這裡是第二道且母集合定義一致。
  const srcIds = new Set(rows.map((r) => String(r['許可證字號'] ?? '').trim()));
  if (srcIds.has('')) die('來源含空的許可證字號，中止');
  const errs = validatePair(payload, excludedPayload, srcIds);
  if (errs.length) die(`成對驗證失敗（${errs.length} 項）：\n  - ${errs.join('\n  - ')}`);

  const exPath = path.resolve(path.dirname(outPath), 'excluded.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // **成對寫出**（覆審發現 4）：先各寫一份 `.tmp`，**兩份都寫成功才 rename**。
  // 原本是先寫 pool.json 再寫 excluded.json——第二次寫入失敗（磁碟滿、權限）
  // 會留下「新 pool ＋ 舊或缺失 excluded」的半更新工作樹，
  // 而錯誤訊息還印著「data/ 未變更」，那是不實的。
  //
  // 不採「在 workflow 用 $RUNNER_TEMP staging」的修法：`carryHashes()` 是從
  // `outPath` 讀前版的，建到 staging 就讀不到前版 → `src_sha256` 全成 null →
  // `fetch-images.py` 全量重抓 3,941 張圖。**那正是 SC-3 那個回歸**。
  // rename 的作法同時保護 CI 與本機 CLI，且完全不動 workflow 的接力鏈。
  const tmpPool = outPath + '.tmp';
  const tmpEx = exPath + '.tmp';
  try {
    fs.writeFileSync(tmpPool, JSON.stringify(payload, null, 1) + '\n', 'utf8');
    fs.writeFileSync(tmpEx, JSON.stringify(excludedPayload, null, 1) + '\n', 'utf8');
    fs.renameSync(tmpPool, outPath);
    fs.renameSync(tmpEx, exPath);
  } catch (e) {
    for (const t of [tmpPool, tmpEx]) { try { fs.unlinkSync(t); } catch { /* 已不存在 */ } }
    die(`寫出失敗，兩份產物均未更新：${e.message}`);
  }
  const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
  const exKb = (fs.statSync(exPath).size / 1024).toFixed(0);
  console.log(`      ${path.relative(ROOT, outPath)}  ${items.length.toLocaleString()} 題  ${kb} KB ✓`);
  console.log(`      ${path.relative(ROOT, exPath)}  ${excludedItems.length.toLocaleString()} 筆  ${exKb} KB ✓`);
  const byStage = {};
  for (const it of excludedItems) byStage[it.stage] = (byStage[it.stage] ?? 0) + 1;
  console.log(`      淘汰階段分布：${Object.entries(byStage).sort().map(([k, v]) => `${k} ${v}`).join('／')}`);
}

// 直接執行才跑管線。沒有這道 guard 的話，測試一 import 就會真的去下載 TFDA 來源——
// 純函式（dosDateToISO／carryHashes）因此完全測不到
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(`\n✖ ${e instanceof PipelineError ? e.message : e.stack}`);
    console.error('  data/ 未變更。');
    process.exit(1);
  });
}
