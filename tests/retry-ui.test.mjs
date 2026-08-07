/**
 * M5 錯題再戰 — 跨層（規格 plan-v4-engagement.md 的 C28–C30、C34–C39）
 *
 *   node --test
 *
 * **這個檔存在的理由與 engagement-ui 相同**：`retry.test.mjs` 證明 engine 算得對，
 * 證明不了「按鈕存在、點下去真的出題、返回真的拿回原成績」。
 * 純函式全綠而功能靜默不存在，是這個 repo 已經發生三次的形狀。
 *
 * 樁的 `getElementById` 會自動生出沒宣告過的元素 → 忘記改 index.html 仍會全綠。
 * 那個假綠燈由本檔最後的「DOM 掛點確實存在於 index.html」那組守著。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, ROOT } from './_ui-harness.mjs';
import {
  Level, QUIZ_SIZE, CHOICE_COUNT, QState,
  buildIndex, eligibleKeys, drawLeveledQuiz, makeRng, wrongAnsKeys,
} from '../engine.js';

const hasPool = fs.existsSync(path.join(ROOT, 'data/pool.json'));
const dom = installDom();
const { $, drawn, hidden, store } = dom;

if (hasPool) {
  await import(`file://${path.join(ROOT, 'app.js').replace(/\\/g, '/')}`);
  await new Promise((r) => setTimeout(r, 300));
}

const needPool = () => assert.ok(hasPool, 'data/pool.json 不存在，請先執行 npm run build:pool');
const KEY = 'tfda-drug-id-quiz:records';
const POOL = hasPool
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data/pool.json'), 'utf8'))
  : { items: [] };
let IDX = null;
const idx = () => (IDX ||= buildIndex(POOL.items));
const levelCards = () => $('levelPick').querySelectorAll('.level');
const srcOf = (item) => `data/${item.img}`;
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const REAL_RANDOM = Math.random;
after(() => { Math.random = REAL_RANDOM; });

const flags = (s) => [...s].map((c) => c === 'T');

function startLevel(level, seed) {
  const expected = drawLeveledQuiz(POOL.items, {
    level, n: QUIZ_SIZE, rng: makeRng(seed), index: idx(), eligible: eligibleKeys(idx(), level),
  });
  Math.random = makeRng(seed);
  levelCards().find((l) => l.dataset.level === level).click();
  $('btnStart').click();
  return expected;
}

/** 走完一整回合 L1，逐題依 pattern 決定答對或答錯 */
function playL1(seed, pattern) {
  const f = flags(pattern);
  assert.equal(f.length, QUIZ_SIZE);
  $('btnAgain').click();
  const expected = startLevel(Level.L1, seed);
  for (let i = 0; i < QUIZ_SIZE; i++) {
    const opts = $('qOptions').querySelectorAll('.opt');
    const ai = expected[i].answerIdx;
    opts[f[i] ? ai : (ai + 1) % CHOICE_COUNT].click();
    $('btnNext').click();
  }
  assert.ok(!hidden('result'), '未走到成績頁');
  return expected;
}

function playL3(seed, pattern) {
  const f = flags(pattern);
  $('btnAgain').click();
  const expected = startLevel(Level.L3, seed);
  for (let i = 0; i < QUIZ_SIZE; i++) {
    $('qInput').value = f[i] ? expected[i].item.ans : 'ZZZWRONGNAME';
    $('btnSubmit').click();
    $('btnNext').click();
  }
  assert.ok(!hidden('result'));
  return expected;
}

/**
 * 走完目前這份**複習卷**（L3；題數由畫面上的總題數決定）。
 * 一律答錯——複習卷的正解格由 `Math.random` 決定，測試不預期它。
 */
function playRetryWrong() {
  const n = Number($('qTotal').textContent);
  for (let i = 0; i < n; i++) {
    $('qInput').value = 'ZZZWRONGNAME';
    $('btnSubmit').click();
    $('btnNext').click();
  }
  return n;
}

const P_ALL = 'T'.repeat(QUIZ_SIZE);
const P_15WRONG = 'TTTTTFFFFFFFFFFFFFFF';   // 5 對 15 錯
const P_1WRONG = 'TTTTTTTTTTTTTTTTTTTF';    // 19 對 1 錯

/** 目前畫面上的複習卷正解鍵集合，由逐題檢討反推 */
const reviewAnsKeys = () => [...$('reviewBody').innerHTML.matchAll(/<td class="ans">([^<]*)<\/td>/g)]
  .map((m) => m[1]);

describe('C37 M5 完整跨層成功流程', () => {
  before(needPool);

  test('L3：控制項存在且帶錯題數 → 點擊 → 複習卷 → D29 結算 → 返回原成績', () => {
    store.reset();
    const expected = playL3(3101, P_15WRONG);
    const originKeys = wrongAnsKeys(
      expected.map((q, i) => ({ ...q, state: QState.LOCKED, correct: flags(P_15WRONG)[i] })));
    assert.equal(originKeys.length, 15);

    // ── 原結算頁：控制項存在且文字含實際錯題數（D33）──
    assert.ok(!hidden('btnRetry'), '錯題再戰控制項不存在');
    assert.equal(Number($('btnRetryN').textContent), 15, '控制項未顯示實際錯題數');
    const originSub = $('resultSub').textContent;
    const originReview = $('reviewBody').innerHTML;

    // ── 點擊 → 進入複習卷 ──
    $('btnRetry').click();
    assert.ok(!hidden('quiz'), '未進入答題頁');
    assert.ok(hidden('result'));
    assert.equal(Number($('qTotal').textContent), 15, '複習卷題數不等於錯題數');
    assert.ok(!hidden('qRetryTag'), '複習模式標示未顯示');

    assert.equal(playRetryWrong(), 15);

    // ── D29 結算頁 ──
    assert.ok(!hidden('result'), '未走到複習結算頁');
    assert.equal($('resultTitle').textContent, '錯題複習結果');
    assert.equal($('resultSub').textContent, '本次 15 題答對 0 題');
    assert.deepEqual(reviewAnsKeys().sort(), [...originKeys].sort(),
      '複習卷的正解鍵集合必須恰等於原卷錯題鍵集合');

    // ── 返回原成績 ──
    assert.ok(!hidden('btnBackToOrigin'), '返回控制項不存在');
    $('btnBackToOrigin').click();
    assert.equal($('resultTitle').textContent, '測驗結果');
    assert.equal($('resultSub').textContent, originSub, '返回後原結算頁的摘要不符');
    assert.equal($('reviewBody').innerHTML, originReview, '返回後逐題檢討不是原卷的');
  });

  test('N=1 邊界：只有一題錯也要走得完', () => {
    store.reset();
    playL3(3102, P_1WRONG);
    assert.equal(Number($('btnRetryN').textContent), 1);
    $('btnRetry').click();
    assert.equal(Number($('qTotal').textContent), 1);
    $('qInput').value = 'ZZZWRONGNAME';
    $('btnSubmit').click();
    $('btnNext').click();
    assert.equal($('resultSub').textContent, '本次 1 題答對 0 題');
    $('btnBackToOrigin').click();
    assert.equal($('resultTitle').textContent, '測驗結果');
  });

  test(`N=${QUIZ_SIZE} 邊界：全錯也要走得完`, () => {
    store.reset();
    playL3(3103, 'F'.repeat(QUIZ_SIZE));
    assert.equal(Number($('btnRetryN').textContent), QUIZ_SIZE);
    $('btnRetry').click();
    assert.equal(Number($('qTotal').textContent), QUIZ_SIZE);
    for (let i = 0; i < QUIZ_SIZE; i++) {
      $('qInput').value = 'ZZZWRONGNAME';
      $('btnSubmit').click();
      $('btnNext').click();
    }
    assert.equal($('resultSub').textContent, `本次 ${QUIZ_SIZE} 題答對 0 題`);
    $('btnBackToOrigin').click();
    assert.equal($('resultTitle').textContent, '測驗結果');
  });

  test('複習中答對會計入 M（M 是題數不是分數）', () => {
    store.reset();
    const expected = playL3(3104, P_1WRONG);
    const wrongItem = expected[QUIZ_SIZE - 1].item;
    $('btnRetry').click();
    // 複習卷同答案鍵，因此輸入原答案鍵即答對
    $('qInput').value = wrongItem.ans;
    $('btnSubmit').click();
    $('btnNext').click();
    assert.equal($('resultSub').textContent, '本次 1 題答對 1 題');
  });
});

describe('C35 三種失敗的 session 原子性', () => {
  before(needPool);

  test('複習途中圖片失敗 → 整次終止回原成績，且**不得遞補**', async () => {
    // 〔堵〕drawSpareQuestion 抽的是「未使用且 eligible」的**任意**鍵（F15），
    //       複習卷用它必然混入原本沒答錯的藥，而畫面上完全看不出來——
    //       使用者會以為自己複習完了全部錯題。**這是 M5 專屬的第一順位風險。**
    store.reset();
    dom.img.reset();
    const expected = playL3(3701, P_1WRONG);
    const wrongKey = expected[QUIZ_SIZE - 1].item.ans;

    const originSub = $('resultSub').textContent;
    const originMetrics = $('resultMetrics').innerHTML;
    const originReview = $('reviewBody').innerHTML;
    const originRows = reviewAnsKeys().length;

    // 該答案鍵的**每一筆**紀錄都失敗——複習卷會在該鍵的紀錄內重抽
    for (const it of POOL.items) if (it.ans === wrongKey) dom.img.fail.add(srcOf(it));

    $('btnRetry').click();
    await dom.settle();
    await dom.settle();

    assert.ok(!hidden('result'), '未回到結算頁');
    assert.ok(hidden('quiz'), '仍停在答題頁');
    assert.equal($('resultTitle').textContent, '測驗結果', '未回到原回合的結算頁');
    assert.equal($('resultSub').textContent, originSub, '原成績摘要被改動');
    assert.equal($('resultMetrics').innerHTML, originMetrics, '原成績的三級判定被改動');
    assert.equal($('reviewBody').innerHTML, originReview, '原卷的逐題檢討被改動');
    assert.equal(reviewAnsKeys().length, originRows, '題數變了 → 走了遞補路徑');
    assert.ok(!hidden('retryFail'), '必須有非破壞性失敗提示，不得靜默');
    assert.ok(hidden('retryNote'), '仍停在複習模式');
    assert.ok(!hidden('resultActions'), '原結算頁的動作列必須恢復');
    assert.ok(!hidden('btnRetry'), '必須可以再試一次');
  });

  test('失敗後可再次啟動，且 origin 仍是最初那個正常卷', async () => {
    store.reset();
    dom.img.reset();
    const expected = playL3(3702, P_1WRONG);
    const wrongKey = expected[QUIZ_SIZE - 1].item.ans;
    const originSub = $('resultSub').textContent;
    for (const it of POOL.items) if (it.ans === wrongKey) dom.img.fail.add(srcOf(it));
    $('btnRetry').click();
    await dom.settle();
    await dom.settle();

    dom.img.reset();                       // 圖片恢復正常
    $('btnRetry').click();
    assert.ok(!hidden('quiz'), '失敗後應可再次啟動複習');
    assert.equal(Number($('qTotal').textContent), 1);
    playRetryWrong();
    $('btnBackToOrigin').click();
    assert.equal($('resultSub').textContent, originSub, 'origin 不是最初那個正常卷');
  });
});

describe('C34 整卷驗證接在正式入口上', () => {
  const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /** 取出 `startRetry` 的整段函式原始碼 */
  const startRetrySrc = () => {
    const at = APP.indexOf('function startRetry(');
    assert.ok(at >= 0, '找不到 startRetry()');
    let depth = 0;
    for (let i = APP.indexOf('{', at); i < APP.length; i++) {
      if (APP[i] === '{') depth++;
      else if (APP[i] === '}' && --depth === 0) return APP.slice(at, i + 1);
    }
    assert.fail('startRetry() 未閉合');
  };

  test('發布動作全部排在整卷驗證之後（原子發布點，D28.1）', () => {
    // 行為面的另一半在 tests/retry.test.mjs：drawRetryQuiz 對**任何**非空違規
    // 都拋 INVARIANT_VIOLATED。這裡驗的是呼叫端沒有在驗證前就改狀態——
    // 那條路徑在樁上構造不出來（無法讓真實題庫組出違規卷），因此改為靜態契約
    const src = startRetrySrc();
    const build = src.indexOf('drawRetryQuiz(');
    assert.ok(build > 0, 'startRetry 未呼叫 drawRetryQuiz');
    for (const publish of ["state.mode = 'retry'", 'state.origin =', 'state.questions =',
      "show($('quiz'))", "show($('result'), false)", 'renderQuestion()']) {
      const at = src.indexOf(publish);
      assert.ok(at > build,
        `發布動作「${publish}」排在整卷驗證之前——失敗就會變成回滾而不是「還沒開始」`);
    }
  });

  test('catch 的每一條路徑都不發布（具名代碼是例示，不是 allowlist）', () => {
    // 〔堵〕`if (e.code === 'A') … if (e.code === 'B') …` 之後沒有 catch-all，
    //       未列舉的違規代碼就會掉出 catch 繼續往下走到發布點
    const src = startRetrySrc();
    const catchAt = src.indexOf('} catch (e) {');
    assert.ok(catchAt > 0, 'startRetry 必須攔截建構失敗');
    const catchBody = src.slice(catchAt, src.indexOf("state.origin = {"));
    const branches = [...catchBody.matchAll(/if \(e\.code/g)].length;
    assert.ok(branches >= 1, 'catch 內應有具名分支');
    // 最後一定要有一條無條件 return，否則未列舉的 code 會掉出去
    assert.match(catchBody, /\n\s*return retryFailed\(e\.message\);\s*\n\s*\}/,
      'catch 缺少 catch-all return——未列舉的違規代碼會掉出去繼續發布');
  });

  test('複習卷是完整候選卷才送驗（不得只送部分或摘要）', () => {
    // drawRetryQuiz 內部把整卷交給 validateQuizInvariants；
    // 這裡確認呼叫端沒有自己另做一套弱驗證後就發布
    const src = startRetrySrc();
    assert.doesNotMatch(src, /validateQuizInvariants\(/,
      'startRetry 不應自行呼叫 validator——整卷驗證屬於組裝器的階段 3，兩處驗會漂移');
  });
});

describe('C36 D29 的正面與負面 UI 契約', () => {
  before(needPool);

  test('複習結算頁：正面三項存在，負面六項一項都不得出現', () => {
    store.reset();
    playL3(3201, P_15WRONG);
    $('btnRetry').click();
    playRetryWrong();
    // 正面
    assert.match($('resultSub').textContent, /^本次 15 題答對 \d+ 題$/);
    assert.equal(reviewAnsKeys().length, 15, '逐題檢討長度必須等於 N');
    assert.ok(!hidden('retryNote'), '「錯題複習（不計入紀錄）」標示未顯示');
    // 負面
    assert.ok(hidden('resultMetrics'), '分數／基線／最長連對不得出現');
    assert.ok(hidden('resultRank'), '稱號不得出現');
    assert.ok(hidden('recordFlash'), '「新紀錄！」不得出現');
    assert.ok(hidden('resultActions'), '成績卡下載與「錯題再戰」控制項不得出現');
    assert.doesNotMatch($('reviewHead').innerHTML, /得分/, '逐題得分也是分數');
  });

  test('複習答題頁：連續答對也不顯示 live streak，題號是 i / N', () => {
    // 〔堵〕D32 把 streak 的更新時點掛在 lockAndReveal()，retry 走同一條——
    //       不明擋就會照跑。錯題卷是刻意挑的難題子集，連對數與正常卷不可比。
    //       **必須連續答對才驗得到**：全部答錯時 streak 本來就是 0、本來就隱藏，
    //       那樣即使守衛被拿掉也看不出差別（測不出東西的斷言比沒有更糟）
    store.reset();
    const expected = playL3(3202, P_15WRONG);
    const wrongKeys = expected.filter((_, i) => !flags(P_15WRONG)[i]).map((q) => q.item.ans);
    assert.equal(wrongKeys.length, 15);

    $('btnRetry').click();
    assert.equal(Number($('qTotal').textContent), 15, '題號分母必須是 N 而不是 20');
    // 複習卷的出題順序沿用錯題鍵的順序（D28），因此可以逐題答對
    for (let i = 0; i < 3; i++) {
      $('qInput').value = wrongKeys[i];
      $('btnSubmit').click();
      assert.ok(hidden('qStreak'),
        `複習模式不得顯示 live streak（第 ${i + 1} 題連續答對後仍顯示了）`);
      $('btnNext').click();
    }
  });

  test('複習模式下 downloadCard 防禦性拒絕', async () => {
    store.reset();
    playL3(3203, P_1WRONG);
    $('btnRetry').click();
    $('qInput').value = 'ZZZWRONGNAME';
    $('btnSubmit').click();
    $('btnNext').click();
    // 按鈕已隱藏，但程式化呼叫也必須被擋——成績卡是唯一會外流的產物
    drawn.length = 0;
    $('btnDownload').click();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(drawn, [], '複習模式仍畫出了成績卡');
  });
});

describe('C28 複習期間零 storage mutation', () => {
  before(needPool);

  test('全程 setItem／removeItem／clear 皆為 0，且不延後寫入', () => {
    // 〔堵〕先 setItem 再還原，前後快照相同仍會通過「前後比較」那種寫法
    store.reset();
    playL3(3301, P_15WRONG);          // 這一回合會寫紀錄（正常）
    const beforeMut = store.mutations().length;
    $('btnRetry').click();
    playRetryWrong();
    // 返回路徑另外驗更強的性質：**連讀都不該讀**。
    // 〔堵〕若返回時仍呼叫 writeRecords，值與原回合相同 → 不是嚴格大於 → 零 mutation，
    //       用 mutation 數量看不出來；但它會重跑一次寫入判定，
    //       而那一輪若剛好被另一分頁提高過紀錄，語意就變成「顯示畫面時順便寫入」
    const beforeAll = store.calls.length;
    $('btnBackToOrigin').click();
    const muts = store.mutations().slice(beforeMut);
    assert.deepEqual(muts, [], `複習期間發生了 ${muts.length} 次 storage mutation`);
    assert.deepEqual(store.calls.slice(beforeAll), [],
      '返回原成績時觸碰了 storage —— 紀錄是「完成回合」的副作用，不是「顯示」的');
  });

  test('複習後的下一個正常回合，寫入結果不受複習影響', () => {
    store.reset();
    playL3(3302, P_15WRONG);          // 25 分
    const afterFirst = JSON.parse(store.map.get(KEY));
    $('btnRetry').click();
    playRetryWrong();
    $('btnBackToOrigin').click();
    assert.deepEqual(JSON.parse(store.map.get(KEY)), afterFirst, '返回時不得寫紀錄');

    // 接著跑一個正常回合，分數更高 → 必須按自身結果寫入
    playL3(3303, P_ALL);              // 100 分
    const now = JSON.parse(store.map.get(KEY));
    assert.equal(now.L3.bestScore.value, 100, '下一個正常回合未按自身結果寫入');
  });
});

describe('C29 返回後由原卷快照重新衍生', () => {
  before(needPool);

  test('原卷與複習卷在級別、題數、作答、正誤上刻意不同，返回後逐欄為原卷值', () => {
    store.reset();
    playL3(3401, P_15WRONG);
    const originTitle = $('resultTitle').textContent;
    const originBadge = $('resultBadge').textContent;
    const originSub = $('resultSub').textContent;
    const originMetrics = $('resultMetrics').innerHTML;
    const originRank = $('rankTitle').textContent;
    const originReview = $('reviewBody').innerHTML;
    const originHead = $('reviewHead').innerHTML;

    $('btnRetry').click();
    playRetryWrong();
    $('btnBackToOrigin').click();

    assert.equal($('resultTitle').textContent, originTitle);
    assert.equal($('resultBadge').textContent, originBadge);
    assert.equal($('resultSub').textContent, originSub);
    assert.equal($('resultMetrics').innerHTML, originMetrics, '三級判定／分數／基線不是原卷值');
    assert.equal($('rankTitle').textContent, originRank, '稱號不是原卷值');
    assert.equal($('reviewHead').innerHTML, originHead, '逐題檢討欄位結構不是原卷的');
    assert.equal($('reviewBody').innerHTML, originReview, '逐題檢討內容不是原卷的');
    assert.equal(reviewAnsKeys().length, QUIZ_SIZE, '逐題檢討長度必須回到原卷的 20');
  });

  test('返回後重新產生的成績卡是原卷的級別與分數', async () => {
    store.reset();
    playL3(3402, P_15WRONG);
    $('btnRetry').click();
    playRetryWrong();
    $('btnBackToOrigin').click();
    drawn.length = 0;
    $('btnDownload').click();
    await new Promise((r) => setTimeout(r, 200));
    const txt = drawn.join(' ');
    assert.match(txt, /25\.0/, `成績卡未印出原卷分數 25.0，實得：${txt}`);
    assert.match(txt, /困難級/, '成績卡未印出原卷級別');
  });

  test('返回後 state.origin 已清除：下一個正常回合的成績卡不得沿用上一卷', async () => {
    // 〔堵〕返回後不清 origin，下一個正常回合的結算就會讀到殘留快照
    store.reset();
    playL3(3403, P_15WRONG);
    $('btnRetry').click();
    playRetryWrong();
    $('btnBackToOrigin').click();
    playL3(3404, P_ALL);                       // 100 分的新回合
    assert.match($('resultMetrics').innerHTML, /100\.0/, '新回合的分數被上一卷的殘留覆寫');
  });
});

describe('C30 零錯題時無副作用', () => {
  before(needPool);

  test('全對回合：控制項隱藏，且程式化呼叫 handler 不得有任何副作用', () => {
    store.reset();
    playL3(3501, P_ALL);
    assert.ok(hidden('btnRetry'), '零錯題時「錯題再戰」控制項必須不可及');

    const snap = {
      title: $('resultTitle').textContent,
      sub: $('resultSub').textContent,
      metrics: $('resultMetrics').innerHTML,
      review: $('reviewBody').innerHTML,
      records: store.map.get(KEY),
      quizHidden: hidden('quiz'),
    };
    const mutBefore = store.mutations().length;
    $('btnRetry').click();                     // 防禦性：即使被程式化觸發
    assert.equal($('resultTitle').textContent, snap.title);
    assert.equal($('resultSub').textContent, snap.sub);
    assert.equal($('resultMetrics').innerHTML, snap.metrics);
    assert.equal($('reviewBody').innerHTML, snap.review);
    assert.equal(store.map.get(KEY), snap.records);
    assert.equal(hidden('quiz'), snap.quizHidden, '不得切到答題頁');
    assert.ok(hidden('retryNote'), '不得進入複習模式');
    assert.deepEqual(store.mutations().slice(mutBefore), []);
  });
});

describe('C38 重複啟動冪等與只允許一層', () => {
  before(needPool);

  test('雙擊「錯題再戰」只建立一份複習卷，origin 不被覆寫', () => {
    store.reset();
    playL3(3601, P_15WRONG);
    const originSub = $('resultSub').textContent;
    $('btnRetry').click();
    const firstCard = $('qImg').getAttribute('src');
    $('btnRetry').click();                     // 第二次：必須 no-op
    assert.equal(Number($('qTotal').textContent), 15, '第二次觸發改動了複習卷');
    assert.equal($('qImg').getAttribute('src'), firstCard, '第二次觸發重建了複習卷');
    // 走完並返回，origin 仍必須是最初那個正常卷
    playRetryWrong();
    $('btnBackToOrigin').click();
    assert.equal($('resultSub').textContent, originSub, 'origin 被第二次啟動覆寫了');
  });

  test('複習結算頁不提供第二層「錯題再戰」', () => {
    store.reset();
    playL3(3602, P_15WRONG);
    $('btnRetry').click();
    playRetryWrong();
    assert.ok(hidden('resultActions'), '複習結算頁不得出現「錯題再戰」控制項');
    // 程式化觸發也必須 no-op：不得堆疊出第二層。
    // 〔堵〕只比對 resultTitle 的文字不夠——切到答題頁後它仍是舊值，
    //       必須直接驗「有沒有離開結算頁」與「origin 有沒有被複習卷覆寫」
    const originSub = $('resultSub').textContent;
    $('btnRetry').click();
    assert.ok(hidden('quiz'), '第二層複習被建立了（已切到答題頁）');
    assert.ok(!hidden('result'), '離開了複習結算頁');
    assert.equal($('resultTitle').textContent, '錯題複習結果');
    $('btnBackToOrigin').click();
    assert.equal($('resultTitle').textContent, '測驗結果');
    assert.notEqual($('resultSub').textContent, originSub,
      '返回後拿到的仍是複習卷 —— origin 被第二層覆寫了');
    assert.equal(reviewAnsKeys().length, QUIZ_SIZE, '返回後的逐題檢討必須是原卷的 20 題');
  });

  test('返回後再次啟動：仍以現在的原卷為準，不堆疊', () => {
    store.reset();
    playL3(3603, P_15WRONG);
    $('btnRetry').click();
    playRetryWrong();
    $('btnBackToOrigin').click();
    assert.ok(!hidden('btnRetry'), '返回後應可再次啟動複習');
    $('btnRetry').click();
    assert.equal(Number($('qTotal').textContent), 15);
    playRetryWrong();
    $('btnBackToOrigin').click();
    assert.equal($('resultTitle').textContent, '測驗結果');
  });
});

describe('C39 M5 控制項的可見性（靜態原始碼契約）', () => {
  test('D33 列出的元素都存在於 index.html，且沒有被無條件隱藏', () => {
    // 〔堵〕樁的 getElementById 會自動生出沒宣告過的元素——
    //       忘記改 index.html 時上面每一條都仍會全綠
    for (const id of ['btnRetry', 'btnRetryN', 'btnBackToOrigin', 'retryNote',
      'retryFail', 'retryActions', 'resultActions', 'qRetryTag', 'resultTitle']) {
      assert.match(HTML, new RegExp(`id="${id}"`), `index.html 缺少 #${id}`);
    }
  });

  test('複習模式的文字承諾寫在 index.html（樁上取不到靜態文字）', () => {
    // 〔堵〕D29 要求「錯題複習（不計入紀錄）」標示存在。樁的 getElementById
    //       生出來的元素 textContent 是空的，跨層測試只驗得到「有沒有顯示」，
    //       驗不到「顯示的是什麼」——文字承諾只能在原始碼這一層釘住
    const note = /id="retryNote"[^>]*>([^<]*)</.exec(HTML);
    assert.ok(note, '缺少 #retryNote');
    assert.match(note[1], /不計入紀錄/, '複習標示未寫明「不計入紀錄」');
    const tag = /id="qRetryTag"[^>]*>([^<]*)</.exec(HTML);
    assert.ok(tag, '缺少 #qRetryTag');
    assert.match(tag[1], /複習/, '答題頁的複習標示看不出是複習');
    assert.match(HTML, /id="btnRetry"[\s\S]{0,80}錯題再戰/, '控制項文字看不出是錯題再戰');
    assert.match(HTML, /id="btnBackToOrigin"[^>]*>[^<]*返回原成績/, '返回控制項文字不明確');
  });

  test('沒有把 M5 元素無條件設為 display:none／visibility:hidden／opacity:0', () => {
    // 〔堵〕樁可以點擊 display:none 的元素。「測試點得到」不等於「使用者看得到」——
    //       真實可見性、對比與觸控尺寸另做人工瀏覽器留檔（F13）
    const css = /<style>([\s\S]*?)<\/style>/.exec(HTML)[1];
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((m) => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));
    // 〔堵〕只列 id selector 會漏掉實際使用的 class——
    //       `.retry-note { display: none }` 一樣讓使用者看不到，卻掃不到
    const TARGETS = ['#btnRetry', '#btnBackToOrigin', '#retryNote', '#qRetryTag',
      '#retryActions', '#resultActions', '.retry-note', '.retry-tag', '.retry-fail'];
    for (const r of rules) {
      const sels = r.sel.split(',').map((s) => s.trim());
      if (!sels.some((s) => TARGETS.some((t) => s === t || s.endsWith(` ${t}`)))) continue;
      assert.doesNotMatch(r.body, /display\s*:\s*none/, `${r.sel} 無條件隱藏了 M5 控制項`);
      assert.doesNotMatch(r.body, /visibility\s*:\s*hidden/, `${r.sel} 無條件隱藏了 M5 控制項`);
      assert.doesNotMatch(r.body, /opacity\s*:\s*0(\D|$)/, `${r.sel} 無條件隱藏了 M5 控制項`);
    }
  });

  test('「錯題再戰」控制項在原結算頁的動作列內，返回控制項在複習動作列內', () => {
    const actions = /<div class="btn-row" id="resultActions">([\s\S]*?)<\/div>/.exec(HTML);
    assert.ok(actions, '缺少 #resultActions');
    assert.match(actions[1], /id="btnRetry"/, '錯題再戰不在原結算頁的動作列內');
    assert.match(actions[1], /id="btnDownload"/);
    const retryActions = /id="retryActions"[\s\S]*?<\/div>/.exec(HTML);
    assert.ok(retryActions, '缺少 #retryActions');
    assert.match(retryActions[0], /id="btnBackToOrigin"/);
  });
});
