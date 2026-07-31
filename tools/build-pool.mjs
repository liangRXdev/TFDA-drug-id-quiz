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
import { fileURLToPath } from 'node:url';
import { normalize, squash, editDistance, FUZZY_MIN_LEN } from '../engine.js';

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

    entries.push({ name, content });
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
    if (REQUIRED_FIELDS.every((f) => keys.includes(f))) candidates.push({ name: e.name, rows: parsed });
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

  let cur = rows.filter((r) => splitMulti(r['形狀']).some((s) => SOLID_SHAPES.has(s)));
  stages['Q1 固體口服'] = cur.length;

  cur = cur.filter((r) => String(r['外觀圖檔連結'] ?? '').trim());
  stages['Q2 有圖檔'] = cur.length;

  const withKey = cur.map((r) => ({ r, ans: normalize(r['英文品名']) }));
  cur = withKey.filter((x) => squash(x.ans).length >= 3);
  stages['Q3 答案鍵 ≥3'] = cur.length;

  cur = cur.filter((x) => String(x.r['標註一'] ?? '').trim());
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
    if (new Set(members.map((m) => m.ans)).size > 1) { ambiguousGroups++; continue; }
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

  return { items, stages, ambiguousGroups };
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
  const outPath = path.join(ROOT, arg('--out') || 'data/pool.json');
  const allowAnyDelta = argv.includes('--allow-any-delta');

  const buf = await fetchSource(arg('--source'));
  console.log(`[2/8] 取得 ${buf.length.toLocaleString()} bytes，驗證 ZIP 結構`);
  const entries = readZipEntries(buf);

  console.log(`[3/8] ZIP 內 ${entries.length} 個檔案，依 schema 辨識資料檔`);
  const { name, rows } = pickDataFile(entries);
  console.log(`      → ${name}（${rows.length.toLocaleString()} 筆）`);

  if (rows.length < MIN_SOURCE_ROWS) die(`來源僅 ${rows.length} 筆，低於下限 ${MIN_SOURCE_ROWS}，中止`);
  const missing = REQUIRED_FIELDS.filter((f) => !(f in rows[0]));
  if (missing.length) die(`來源缺欄位：${missing.join(', ')}`);

  console.log('[4/8] 套用資格條件 Q1–Q5');
  const { items, stages, ambiguousGroups } = buildPool(rows);
  for (const [k, v] of Object.entries(stages)) console.log(`      ${k.padEnd(16)} ${v.toLocaleString()}`);
  console.log(`      （Q5 排除 ${ambiguousGroups} 個外觀不可區分群組）`);

  console.log('[5/8] 計算容錯停用清單');
  const noFuzzy = computeNoFuzzy(items);
  console.log(`      ${noFuzzy.length} 個答案鍵停用容錯（與他鍵編輯距離 ≤1，開容錯會誤判為對）`);

  console.log('[6/8] 斷言資產鍵唯一');
  const keys = new Map();
  for (const it of items) {
    const k = it.img;
    if (keys.has(k)) die(`資產鍵碰撞：${keys.get(k)} 與 ${it.id} 皆映射到 ${k}`);
    keys.set(k, it.id);
  }
  console.log(`      ${keys.size.toLocaleString()} / ${items.length.toLocaleString()} 唯一 ✓`);

  console.log('[7/8] 比對變動幅度');
  let prev = null;
  if (fs.existsSync(outPath)) {
    try { prev = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { /* 損毀視同無前版 */ }
  }
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

  console.log('[8/8] 寫出');
  // meta 不含執行時間：否則來源未變仍會產生 diff，違反冪等（規格 B7）
  const payload = {
    meta: {
      schema: 1,
      source: 'TFDA 藥品外觀資料集 (opendata 42)',
      source_file: name,
      source_rows: rows.length,
      content_hash: 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex'),
      count: items.length,
      stages,
      // 去空白形式；判定時若答案鍵在此清單內則停用編輯距離容錯（規格 6.2）
      no_fuzzy: noFuzzy,
    },
    items,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 1) + '\n', 'utf8');
  const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`      ${path.relative(ROOT, outPath)}  ${items.length.toLocaleString()} 題  ${kb} KB ✓`);
}

main().catch((e) => {
  console.error(`\n✖ ${e instanceof PipelineError ? e.message : e.stack}`);
  console.error('  data/ 未變更。');
  process.exit(1);
});
