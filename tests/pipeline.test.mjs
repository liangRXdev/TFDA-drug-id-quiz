/**
 * 資料管線 — 依 .ai-review/verdict-v4a.md 的 SC-2／SC-3／CR-2 補測
 *
 *   node --test
 *
 * 這三項都是**「規格宣稱做到、實際沒做到」**：
 *   SC-2  meta.source_version 從未產生，前端 `if (m.source_version)` 永遠不成立
 *   SC-3  src_sha256 對每一筆寫死 null，D10 的增量判定形同未實作
 *   CR-2  verify-data.mjs 只讀 header 卻宣稱「可解碼」
 *
 * 管線的整體行為要真的下載 TFDA 來源才驗得到，這裡驗的是**抽出來的純函式**
 * 與**腳本原始碼的靜態契約**——後者證據強度較低，理由與 engagement.test.mjs
 * 檔頭同一條（不做假斷言，寧可誠實標明證據層級）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from './_ui-harness.mjs';
import { dosDateToISO, carryHashes, isSha256 } from '../tools/build-pool.mjs';

// ══ SC-2 來源版本 ═════════════════════════════════════════════════════

describe('SC-2 dosDateToISO：來源 ZIP 的資料產生日', () => {
  /** DOS 日期字：(年-1980)<<9 | 月<<5 | 日 */
  const word = (y, m, d) => (((y - 1980) & 0x7f) << 9) | ((m & 0xf) << 5) | (d & 0x1f);

  test('實測值：TFDA 的 42_5.json 標 2026-08-03', () => {
    // 這個字是 2026-08-06 實際下載 opendata 42 時，ZIP 中央目錄 off+14 的值。
    // 比下載時間早 3 天 —— 這正是「不是執行時間」的證據，也是能放進 meta 的理由
    assert.equal(dosDateToISO(0x5D03), '2026-08-03');
    assert.equal(dosDateToISO(word(2026, 8, 3)), '2026-08-03');
  });

  test('月與日補零，不得輸出 2026-8-3', () => {
    // 〔堵〕少了 padStart 仍是「合法日期字串」，但 C6 顯示與格式契約都會漂移
    assert.equal(dosDateToISO(word(2026, 1, 5)), '2026-01-05');
    assert.match(dosDateToISO(word(1999, 12, 31)), /^\d{4}-\d{2}-\d{2}$/);
  });

  test('DOS 紀元下界 1980 與上界 2107', () => {
    assert.equal(dosDateToISO(word(1980, 1, 1)), '1980-01-01');
    assert.equal(dosDateToISO(word(2107, 12, 31)), '2107-12-31');
  });

  test('不合法的月／日回 null，不得硬湊出字串', () => {
    // 〔堵〕不檢查就會產出 2026-00-00 這種值，而 build-pool 只在有值時才寫欄位——
    //       回 null 才會走到「不寫 source_version」那條路
    assert.equal(dosDateToISO(0), null, '全零（欄位未填）必須回 null');
    assert.equal(dosDateToISO(word(2026, 0, 15)), null, '月 = 0');
    assert.equal(dosDateToISO(word(2026, 13, 1)), null, '月 = 13');
    assert.equal(dosDateToISO(word(2026, 8, 0)), null, '日 = 0');
  });

  test('〔CR-2〕曆法上不存在的日回 null，不得只做 range check', () => {
    // 〔堵〕`m<=12 && d<=31` 放行 2026-02-31、2026-04-31、非閏年的 2-29，
    //       三者都會輸出「看起來合法」的 YYYY-MM-DD。
    //       build-pool 自己的註解寫著「寫假值比缺欄位更糟」——只驗範圍就是在寫假值
    assert.equal(dosDateToISO(word(2026, 2, 31)), null, '2 月沒有 31 日');
    assert.equal(dosDateToISO(word(2026, 4, 31)), null, '4 月沒有 31 日');
    assert.equal(dosDateToISO(word(2025, 2, 29)), null, '2025 非閏年，沒有 2-29');
    assert.equal(dosDateToISO(word(2026, 6, 31)), null, '6 月沒有 31 日');
  });

  test('〔CR-2〕合法的閏日與月底仍須通過，不得矯枉過正', () => {
    assert.equal(dosDateToISO(word(2024, 2, 29)), '2024-02-29', '2024 是閏年');
    assert.equal(dosDateToISO(word(2000, 2, 29)), '2000-02-29', '整百閏年規則');
    assert.equal(dosDateToISO(word(2026, 1, 31)), '2026-01-31');
    assert.equal(dosDateToISO(word(2026, 4, 30)), '2026-04-30');
  });
});

// ══ SC-3 增量判定 ═════════════════════════════════════════════════════

describe('SC-3 carryHashes：D10 的增量判定', () => {
  const item = (id, src, sha = null) => ({ id, src, src_sha256: sha });
  const H1 = 'a'.repeat(64);
  const H2 = 'b'.repeat(64);

  test('id 與 URL 都未變 → 沿用前版雜湊', () => {
    const items = [item('A', 'http://x/1.jpg')];
    const n = carryHashes(items, [item('A', 'http://x/1.jpg', H1)]);
    assert.equal(n, 1);
    assert.equal(items[0].src_sha256, H1, '未沿用 → fetch-images 會重抓這一筆');
  });

  test('URL 變了 → 不得沿用（否則 TFDA 換圖後新圖永遠抓不進來）', () => {
    // 〔堵〕只比對 id 就沿用。URL 是換圖時唯一看得見的訊號，
    //       沿用舊雜湊會讓 fetch-images 的 predicate 直接跳過這一筆
    const items = [item('A', 'http://x/NEW.jpg')];
    const n = carryHashes(items, [item('A', 'http://x/OLD.jpg', H1)]);
    assert.equal(n, 0);
    assert.equal(items[0].src_sha256, null);
  });

  test('新項目（前版沒有這個 id）→ 留 null，落入待抓', () => {
    const items = [item('NEW', 'http://x/1.jpg')];
    assert.equal(carryHashes(items, [item('A', 'http://x/1.jpg', H1)]), 0);
    assert.equal(items[0].src_sha256, null);
  });

  test('前版該筆自己就沒有雜湊 → 不算沿用，計數不得灌水', () => {
    // 〔堵〕`it.src_sha256 = p.src_sha256` 無條件執行時，null 覆蓋 null 看起來沒事，
    //       但 carried 計數會虛報，log 上的「待抓 N」就不再可信
    const items = [item('A', 'http://x/1.jpg')];
    assert.equal(carryHashes(items, [item('A', 'http://x/1.jpg', null)]), 0);
  });

  test('無前版（首次建置）→ 全部留 null，不得爆炸', () => {
    const items = [item('A', 'http://x/1.jpg'), item('B', 'http://x/2.jpg')];
    assert.equal(carryHashes(items, undefined), 0);
    assert.equal(carryHashes(items, null), 0);
    assert.equal(carryHashes(items, []), 0);
    assert.deepEqual(items.map((i) => i.src_sha256), [null, null]);
  });

  test('混合情境：只有真正變動的項目落入待抓', () => {
    const items = [
      item('keep', 'http://x/1.jpg'),      // 未變 → 沿用
      item('moved', 'http://x/NEW.jpg'),   // URL 變 → 待抓
      item('fresh', 'http://x/3.jpg'),     // 新增 → 待抓
    ];
    const n = carryHashes(items, [
      item('keep', 'http://x/1.jpg', H1),
      item('moved', 'http://x/OLD.jpg', H2),
      item('gone', 'http://x/9.jpg', H1),
    ]);
    assert.equal(n, 1, `3,913 筆全部重抓正是 SC-3 的病徵，待抓數必須真的收斂`);
    assert.deepEqual(items.map((i) => i.src_sha256), [H1, null, null]);
  });

  test('〔CR-3〕格式不合法的舊雜湊不得沿用', () => {
    // 〔堵〕只判斷 truthy 的話，損毀的值會被原封不動沿用，
    //       fetch-images 的 todo predicate 也放行 → 這一筆**永久**避開一般排程
    for (const bad of ['corrupt', H1.slice(0, 63), H1.toUpperCase(), 'undefined', H1 + 'a', 0, {}]) {
      const items = [item('A', 'http://x/1.jpg')];
      const n = carryHashes(items, [{ id: 'A', src: 'http://x/1.jpg', src_sha256: bad }]);
      assert.equal(n, 0, `不合法雜湊 ${JSON.stringify(bad)} 被沿用了`);
      assert.equal(items[0].src_sha256, null, `不合法雜湊 ${JSON.stringify(bad)} 進了產物`);
    }
  });
});

describe('CR-3 isSha256：三處共用的格式判定', () => {
  test('只接受 64 碼小寫十六進位', () => {
    assert.equal(isSha256('a'.repeat(64)), true);
    assert.equal(isSha256('0123456789abcdef'.repeat(4)), true);
  });

  test('長度、大小寫、型別、空白一律不接受', () => {
    for (const bad of [
      'A'.repeat(64),               // 大寫：Python 端產生的一律小寫，大寫代表另一個來源
      'a'.repeat(63), 'a'.repeat(65),
      ' ' + 'a'.repeat(64), 'a'.repeat(64) + '\n',
      'g'.repeat(64),               // 非十六進位
      '', null, undefined, 0, 123, {}, ['a'.repeat(64)],
    ]) {
      assert.equal(isSha256(bad), false, `${JSON.stringify(bad)} 不該被視為合法雜湊`);
    }
  });

  test('Python 端 is_sha256 用同一條 regex（跨語言一致性）', () => {
    // 〔堵〕兩邊各寫一份必然漂移，而漂移的後果是
    //       「Node 端認為要重抓、Python 端認為已完成」這種永遠對不起來的狀態
    const py = fs.readFileSync(path.join(ROOT, 'tools/fetch-images.py'), 'utf8');
    assert.match(py, /_SHA256_RE\s*=\s*re\.compile\(r"\^\[0-9a-f\]\{64\}\$"\)/,
      'fetch-images.py 的格式規則與 build-pool 的 isSha256 不一致');
    assert.match(py, /def is_sha256\(/, 'fetch-images.py 缺少 is_sha256()');
    // todo predicate 與 process() 的早退條件都必須走這條規則，不得只判斷有值
    assert.doesNotMatch(py, /or not i\.get\("src_sha256"\)\]/,
      'todo predicate 仍在只判斷 truthy');
    assert.doesNotMatch(py, /dest\.exists\(\) and item\.get\("src_sha256"\) and/,
      'process() 的早退仍在只判斷 truthy');
  });
});

// ══ CR-2 解碼驗證的責任歸屬（靜態契約）═══════════════════════════════

describe('CR-2 「可解碼」的宣稱必須有對應的證據', () => {
  const FETCH = fs.readFileSync(path.join(ROOT, 'tools/fetch-images.py'), 'utf8');
  const VERIFY = fs.readFileSync(path.join(ROOT, 'tools/verify-data.mjs'), 'utf8');

  /** 取出某個 def 的整段。行尾用 `\r?\n`——這個檔是 CRLF，寫死 `\n\n` 會抽出空字串而恆過 */
  const defBody = (src, name) => {
    const m = new RegExp(`def ${name}\\([\\s\\S]*?(?=\\r?\\ndef |\\r?\\nif __name__)`).exec(src);
    assert.ok(m, `找不到 def ${name}(`);
    return m[0];
  };

  test('fetch-images 對落地後的檔案做完整 Pillow 解碼', () => {
    // to_webp() 的 im.load() 驗的是**來源原圖**，證明不了寫出去的那份完好
    assert.match(FETCH, /def verify_asset\(/, '缺少落地後的解碼驗證');
    const body = defBody(FETCH, 'verify_asset');
    assert.match(body, /Image\.open\(dest\)/, 'verify_asset 必須開啟落地檔而非來源位元組');
    assert.match(body, /\.load\(\)/, '沒有 load() 就只是讀 header，等於沒驗');
  });

  test('寫檔後與 --verify-all 兩條路徑都呼叫得到 verify_asset', () => {
    // 〔堵〕只在新寫出時驗 → 季度全驗對「內容未變」的檔案提早 return，一張都沒驗到
    const proc = defBody(FETCH, 'process');
    const calls = proc.match(/verify_asset\(dest\)/g) ?? [];
    assert.ok(calls.length >= 2,
      `process() 內只有 ${calls.length} 處 verify_asset —— 寫檔後與 verify_all 提早返回前都要驗`);
    assert.match(proc, /if verify_all:\s*\n\s*verify_asset\(dest\)/,
      '內容未變的早退路徑沒有在 --verify-all 時解碼');
  });

  test('verify-data 不得再宣稱「可解碼」', () => {
    // 〔堵〕這是本輪的核心——它從不觸碰壓縮位元流，
    //       「header 合法但位元流損毀」的檔案會全數通過
    const okLines = [...VERIFY.matchAll(/ok\(`?'?([^`']*可解碼[^`']*)/g)].map((m) => m[1]);
    assert.deepEqual(okLines, [], `verify-data 仍在宣稱可解碼：${okLines.join(' / ')}`);
    assert.match(VERIFY, /容器結構/, '應改用「容器結構合法」這類與證據相稱的措辭');
  });
});

// ══ TG-1 產物端到端：欄位真的進到 pool.json ══════════════════════════

/**
 * 手組最小 ZIP（stored，method 0）。不引入 npm 依賴，理由與 build-pool
 * 自己寫最小 ZIP 讀取器相同。
 *
 * 〔TG-1〕上面每一條都只測純函式——`pickDataFile()` 漏回傳 `mtime`、
 * payload 漏寫 `source_version`，兩種錯誤實作都能讓它們全綠。
 * **修一個「功能靜默不存在」的缺口時，最該補的測試就是「它現在真的存在」。**
 */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, content, dateWord } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(content);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);      // 本地檔頭簽章
    lh.writeUInt16LE(20, 4);              // version needed
    lh.writeUInt16LE(0, 8);               // method 0 = stored
    lh.writeUInt16LE(dateWord, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(content.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, content);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // 中央目錄簽章
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 10);              // method
    cd.writeUInt16LE(dateWord, 14);       // ← build-pool 讀的就是這個欄位
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(content.length, 20);
    cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);         // 本地檔頭位移
    centrals.push(cd, nameBuf);

    offset += 30 + nameBuf.length + content.length;
  }
  const localPart = Buffer.concat(locals);
  const cdPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, cdPart, eocd]);
}

/** DOS 日期字：(年-1980)<<9 | 月<<5 | 日 */
const dosWord = (y, m, d) => (((y - 1980) & 0x7f) << 9) | ((m & 0xf) << 5) | (d & 0x1f);

/**
 * 產生一份能通過 build-pool 全部驗收的來源列。
 *
 * 絕大多數列刻意在 Q1（固體口服）就被濾掉：`source_rows` 要過 5,000 筆下限，
 * 而入選題數必須維持在個位數——`computeNoFuzzy()` 對同長度答案鍵是 O(n²)，
 * 餵 5,000 題會讓這條測試從毫秒級變成分鐘級。
 */
function sourceRows({ keep = 6, filler = 5200 } = {}) {
  const rows = [];
  for (let i = 0; i < filler; i++) {
    rows.push({
      許可證字號: `衛部藥輸字第F${String(i).padStart(5, '0')}號`,
      英文品名: `FILLER INJECTION ${i}`,
      外觀圖檔連結: `https://example.invalid/f${i}.jpg`,
      形狀: '注射劑',                  // ← Q1 濾掉
      顏色: '無色', 刻痕: '無', 標註一: `F${i}`,
    });
  }
  const NAMES = ['ALFATIN', 'BRAVOZOL', 'CHARLIDINE', 'DELTAMOX', 'ECHOPRIL', 'FOXTROLOL'];
  for (let i = 0; i < keep; i++) {
    rows.push({
      許可證字號: `衛部藥製字第K${String(i).padStart(5, '0')}號`,
      英文品名: `${NAMES[i % NAMES.length]} TABLETS ${i} MG`,
      中文品名: `測試錠 ${i}`,
      外觀圖檔連結: `https://example.invalid/k${i}.jpg`,
      形狀: '圓形', 顏色: '白色', 刻痕: '無',
      標註一: `KEEP${i}`, 標註二: '', 外觀尺寸: `${8 + i}mm`,
    });
  }
  return rows;
}

/** 實跑 build-pool.mjs 到暫存輸出，回傳 stdout 與產物 */
function runBuildPool(zip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idquiz-pool-'));
  try {
    const zipPath = path.join(dir, 'source.zip');
    const outPath = path.join(dir, 'pool.json');
    fs.writeFileSync(zipPath, zip);
    const stdout = execFileSync(process.execPath,
      ['tools/build-pool.mjs', '--source', zipPath, '--out', outPath],
      { cwd: ROOT, encoding: 'utf8' });
    return { stdout, pool: JSON.parse(fs.readFileSync(outPath, 'utf8')) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('TG-1 source_version 真的寫進產物（端到端）', () => {
  const dataFile = (rows) => Buffer.from(JSON.stringify(rows), 'utf8');
  /** 不符 schema 的誘餌，且日期刻意不同——用來證明取的是**資料檔**的日期 */
  const decoy = {
    name: 'readme.json',
    content: Buffer.from(JSON.stringify([{ 說明: '這不是資料檔' }]), 'utf8'),
    dateWord: dosWord(2001, 1, 1),
  };

  test('ZIP 中央目錄的日期一路走到 meta.source_version', () => {
    const { stdout, pool } = runBuildPool(makeZip([
      decoy,
      { name: '42_5.json', content: dataFile(sourceRows()), dateWord: dosWord(2026, 8, 3) },
    ]));
    assert.equal(pool.meta.source_version, '2026-08-03',
      'C6 的資料版本仍未進到產物——這正是 SC-2 原本的病徵');
    assert.equal(pool.meta.source_file, '42_5.json', '依 schema 選檔，不得挑到誘餌');
    assert.match(stdout, /資料版本 2026-08-03/, '建置 log 也應印出資料版本');
    // 前端的判斷是 `if (m.source_version)`——這裡驗的就是那個條件會成立
    assert.ok(pool.meta.source_version, '前端的 if (m.source_version) 仍不成立');
  });

  test('ZIP 無合法日期時不寫欄位，不得填 null 或 "undefined"', () => {
    // 〔堵〕`source_version: mtime` 無條件寫入時，缺日期就變成 null——
    //       前端 `if (m.source_version)` 雖然仍不成立，但 verify-data 的
    //       格式檢查會把 null 判成 C6 失敗，整批資料更新被一個顯示欄位擋掉
    const { pool } = runBuildPool(makeZip([
      { name: '42_5.json', content: dataFile(sourceRows()), dateWord: 0 },
    ]));
    assert.equal('source_version' in pool.meta, false,
      `無合法日期時不得寫出 source_version（實得 ${JSON.stringify(pool.meta.source_version)}）`);
  });

  test('meta 仍不得含執行時間（B7 冪等）', () => {
    // 同一份來源建兩次，產物必須位元相同
    const zip = makeZip([
      { name: '42_5.json', content: dataFile(sourceRows()), dateWord: dosWord(2026, 8, 3) },
    ]);
    const a = runBuildPool(zip).pool;
    const b = runBuildPool(zip).pool;
    assert.deepEqual(a, b, '同一份來源建出不同產物 → meta 含執行時間或有其他非決定性');
    const timeish = Object.keys(a.meta).filter((k) => /time|generated|updated_at/i.test(k));
    assert.deepEqual(timeish, [], `meta 含執行時間欄位：${timeish.join(', ')}`);
  });
});

// ══ 管線腳本可被 import（前提條件）═══════════════════════════════════

describe('build-pool 的純函式可在不觸發下載的情況下 import', () => {
  test('module-main guard 存在（靜態）', () => {
    // 沒有這道 guard 的話，上面每一條測試在 import 當下就會真的去下載 TFDA 來源，
    // CI 會因為外部網路而隨機紅，而且 data/ 可能被改寫
    const src = fs.readFileSync(path.join(ROOT, 'tools/build-pool.mjs'), 'utf8');
    assert.match(src, /import\.meta\.url/, 'main() 必須以 module-main guard 包住');
    assert.doesNotMatch(src, /^main\(\)\.catch/m, 'main() 仍在模組層無條件執行');
  });

  test('〔TG-4〕import 不觸發 main()：子行程實跑', () => {
    // 〔堵〕上面那條只驗字樣。`if (true) main(); void import.meta.url;` 照樣全綠。
    //       這裡真的起子行程 import；main() 若跑起來會印出 `[1/8] 下載 …`
    //       並真的去打 TFDA，兩種情況都看得見
    const url = pathToFileURL(path.join(ROOT, 'tools/build-pool.mjs')).href;
    const out = execFileSync(process.execPath,
      ['--input-type=module', '-e',
        `const m = await import(${JSON.stringify(url)});`
        + `console.log('IMPORTED_CLEAN', typeof m.dosDateToISO, typeof m.isSha256);`],
      { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    assert.match(out, /IMPORTED_CLEAN function function/, 'import 未正常返回具名匯出');
    assert.doesNotMatch(out, /\[1\/8\]/, 'import 觸發了 main()，管線真的跑起來了');
  });

  test('〔TG-4〕四種呼叫方式都必須進 main()（guard 不得反向失效）', () => {
    // 〔堵〕guard 條件寫錯（例如與 undefined 比對）會讓直接執行變成
    //       「什麼都不做、退出碼 0」——排程從此靜默空轉，而 import 那條完全看不出來。
    //       `process.argv[1]` 的形式因呼叫方式而異，這正是 guard 唯一的輸入。
    //       npm script 就是 `node tools/build-pool.mjs`（cwd 為 ROOT），與第一案同形
    const abs = path.join(ROOT, 'tools/build-pool.mjs');
    const specs = [
      ['相對路徑（= npm run build:pool）', 'tools/build-pool.mjs'],
      ['帶 ./ 的相對路徑', './tools/build-pool.mjs'],
      ['絕對路徑', abs],
      ['平台原生分隔符', abs.split(path.sep).join(path.sep)],
    ];
    for (const [label, spec] of specs) {
      try {
        execFileSync(process.execPath, [spec, '--source', 'no-such-file.zip'],
          { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
        assert.fail(`${label}：來源不存在卻退出碼 0 —— main() 沒被執行到`);
      } catch (e) {
        assert.equal(e.status, 1, `${label}：預期退出碼 1，實得 ${e.status}`);
        assert.match(String(e.stdout ?? '') + String(e.stderr ?? ''), /ENOENT|本機來源/,
          `${label}：main() 未進入取得來源那一步`);
      }
    }
  });
});
