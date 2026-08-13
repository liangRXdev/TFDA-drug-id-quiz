/**
 * V5.2 測驗卷長選項（10 / 20 題）— 驗收 A46–A67、變異 M1–M15。
 *
 * 規格：`.ai-review/plan-v52-quiz-length.md` v5.2-r3
 * 覆審：`plan-review-v52.md` → `plan-verdict-v52.md` → `plan-verdict-v52-r2.md`
 *
 * **本檔每一條都對應一個「堵死的弱化版本」**，寫在該測試的〔堵〕註解裡。
 * 兩輪覆審的教訓：加固過的斷言仍會有洞——A56 原本用「token 集合相同」證明
 * probe identity，而 `token: i + 1` 讓任意兩份同長度題卷的 token 集合恆等。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, ROOT } from './_ui-harness.mjs';
import {
  Level, QUIZ_SIZE, QUIZ_LENGTHS, MIN_QUIZ_LEN, DEFAULT_QUIZ_LEN, DECK_SIZE,
  CHOICE_COUNT, buildIndex, eligibleKeys, drawLeveledQuiz, makeRng, validateQuizInvariants,
} from '../engine.js';

const hasPool = fs.existsSync(path.join(ROOT, 'data/pool.json'));
const dom = installDom();
const { $, hidden, store } = dom;

if (hasPool) {
  await import(`file://${path.join(ROOT, 'app.js').replace(/\\/g, '/')}`);
  await new Promise((r) => setTimeout(r, 300));
}

const needPool = () => assert.ok(hasPool, 'data/pool.json 不存在，請先執行 npm run build:pool');
const KEY = 'tfda-drug-id-quiz:records';
const POOL = hasPool
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data/pool.json'), 'utf8'))
  : { items: [] };
const POOL_HASH = String(POOL.meta?.content_hash || '').replace(/^sha256:/, '').slice(0, 12);
let IDX = null;
const idx = () => (IDX ||= buildIndex(POOL.items));
const levelCards = () => $('levelPick').querySelectorAll('.level');
const lenButtons = () => $('lenPick').querySelectorAll('.qlen');
const lenBtn = (len) => lenButtons().find((b) => Number(b.dataset.len) === len);
const stored = () => {
  const raw = store.map.get(KEY);
  return raw == null ? null : JSON.parse(raw);
};

const REAL_RANDOM = Math.random;
after(() => { Math.random = REAL_RANDOM; });

/**
 * 開一回合：選難度 → 選卷長 → 開始。**卷長由參數指定並實際點下去**，
 * 不直接設 state——A46／A64 要驗的就是「UI 選了 10、引擎真的收到 10」這條線。
 */
function startRound(level, len, seed) {
  const expected = drawLeveledQuiz(POOL.items, {
    level, n: len, rng: makeRng(seed), index: idx(), eligible: eligibleKeys(idx(), level),
  });
  Math.random = makeRng(seed);
  levelCards().find((l) => l.dataset.level === level).click();
  lenBtn(len).click();
  $('btnStart').click();
  return expected;
}

/** 走完一整卷 L1，`pattern` 決定每題答對與否 */
function playL1(len, seed, pattern, { reset = true } = {}) {
  const f = [...pattern].map((c) => c === 'T');
  assert.equal(f.length, len, 'pattern 長度必須等於卷長');
  if (reset) $('btnAgain').click();
  const expected = startRound(Level.L1, len, seed);
  for (let i = 0; i < len; i++) {
    const opts = $('qOptions').querySelectorAll('.opt');
    const ai = expected[i].answerIdx;
    opts[f[i] ? ai : (ai + 1) % CHOICE_COUNT].click();
    $('btnNext').click();
  }
  assert.ok(!hidden('result'), '未走到成績頁');
  return expected;
}

const P10_ALL = 'T'.repeat(10);
const P10_70_4 = 'TTTTFTTFTF';        // 7 對 → 70 分，最長連對 4
const entry = (v, date = '2026-08-01') => ({ value: v, date, pool: POOL_HASH });
const seed10 = (obj) => store.map.set(KEY, JSON.stringify({ schema: 1, ...obj }));

// ════════════════════════════════════════════════════════════════════
describe('A46 從 UI 選 10 題並開始：引擎確實收到 10，且題卷獨立通過不變量', () => {
  before(needPool);

  for (const level of [Level.L1, Level.L2, Level.L3]) {
    test(`${level}：卷長恰為 10、正解鍵兩兩相異、誘答不含他題正解`, () => {
      store.reset();
      $('btnAgain').click();
      const quiz = startRound(level, 10, 3300 + level.length);
      assert.equal(quiz.length, 10);
      assert.equal(Number($('qTotal').textContent), 10,
        '答題頁分母不是 10——UI 沒把選定卷長傳下去');

      // 〔堵〕用受測程式自己的 validator 自證。這裡以測試獨立重建的 index 再驗一次
      assert.deepEqual(validateQuizInvariants(quiz, { level, index: buildIndex(POOL.items) }), []);
      const corrects = new Set(quiz.map((q) => q.item.ans));
      assert.equal(corrects.size, 10, '正解鍵有重複');
      for (const q of quiz) {
        for (const o of q.options ?? []) {
          if (o === q.item) continue;
          assert.ok(!corrects.has(o.ans), `誘答 ${o.ans} 屬於本卷正解集合（H2）`);
        }
      }
    });
  }
});

// ════════════════════════════════════════════════════════════════════
describe('A47／A48.1 紀錄：兩個卷長各存各的，且「只有 10 題」是合法形狀', () => {
  before(needPool);

  /**
   * A48.1／R-1：**這是第二輪覆審唯一的 High 資料模型缺口。**
   *
   * 〔堵〕沿用 v5.2-r1 的 `validRecord`（要求頂層 bestScore/bestStreak 都在）——
   * 第一次就選 10 題的使用者會看到「新紀錄！」，重整後整個難度被判損毀而消失。
   */
  test('空 storage → 第一卷就是 10 題 → 重讀仍在，且頂層 20 題格仍缺席', () => {
    store.reset();
    playL1(10, 3401, P10_70_4);

    const raw = stored();
    assert.ok(raw, '第一回合完成後應有紀錄');
    assert.equal(raw.schema, 1, 'schema 不得升版（舊版要讀得懂頂層）');
    assert.equal(raw.L1.byLen['10'].bestScore.value, 70);
    assert.equal(raw.L1.byLen['10'].bestStreak.value, 4);
    assert.equal(raw.L1.bestScore, undefined, '沒跑過 20 題卷，頂層不該被憑空造出來');
    assert.equal(raw.L1.bestStreak, undefined);
    assert.ok(!hidden('recordFlash'), '應顯示「新紀錄！」');

    // 重讀：起始頁必須真的顯示它（宣稱已保存就要真的讀得回來）
    $('btnAgain').click();
    assert.ok(!hidden('recordsBox'), '重讀後紀錄整塊消失了——第四態被判成損毀');
    assert.match($('recordsSummary').textContent, /10 題 70\.0/);
  });

  test('A47 10 題破紀錄後，同難度 20 題格逐欄不變；反向亦然', () => {
    store.reset();
    seed10({
      L1: { bestScore: entry(85), bestStreak: entry(17), byLen: { 10: { bestScore: entry(40), bestStreak: entry(3) } } },
      L2: { bestScore: entry(55), bestStreak: entry(9) },
    });
    const before20 = JSON.stringify(stored().L1.bestScore);
    const beforeStreak20 = JSON.stringify(stored().L1.bestStreak);
    const beforeL2 = JSON.stringify(stored().L2);

    playL1(10, 3402, P10_70_4);        // 70 分 > 40 → 10 題格更新

    const after = stored();
    assert.equal(after.L1.byLen['10'].bestScore.value, 70, '10 題格未更新');
    // 〔堵〕兩格都不更新也符合「另一格不變」——所以先驗目標格真的動了
    assert.equal(JSON.stringify(after.L1.bestScore), before20, '20 題格被 10 題卷改到了');
    assert.equal(JSON.stringify(after.L1.bestStreak), beforeStreak20);
    assert.equal(JSON.stringify(after.L2), beforeL2, '其他難度被波及');
  });

  test('A47 反向：20 題卷不得改到 10 題格', () => {
    store.reset();
    seed10({ L1: { bestScore: entry(10), bestStreak: entry(1), byLen: { 10: { bestScore: entry(90), bestStreak: entry(9) } } } });
    const before10 = JSON.stringify(stored().L1.byLen['10']);

    $('btnAgain').click();
    const quiz = startRound(Level.L1, QUIZ_SIZE, 3403);
    for (let i = 0; i < QUIZ_SIZE; i++) {
      $('qOptions').querySelectorAll('.opt')[quiz[i].answerIdx].click();
      $('btnNext').click();
    }
    const after = stored();
    assert.equal(after.L1.bestScore.value, 100, '20 題格未更新');
    assert.equal(JSON.stringify(after.L1.byLen['10']), before10, '10 題格被 20 題卷改到了');
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A49／A51／A52／A53 紀錄 predicate：兩項各自的完整反例組', () => {
  before(needPool);

  const reread = () => { $('btnAgain').click(); return $('recordsSummary').textContent; };

  /**
   * 〔堵〕只特判 `bestScore === 101`。弱化的 validator 可以完整驗 score，
   * 卻對 `bestStreak` 的缺失／字串／負數／非整數照單全收（判定 V-4）。
   */
  const BAD = [
    ['bestScore 超上界', { bestScore: entry(101), bestStreak: entry(5) }],
    ['bestScore 負值', { bestScore: entry(-1), bestStreak: entry(5) }],
    ['bestScore NaN', { bestScore: entry(NaN), bestStreak: entry(5) }],
    ['bestScore 字串', { bestScore: entry('80'), bestStreak: entry(5) }],
    ['bestScore 缺欄', { bestStreak: entry(5) }],
    ['bestStreak 超該格卷長', { bestScore: entry(80), bestStreak: entry(11) }],
    ['bestStreak 負值', { bestScore: entry(80), bestStreak: entry(-1) }],
    ['bestStreak 非整數', { bestScore: entry(80), bestStreak: entry(5.5) }],
    ['bestStreak 字串', { bestScore: entry(80), bestStreak: entry('5') }],
    ['bestStreak 缺欄', { bestScore: entry(80) }],
    ['date 格式錯', { bestScore: entry(80, '2026/08/01'), bestStreak: entry(5) }],
    ['pool 格式錯', { bestScore: { value: 80, date: '2026-08-01', pool: 'XX' }, bestStreak: entry(5) }],
  ];

  for (const [label, slot] of BAD) {
    test(`A49 10 題格 ${label} → 丟棄該難度整組，其他難度保留`, () => {
      store.reset();
      seed10({
        L1: { bestScore: entry(88), bestStreak: entry(15), byLen: { 10: slot } },
        L2: { bestScore: entry(55), bestStreak: entry(9) },
      });
      const txt = reread();
      assert.ok(!/簡單/.test(txt), `${label}：該難度應整組丟棄（含頂層 20 題）`);
      assert.match(txt, /中級 20 題 55\.0/, '其他難度不該被波及');
    });
  }

  test('A49／A51 合法邊界必須被接受（否則「全部拒絕」也能讓上面那些綠）', () => {
    store.reset();
    seed10({
      L1: { byLen: { 10: { bestScore: entry(0), bestStreak: entry(0) } } },
      L2: { byLen: { 10: { bestScore: entry(100), bestStreak: entry(10) } } },
      L3: { bestScore: entry(100), bestStreak: entry(QUIZ_SIZE) },
    });
    const txt = reread();
    assert.match(txt, /簡單 10 題 0\.0/, 'score 0 是合法值');
    assert.match(txt, /中級 10 題 100\.0/, 'streak 恰等於卷長 10 是合法值');
    assert.match(txt, /困難 20 題 100\.0/, 'streak 恰等於 20 是合法值');
  });

  test('A51 10 題格的 bestStreak 上界是 10 而非 QUIZ_SIZE', () => {
    // 〔堵〕M3：上界寫死 QUIZ_SIZE，10 題格接受 11–20 的連對
    store.reset();
    seed10({ L1: { byLen: { 10: { bestScore: entry(90), bestStreak: entry(11) } } } });
    assert.ok(!/簡單/.test(reread()), '10 題卷不可能有 11 連對');
  });

  test('A52 未知卷長與錯位 key 一律忽略，且不觸發 E6', () => {
    // 〔堵〕只特判 "15"；或採信 byLen["20"] 而讓 20 題出現兩個真相來源
    store.reset();
    seed10({
      L1: {
        bestScore: entry(88), bestStreak: entry(15),
        byLen: {
          10: { bestScore: entry(70), bestStreak: entry(6) },
          15: { bestScore: entry(99), bestStreak: entry(14) },
          abc: { bestScore: entry(99), bestStreak: entry(3) },
          20: { bestScore: entry(99), bestStreak: entry(19) },
        },
      },
    });
    const txt = reread();
    assert.match(txt, /簡單 10 題 70\.0／20 題 88\.0/, '已知格應精確採信');
    assert.ok(!/99\.0/.test(txt), '未知卷長或錯位 byLen["20"] 被採信了');
  });

  test('A53 byLen 不是 plain object → 視為損毀，丟該難度', () => {
    for (const bad of [[], 'x', 5]) {
      store.reset();
      seed10({
        L1: { bestScore: entry(88), bestStreak: entry(15), byLen: bad },
        L2: { bestScore: entry(55), bestStreak: entry(9) },
      });
      const txt = reread();
      assert.ok(!/簡單/.test(txt), `byLen=${JSON.stringify(bad)} 應視為損毀`);
      assert.match(txt, /中級/, '其他難度保留');
    }
  });

  test('A53 schema > 1（未來版本）→ 整份不採信，且零 mutation（E5 不因本輪鬆動）', () => {
    for (const schema of [2, 3, 99, '1']) {
      store.reset();
      store.map.set(KEY, JSON.stringify({ schema, L1: { bestScore: entry(90), bestStreak: entry(9) } }));
      const raw = store.map.get(KEY);
      const before = store.mutations().length;
      assert.ok(!/簡單/.test(reread()), `schema=${JSON.stringify(schema)} 不得採信`);
      assert.equal(store.map.get(KEY), raw, '讀取路徑動了 storage');
      assert.equal(store.mutations().length, before, '讀取路徑有 mutation');
    }
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A50 零 mutation 的證明不只靠 method spy', () => {
  before(needPool);

  test('純讀取、損毀資料、未破紀錄的回合 → keyspace 與 raw 內容全等', () => {
    // 〔堵〕M15：以 named property assignment 寫 storage，三個 method spy 全都看不到
    store.reset();
    seed10({ L1: { byLen: { 10: { bestScore: entry(100), bestStreak: entry(10) } } } });
    const snapKeys = JSON.stringify([...store.map.keys()].sort());
    const snapRaw = JSON.stringify([...store.map]);
    const snapMut = store.mutations().length;

    $('btnAgain').click();                       // 純讀取
    assert.equal(JSON.stringify([...store.map]), snapRaw, '讀取改了 storage');

    // 滿分 sentinel：跑完一回合但**破不了紀錄** → 必須零 mutation
    playL1(10, 3501, P10_70_4);
    assert.equal(JSON.stringify([...store.map.keys()].sort()), snapKeys, 'keyspace 變了');
    assert.equal(JSON.stringify([...store.map]), snapRaw, '未破紀錄卻寫了 storage');
    assert.equal(store.mutations().length, snapMut);
  });

  test('破紀錄後恰好一次 setItem，key 精確，內容是完整的 schema:1 結構', () => {
    store.reset();
    const before = store.mutations().length;
    playL1(10, 3502, P10_ALL);
    const muts = store.mutations().slice(before);
    assert.equal(muts.length, 1, `應恰好一次 mutation，實際 ${muts.length}`);
    assert.equal(muts[0].op, 'setItem');
    assert.equal(muts[0].key, KEY);
    assert.equal(stored().schema, 1);
    assert.equal(stored().L1.byLen['10'].bestScore.value, 100);
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A64／A65 UI 與資料層的一致性', () => {
  before(needPool);

  test('A64 aria-checked、CTA 文字、實際卷長三者都等於 literal 10', () => {
    // 〔堵〕忽略「選 10」，把三者同步改成 20——「三者相等」照樣成立（判定 V-9）
    store.reset();
    $('btnAgain').click();
    levelCards().find((l) => l.dataset.level === Level.L1).click();
    lenBtn(10).click();
    assert.equal(lenBtn(10).getAttribute('aria-checked'), 'true');
    assert.equal(lenBtn(QUIZ_SIZE).getAttribute('aria-checked'), 'false');
    assert.match($('btnStart').textContent, /開始 10 題測驗/);

    Math.random = makeRng(3601);
    $('btnStart').click();
    assert.equal(Number($('qTotal').textContent), 10);
  });

  test('A64 預設是 20，且未選難度時 CTA 仍 disabled', () => {
    $('btnAgain').click();
    assert.equal(DEFAULT_QUIZ_LEN, QUIZ_SIZE);
    assert.equal(lenBtn(QUIZ_SIZE).getAttribute('aria-checked'), 'true');
    assert.equal($('btnStart').disabled, true);
  });

  test('A65 摘要必須帶卷長標籤，且可見文字不等於任一單值或 max', () => {
    // 〔堵〕M8：跨卷長取 max。隱藏節點偽造由「可見文字」這一層擋
    store.reset();
    seed10({ L1: { bestScore: entry(85), bestStreak: entry(17), byLen: { 10: { bestScore: entry(90), bestStreak: entry(9) } } } });
    $('btnAgain').click();
    const txt = $('recordsSummary').textContent;
    assert.match(txt, /10 題 90\.0/, '缺 10 題的值或標籤');
    assert.match(txt, /20 題 85\.0/, '缺 20 題的值或標籤');
    assert.notEqual(txt.trim(), '簡單 90.0', '取了 max');
    assert.notEqual(txt.trim(), '簡單 85.0');
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A61 10 題卷的結算：分母、計分題數與 retry 集合', () => {
  before(needPool);

  test('無作廢：header 分母恆為 10、counted 為 10、紀錄進 10 題格', () => {
    store.reset();
    playL1(10, 3701, P10_70_4);
    assert.match($('resultMetrics').innerHTML, /70\.0/, '總分應為 70');
    assert.match($('reviewBody').innerHTML, /<tr>/, '逐題檢討空白');
    assert.equal(stored().L1.byLen['10'].bestScore.value, 70);
    assert.equal(stored().L1.bestScore, undefined, '不得寫進 20 題格');
    // retry 入口的數字必須等於實際錯題鍵數（3 題答錯）
    assert.equal(Number($('btnRetryN').textContent), 3);
  });

  test('A60 閃卡張數不受卷長影響（執行期，但證明不了解耦）', () => {
    // **不宣稱這證明了解耦**：本輪 QUIZ_SIZE 仍是 20，別名與獨立常數的執行期行為
    // 完全相同。真正的契約是原始碼形狀，見下一條
    assert.equal(DECK_SIZE, 20);
    store.reset();
    playL1(10, 3702, P10_ALL);
    assert.equal(DECK_SIZE, 20, '跑完 10 題卷後閃卡張數被改了');
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A60 DECK_SIZE 解耦：source-shape 契約（明確標註非行為證據）', () => {
  /**
   * 〔堵〕(a) 改回 `DECK_SIZE = QUIZ_SIZE` 別名；
   *       (b) 經中介常數繞過識別字檢查（`const X = QUIZ_SIZE; DECK_SIZE = X`）；
   *       (c) 讓閃卡消費點直接改讀 `QUIZ_SIZE`（判定 V-8）。
   *
   * **掃描前一定要剝註解。** 本檔上方與 engine.js 的註解裡都寫著
   * 「不寫成 QUIZ_SIZE 的別名」——說明性文字幾乎一定會複述被搜尋的關鍵字，
   * 不剝就會讓這條測試恆綠或恆紅，兩種都證明不了東西。
   */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  test('DECK_SIZE 是獨立 literal，定義不經由任何識別字', () => {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8'));
    const m = src.match(/export\s+const\s+DECK_SIZE\s*=\s*([^;]+);/);
    assert.ok(m, '找不到 DECK_SIZE 的定義');
    const rhs = m[1].trim();
    assert.match(rhs, /^\d+$/, `DECK_SIZE 必須是獨立數字 literal，實際是「${rhs}」`);
  });

  test('剝註解的掃描本身有效（防恆綠：未剝時 engine.js 確實含該字串）', () => {
    // 這條守著上一條的前提。若哪天註解改寫、剝除邏輯失效，這裡會先紅
    const raw = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
    assert.ok(/別名/.test(raw), 'engine.js 的註解應提到「別名」——前提變了請重看上一條');
    assert.ok(!/別名/.test(stripComments(raw)), '剝註解沒有生效');
  });

  test('閃卡消費點仍讀 DECK_SIZE，不是改讀 QUIZ_SIZE', () => {
    const app = stripComments(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'));
    const line = app.split('\n').find((l) => l.includes("$('fTotal')"));
    assert.ok(line, '找不到閃卡總數的渲染點');
    assert.match(line, /DECK_SIZE/, `閃卡總數改讀了別的常數：${line.trim()}`);
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A59 全域開機門檻的兩側邊界（D52）', () => {
  test('門檻是最短卷長而非 QUIZ_SIZE', () => {
    // 〔堵〕維持 `keys.size < QUIZ_SIZE` → 一個只出得起 10 題的題庫被整個判死
    assert.equal(MIN_QUIZ_LEN, 10);
    assert.equal(MIN_QUIZ_LEN, Math.min(...QUIZ_LENGTHS), '最小卷長必須由 QUIZ_LENGTHS 導出');
    const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const line = src.split('\n').find((l) => /keys\.size <\s*\w+/.test(l));
    assert.ok(line, '找不到開機門檻那一行');
    assert.match(line, /MIN_QUIZ_LEN/, `開機門檻仍寫死較大的值：${line.trim()}`);
  });
});
