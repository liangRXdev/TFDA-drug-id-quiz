/**
 * M5 錯題再戰 — 純函式層（規格 plan-v4-engagement.md v4.5+ 的 A30–A35）
 *
 *   node --test
 *
 * 這一檔只驗**純函式性質**。凡涉及正式入口、`state.mode`、DOM、原子提交者
 * 一律在 `tests/retry-ui.test.mjs`（C34–C39）——A 組把跨層要求寫進來，
 * 會誘導把 app state 帶進 engine，直接違反 D18 的分層。
 *
 * 每條測試上方標註它要堵死的弱化實作；每一條都經過變異驗證。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QState, newQuestion, makeRng, Level, CHOICE_COUNT, CHANCE, QUIZ_SIZE,
  buildIndex, eligibleKeys, validateQuizInvariants,
  wrongAnsKeys, drawRetryQuiz,
} from '../engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POOL_PATH = path.join(ROOT, 'data/pool.json');
const POOL = fs.existsSync(POOL_PATH) ? JSON.parse(fs.readFileSync(POOL_PATH, 'utf8')) : null;
const need = () => assert.ok(POOL, 'data/pool.json 不存在，請先執行 npm run build:pool');

const ITEMS = POOL?.items ?? [];
let INDEX = null;
const index = () => (INDEX ||= buildIndex(ITEMS));
const ELIGIBLE = new Map();
const eligible = (lv) => {
  if (!ELIGIBLE.has(lv)) ELIGIBLE.set(lv, eligibleKeys(index(), lv));
  return ELIGIBLE.get(lv);
};

// ══ A30 錯題集合定義 ══════════════════════════════════════════════════

describe('A30 錯題集合定義（純函式）', () => {
  const q = (ans, extra) => newQuestion({ ans, id: `id-${ans}` }, extra);

  test('六類反例逐一指名：只有 LOCKED 且嚴格 false 被收', () => {
    // 〔堵〕規格 D28 原文寫 `state !== VOID && correct === false`——**那是錯的**：
    //       newQuestion() 把 correct 預設為 false，transition() 只在 submit/fail
    //       才寫它，於是 PENDING 與 HINTED 的題目 correct 也都是 false。
    //       今天碰不到只因為 finish() 僅在全部終態時才走到，那是脈絡的偶然。
    const questions = [
      q('LOCKED_WRONG', { state: QState.LOCKED, correct: false }),   // ← 收
      q('LOCKED_RIGHT', { state: QState.LOCKED, correct: true }),
      q('LOCKED_HINT_WRONG', { state: QState.LOCKED, correct: false, mark: 0.5 }), // ← 收
      q('LOCKED_HINT_RIGHT', { state: QState.LOCKED, correct: true, mark: 0.5 }),
      q('VOIDED', { state: QState.VOID, correct: false }),
      q('PENDING'),                                                   // correct 預設 false
      q('HINTED', { state: QState.HINTED }),                          // correct 仍是 false
      q('NULLISH', { state: QState.LOCKED, correct: null }),
      q('UNDEF', { state: QState.LOCKED, correct: undefined }),
    ];
    assert.deepEqual(wrongAnsKeys(questions), ['LOCKED_WRONG', 'LOCKED_HINT_WRONG']);
  });

  test('提示後答錯算錯題，提示後答對不算', () => {
    assert.deepEqual(
      wrongAnsKeys([q('A', { state: QState.LOCKED, correct: false, mark: 0.5 })]), ['A']);
    assert.deepEqual(
      wrongAnsKeys([q('B', { state: QState.LOCKED, correct: true, mark: 0.5 })]), []);
  });

  test('作廢題一律排除，即使 correct 為 false', () => {
    // 〔堵〕`!q.correct` 單一條件過濾會誤收 VOID——作廢題的 correct 就是 false
    assert.deepEqual(wrongAnsKeys([q('V', { state: QState.VOID, correct: false, mark: 0 })]), []);
  });

  test('順序沿用原卷，且不去重（原卷 H1 才是保證來源）', () => {
    // 〔堵〕在這裡去重會把「原卷違反 H1」這個 bug 靜默吸收掉。
    //       回傳長度必須等於符合條件的題數——比 multiset 不只比 set
    const dup = [
      q('X', { state: QState.LOCKED, correct: false }),
      q('Y', { state: QState.LOCKED, correct: false }),
      q('X', { state: QState.LOCKED, correct: false }),
    ];
    assert.deepEqual(wrongAnsKeys(dup), ['X', 'Y', 'X'], '不得去重、不得改順序');
    assert.equal(wrongAnsKeys(dup).length, 3, '長度必須等於符合條件的題數');
  });

  test('空輸入與 nullish 不得爆炸', () => {
    assert.deepEqual(wrongAnsKeys([]), []);
    assert.deepEqual(wrongAnsKeys(undefined), []);
    assert.deepEqual(wrongAnsKeys(null), []);
  });

  test('全對回合回傳空陣列', () => {
    assert.deepEqual(
      wrongAnsKeys([q('A', { state: QState.LOCKED, correct: true }),
        q('B', { state: QState.LOCKED, correct: true })]), []);
  });
});

// ══ 分層樣本（A31／A35 共用）══════════════════════════════════════════

/**
 * 每層要取的鍵數。**規格 A31 寫的是「各 ≥20 個 distinct 鍵」**——
 * 實作原本寫 6，且 `shortest`／`longest` 只取 3（覆審 M-5）。
 * 「規格宣稱有、實作做弱了」而中間只隔幾小時：
 * **規格與實作由同一人先後完成，並不會讓兩者自動一致。**
 */
const PER_STRATUM = 20;

/**
 * 固定 seed 的分層樣本。
 *
 * 〔堵〕「≥200 個隨機鍵」會有重複、不可重現，而且守備力被資料分布稀釋——
 *       2026-08-07 的 C8 斷言就是這樣錯了很久才被題庫更新照出來。
 * **不寫死鍵名或數量**：題庫每月更新，寫死就會在下一次更新時假紅或假綠。
 *
 * `two`（恰 2 筆）與 `many`（≥5 筆）**分開**，不合併成一個「多筆」池——
 * 合併後按比例判定可能完全沒測到恰 2 筆那一類（覆審 M-14）。
 */
function strata(level, perStratum = PER_STRATUM) {
  const idx = index();
  const el = eligible(level);
  const single = [];
  const two = [];
  const few = [];
  const many = [];
  for (const [ans, recs] of idx.byAns) {
    if (!el.has(ans)) continue;
    if (recs.length === 1) single.push(ans);
    else if (recs.length === 2) two.push(ans);
    else if (recs.length >= 5) many.push(ans);
    else few.push(ans);
  }
  const rng = makeRng(4242);
  const take = (arr, n) => {
    const copy = [...arr];
    for (let i = 0; i < Math.min(n, copy.length); i++) {
      const j = i + Math.floor(rng() * (copy.length - i));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, Math.min(n, copy.length));
  };
  const noFuzzy = [...new Set(POOL.meta.no_fuzzy ?? [])].filter((k) => el.has(k));
  const byLen = [...el].sort((a, b) => a.length - b.length);
  return {
    single: take(single, perStratum),
    two: take(two, perStratum),
    few: take(few, perStratum),
    many: take(many, perStratum),
    noFuzzy: take(noFuzzy, perStratum),
    shortest: byLen.slice(0, perStratum),
    longest: byLen.slice(-perStratum),
    // 母體大小，供「取不滿 20 是資料的上限，不是實作偷懶」的斷言用
    sizes: {
      single: single.length, two: two.length, few: few.length,
      many: many.length, noFuzzy: noFuzzy.length, shortest: el.size, longest: el.size,
    },
  };
}

/**
 * 每層都必須**要嘛取滿 perStratum，要嘛把整層取完**。
 * 〔堵〕悄悄把某層改成只取 3 個，樣本仍「看起來有分層」而守備力掉一個量級
 */
function assertStrataDepth(s, perStratum = PER_STRATUM) {
  for (const k of ['single', 'two', 'few', 'many', 'noFuzzy', 'shortest', 'longest']) {
    const got = s[k].length;
    const pop = s.sizes[k];
    assert.equal(new Set(s[k]).size, got, `${k} 層有重複鍵`);
    assert.ok(got >= Math.min(perStratum, pop),
      `${k} 層只取了 ${got} 個鍵（母體 ${pop}，規格要求 ≥${perStratum} 或取完整層）`);
  }
}

const allStrata = (level) => {
  const s = strata(level);
  assertStrataDepth(s);
  return [...new Set([...s.single, ...s.two, ...s.few, ...s.many, ...s.noFuzzy,
    ...s.shortest, ...s.longest])];
};

// ══ A31 組裝輸出的逐欄契約 ════════════════════════════════════════════

describe('A31 組裝輸出的逐欄契約（固定 seed 分層樣本）', () => {
  for (const level of [Level.L1, Level.L2, Level.L3]) {
    test(`${level}：逐欄契約成立，且輸入未被改動`, () => {
      need();
      const keys = allStrata(level);
      // 七層各 ≥20（或取完整層）→ 去重後不可能低於 PER_STRATUM
      assert.ok(keys.length >= PER_STRATUM * 3,
        `分層樣本僅 ${keys.length} 個 distinct 鍵，樣本過小`);

      const idx = index();
      const before = JSON.stringify(ITEMS.slice(0, 50));
      const keysBefore = [...idx.keys];

      for (const ans of keys) {
        const quiz = drawRetryQuiz(ITEMS, {
          level, ansKeys: [ans], rng: makeRng(7), index: idx, eligible: eligible(level),
        });
        assert.equal(quiz.length, 1);
        const q = quiz[0];
        assert.equal(q.item.ans, ans, `${level} ${ans}：題幹紀錄的答案鍵不符`);
        assert.equal(q.token, 1, 'token 必須由呼叫順序決定');
        assert.equal(q.level, level);
        assert.equal(q.state, QState.PENDING, '新題必須是未作答');
        assert.equal(q.chance, level === Level.L3 ? CHANCE.NONE : CHANCE.FOUR);
        if (level === Level.L3) {
          assert.equal(q.options, undefined, 'L3 不得有選項');
        } else {
          assert.equal(q.options.length, CHOICE_COUNT);
          // I1：正解格必須是**題幹那一筆紀錄本身**
          assert.equal(q.options[q.answerIdx], q.item, 'answerIdx 未指向 correctItem 本身');
          assert.equal(new Set(q.options.map((o) => o.ans)).size, CHOICE_COUNT, 'H1');
        }
      }
      // D20：輸入不得被改動
      assert.equal(JSON.stringify(ITEMS.slice(0, 50)), before, 'items 被改動了');
      assert.deepEqual([...idx.keys], keysBefore, 'index.keys 被改動了');
    });
  }

  test('多題卷：token 連號、H2 成立、整卷驗證通過', () => {
    need();
    const keys = allStrata(Level.L1).slice(0, 8);
    const quiz = drawRetryQuiz(ITEMS, {
      level: Level.L1, ansKeys: keys, rng: makeRng(11), index: index(), eligible: eligible(Level.L1),
    });
    assert.deepEqual(quiz.map((q) => q.token), keys.map((_, i) => i + 1));
    assert.deepEqual(quiz.map((q) => q.item.ans), keys, '正解鍵集合與順序必須恰等於輸入');
    const K = new Set(keys);
    for (const q of quiz) {
      for (const o of q.options) {
        if (o === q.item) continue;
        assert.ok(!K.has(o.ans), `H2：誘答 ${o.ans} 是本卷其他題的正解`);
      }
    }
    assert.deepEqual(validateQuizInvariants(quiz, { level: Level.L1, index: index() }), []);
  });

  test('指定鍵不在 eligible 內 → 拋 KEY_NOT_ELIGIBLE，不得靜默剔除', () => {
    // 〔堵〕「跳過該題繼續」會讓使用者以為自己已複習完全部錯題（D28）
    need();
    const good = allStrata(Level.L2)[0];
    assert.throws(
      () => drawRetryQuiz(ITEMS, {
        level: Level.L2, ansKeys: [good, 'ZZZ_NOT_A_REAL_KEY'],
        rng: makeRng(1), index: index(), eligible: eligible(Level.L2),
      }),
      (e) => e.code === 'KEY_NOT_ELIGIBLE' && e.keys.includes('ZZZ_NOT_A_REAL_KEY'));
  });

  test('空錯題集合 → 拋 EMPTY_RETRY，不得回傳空卷', () => {
    // 〔堵〕回傳 [] 會讓呼叫端建立一個 0 題的複習卷，D29 的 N 變成 0
    need();
    for (const empty of [[], undefined, null]) {
      assert.throws(
        () => drawRetryQuiz(ITEMS, {
          level: Level.L1, ansKeys: empty, index: index(), eligible: eligible(Level.L1),
        }),
        (e) => e.code === 'EMPTY_RETRY');
    }
  });
});

// ══ A32 正解格位置可達性 ══════════════════════════════════════════════

describe('A32 正解格位置可達性（L1／L2 分別驗）', () => {
  for (const level of [Level.L1, Level.L2]) {
    test(`${level}：每一個鍵的 answerIdx 都至少 3 個值可達（逐鍵，非比例）`, () => {
      // 〔堵〕**誘答集合很多樣但正解永遠固定同一格**——位置記憶完全沒被打散。
      //       只驗 L1 的話，L2 固定位置照樣全綠。
      // 規格 A32 是**逐鍵**性質（「同一鍵在指定的不同 RNG 序列下 answerIdx
      // 至少 3 個值可達」），實作原本寫成「80% 的鍵達標」（覆審 M-13）——
      // 比例門檻讓 20% 的鍵可以永遠固定同格而測試全綠，
      // 而規格自己的〔堵〕還特別寫了「統計門檻在合法組合少的鍵上會 flaky」。
      // 樣本刻意涵蓋各層（單筆／恰 2 筆／多筆／noFuzzy／最短／最長）
      need();
      const s = strata(level, 3);
      const keys = [...new Set([...s.single, ...s.two, ...s.few, ...s.many,
        ...s.noFuzzy, ...s.shortest, ...s.longest])];
      assert.ok(keys.length >= 12, `樣本僅 ${keys.length} 個鍵`);
      for (const ans of keys) {
        const seen = new Set();
        for (let seed = 1; seed <= 40; seed++) {
          const [q] = drawRetryQuiz(ITEMS, {
            level, ansKeys: [ans], rng: makeRng(seed), index: index(), eligible: eligible(level),
          });
          seen.add(q.answerIdx);
        }
        assert.ok(seen.size >= 3,
          `${level} ${ans}：40 個序列下 answerIdx 只出現 ${seen.size} 種（${[...seen]}）`);
      }
    });

    test(`${level}：相同 RNG 序列完全重現`, () => {
      need();
      const ans = allStrata(level)[0];
      const one = () => drawRetryQuiz(ITEMS, {
        level, ansKeys: [ans], rng: makeRng(99), index: index(), eligible: eligible(level),
      })[0];
      const a = one();
      const b = one();
      assert.equal(a.answerIdx, b.answerIdx);
      assert.deepEqual(a.options.map((o) => o.id), b.options.map((o) => o.id));
      assert.equal(a.item.id, b.item.id);
    });

    test(`${level}：誘答集合在不同序列下會變`, () => {
      need();
      const ans = allStrata(level)[0];
      const sig = (seed) => drawRetryQuiz(ITEMS, {
        level, ansKeys: [ans], rng: makeRng(seed), index: index(), eligible: eligible(level),
      })[0].options.map((o) => o.ans).sort().join('|');
      const sigs = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(sig));
      assert.ok(sigs.size >= 2, '誘答集合在 8 個不同序列下完全相同 → 沒有真的重抽');
    });
  }
});

// ══ A34 建構器失敗時不回傳部分結果 ════════════════════════════════════

describe('A34 建構器失敗時不回傳部分結果', () => {
  test('中途某鍵不合法 → 整個拋出，不回傳前面已組好的題', () => {
    // 〔堵〕建構器先把部分題寫入共享狀態或回傳部分陣列，
    //       仍符合「有拋錯」這個較弱的描述
    need();
    const keys = allStrata(Level.L1).slice(0, 4);
    let result = 'NOT_THROWN';
    try {
      result = drawRetryQuiz(ITEMS, {
        level: Level.L1, ansKeys: [...keys, 'ZZZ_NOT_A_REAL_KEY'],
        rng: makeRng(3), index: index(), eligible: eligible(Level.L1),
      });
    } catch (e) {
      result = e;
    }
    assert.ok(result instanceof Error, '必須拋出');
    assert.equal(result.code, 'KEY_NOT_ELIGIBLE');
    assert.ok(!Array.isArray(result), '不得回傳部分題卷');
  });

  test('階段 3 的整卷驗證真的接在建構器上（重複鍵 → INVARIANT_VIOLATED）', () => {
    // 〔堵〕`assertQuizInvariants` 在建構器內部，沒有測試逼它動作的話，
    //       整段拿掉也不會有東西轉紅——這正是「防線存在但沒人守著」的形狀。
    //       重複鍵是**真的到得了**的輸入：wrongAnsKeys 刻意不去重
    //       （去重會把「原卷違反 H1」這個 bug 靜默吸收掉），
    //       所以原卷若違反 H1，這裡就是最後一道攔截
    need();
    const ans = allStrata(Level.L1)[0];
    assert.throws(
      () => drawRetryQuiz(ITEMS, {
        level: Level.L1, ansKeys: [ans, ans],
        rng: makeRng(3), index: index(), eligible: eligible(Level.L1),
      }),
      (e) => e.code === 'INVARIANT_VIOLATED'
        && e.violations.some((v) => v.startsWith('[H1]')),
      '重複的錯題鍵必須被整卷驗證擋下，不得組出一份違反 H1 的複習卷');
  });

  /**
   * 合成題庫：讓失敗**發生在組題迴圈中途**，而不是被前置檢查提前擋下。
   *
   * 〔堵〕原本的注入用假鍵（`ZZZ_NOT_A_REAL_KEY`），而 `drawRetryQuiz` 的
   *       `KEY_NOT_ELIGIBLE` 檢查排在組題迴圈**之前**——那條測試根本沒進到迴圈，
   *       「先寫入部分結果再拋錯」因此完全沒被覆蓋（覆審 M-11）。
   *
   * 構造：兩群同形同色、刻字互異的紀錄。
   * - `ROUND/WHITE`：`ALPHAZOL` ＋ 5 個 filler（filler 不在 ansKeys 內）
   * - `OVAL/BLUE`：6 個彼此就是彼此**僅有**候選的鍵
   *
   * 每個鍵單獨看都 eligible（各有 5 個候選，等於 L2 的 `DISTRACTOR_COUNT`），
   * 因此前置檢查全數放行；但整卷的 `excludeAns` 含全部 6 個 OVAL 鍵之後，
   * 第 2 題起再也湊不到誘答 → 迴圈中途拋 `NO_DISTRACTORS`。
   *
   * 藥名刻意兩兩差異極大：`nameCollides` 把編輯距離 ≤1 與前綴關係都判為碰撞，
   * `FILLER1MIDE`／`FILLER2MIDE` 這種序號命名會讓整個合成題庫變成不 eligible。
   */
  const rec = (ans, shape, color, mark1) => ({
    id: `${ans}-1`, ans, full: `${ans} 10MG`, zh: `合成藥${ans}`,
    img: `img/${ans}.webp`, shape: [shape], color: [color],
    score_mark: ['無'], size: '8', mark1, mark2: '',
  });
  const ROUND_KEYS = ['ALPHAZOL', 'BRAVOMYCIN', 'CHARLIEPINE', 'DELTACORT',
    'ECHOSTATIN', 'FOXTROMIDE'];
  const OVAL_KEYS = ['GOLFACIN', 'HOTELAMIDE', 'INDIAZINE', 'JULIETTEX',
    'KILOPRIL', 'LIMAFENAC'];
  const MARKS = ['AA', 'BB', 'CC', 'DD', 'EE', 'FF'];
  const SYNTH = [
    ...ROUND_KEYS.map((k, i) => rec(k, 'ROUND', 'WHITE', `R${MARKS[i]}`)),
    ...OVAL_KEYS.map((k, i) => rec(k, 'OVAL', 'BLUE', `O${MARKS[i]}`)),
  ];

  test('組題迴圈**中途**湊不出誘答 → 整個拋出，不回傳部分題卷', () => {
    need();
    const idx = buildIndex(SYNTH);
    const el = eligibleKeys(idx, Level.L2);
    const keys = [ROUND_KEYS[0], ...OVAL_KEYS];

    // 前置條件：這些鍵**全部通過 eligible 前置檢查**——
    // 沒有這一條，這條測試就會退化成又一次 KEY_NOT_ELIGIBLE
    for (const k of keys) assert.ok(el.has(k), `前置條件失效：${k} 未被判為 eligible`);

    // 前置條件：分開組都成得了，證明失敗是「整卷 excludeAns 造成的」而非鍵本身壞掉
    for (const k of [keys[0], keys[1]]) {
      const solo = drawRetryQuiz(SYNTH, {
        level: Level.L2, ansKeys: [k], rng: makeRng(5), index: idx, eligible: el,
      });
      assert.equal(solo.length, 1, `${k} 單獨組不出來，前置條件不成立`);
    }

    let result = 'NOT_THROWN';
    try {
      result = drawRetryQuiz(SYNTH, {
        level: Level.L2, ansKeys: keys, rng: makeRng(5), index: idx, eligible: el,
      });
    } catch (e) {
      result = e;
    }
    assert.ok(result instanceof Error, '必須拋出，不得回傳已組好的那幾題');
    assert.ok(!Array.isArray(result), '不得回傳部分題卷');
    assert.equal(result.code, 'QUIZ_ASSEMBLY_FAILED',
      `迴圈中途的 NO_DISTRACTORS 應由整卷重試兜底後轉為 QUIZ_ASSEMBLY_FAILED，實得 ${result.code}`);

    // D20：失敗路徑也不得改動輸入
    assert.equal(SYNTH.length, 12);
    assert.deepEqual([...idx.byAns.keys()].sort(), [...new Set(SYNTH.map((r) => r.ans))].sort());
  });

  test('失敗時輸入 items 與 index 深度不變（D20）', () => {
    need();
    const idx = index();
    const snapshot = {
      keys: [...idx.keys],
      sizes: [...idx.byAns].map(([k, v]) => [k, v.length]),
    };
    assert.throws(() => drawRetryQuiz(ITEMS, {
      level: Level.L1, ansKeys: ['ZZZ_NOT_A_REAL_KEY'],
      rng: makeRng(3), index: idx, eligible: eligible(Level.L1),
    }));
    assert.deepEqual([...idx.keys], snapshot.keys);
    assert.deepEqual([...idx.byAns].map(([k, v]) => [k, v.length]), snapshot.sizes);
  });
});

// ══ A35 紀錄重抽（三級都要）═══════════════════════════════════════════

describe('A35 紀錄重抽用固定 RNG（L1／L2／L3 各驗）', () => {
  for (const level of [Level.L1, Level.L2, Level.L3]) {
    test(`${level}：單筆紀錄的鍵必成功且沿用該唯一紀錄`, () => {
      need();
      const s = strata(level);
      assert.ok(s.single.length, `${level} 找不到單筆紀錄的鍵`);
      for (const ans of s.single) {
        const only = index().byAns.get(ans)[0];
        for (const seed of [1, 2, 3]) {
          const [q] = drawRetryQuiz(ITEMS, {
            level, ansKeys: [ans], rng: makeRng(seed), index: index(), eligible: eligible(level),
          });
          assert.equal(q.item, only, `${level} ${ans}：單筆紀錄必須沿用那一筆本身`);
        }
      }
    });

    // 規格明寫「多筆至少覆蓋**恰 2 筆**及**高 multiplicity** 類別」。
    // 原本把 2–4 筆與 ≥5 筆合併成一個池再算比例，**可能完全沒測到恰 2 筆**
    // （覆審 M-14）；且比例門檻允許 20% 的鍵永遠沿用原圖（覆審 M-13）。
    for (const [label, pick] of [['恰 2 筆', (s) => s.two], ['≥5 筆', (s) => s.many]]) {
      test(`${level}：${label}紀錄的鍵**逐鍵**都換得到不同 id，同序列可重現`, () => {
        // 〔堵〕**只驗 L3**——D28 對 L1／L2 也要求重抽正解格圖片，
        //       L1／L2 永遠沿用原圖照樣全綠
        need();
        const s = strata(level);
        const pool = pick(s);
        assert.ok(pool.length, `${level} 找不到${label}紀錄的鍵`);
        for (const ans of pool) {
          const n = index().byAns.get(ans).length;
          const ids = new Set();
          for (let seed = 1; seed <= 30; seed++) {
            const [q] = drawRetryQuiz(ITEMS, {
              level, ansKeys: [ans], rng: makeRng(seed), index: index(), eligible: eligible(level),
            });
            ids.add(q.item.id);
          }
          assert.ok(ids.size >= 2,
            `${level} ${ans}（${n} 筆紀錄）：30 個序列下都是同一筆 —— 沒有真的重抽`);
        }

        const ans = pool[0];
        const one = (seed) => drawRetryQuiz(ITEMS, {
          level, ansKeys: [ans], rng: makeRng(seed), index: index(), eligible: eligible(level),
        })[0].item.id;
        assert.equal(one(5), one(5), '同序列必須重現');
      });
    }
  }
});

// ══ 整卷規模邊界（對應 C37 的 N=1／N=20，純函式層先守一次）══════════

describe('錯題卷規模邊界', () => {
  for (const level of [Level.L1, Level.L2, Level.L3]) {
    test(`${level}：N=1 與 N=${QUIZ_SIZE} 都組得出來且整卷驗證通過`, () => {
      need();
      const el = eligible(level);
      const keys = [...el].slice(0, QUIZ_SIZE);
      for (const n of [1, QUIZ_SIZE]) {
        const quiz = drawRetryQuiz(ITEMS, {
          level, ansKeys: keys.slice(0, n), rng: makeRng(2026), index: index(), eligible: el,
        });
        assert.equal(quiz.length, n, `N=${n} 的複習卷題數不符`);
        assert.deepEqual(validateQuizInvariants(quiz, { level, index: index() }), [],
          `N=${n} 未通過整卷驗證`);
      }
    });
  }
});
