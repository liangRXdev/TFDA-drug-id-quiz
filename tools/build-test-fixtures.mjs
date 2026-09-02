#!/usr/bin/env node
/**
 * 凍結 UI 測試用的題庫子集 — 產出 tests/fixtures/
 *
 *   node tools/build-test-fixtures.mjs
 *
 * ## 為什麼要凍結
 *
 * `formulary-ui.test.mjs` 原本用 `pickIds(n, seed)` 從**活的** `data/pool.json`
 * 抽子集。seed 固定，但被洗牌的陣列本身每月會變（上游 TFDA 資料集更新），
 * 於是同一個 seed 抽到的是另一組品項——凡是斷言依賴「這組品項的性質」
 * （K 值、某卷長可用／不可用、某級別撐不起來）的測試就會整批變紅。
 * 2026-09-01 的排程更新（來源 2026-08-10 → 2026-08-31，pool 3941 → 3950）
 * 一次打掉 6 條，程式碼一行沒改。
 *
 * 這支工具把那些子集連同**完整品項紀錄**寫成固定檔案，讓行為契約與上游資料解耦。
 * 真實資料的驗證留在 `formulary.test.mjs`（A44 逐 stage、A41 子集封閉）與
 * UI 測試裡 n=300 的那些站點——它們只要求「夠大的子集」，不依賴組成。
 *
 * ## 重新產生前請先讀這段
 *
 * **測試變紅不是重跑這支工具的理由。** 每個子集在測試內都有自檢
 * （「fixture 必須讓 10 題可用」之類）；重新產生會讓自檢跟著新資料一起漂移，
 * 等於把「行為壞了」與「fixture 換了」兩件事混在一起。
 * 只有在**刻意**要換一組 fixture（例如引擎規則改了、舊子集不再有代表性）時才跑，
 * 跑完必須逐條確認自檢仍然驗得到原本要驗的東西。
 *
 * ## 產出
 *
 * - `tests/fixtures/pool.json`   — pool 形狀（`{meta, items}`），可直接餵給 `boot({pool})`
 * - `tests/fixtures/subsets.json` — 子集名稱 → 院內清單 id 陣列
 *
 * pool 刻意比任何子集大得多（填充品項），院內版「子集封閉」才驗得到東西：
 * 若 pool 恰好等於子集，實作誤用全庫也不會被抓到。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng } from '../engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'tests/fixtures');
const POOL = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/pool.json'), 'utf8'));

/** 填充後的 fixture pool 總筆數。子集最大 60，留足夠倍率讓「封閉」驗得到 */
const POOL_SIZE = 600;

/**
 * 與 `formulary-ui.test.mjs` 原本的 `pickIds` 逐字相同——這支工具的職責就是
 * 把「當時那個 seed 抽到的那組品項」一次性固定下來。
 */
function pickIds(n, seed) {
  const rng = makeRng(seed);
  const ids = POOL.items.map((it) => it.id);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (ids.length - i));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, n).sort();
}

/**
 * 要凍結的子集。`n`／`seed` 是原本測試裡的實測值，留著只為了說明來歷——
 * 檔案產出後就是權威，改這裡不會讓已凍結的檔案跟著變（除非重跑本工具）。
 */
const SUBSETS = [
  ['l1-off-k12', 12, 4501, 'L1 的 K=12 未達 13 → L1 整級不可用'],
  ['all-off-k9', 9, 4503, '9 品項 → 三級全禁用（D41）'],
  ['l2-off-k29', 30, 4545, 'L2 湊不到同形同色誘答 → L2 不可用；L1 可用但重抽會隨機失敗（S-2）'],
  ['len-k16', 16, 4501, 'L1 K=16：10 題可用、13 題組卷失敗、20 題品項數不足（A66／A67／A54）'],
  ['short-deck', 15, 4615, 'L3 短卷：可組卷但不足 20 題'],
  ['exit-l2off', 30, 5401, '切回全題庫前 L2 是禁用的，切回後要解除'],
  ['len-both', 60, 4601, '10 題格與 20 題格都可用，且兩格的前 10 題不同（A56）'],
  ['len-records', 60, 4602, '10 題與 20 題全對卷都跑得完（院內版不寫紀錄）'],
];

const squash = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

const subsets = {};
const wanted = new Set();
for (const [name, n, seed, note] of SUBSETS) {
  const ids = pickIds(n, seed);
  if (new Set(ids).size !== n) throw new Error(`${name}：抽到重複 id`);
  subsets[name] = { note, from: { n, seed, source_version: POOL.meta.source_version }, ids };
  for (const id of ids) wanted.add(id);
}

// 填充：pool 順序內、不屬於任何子集的品項，補到 POOL_SIZE。
// 依 pool 原始順序取，子集品項在 fixture 內的**相對順序**因此與正式題庫一致——
// `prepareFormulary()` 之後的抽題結果才會與凍結當下逐題相同。
const filler = POOL.items.filter((it) => !wanted.has(it.id)).slice(0, POOL_SIZE - wanted.size);
if (filler.length < POOL_SIZE - wanted.size) throw new Error('題庫不足以填充 fixture pool');
const keep = new Set([...wanted, ...filler.map((it) => it.id)]);
const items = POOL.items.filter((it) => keep.has(it.id));
if (items.length !== POOL_SIZE) throw new Error(`fixture pool 筆數 ${items.length} ≠ ${POOL_SIZE}`);

const keys = new Set(items.map((it) => squash(it.ans)));
const pool = {
  meta: {
    schema: POOL.meta.schema,
    source: 'UI 測試凍結 fixture（tools/build-test-fixtures.mjs 產生，勿手改）',
    frozen_from: {
      source_version: POOL.meta.source_version,
      content_hash: POOL.meta.content_hash,
      pool_count: POOL.meta.count,
    },
    source_version: POOL.meta.source_version,
    count: items.length,
    no_fuzzy: (POOL.meta.no_fuzzy || []).filter((k) => keys.has(squash(k))),
  },
  items,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'pool.json'), `${JSON.stringify(pool, null, 1)}\n`);
fs.writeFileSync(path.join(OUT_DIR, 'subsets.json'), `${JSON.stringify(subsets, null, 1)}\n`);

console.log(`tests/fixtures/pool.json     ${items.length} 筆（自 ${POOL.meta.source_version} 題庫凍結）`);
for (const [name, s] of Object.entries(subsets)) {
  console.log(`tests/fixtures/subsets.json  ${name.padEnd(12)} ${String(s.ids.length).padStart(3)} 筆  ${s.note}`);
}
