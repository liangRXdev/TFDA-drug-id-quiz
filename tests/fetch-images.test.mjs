/**
 * fetch-images.py 的行為驗收 — 依 .ai-review/verdict-v4b.md 的 TG-2／TG-3 補測
 *
 *   node --test tests/fetch-images.test.mjs
 *
 * 實際的斷言在 `tests/fetch_images_probe.py`（要真的 Pillow 才驗得到解碼），
 * 這裡負責把它接進 `npm test`，並確保**沒有任何一項被靜默拿掉**。
 *
 * 需要 uv（與 `npm run fetch:images` 同一個前提，CI 由 setup-uv 提供）。
 * 缺 uv 時**直接 fail 而不是 skip**：這個 repo 反覆踩到的形態就是
 * 「功能靜默不存在」，靜默跳過的測試是同一件事的另一個面貌。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './_ui-harness.mjs';

/** 探針必須涵蓋的項目。少一項就是有人把測試拿掉了，不是「剛好沒跑到」 */
const REQUIRED_CASES = [
  'needs_fetch 檔在且雜湊合法 → 跳過',
  'needs_fetch 缺檔 → 重抓',
  'needs_fetch 無雜湊',
  'needs_fetch 雜湊格式不合法',
  'needs_fetch --verify-all → 一律重抓',
  'process 一般模式：檔在且雜湊合法 → 不下載',
  'process --verify-all：重新下載且對既有檔案解碼',
  'process 一般模式：偵測不到原地換圖',
  'process --verify-all 且雜湊不符 → 重寫並解碼驗證',
  'process 缺檔 → 下載並寫出，且解碼驗證',
  'process 下載失敗 → 回報錯誤',
  'verify_asset 合法 WebP → 通過',
  '損毀檔的容器結構仍然合法',
  'verify_asset 位元流損毀 → 拋出',
  'CR-1 容量檢查排在 pool.json 回寫之前',
];

const run = (args, opts = {}) => execFileSync(args[0], args.slice(1),
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000, ...opts });

/**
 * 解析 uv 執行檔的路徑。
 *
 * 直接 spawn `uv` 在乾淨的環境可行（CI 就是），但實測本機的 PATH 有一筆
 * 帶前導空白的項目，而 Windows 的 CreateProcess **不會 trim**——
 * 於是 shell 找得到、Node 找不到。測試不該因為使用者 PATH 有雜訊而假紅，
 * 所以留一條自行掃描 PATH 的後路。
 */
function resolveUv() {
  const exes = process.platform === 'win32' ? ['uv.exe', 'uv.cmd'] : ['uv'];
  const candidates = ['uv'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const d = dir.trim();
    if (!d) continue;
    for (const exe of exes) {
      const p = path.join(d, exe);
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch { /* 換下一個 */ }
  }
  return null;
}

describe('TG-2／TG-3 fetch-images.py 的行為驗收（Python 探針）', () => {
  let output = '';

  before(() => {
    const uv = resolveUv();
    assert.ok(uv, '找不到 uv——`npm test` 與 `npm run fetch:images` 同樣需要它。'
      + '安裝方式見 README；CI 由 astral-sh/setup-uv 提供');
    // --locked：照 tests/fetch_images_probe.py.lock 安裝，與正式管線同一條紀律。
    // 探針不觸網（download 被換掉）、不寫 repo（ROOT 指向暫存目錄）
    output = run([uv, 'run', '--locked', '--script', 'tests/fetch_images_probe.py']);
  });

  test('探針全部通過', () => {
    assert.match(output, /項全部通過/, `探針未跑完：\n${output}`);
  });

  test('涵蓋項目一項都不得少（防止靜默拿掉）', () => {
    const missing = REQUIRED_CASES.filter((c) => !output.includes(c));
    assert.deepEqual(missing, [], `探針少了這些項目：\n  ${missing.join('\n  ')}`);
  });

  test('探針有自己的 lock，且與正式管線鎖到同一組版本', () => {
    // 〔堵〕探針若用不同版本的 Pillow，「解碼會不會拋」的結論就不適用於正式管線
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const versions = (src) => [...src.matchAll(/name = "(.+?)"\s*\nversion = "(.+?)"/g)]
      .map((m) => `${m[1]}==${m[2]}`).sort();
    assert.deepEqual(
      versions(read('tests/fetch_images_probe.py.lock')),
      versions(read('tools/fetch-images.py.lock')),
      '探針與 fetch-images.py 鎖到不同版本，探針的結論不適用於正式管線');
  });
});
