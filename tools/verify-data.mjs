#!/usr/bin/env node
/**
 * 資料完整性驗證 — 規劃文件 §7 B 組驗收條件
 *
 *   node tools/verify-data.mjs
 *
 * 這裡驗的是「資產真的屬於這一筆」，不只是「檔案存在」。
 * B4 只檢查路徑存在的話，slug 碰撞、錯誤 rename、seed 錯配都會全數通過。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
// 〔CR-3〕與 build-pool 共用同一條格式規則。各寫一份必然漂移，
// 而漂移的後果是「產生端認為合法、驗證端放行」的值悄悄留在 pool 裡
import { isSha256 } from './build-pool.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POOL = path.join(ROOT, 'data/pool.json');
const IMG_DIR = path.join(ROOT, 'data/img');

const MAX_EDGE = 640;
const BUDGET_BYTES = 200 * 1024 * 1024;

const fails = [];
const fail = (code, msg) => fails.push(`[${code}] ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

/**
 * WebP **容器結構**解析：RIFF 長度、WEBP 標記、第一個 chunk 的 header 與尺寸。
 *
 * 〔CR-2〕這裡刻意**不宣稱「可解碼」**。本函式從不觸碰壓縮位元流，
 * 「header 合法但位元流損毀」的檔案會全數通過。真正的解碼證據來自
 * `tools/fetch-images.py` 的 `verify_asset()`（Pillow 完整 decode）——
 * 新寫出的每一張都驗，`--verify-all` 的季度全跑再對既有檔案驗一次。
 *
 * 這道檢查仍有價值：它抓截斷與尺寸違約，而且不需要 Python 執行環境。
 */
function readWebp(buf) {
  if (buf.length < 30) throw new Error('檔案過小');
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('非 RIFF 容器');
  if (buf.toString('ascii', 8, 12) !== 'WEBP') throw new Error('非 WEBP');
  const riffSize = buf.readUInt32LE(4);
  if (riffSize + 8 !== buf.length) throw new Error(`RIFF 長度不符（宣告 ${riffSize + 8}，實際 ${buf.length}）— 檔案可能截斷`);

  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    if (buf.readUIntLE(23, 3) !== 0x2a019d) throw new Error('VP8 sync code 錯誤');
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) throw new Error('VP8L signature 錯誤');
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
  }
  throw new Error(`未知 chunk ${JSON.stringify(chunk)}`);
}

const assetKey = (id) => crypto.createHash('sha1').update(id, 'utf8').digest('hex').slice(0, 16);

function main() {
  if (!fs.existsSync(POOL)) {
    console.error('✖ 找不到 data/pool.json，請先執行 npm run build:pool');
    process.exit(1);
  }
  const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
  const items = pool.items;
  console.log(`驗證 ${items.length.toLocaleString()} 筆\n`);

  // ── meta 一致性 ───────────────────────────────────────────────────
  if (pool.meta.count !== items.length) {
    fail('META', `meta.count=${pool.meta.count} 與實際 ${items.length} 不符`);
  } else ok(`meta.count 與項目數一致（${items.length}）`);

  // meta 不得含執行時間，否則來源未變仍會產生 diff（規格 B7 冪等）
  const timeish = Object.keys(pool.meta).filter((k) => /time|date|generated|updated_at/i.test(k));
  if (timeish.length) fail('B7', `meta 含執行時間欄位，會破壞冪等：${timeish.join(', ')}`);
  else ok('meta 不含執行時間（冪等）');

  // 〔SC-2〕source_version 來自 ZIP 中央目錄的 DOS 日期，是來源端的資料產生日。
  // 這條只擋**格式漂移**：擋不住「有人改拿執行日填進去」——那靠的是 build-pool
  // 只從 ZIP 位元組取值這個結構性保證（見 dosDateToISO 的註解）。
  // 缺欄位不擋：ZIP 沒有合法日期時 build-pool 刻意不寫，而版本字串只影響顯示，
  // 為了一個顯示欄位擋掉整批資料更新不成比例（結構災難硬擋、格式漂移放行）
  if (!('source_version' in pool.meta)) {
    console.log('  · meta 無 source_version，C6 的資料版本不顯示'
      + '（pool 由 SC-2 之前的管線建置，或來源 ZIP 未帶合法日期——重跑 build:pool 可分辨）');
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(pool.meta.source_version)) {
    fail('C6', `meta.source_version 格式應為 YYYY-MM-DD，實得 ${JSON.stringify(pool.meta.source_version)}`);
  } else ok(`meta.source_version = ${pool.meta.source_version}（來源 ZIP 的資料產生日）`);

  // ── B4：資產鍵唯一且可證明由該筆產生 ──────────────────────────────
  const seen = new Map();
  let keyMismatch = 0;
  for (const it of items) {
    if (seen.has(it.img)) {
      fail('B4', `資產碰撞：${seen.get(it.img)} 與 ${it.id} 皆指向 ${it.img}`);
    }
    seen.set(it.img, it.id);
    if (it.img !== `img/${assetKey(it.id)}.webp`) {
      keyMismatch++;
      if (keyMismatch <= 5) fail('B6', `資產鍵與許可證字號不對應：${it.id} → ${it.img}`);
    }
  }
  if (seen.size === items.length) ok(`資產鍵唯一（${seen.size}/${items.length}）`);
  if (!keyMismatch) ok('每筆資產鍵皆可由其許可證字號重算得出（一對一）');
  else fail('B6', `共 ${keyMismatch} 筆資產鍵與許可證字號不對應`);

  // ── B5：資產容器結構合法且符合輸出契約 ────────────────────────────
  let missing = 0, bad = 0, oversize = 0, total = 0;
  const noHash = [];
  for (const it of items) {
    const p = path.join(ROOT, 'data', it.img);
    if (!fs.existsSync(p)) { missing++; continue; }
    const buf = fs.readFileSync(p);
    total += buf.length;
    if (buf.length === 0) { bad++; fail('B5', `${it.img} 為零位元組`); continue; }
    try {
      const { w, h } = readWebp(buf);
      if (Math.max(w, h) > MAX_EDGE) {
        oversize++;
        if (oversize <= 5) fail('B5', `${it.img} 尺寸 ${w}×${h} 超過長邊上限 ${MAX_EDGE}`);
      }
    } catch (e) {
      bad++;
      if (bad <= 5) fail('B5', `${it.img} 容器結構不合法：${e.message}`);
    }
    // 〔CR-3〕不只判斷有值：格式不合法的雜湊同樣證明不了來源對應
    if (!isSha256(it.src_sha256)) noHash.push(it.id);
  }
  if (missing) fail('B5', `${missing} 筆資產不存在（請執行 npm run fetch:images）`);
  else ok(`全部 ${items.length.toLocaleString()} 張資產存在`);
  // 〔CR-2〕原文是「全部資產可解碼且為合法 WebP」——宣稱強於證據。
  // 這裡只讀 header，沒碰壓縮位元流，「可解碼」由 fetch-images.py 的 verify_asset() 負責
  if (!bad && !missing) ok('全部資產的 WebP 容器結構合法（未解壓位元流，解碼由 fetch-images 驗）');
  if (!oversize && !missing) ok(`全部資產長邊 ≤${MAX_EDGE}px`);

  if (noHash.length) fail('B6', `${noHash.length} 筆的 src_sha256 缺漏或非 64 碼小寫十六進位`
    + `（無法證明來源對應）：${noHash.slice(0, 3).join(', ')}…`);
  else if (!missing) ok('全部項目具格式合法的來源雜湊');

  // ── B9：孤兒資產與容量預算 ────────────────────────────────────────
  if (fs.existsSync(IMG_DIR)) {
    const onDisk = fs.readdirSync(IMG_DIR).filter((f) => f.endsWith('.webp'));
    const referenced = new Set(items.map((i) => path.basename(i.img)));
    const orphans = onDisk.filter((f) => !referenced.has(f));
    if (orphans.length) fail('B9', `${orphans.length} 個孤兒資產未被任何題目引用：${orphans.slice(0, 3).join(', ')}…`);
    else ok('無孤兒資產');

    const mb = (total / 1024 / 1024).toFixed(1);
    if (total > BUDGET_BYTES) fail('B9', `資產總量 ${mb} MB 超出 200MB 預算`);
    else ok(`資產總量 ${mb} MB（預算 200MB）`);
  }

  // ── 結果 ──────────────────────────────────────────────────────────
  console.log('');
  if (fails.length) {
    console.error(`✖ ${fails.length} 項驗證失敗：`);
    for (const f of fails.slice(0, 30)) console.error(`   ${f}`);
    if (fails.length > 30) console.error(`   …另有 ${fails.length - 30} 項`);
    process.exit(1);
  }
  console.log('✓ 全部通過');
}

main();
