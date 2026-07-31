/**
 * engine.js 單元測試 — 對應規劃文件 §7 驗收條件 A1–A7
 *
 *   node --test
 *
 * A1/A4 需要 data/pool.json（由 tools/build-pool.mjs 產出）。
 * 未產出時該組測試會明確失敗而非靜默跳過——題庫層的驗證不可被略過。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalize, squash, editDistance, judge, makeHint,
  drawQuiz, makeRng, QUIZ_SIZE,
  QState, transition, newQuestion, scoreQuiz,
  FUZZY_MIN_LEN, HINTED_MARK,
} from '../engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const GOLD = readJson('tests/gold-set.json').cases;
const POOL_PATH = path.join(ROOT, 'data/pool.json');
const POOL = fs.existsSync(POOL_PATH) ? readJson('data/pool.json') : null;

// ── A2 — Gold set（先跑：正規化錯了其他都不必看）────────────────────

describe('A2 — gold set 正規化', () => {
  test(`≥40 筆人工確認案例，全數精確相符（實際 ${GOLD.length} 筆）`, () => {
    assert.ok(GOLD.length >= 40, `gold set 僅 ${GOLD.length} 筆，驗收要求 ≥40`);
    const fails = [];
    for (const c of GOLD) {
      const got = normalize(c.src);
      if (got !== c.want) fails.push(`  ${JSON.stringify(c.src)}\n    want=${JSON.stringify(c.want)}\n    got =${JSON.stringify(got)}`);
    }
    assert.equal(fails.length, 0, `\n${fails.join('\n')}\n共 ${fails.length} 筆不符`);
  });

  test('涵蓋全部命名型態，且回歸案例齊備', () => {
    const kinds = new Set(GOLD.map((c) => c.archetype));
    assert.ok(kinds.size >= 15, `archetype 僅 ${kinds.size} 種`);
    // 品名內含劑型縮寫是實測踩過的坑：O.G.S.C. 曾被正規化成 "O G"
    assert.ok([...kinds].some((k) => k.includes('品名內含劑型縮寫')));
    assert.ok([...kinds].some((k) => k.includes('品名含劑型字詞')));
  });

  test('品名內含劑型縮寫不得被剝除（回歸）', () => {
    assert.equal(normalize('O.G.S.C. TABLETS "JOHNSON"'), 'O G S C');
    assert.equal(normalize('EUCLIDAN S.C. TABLETS 50MG'), 'EUCLIDAN'); // 整 token 才剝
  });
});

// ── A3 — 判定 ────────────────────────────────────────────────────────

describe('A3 — 作答判定', () => {
  test('大小寫不分', () => {
    for (const s of ['isoptin', 'ISOPTIN', 'Isoptin', 'IsOpTiN']) {
      assert.equal(judge(s, 'ISOPTIN').correct, true, s);
    }
  });

  test('全形英數經 NFKC 後判對', () => {
    const r = judge('ＩＳＯＰＴＩＮ', 'ISOPTIN');
    assert.equal(r.correct, true);
    assert.equal(r.reason, 'exact');
  });

  test('1 字元拼錯在長度 ≥6 時判對', () => {
    const r = judge('isopten', 'ISOPTIN');
    assert.equal(r.correct, true);
    assert.equal(r.reason, 'fuzzy');
  });

  test('少一字元（非 1 距離內）判錯', () => {
    assert.equal(judge('isopt', 'ISOPTIN').correct, false);
  });

  test('空白與連字號差異不影響判定', () => {
    for (const s of ['K-MYCIN', 'KMYCIN', 'K MYCIN', 'k mycin']) {
      const r = judge(s, 'K MYCIN');
      assert.equal(r.correct, true, s);
    }
  });

  test('短答案鍵停用容錯（避免 ISAN/ISAM 誤接受）', () => {
    assert.ok(squash('ISAN').length < FUZZY_MIN_LEN);
    assert.equal(judge('ISAM', 'ISAN').correct, false);
    assert.equal(judge('ISAN', 'ISAN').correct, true);
  });

  test('noFuzzy 旗標可對個別答案鍵停用容錯', () => {
    assert.equal(judge('PROPRANOLOJ', 'PROPRANOLOL').correct, true);
    assert.equal(judge('PROPRANOLOJ', 'PROPRANOLOL', { noFuzzy: true }).correct, false);
  });

  test('空輸入與純空白回報 empty，不算答錯的一種', () => {
    for (const s of ['', '   ', '\t\n']) {
      assert.deepEqual(judge(s, 'ISOPTIN'), { correct: false, reason: 'empty' });
    }
  });

  test('剝除後為空的輸入視同 empty', () => {
    // 只打了劑型字詞與含量，沒有品名
    assert.equal(judge('tablets 100mg', 'ISOPTIN').reason, 'empty');
  });

  test('中文輸入不會誤判為對', () => {
    assert.equal(judge('蘇打錠', 'SODIUM BICARBONATE').correct, false);
  });
});

describe('editDistance', () => {
  test('基本距離與提早放棄', () => {
    assert.equal(editDistance('ABC', 'ABC'), 0);
    assert.equal(editDistance('ABC', 'ABD'), 1);
    assert.equal(editDistance('ABC', 'AB'), 1);
    assert.equal(editDistance('ABC', 'AXY', 1), 2);   // 超過 max 回傳 max+1
    assert.equal(editDistance('ABC', 'ABCDEF', 1), 2); // 長度差 > max
  });
});

// ── A4 — 全題庫零誤接受 ───────────────────────────────────────────────

describe('A4 — 跨答案鍵誤接受', () => {
  /** 找出所有編輯距離 ≤1 的相異答案鍵對（長度分桶加速） */
  const collidingPairs = (keys) => {
    const byLen = new Map();
    for (const k of keys) {
      if (!byLen.has(k.length)) byLen.set(k.length, []);
      byLen.get(k.length).push(k);
    }
    const pairs = [];
    for (const k of keys) {
      for (const L of [k.length - 1, k.length, k.length + 1]) {
        for (const other of byLen.get(L) || []) {
          if (other === k) continue;
          if (editDistance(k, other, 1) <= 1) pairs.push([k, other]);
        }
      }
    }
    return pairs;
  };

  test('題庫確實存在僅差 1 字元的相異藥名（停用清單有其必要）', () => {
    assert.ok(POOL, 'data/pool.json 不存在，請先執行 npm run build:pool');
    const keys = [...new Set(POOL.items.map((i) => squash(i.ans)))].filter((k) => k.length >= FUZZY_MIN_LEN);
    assert.ok(collidingPairs(keys).length > 0,
      '若此斷言失敗，代表題庫已無相近藥名，可考慮簡化 no_fuzzy 機制');
  });

  test('停用清單涵蓋全部碰撞鍵', () => {
    assert.ok(POOL?.meta?.no_fuzzy, 'pool.meta.no_fuzzy 不存在，請重建題庫');
    const nf = new Set(POOL.meta.no_fuzzy);
    const keys = [...new Set(POOL.items.map((i) => squash(i.ans)))].filter((k) => k.length >= FUZZY_MIN_LEN);
    const uncovered = [...new Set(collidingPairs(keys).flat())].filter((k) => !nf.has(k));
    assert.equal(uncovered.length, 0,
      `${uncovered.length} 個碰撞鍵未被停用：${uncovered.slice(0, 10).join(', ')}`);
  });

  test('★ 套用停用清單後，跨相異答案鍵誤接受數 = 0', () => {
    assert.ok(POOL?.meta?.no_fuzzy);
    const nf = new Set(POOL.meta.no_fuzzy);
    const keys = [...new Set(POOL.items.map((i) => squash(i.ans)))].filter((k) => k.length >= FUZZY_MIN_LEN);
    // 對每組碰撞：使用者打成 b、正解為 a，套用該題的 noFuzzy 後必須判錯
    const falseAccepts = collidingPairs(keys).filter(
      ([a, b]) => judge(b, a, { noFuzzy: nf.has(a) }).correct
    );
    assert.equal(falseAccepts.length, 0,
      `仍有 ${falseAccepts.length} 組誤接受：\n` +
        falseAccepts.slice(0, 10).map(([a, b]) => `  正解 ${a} 卻接受了 ${b}`).join('\n'));
  });

  test('停用清單不影響非碰撞藥名的容錯', () => {
    assert.ok(POOL?.meta?.no_fuzzy);
    const nf = new Set(POOL.meta.no_fuzzy);
    const safe = POOL.items.map((i) => squash(i.ans))
      .find((k) => k.length >= 8 && !nf.has(k));
    assert.ok(safe, '找不到可容錯的藥名樣本');
    const typo = safe.slice(0, -1) + (safe.at(-1) === 'X' ? 'Y' : 'X');
    assert.equal(judge(typo, safe, { noFuzzy: false }).correct, true,
      `${safe} 未在停用清單內，應仍允許 1 字元容錯`);
  });
});

// ── A1 — 全題庫正規化健全性 ───────────────────────────────────────────

describe('A1 — 題庫答案鍵健全性', () => {
  test('全題庫答案鍵非空、去空白長度 ≥3', () => {
    assert.ok(POOL, 'data/pool.json 不存在，請先執行 npm run build:pool');
    const bad = POOL.items.filter(
      (i) => typeof i.ans !== 'string' || squash(i.ans).length < 3
    );
    assert.equal(bad.length, 0, `${bad.length} 筆答案鍵過短：` +
      bad.slice(0, 10).map((i) => `${i.id}=${JSON.stringify(i.ans)}`).join(', '));
  });

  test('答案鍵已是正規化形式（normalize 冪等）', () => {
    assert.ok(POOL);
    const bad = POOL.items.filter((i) => normalize(i.ans) !== i.ans);
    assert.equal(bad.length, 0, `${bad.length} 筆答案鍵非正規化形式`);
  });
});

// ── 提示 ─────────────────────────────────────────────────────────────

describe('提示（規格 6.3）', () => {
  test('單字答案：首字母 + 底線，字數以去空白為準', () => {
    assert.deepEqual(makeHint('ISOPTIN'), {
      masked: 'I _ _ _ _ _ _', chars: 7, words: 1,
    });
  });

  test('多字答案：字數為去空白總長，另報詞數', () => {
    const h = makeHint('SODIUM BICARBONATE');
    assert.equal(h.chars, 17);   // SODIUMBICARBONATE
    assert.equal(h.words, 2);
    assert.equal(h.masked.split(' ').length, 17);
    assert.ok(h.masked.startsWith('S _'));
  });

  test('提示長度定義與容錯門檻共用同一基準', () => {
    const key = 'K MYCIN';
    assert.equal(makeHint(key).chars, squash(key).length);
  });
});

// ── A5 — 抽題不變量 ───────────────────────────────────────────────────

const mkItems = (spec) =>
  spec.flatMap(([ans, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `${ans}-${i}`, ans, img: `img/${ans}-${i}.webp` }))
  );

describe('A5 — 抽題', () => {
  test('不變量：20 題答案鍵互異、皆有資產、皆屬題庫（固定 seed 可重現）', () => {
    const items = mkItems([['IBUPROFEN', 20], ['PREDNISOLONE', 15], ...
      Array.from({ length: 40 }, (_, i) => [`DRUG${i}`, 1 + (i % 3)])]);
    const pool = new Set(items);
    for (let seed = 1; seed <= 200; seed++) {
      const q = drawQuiz(items, QUIZ_SIZE, makeRng(seed));
      assert.equal(q.length, QUIZ_SIZE);
      assert.equal(new Set(q.map((x) => x.ans)).size, QUIZ_SIZE, `seed=${seed} 答案鍵重複`);
      for (const x of q) {
        assert.ok(pool.has(x), `seed=${seed} 抽到題庫外項目`);
        assert.ok(x.img, `seed=${seed} 缺資產路徑`);
      }
    }
  });

  test('相同 seed 產出完全相同（可重現，不會偶發紅燈）', () => {
    const items = mkItems(Array.from({ length: 30 }, (_, i) => [`D${i}`, 2]));
    const a = drawQuiz(items, QUIZ_SIZE, makeRng(42)).map((x) => x.id);
    const b = drawQuiz(items, QUIZ_SIZE, makeRng(42)).map((x) => x.id);
    assert.deepEqual(a, b);
  });

  test('邊界：可用答案鍵 0 / 19 個時拒絕開始', () => {
    for (const n of [0, 19]) {
      const items = mkItems(Array.from({ length: n }, (_, i) => [`D${i}`, 3]));
      assert.throws(() => drawQuiz(items, QUIZ_SIZE, makeRng(1)), (e) => {
        assert.equal(e.code, 'INSUFFICIENT_KEYS');
        assert.equal(e.available, n);
        return true;
      }, `n=${n} 應拒絕`);
    }
  });

  test('邊界：恰好 20 個答案鍵時成卷；21 個時正常', () => {
    for (const n of [20, 21]) {
      const items = mkItems(Array.from({ length: n }, (_, i) => [`D${i}`, 2]));
      const q = drawQuiz(items, QUIZ_SIZE, makeRng(7));
      assert.equal(new Set(q.map((x) => x.ans)).size, QUIZ_SIZE);
    }
  });

  test('答案鍵均勻抽樣：IBUPROFEN(20 筆) 不得比單筆品項更常出現', () => {
    // 紀錄均勻抽樣下 IBUPROFEN 機率會是 20 倍；答案鍵均勻則應相當
    const items = mkItems([['IBUPROFEN', 20], ...Array.from({ length: 39 }, (_, i) => [`D${i}`, 1])]);
    const count = {};
    for (let seed = 1; seed <= 4000; seed++) {
      for (const x of drawQuiz(items, QUIZ_SIZE, makeRng(seed))) {
        count[x.ans] = (count[x.ans] || 0) + 1;
      }
    }
    const ibu = count.IBUPROFEN;
    const singles = Object.entries(count).filter(([k]) => k !== 'IBUPROFEN').map(([, v]) => v);
    const avg = singles.reduce((a, b) => a + b, 0) / singles.length;
    assert.ok(Math.abs(ibu - avg) / avg < 0.15,
      `IBUPROFEN 出現 ${ibu} 次 vs 單筆品項平均 ${avg.toFixed(0)} 次，偏離過大`);
  });
});

// ── A7 — 狀態機 ───────────────────────────────────────────────────────

describe('A7 — 題目狀態機（規格 6.4）', () => {
  const q0 = () => newQuestion({ id: 'x', ans: 'ISOPTIN' });

  test('首次送出即鎖定', () => {
    const q = transition(q0(), { type: 'submit', correct: true });
    assert.equal(q.state, QState.LOCKED);
    assert.equal(q.correct, true);
  });

  test('已鎖定後重複送出不改變結果（不重複計分）', () => {
    let q = transition(q0(), { type: 'submit', correct: false });
    const before = { ...q };
    q = transition(q, { type: 'submit', correct: true });
    q = transition(q, { type: 'submit', correct: true });
    assert.deepEqual(q, before);
  });

  test('取提示後滿分降為 0.5', () => {
    const q = transition(q0(), { type: 'hint' });
    assert.equal(q.state, QState.HINTED);
    assert.equal(q.mark, HINTED_MARK);
  });

  test('重複取提示不重複扣分', () => {
    let q = transition(q0(), { type: 'hint' });
    q = transition(q, { type: 'hint' });
    assert.equal(q.mark, HINTED_MARK);
  });

  test('已鎖定後不可再取提示', () => {
    let q = transition(q0(), { type: 'submit', correct: true });
    const before = { ...q };
    q = transition(q, { type: 'hint' });
    assert.deepEqual(q, before);
    assert.equal(q.mark, 1.0);
  });

  test('資源失敗 → 作廢，且作廢為終態', () => {
    let q = transition(q0(), { type: 'fail' });
    assert.equal(q.state, QState.VOID);
    const before = { ...q };
    q = transition(q, { type: 'submit', correct: true });
    assert.deepEqual(q, before, '作廢題不得再被作答');
  });
});

// ── A6 — 計分 ─────────────────────────────────────────────────────────

describe('A6 — 計分（規格 6.6）', () => {
  const build = (n, fn) =>
    Array.from({ length: n }, (_, i) => fn(newQuestion({ id: `q${i}` }), i));
  const lock = (q, correct) => transition(q, { type: 'submit', correct });
  const hint = (q) => transition(q, { type: 'hint' });
  const fail = (q) => transition(q, { type: 'fail' });

  test('全對 = 100', () => {
    assert.equal(scoreQuiz(build(20, (q) => lock(q, true))).score, 100);
  });

  test('全錯 = 0', () => {
    assert.equal(scoreQuiz(build(20, (q) => lock(q, false))).score, 0);
  });

  test('10 對其中 4 題用提示 = 40', () => {
    const qs = build(20, (q, i) => {
      if (i >= 10) return lock(q, false);
      return lock(i < 4 ? hint(q) : q, true);
    });
    const r = scoreQuiz(qs);
    assert.equal(r.earned, 6 * 1.0 + 4 * 0.5);  // 8
    assert.equal(r.counted, 20);
    assert.equal(r.score, 40);
    assert.equal(r.hints, 4);
  });

  test('含 2 題作廢時分母為 18', () => {
    const qs = build(20, (q, i) => {
      if (i < 2) return fail(q);
      return lock(q, i < 11);          // 第 2..10 共 9 題答對
    });
    const r = scoreQuiz(qs);
    assert.equal(r.voided, 2);
    assert.equal(r.counted, 18);
    assert.equal(r.correct, 9);
    assert.equal(r.score, Math.round((9 / 18) * 1000) / 10);  // 50
  });

  test('全部作廢不除以零', () => {
    const r = scoreQuiz(build(20, (q) => fail(q)));
    assert.equal(r.counted, 0);
    assert.equal(r.score, 0);
  });
});
