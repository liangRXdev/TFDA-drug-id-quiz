/**
 * 難度分級單元測試 — 對應 .ai-review/plan-v3-levels.md §7 驗收 A8–A20
 *
 *   node --test
 *
 * 本檔只涵蓋 L1 與共用基礎建設。L2 專屬（A9／A19）待 L2 實作時補。
 * 每條測試上方標註它要堵死的「弱化實作」——那是這些斷言存在的理由。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalize, squash, makeRng, QUIZ_SIZE,
  QState, transition, newQuestion, scoreQuiz,
  HINTED_MARK, FULL_MARK,
  Level, CHOICE_COUNT, DISTRACTOR_COUNT, CHANCE, MAX_QUIZ_ATTEMPTS,
  nameCollides, buildIndex, eligibleKeys, buildChoices, drawLeveledQuiz, judgeChoice,
} from '../engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POOL_PATH = path.join(ROOT, 'data/pool.json');
const POOL = fs.existsSync(POOL_PATH) ? JSON.parse(fs.readFileSync(POOL_PATH, 'utf8')) : null;

const need = (msg = 'data/pool.json 不存在，請先執行 npm run build:pool') =>
  assert.ok(POOL, msg);

const ITEMS = POOL?.items ?? [];
let INDEX = null;
const index = () => (INDEX ||= buildIndex(ITEMS));

// ── 共用斷言 ──────────────────────────────────────────────────────────

const inter = (a, b) => a.some((v) => b.includes(v));

/** 一題選項的全部同題不變量（H1–H4 + I1 + L1 外觀條件） */
function assertChoiceInvariants(choice, correct, level, excludeAns) {
  const { options, answerIdx, spares } = choice;

  assert.equal(options.length, CHOICE_COUNT, '選項數必須是 4');

  // I1：正解格必須是**那一筆紀錄本身**，不是同名的其他紀錄
  assert.equal(options[answerIdx], correct, 'options[answerIdx] 必須是正解紀錄本身');
  assert.equal(options[answerIdx].id, correct.id);

  const all = [...options, ...spares];

  // H1：答案鍵兩兩相異
  assert.equal(new Set(all.map((o) => o.ans)).size, all.length, 'H1 答案鍵必須兩兩相異');

  for (let i = 0; i < all.length; i++) {
    // H2：不得撞到本卷其他題的正解
    if (excludeAns && all[i] !== correct) {
      assert.ok(!excludeAns.has(all[i].ans),
        `H2 選項 ${all[i].ans} 是本卷其他題的正解`);
    }
    // H3：兩兩不得構成名稱碰撞
    for (let j = i + 1; j < all.length; j++) {
      assert.ok(!nameCollides(all[i].ans, all[j].ans),
        `H3 ${all[i].ans} 與 ${all[j].ans} 構成名稱碰撞`);
    }
    // L1：誘答外觀必須與正解完全不相交
    if (level === Level.L1 && all[i] !== correct) {
      const u = index().union.get(all[i].ans);
      assert.ok(!inter(correct.shape, [...u.shape]),
        `L1 ${all[i].ans} 形狀與正解相交`);
      assert.ok(!inter(correct.color, [...u.color]),
        `L1 ${all[i].ans} 顏色與正解相交`);
    }
  }

  if (level !== Level.L2) assert.deepEqual(spares, [], 'L1/L3 的 spares 必須為空');
}

// ══ A8 — 全題庫掃描 L1 ════════════════════════════════════════════════
// 〔堵〕只要不拋錯就算成功率 100%；每個答案鍵只測第一筆紀錄；
//       單一 seed 隱藏貪婪挑選的死路；就地洗牌污染共享索引。
describe('A8 全題庫掃描 L1', () => {
  test('可用答案鍵涵蓋全部 3124 個（F1）', () => {
    need();
    const e = eligibleKeys(index(), Level.L1);
    assert.equal(e.size, index().keys.length,
      `L1 應 100% 可用，實際 ${e.size}/${index().keys.length}`);
  });

  test('每個答案鍵的每一筆紀錄都能組題，且滿足全部不變量', () => {
    need();
    const rng = makeRng(11);
    let n = 0;
    for (const it of ITEMS) {
      const c = buildChoices(it, index(), { level: Level.L1, rng, excludeAns: new Set() });
      assertChoiceInvariants(c, it, Level.L1);
      n++;
    }
    assert.equal(n, ITEMS.length);
  });

  test('多組 RNG 序列下皆成立（不得只在特定 seed 成功）', () => {
    need();
    // 取樣涵蓋：候選極多者、候選較少者、多形多色者
    const sample = ITEMS.filter((_, i) => i % 37 === 0);
    for (const seed of [1, 987654321, 0x7fffffff]) {
      const rng = makeRng(seed);
      for (const it of sample) {
        const c = buildChoices(it, index(), { level: Level.L1, rng, excludeAns: new Set() });
        assertChoiceInvariants(c, it, Level.L1);
      }
    }
  });

  test('索引與輸入在組題前後完全不變（D20）', () => {
    need();
    const before = JSON.stringify(ITEMS.slice(0, 400));
    const keysBefore = index().keys.slice();
    const ansBefore = index().byAns.get(ITEMS[0].ans).slice();

    const rng = makeRng(5);
    for (const it of ITEMS.slice(0, 400)) {
      buildChoices(it, index(), { level: Level.L1, rng, excludeAns: new Set() });
    }
    assert.equal(JSON.stringify(ITEMS.slice(0, 400)), before, 'items 被就地改動');
    assert.deepEqual(index().keys, keysBefore, 'index.keys 被就地洗牌');
    assert.deepEqual(index().byAns.get(ITEMS[0].ans), ansBefore, 'byAns 陣列被就地改動');
  });
});

// ══ A10 — L1 外觀不相交的反例類別 ══════════════════════════════════════
// 〔堵〕predicate 寫了但 buildChoices 沒套用；只測「完全相同」漏掉部分相交。
describe('A10 L1 外觀不相交', () => {
  const mk = (ans, shape, color) => ({ id: ans, ans, shape, color, img: `${ans}.webp` });

  const cases = [
    ['完全相同', mk('ALPHA', ['圓形'], ['白'])],
    ['僅部分顏色相交', mk('BRAVOX', ['膠囊'], ['白', '藍'])],
    ['多形狀部分相交', mk('CHARLIE', ['圓形', '膠囊'], ['黃'])],
    ['形狀不交但顏色相交', mk('DELTAQ', ['膠囊'], ['白'])],
  ];

  for (const [name, bad] of cases) {
    test(`拒絕誘答：${name}`, () => {
      const correct = mk('ZULUXX', ['圓形'], ['白']);
      // 只給不合法誘答 + 不足量的合法誘答 → 必須拋 NO_DISTRACTORS
      const idx = buildIndex([correct, bad, mk('ECHOZZ', ['膠囊'], ['藍'])]);
      assert.throws(
        () => buildChoices(correct, idx, { level: Level.L1, rng: makeRng(1), excludeAns: new Set() }),
        (e) => e.code === 'NO_DISTRACTORS',
        `${name} 的誘答不該被接受`,
      );
    });
  }

  test('接受：形狀與顏色皆不相交', () => {
    const correct = mk('ZULUXX', ['圓形'], ['白']);
    const idx = buildIndex([
      correct,
      mk('ECHOZZ', ['膠囊'], ['藍']),
      mk('FOXTRT', ['橢圓形'], ['紅']),
      mk('GOLFYY', ['三角形'], ['綠']),
    ]);
    const c = buildChoices(correct, idx, { level: Level.L1, rng: makeRng(1), excludeAns: new Set() });
    assert.equal(c.options.length, 4);
  });

  test('外觀聯集：同名另一筆紀錄相交也必須拒絕', () => {
    // HOTELX 有兩筆，其中一筆是圓形白 → 與正解相交，整個答案鍵不可作誘答
    const correct = mk('ZULUXX', ['圓形'], ['白']);
    const idx = buildIndex([
      correct,
      { ...mk('HOTELX', ['膠囊'], ['藍']), id: 'H1' },
      { ...mk('HOTELX', ['圓形'], ['白']), id: 'H2' },
      mk('INDIAZ', ['膠囊'], ['綠']),
      mk('JULIET', ['橢圓形'], ['紅']),
      mk('KILOAB', ['三角形'], ['黑']),
    ]);
    const c = buildChoices(correct, idx, { level: Level.L1, rng: makeRng(2), excludeAns: new Set() });
    assert.ok(!c.options.some((o) => o.ans === 'HOTELX'),
      'HOTELX 另有一筆與正解外觀相同，不得作為誘答');
  });
});

// ══ A11 — D13 名稱碰撞 ════════════════════════════════════════════════
// 〔堵〕只測 comparator fixture 而生成器沒套用；只檢查誘答對正解、
//       漏掉誘答彼此；把具名回歸案例硬編排除。
describe('A11 名稱碰撞排除', () => {
  test('comparator：反例類別', () => {
    assert.equal(nameCollides('SOLAXIN', 'SOLAXIN'), false, '距離 0 由 H1 處理');
    assert.equal(nameCollides('SOLAXIN', 'BOLAXIN'), true, '距離 1');
    assert.equal(nameCollides('PISTON', 'POSTON'), true, '距離 1');
    assert.equal(nameCollides('ISOPTIN', 'ISOPTAN'), true, '距離 1');
    assert.equal(nameCollides('ALPHA', 'OMEGA'), false, '距離 2 以上');
    assert.equal(nameCollides('COLD', 'COLDAN'), true, '單向前綴');
    assert.equal(nameCollides('COLDAN', 'COLD'), true, '反向前綴');
    assert.equal(nameCollides('OLDAN', 'GOLDANX'), false, '中間包含但非前綴');
    assert.equal(nameCollides('K MYCIN', 'KMYCIN'), false, '僅空白差異 → squash 後相等，由 H1 處理');
    assert.equal(nameCollides('AB', 'AC'), true, '短名距離 1 也算碰撞');
  });

  test('具名回歸：SOLAXIN/BOLAXIN 與 COLD/COLDAN 不得同題', () => {
    need();
    const pairs = [['SOLAXIN', 'BOLAXIN'], ['COLD', 'COLDAN']];
    for (const [a, b] of pairs) {
      if (!index().byAns.has(a) || !index().byAns.has(b)) continue;
      const correct = index().byAns.get(a)[0];
      const rng = makeRng(7);
      for (let i = 0; i < 50; i++) {
        const c = buildChoices(correct, index(), { level: Level.L1, rng, excludeAns: new Set() });
        assert.ok(!c.options.some((o) => o.ans === b), `${b} 不得與 ${a} 同題`);
      }
    }
  });

  test('整合：全題庫抽樣的同題全 pair 檢查', () => {
    need();
    const rng = makeRng(23);
    for (const it of ITEMS.filter((_, i) => i % 53 === 0)) {
      const c = buildChoices(it, index(), { level: Level.L1, rng, excludeAns: new Set() });
      assertChoiceInvariants(c, it, Level.L1);
    }
  });
});

// ══ A12 — 整卷不變量與可重現 ═══════════════════════════════════════════
// 〔堵〕固定回傳同一份題卷也能通過「固定 seed 可重現」；
//       只比較正解鍵而隱藏 options/answerIdx 不可重現；H2 只排除上一題。
describe('A12 整卷', () => {
  const snapshot = (qs) => qs.map((q) => ({
    token: q.token,
    id: q.item.id,
    answerIdx: q.answerIdx,
    options: q.options.map((o) => o.id),
    spares: q.spares.map((o) => o.id),
  }));

  test('同 seed 產生逐欄相同的深層快照', () => {
    need();
    const a = drawLeveledQuiz(ITEMS, { level: Level.L1, rng: makeRng(42), index: index() });
    const b = drawLeveledQuiz(ITEMS, { level: Level.L1, rng: makeRng(42), index: index() });
    assert.deepEqual(snapshot(a), snapshot(b));
  });

  test('不同 seed 產生不同題卷', () => {
    need();
    const a = drawLeveledQuiz(ITEMS, { level: Level.L1, rng: makeRng(1), index: index() });
    const b = drawLeveledQuiz(ITEMS, { level: Level.L1, rng: makeRng(2), index: index() });
    assert.notDeepEqual(snapshot(a), snapshot(b));
  });

  test('H2：選項不得含本卷其他題的正解，且 20 個正解兩兩相異', () => {
    need();
    for (const seed of [3, 314159, 271828]) {
      const qs = drawLeveledQuiz(ITEMS, { level: Level.L1, rng: makeRng(seed), index: index() });
      assert.equal(qs.length, QUIZ_SIZE);
      const corrects = new Set(qs.map((q) => q.item.ans));
      assert.equal(corrects.size, QUIZ_SIZE, '正解答案鍵必須兩兩相異');
      for (const q of qs) {
        const others = new Set(corrects);
        others.delete(q.item.ans);
        assertChoiceInvariants(q, q.item, Level.L1, others);
      }
    }
  });

  test('token 兩兩相異', () => {
    need();
    const qs = drawLeveledQuiz(ITEMS, { level: Level.L1, rng: makeRng(9), index: index() });
    assert.equal(new Set(qs.map((q) => q.token)).size, QUIZ_SIZE);
  });
});

// ══ A13 — 正解位置 ═════════════════════════════════════════════════════
// 〔堵〕以題號循環放 0/1/2/3 也能通過分布檢定；
//       answerIdx 分布正常但 options[answerIdx] 不是正解。
describe('A13 正解位置', () => {
  test('(a) options[answerIdx] 必是正解紀錄本身', () => {
    need();
    const rng = makeRng(17);
    for (const it of ITEMS.filter((_, i) => i % 29 === 0)) {
      const c = buildChoices(it, index(), { level: Level.L1, rng, excludeAns: new Set() });
      assert.equal(c.options[c.answerIdx].id, it.id);
      assert.equal(c.options[c.answerIdx], it);
    }
  });

  test('(b) 四個位置皆可達', () => {
    need();
    const rng = makeRng(31);
    const seen = new Set();
    for (const it of ITEMS.slice(0, 300)) {
      const c = buildChoices(it, index(), { level: Level.L1, rng, excludeAns: new Set() });
      seen.add(c.answerIdx);
    }
    assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
  });

  test('(c) 題號不能決定位置', () => {
    need();
    // 同一批紀錄、同一 seed，但以不同順序送入 → 位置不得跟著序號走
    const sample = ITEMS.slice(100, 160);
    const posOf = (arr) => {
      const rng = makeRng(77);
      return arr.map((it) => buildChoices(it, index(), { level: Level.L1, rng, excludeAns: new Set() }).answerIdx);
    };
    const forward = posOf(sample);
    const reversed = posOf(sample.slice().reverse()).reverse();
    assert.notDeepEqual(forward, reversed,
      '位置與紀錄順序完全一致 → 位置是由序號而非 RNG 決定');
  });

  test('(d) 500 題分布：四格皆 >0 且最大/最小 <2.0', () => {
    need();
    const rng = makeRng(20260801);
    const count = [0, 0, 0, 0];
    for (let i = 0; i < 500; i++) {
      const it = ITEMS[Math.floor(rng() * ITEMS.length)];
      count[buildChoices(it, index(), { level: Level.L1, rng, excludeAns: new Set() }).answerIdx]++;
    }
    assert.ok(Math.min(...count) > 0, `有位置從未出現：${count}`);
    assert.ok(Math.max(...count) / Math.min(...count) < 2.0, `分布過於不均：${count}`);
  });
});

// ══ A14 — judgeChoice 型別邊界 ════════════════════════════════════════
// 〔堵〕DOM dataset 取出來是字串，"1" == 1 的寬鬆比較會誤判為對。
describe('A14 judgeChoice', () => {
  const BAD = [undefined, null, NaN, Infinity, -Infinity, -1, 4, 99, 1.5, '1', '0', true, false, {}, [], [1]];

  test('非法 pickedIdx 一律 false 且不拋例外', () => {
    for (const v of BAD) {
      assert.equal(judgeChoice(v, 1), false, `pickedIdx=${String(v)} 應為 false`);
    }
  });

  test('非法 answerIdx 一律 false', () => {
    for (const v of BAD) {
      assert.equal(judgeChoice(1, v), false, `answerIdx=${String(v)} 應為 false`);
    }
  });

  test('合法：只有範圍內整數且嚴格相等才為 true，回傳型別是 boolean', () => {
    for (let i = 0; i < CHOICE_COUNT; i++) {
      assert.equal(judgeChoice(i, i), true);
      assert.equal(typeof judgeChoice(i, i), 'boolean');
      for (let j = 0; j < CHOICE_COUNT; j++) {
        if (i !== j) assert.equal(judgeChoice(i, j), false);
      }
    }
  });
});

// ══ A16 — 計分與基線 ══════════════════════════════════════════════════
// 〔堵〕只測全對未提示；「三級公式相同」只是回傳同一硬編數字。
describe('A16 計分與亂猜基線', () => {
  const q = (chance, opts = {}) => newQuestion({ id: 'x', ans: 'ALPHA' }, { chance, ...opts });
  const lock = (x, ok) => transition(x, { type: 'submit', correct: ok });
  const hint = (x) => transition(x, { type: 'hint' });
  const fail = (x) => transition(x, { type: 'fail' });

  test('計分矩陣', () => {
    const qs = [
      lock(q(CHANCE.FOUR), true),                 // 1.0
      lock(hint(q(CHANCE.FOUR, { options: [] })), true), // 0.5
      lock(q(CHANCE.FOUR), false),                // 0
      fail(q(CHANCE.FOUR)),                       // 作廢
    ];
    const r = scoreQuiz(qs);
    assert.equal(r.counted, 3);
    assert.equal(r.voided, 1);
    assert.equal(r.correct, 2);
    assert.equal(r.hints, 1);
    assert.equal(r.earned, 1.5);
    assert.equal(r.score, 50);
  });

  test('基線：未提示四選一 25、L3 為 0', () => {
    assert.equal(scoreQuiz([lock(q(CHANCE.FOUR), true)]).chance, 25);
    assert.equal(scoreQuiz([lock(q(CHANCE.NONE), true)]).chance, 0);
  });

  test('基線：提示後降為三選一的 16.7，不是固定 25', () => {
    const hinted = hint(q(CHANCE.FOUR, { options: [1, 2, 3, 4] }));
    assert.equal(Math.round(hinted.chance * 10000) / 10000, 0.1667);
    assert.equal(scoreQuiz([lock(hinted, true)]).chance, 16.7);
  });

  test('基線是逐題加總，混合提示時介於兩者之間', () => {
    const qs = [
      lock(q(CHANCE.FOUR), true),
      lock(hint(q(CHANCE.FOUR, { options: [1, 2, 3, 4] })), true),
    ];
    const r = scoreQuiz(qs);
    assert.ok(r.chance > 16.7 && r.chance < 25, `混合基線應介於 16.7~25，實際 ${r.chance}`);
  });

  test('作廢題不計入基線分母', () => {
    const r = scoreQuiz([lock(q(CHANCE.FOUR), true), fail(q(CHANCE.FOUR))]);
    assert.equal(r.counted, 1);
    assert.equal(r.chance, 25);
  });

  test('相同題目結果時三級 score 必須相同，只有 chance 不同', () => {
    const mk = (chance) => [lock(q(chance), true), lock(q(chance), false)];
    const a = scoreQuiz(mk(CHANCE.FOUR));
    const b = scoreQuiz(mk(CHANCE.NONE));
    assert.equal(a.score, b.score);
    assert.equal(a.earned, b.earned);
    assert.notEqual(a.chance, b.chance);
  });

  test('全部作廢時 chance 不除以零', () => {
    assert.equal(scoreQuiz([fail(q(CHANCE.FOUR))]).chance, 0);
  });

  test('L3 的 newQuestion 預設 chance 為 0（v2 行為不變）', () => {
    assert.equal(newQuestion({ id: 'x' }).chance, 0);
    assert.equal(newQuestion({ id: 'x' }).mark, FULL_MARK);
    assert.equal(newQuestion({ id: 'x' }).state, QState.PENDING);
  });

  test('L3 取提示不改變 chance（沒有猜測基線可言）', () => {
    const h = hint(newQuestion({ id: 'x' }));
    assert.equal(h.mark, HINTED_MARK);
    assert.equal(h.chance, 0);
  });
});

// ══ A17 — normalize 未漂移 ════════════════════════════════════════════
// 〔堵〕只檢查 content_hash 字串未變——改了內容但忘記更新 hash 就照樣綠。
describe('A17 normalize 未漂移', () => {
  test('normalize(item.full) === item.ans 對全題庫成立（F5）', () => {
    need();
    const bad = [];
    for (const it of ITEMS) {
      if (normalize(it.full) !== it.ans) {
        bad.push({ full: it.full, ans: it.ans, got: normalize(it.full) });
        if (bad.length >= 5) break;
      }
    }
    assert.deepEqual(bad, [],
      'normalize() 已漂移：pool 內的答案鍵無法由現行 normalize 重現');
  });

  test('答案鍵長度與非空條件仍成立（A1 回歸）', () => {
    need();
    for (const it of ITEMS) {
      assert.ok(it.ans && squash(it.ans).length >= 3, `答案鍵過短：${it.ans}`);
    }
  });
});

// ══ A18 — 身分鏈 ══════════════════════════════════════════════════════
// 〔堵〕所有單元測試全綠但畫面放錯圖／index 錯一格。
describe('A18 身分鏈', () => {
  test('題目、正解格、圖片、檢討全部指向同一紀錄', () => {
    need();
    const qs = drawLeveledQuiz(ITEMS, { level: Level.L1, rng: makeRng(1234), index: index() });
    for (const q of qs) {
      const correctOption = q.options[q.answerIdx];
      assert.equal(correctOption, q.item, '正解格必須是題目紀錄本身');
      assert.equal(correctOption.id, q.item.id);
      assert.equal(correctOption.img, q.item.img, '圖片必須來自同一紀錄');
      assert.equal(correctOption.full, q.item.full);
      assert.equal(correctOption.ans, q.item.ans);
      // 該紀錄確實屬於題庫，且 id 在題庫中唯一
      assert.equal(ITEMS.filter((i) => i.id === q.item.id).length, 1);
    }
  });

  test('同名不同紀錄不得混用：正解格不是同 ans 的另一筆', () => {
    need();
    const multi = [...index().byAns.values()].find((r) => r.length > 3);
    assert.ok(multi, '題庫應有答案鍵對應多筆紀錄');
    const rng = makeRng(55);
    for (const rec of multi) {
      const c = buildChoices(rec, index(), { level: Level.L1, rng, excludeAns: new Set() });
      assert.equal(c.options[c.answerIdx].id, rec.id,
        '正解格被換成同名的另一筆紀錄');
    }
  });
});

// ══ A20 — 錯誤分類 ════════════════════════════════════════════════════
// 〔堵〕兩種錯誤共用同一 code，UI 無法給出正確訊息。
describe('A20 錯誤分類', () => {
  const mk = (ans, shape, color) => ({ id: ans, ans, shape, color, img: `${ans}.webp` });

  /** 產生 n 個外觀互不相交、名稱互不碰撞的紀錄 */
  const spread = (n) => {
    const shapes = ['圓形', '膠囊', '橢圓形', '三角形', '四邊形', '六邊形', '八邊形', '五邊形', '水滴形', '雙圓形'];
    const colors = ['白', '藍', '紅', '綠', '黃', '黑', '紫', '棕', '粉', '橘'];
    return Array.from({ length: n }, (_, i) =>
      mk(`DRUG${String.fromCharCode(65 + i)}${i}`, [shapes[i % shapes.length]], [colors[i % colors.length]]));
  };

  test('可用答案鍵不足 → INSUFFICIENT_KEYS，且不進入階段 2', () => {
    for (const n of [0, 19]) {
      const items = spread(n);
      assert.throws(
        () => drawLeveledQuiz(items, { level: Level.L1, n: 20, rng: makeRng(1) }),
        (e) => e.code === 'INSUFFICIENT_KEYS',
        `${n} 個答案鍵應拒絕開始`,
      );
    }
  });

  test('選擇題的下限是 n + 誘答數，不是 n', () => {
    // H2 禁止誘答等於本卷其他題的正解。可用答案鍵恰好 20 個時
    // 全部都是正解，合法誘答為 0——這條邊界寫成 `< n` 會讓程式
    // 通過檢查後才在組裝階段炸掉，錯誤訊息也會指錯方向。
    const items = spread(22);                       // 20 + 3 - 1
    assert.equal(eligibleKeys(buildIndex(items), Level.L1).size, 22);
    assert.throws(
      () => drawLeveledQuiz(items, { level: Level.L1, n: 20, rng: makeRng(1) }),
      (e) => e.code === 'INSUFFICIENT_KEYS' && e.required === 23,
      '22 個可用答案鍵不足以出 20 題四選一',
    );
  });

  test('L3 的下限仍是 n（沒有誘答需求）', () => {
    const items = spread(20);
    const qs = drawLeveledQuiz(items, { level: Level.L3, n: 20, rng: makeRng(1) });
    assert.equal(qs.length, 20);
    assert.equal(qs[0].chance, 0);
    assert.equal(qs[0].options, undefined, 'L3 不應有選項');
  });

  test('組裝連續失敗 → QUIZ_ASSEMBLY_FAILED（與 INSUFFICIENT_KEYS 不同 code）', () => {
    // ZULUXX 的合法誘答只有 AAAAA* 三個，而那三個彼此兩兩名稱碰撞（距離 1）
    // → 通得過 eligibleKeys 的單項計數，卻組不出一題。
    // MIKEXX／NOVEMB 與 ZULUXX 外觀相交（分別是形狀、顏色），
    // 因此不能當 ZULUXX 的誘答，但足以讓其他答案鍵可用、把 |E| 撐過下限。
    const items = [
      mk('ZULUXX', ['圓形'], ['白']),
      mk('AAAAAA', ['膠囊'], ['藍']),
      mk('AAAAAB', ['膠囊'], ['藍']),
      mk('AAAAAC', ['膠囊'], ['藍']),
      mk('MIKEXX', ['圓形'], ['紅']),
      mk('NOVEMB', ['橢圓形'], ['白']),
    ];
    const idx = buildIndex(items);
    const e = eligibleKeys(idx, Level.L1);
    assert.ok(e.has('ZULUXX'), '前提：ZULUXX 在單項計數下應被判為可用');
    assert.ok(e.size >= 1 + 3, `前提：|E| 需通過下限，實際 ${e.size}`);

    const codes = new Set();
    let assemblyFailed = 0;
    for (let seed = 1; seed <= 60; seed++) {
      try {
        drawLeveledQuiz(items, { level: Level.L1, n: 1, rng: makeRng(seed), index: idx });
      } catch (err) {
        codes.add(err.code);
        if (err.code === 'QUIZ_ASSEMBLY_FAILED') assemblyFailed++;
      }
    }
    assert.ok(assemblyFailed > 0, '抽到 ZULUXX 時必須拋 QUIZ_ASSEMBLY_FAILED');
    assert.deepEqual([...codes], ['QUIZ_ASSEMBLY_FAILED'],
      '不得混入其他錯誤 code');
  });

  test('buildChoices 誘答不足時拋 NO_DISTRACTORS', () => {
    const correct = mk('ZULUXX', ['圓形'], ['白']);
    const idx = buildIndex([correct, mk('ECHOZZ', ['膠囊'], ['藍'])]);
    assert.throws(
      () => buildChoices(correct, idx, { level: Level.L1, rng: makeRng(1), excludeAns: new Set() }),
      (e) => e.code === 'NO_DISTRACTORS',
    );
  });

  test('MAX_QUIZ_ATTEMPTS 為有限值', () => {
    assert.ok(Number.isInteger(MAX_QUIZ_ATTEMPTS) && MAX_QUIZ_ATTEMPTS >= 1);
  });
});

// ══ 級別常數 ══════════════════════════════════════════════════════════
describe('級別常數', () => {
  test('L1/L3 的 spares 恆為空，L2 才有備援', () => {
    assert.equal(DISTRACTOR_COUNT, CHOICE_COUNT - 1 + 2);
  });

  test('三個級別代號存在', () => {
    assert.deepEqual(Object.keys(Level).sort(), ['L1', 'L2', 'L3']);
  });
});
