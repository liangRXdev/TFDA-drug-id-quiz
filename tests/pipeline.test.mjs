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
import path from 'node:path';
import { ROOT } from './_ui-harness.mjs';
import { dosDateToISO, carryHashes } from '../tools/build-pool.mjs';

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

// ══ 管線腳本可被 import（前提條件）═══════════════════════════════════

describe('build-pool 的純函式可在不觸發下載的情況下 import', () => {
  test('module-main guard 存在', () => {
    // 沒有這道 guard 的話，上面每一條測試在 import 當下就會真的去下載 TFDA 來源，
    // CI 會因為外部網路而隨機紅，而且 data/ 可能被改寫
    const src = fs.readFileSync(path.join(ROOT, 'tools/build-pool.mjs'), 'utf8');
    assert.match(src, /import\.meta\.url/, 'main() 必須以 module-main guard 包住');
    assert.doesNotMatch(src, /^main\(\)\.catch/m, 'main() 仍在模組層無條件執行');
  });
});
