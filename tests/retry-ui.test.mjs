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
const P_15WRONG = 'TTTTTFFFFFFFFFFFFFFF';   // 5 對 15 錯 → 25 分、最長連對 5
const P_1WRONG = 'TTTTTTTTTTTTTTTTTTTF';    // 19 對 1 錯
const P_10RIGHT = 'TTTTTTTTTTFFFFFFFFFF';   // 10 對 10 錯 → 50 分、最長連對 10

/**
 * 目前畫面上的複習卷正解鍵集合，由逐題檢討反推。
 *
 * **每列只取第一個 `.ans`**：選擇題的「你選的」那一欄也是 `class="ans"`，
 * 全抓會拿到兩倍長度的清單，讓「鍵集合等於 K」的斷言變成永遠不成立
 */
const reviewAnsKeys = () =>
  [...$('reviewBody').innerHTML.matchAll(/<tr>[\s\S]*?<td class="ans[^"]*">([^<]*)<\/td>/g)]
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

  // 〔堵〕兩條邊界原本只驗題數與結算文字（覆審 M-19）——
  //       **「鍵集合恰等於 K」才是 M5 的核心承諾**，題數對而鍵混入非錯題
  //       正是 F15 那條路徑的樣態，只數題數完全看不出來
  test('N=1 邊界：只有一題錯也要走得完，且鍵集合恰等於 K', () => {
    store.reset();
    const expected = playL3(3102, P_1WRONG);
    const originKeys = [expected[QUIZ_SIZE - 1].item.ans];
    assert.equal(Number($('btnRetryN').textContent), 1);
    $('btnRetry').click();
    assert.equal(Number($('qTotal').textContent), 1);
    $('qInput').value = 'ZZZWRONGNAME';
    $('btnSubmit').click();
    $('btnNext').click();
    assert.equal($('resultSub').textContent, '本次 1 題答對 0 題');
    assert.deepEqual(reviewAnsKeys(), originKeys, 'N=1 的複習卷正解鍵不等於 K');
    $('btnBackToOrigin').click();
    assert.equal($('resultTitle').textContent, '測驗結果');
  });

  test(`N=${QUIZ_SIZE} 邊界：全錯也要走得完，且鍵集合恰等於 K`, () => {
    store.reset();
    const expected = playL3(3103, 'F'.repeat(QUIZ_SIZE));
    const originKeys = expected.map((q) => q.item.ans);
    assert.equal(Number($('btnRetryN').textContent), QUIZ_SIZE);
    $('btnRetry').click();
    assert.equal(Number($('qTotal').textContent), QUIZ_SIZE);
    for (let i = 0; i < QUIZ_SIZE; i++) {
      $('qInput').value = 'ZZZWRONGNAME';
      $('btnSubmit').click();
      $('btnNext').click();
    }
    assert.equal($('resultSub').textContent, `本次 ${QUIZ_SIZE} 題答對 0 題`);
    assert.deepEqual(reviewAnsKeys().sort(), [...originKeys].sort(),
      `N=${QUIZ_SIZE} 的複習卷正解鍵集合不等於 K`);
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

    // ── 直接觀測「遞補呼叫次數為 0」（覆審 M-2）──
    // 〔堵〕只比對失敗後的 DOM 是**證明不了**這件事的：先呼叫 drawSpareQuestion
    //       混入一個非錯題、再立刻回原卷，resultSub／resultMetrics／reviewBody
    //       與列數會**全部相同**。斷言的對象根本不在違規發生的那條路徑上。
    //       遞補一定要抽籤：drawSpareQuestion 先 `shuffle(keys, rng)` 才挑鍵，
    //       因此「中止路徑上 RNG 呼叫次數為 0」等價於「一次都沒遞補」。
    //       spy 裝在 click() **之後**：複習卷本身的組裝當然要用 RNG
    const spied = Math.random;
    let rngCalls = 0;
    Math.random = () => { rngCalls++; return spied(); };
    await dom.settle();
    await dom.settle();
    Math.random = spied;
    assert.equal(rngCalls, 0,
      `複習中止路徑上發生了 ${rngCalls} 次抽籤 —— 走了遞補（drawSpareQuestion）`);

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

// ── L1／L2：另外兩條渲染路徑（覆審 M-17）──────────────────────────────
// L3 全綠證明不了 L1 與 L2：三級各自走 renderChoices／renderGrid／renderInput，
// 複習模式的分支散在其中。原本本檔定義了 playL1() 卻從未呼叫——**死碼**，
// 而它的存在會讓人以為 L1 已被覆蓋。

/** 目前畫面上 L1 選項的英文品名，順序即格位順序 */
const optionAns = () => [...$('qOptions').innerHTML.matchAll(/<span class="en">([^<]*)<\/span>/g)]
  .map((m) => m[1]);

/** 走完一整回合 L2（逐題等四張圖 ready 後才點） */
async function playL2(seed, pattern) {
  const f = flags(pattern);
  assert.equal(f.length, QUIZ_SIZE);
  $('btnAgain').click();
  const expected = startLevel(Level.L2, seed);
  for (let i = 0; i < QUIZ_SIZE; i++) {
    await dom.settle();
    const cells = dom.cells();
    assert.equal(cells.length, CHOICE_COUNT, `第 ${i + 1} 題格數應為 4`);
    const ai = expected[i].answerIdx;
    cells[f[i] ? ai : (ai + 1) % CHOICE_COUNT].click();
    $('btnNext').click();
  }
  assert.ok(!hidden('result'), '未走到成績頁');
  return expected;
}

describe('C37 L1 完整跨層流程（renderChoices 路徑）', () => {
  before(needPool);

  test('L1：錯題再戰 → 逐題以選項作答 → D29 結算 → 返回原成績', () => {
    store.reset();
    dom.img.reset();
    const expected = playL1(3801, P_15WRONG);
    const wrongKeys = expected.filter((_, i) => !flags(P_15WRONG)[i]).map((q) => q.item.ans);
    assert.equal(wrongKeys.length, 15);
    const originSub = $('resultSub').textContent;
    const originReview = $('reviewBody').innerHTML;

    assert.equal(Number($('btnRetryN').textContent), 15);
    $('btnRetry').click();
    assert.ok(!hidden('quiz'), 'L1 未進入複習答題頁');
    assert.equal(Number($('qTotal').textContent), 15);
    assert.ok(!hidden('qRetryTag'), 'L1 複習模式標示未顯示');

    // 複習卷沿用錯題鍵的順序（D28），因此每題都答得出正解——
    // 全部答對才驗得到「M 計的是題數」與 streak 守衛（全錯時兩者都恆為 0）
    for (let i = 0; i < 15; i++) {
      const k = optionAns().indexOf(wrongKeys[i]);
      assert.ok(k >= 0, `第 ${i + 1} 題的選項不含該錯題的正解 ${wrongKeys[i]}`);
      $('qOptions').querySelectorAll('.opt')[k].click();
      assert.ok(hidden('qStreak'), '複習模式不得顯示 live streak');
      $('btnNext').click();
    }

    assert.equal($('resultSub').textContent, '本次 15 題答對 15 題');
    assert.deepEqual(reviewAnsKeys().sort(), [...wrongKeys].sort(),
      'L1 複習卷的正解鍵集合必須恰等於原卷錯題鍵集合');
    assert.ok(hidden('resultMetrics'), 'L1 複習結算頁不得出現分數');

    $('btnBackToOrigin').click();
    assert.equal($('resultTitle').textContent, '測驗結果');
    assert.equal($('resultSub').textContent, originSub);
    assert.equal($('reviewBody').innerHTML, originReview);
  });
});

describe('D28.1 L2 資源前置條件（發布前預載）', () => {
  before(needPool);

  test('L2：四格圖全部載完才發布 → 複習卷 → 返回原成績', async () => {
    store.reset();
    dom.img.reset();
    const expected = await playL2(3901, P_15WRONG);
    const wrongKeys = expected.filter((_, i) => !flags(P_15WRONG)[i]).map((q) => q.item.ans);
    const originSub = $('resultSub').textContent;
    const originReview = $('reviewBody').innerHTML;

    assert.equal(Number($('btnRetryN').textContent), 15);
    $('btnRetry').click();
    // **同步斷言**：預載未完成前一格畫面都不得動（D28.1）
    assert.ok(hidden('quiz'), 'L2 在圖片預載完成前就切到了答題頁');
    await dom.settle();
    assert.ok(!hidden('quiz'), 'L2 預載完成後未進入複習答題頁');
    assert.equal(Number($('qTotal').textContent), 15);

    for (let i = 0; i < 15; i++) {
      await dom.settle();
      const cells = dom.cells();
      assert.equal(cells.length, CHOICE_COUNT);
      // 預載已把四張圖送進快取，ready-gate 因此在第一個 tick 就開
      assert.ok(cells.every((c) => !c.disabled), `第 ${i + 1} 題的格子仍被 ready-gate 鎖住`);
      cells[0].click();
      $('btnNext').click();
    }

    assert.match($('resultSub').textContent, /^本次 15 題答對 \d+ 題$/);
    assert.deepEqual(reviewAnsKeys().sort(), [...wrongKeys].sort(),
      'L2 複習卷的正解鍵集合必須恰等於原卷錯題鍵集合');
    $('btnBackToOrigin').click();
    assert.equal($('resultSub').textContent, originSub);
    assert.equal($('reviewBody').innerHTML, originReview);
  });

  test('最後一題的圖載不動 → 完全不發布（不是先發布再回滾）', async () => {
    // 〔堵〕舊實作先切畫面再等 ready-gate，圖片失敗時走 voidCurrent 退回原成績。
    //       **終態與「不發布」完全相同**——原結算頁、retryFail 提示都一樣，
    //       因此只比對終態的斷言證明不了任何事。這裡驗的是**答題頁從未被渲染過**：
    //       qTotal／qIdx 仍是原回合的值，且複習標示從未顯示。
    // 〔堵〕失敗的是**最後一題**的正解圖：只預載第一題的實作會照樣發布
    store.reset();
    dom.img.reset();
    const expected = await playL2(3902, P_15WRONG);
    const wrongKeys = expected.filter((_, i) => !flags(P_15WRONG)[i]).map((q) => q.item.ans);
    const lastKey = wrongKeys[wrongKeys.length - 1];      // 複習卷的第 15 題（D28 沿用順序）
    for (const it of POOL.items) if (it.ans === lastKey) dom.img.fail.add(srcOf(it));

    const originSub = $('resultSub').textContent;
    const originReview = $('reviewBody').innerHTML;
    const qTotalBefore = Number($('qTotal').textContent);
    const qIdxBefore = Number($('qIdx').textContent);
    assert.equal(qTotalBefore, QUIZ_SIZE, '前置條件：原回合的題號分母應為 20');

    $('btnRetry').click();
    await dom.settle();
    await dom.settle();

    assert.ok(hidden('quiz'), '切到了答題頁 —— 這是先發布再回滾');
    assert.equal(Number($('qTotal').textContent), qTotalBefore,
      '題號分母被複習卷覆寫 —— renderQuestion() 跑過了，代表已經發布');
    assert.equal(Number($('qIdx').textContent), qIdxBefore, '題號被複習卷覆寫 —— 已經發布');
    assert.ok(hidden('qRetryTag'), '複習標示顯示過 —— 已經發布');
    assert.ok(hidden('retryNote'), '停在複習模式');
    assert.equal($('resultTitle').textContent, '測驗結果');
    assert.equal($('resultSub').textContent, originSub, '原成績摘要被改動');
    assert.equal($('reviewBody').innerHTML, originReview, '原卷的逐題檢討被改動');
    assert.ok(!hidden('retryFail'), '必須有非破壞性失敗提示，不得靜默');
    assert.ok(!hidden('btnRetry'), '必須可以再試一次');

    // 圖片恢復後可再次啟動，且 origin 仍是最初那個正常卷
    dom.img.reset();
    $('btnRetry').click();
    await dom.settle();
    assert.ok(!hidden('quiz'), '恢復後應可再次啟動 L2 複習');
    assert.equal(Number($('qTotal').textContent), 15);
  });

  test('預載期間重複點擊只建一份（D31 冪等要撐過整個等待期間）', async () => {
    // 〔堵〕retryBuilding 若在同步段就清掉，等待期間的第二次點擊會再組一份，
    //       兩份都 resolve 後第二份的 origin 就是第一份的複習卷
    store.reset();
    dom.img.reset();
    await playL2(3903, P_15WRONG);
    const originSub = $('resultSub').textContent;

    $('btnRetry').click();
    $('btnRetry').click();                     // 預載尚未 resolve
    $('btnRetry').click();
    await dom.settle();
    await dom.settle();
    assert.equal(Number($('qTotal').textContent), 15, '重複點擊改動了複習卷');

    for (let i = 0; i < 15; i++) {
      await dom.settle();
      dom.cells()[0].click();
      $('btnNext').click();
    }
    $('btnBackToOrigin').click();
    assert.equal($('resultSub').textContent, originSub, 'origin 被第二次啟動覆寫了');
  });
});

describe('C34 整卷驗證接在正式入口上', () => {
  const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /** 取出指定函式的整段原始碼 */
  const fnSrc = (name) => {
    const at = APP.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `找不到 ${name}()`);
    let depth = 0;
    for (let i = APP.indexOf('{', at); i < APP.length; i++) {
      if (APP[i] === '{') depth++;
      else if (APP[i] === '}' && --depth === 0) return APP.slice(at, i + 1);
    }
    assert.fail(`${name}() 未閉合`);
  };
  const startRetrySrc = () => fnSrc('startRetry');

  /**
   * 發布動作的完整清單。**這一份就是 D28.1 的「發布」定義**——
   * 少列一項，那一項就可以偷偷排到驗證前面而測試照樣全綠
   */
  const PUBLISH = ["state.mode = 'retry'", 'state.origin =', 'state.questions =',
    "show($('quiz'))", "show($('result'), false)", 'renderQuestion()'];

  test('發布動作全部集中在 publishRetry()，startRetry 一項都不做', () => {
    // 〔堵〕L2 的發布發生在 Promise 回呼裡。若兩條入口各自寫一份發布程式碼，
    //       「L2 那份少做了一步」就會是靜默的——兩份都改對才會被發現
    const src = startRetrySrc();
    const pub = fnSrc('publishRetry');
    for (const act of PUBLISH) {
      assert.ok(pub.includes(act), `publishRetry() 缺少發布動作「${act}」`);
      assert.ok(!src.includes(act),
        `startRetry() 自行執行了發布動作「${act}」——發布必須只有 publishRetry 一個出口`);
    }
  });

  test('每一處 publishRetry() 都排在整卷驗證之後（原子發布點，D28.1）', () => {
    // 行為面的另一半在 tests/retry.test.mjs：drawRetryQuiz 對**任何**非空違規
    // 都拋 INVARIANT_VIOLATED。app 層的行為面在下方「L2 資源前置條件」那組——
    // 那是本層唯一構造得出來的真實違規路徑（無法讓真實題庫組出違規卷）
    const src = startRetrySrc();
    const build = src.indexOf('drawRetryQuiz(');
    assert.ok(build > 0, 'startRetry 未呼叫 drawRetryQuiz');
    const calls = [...src.matchAll(/publishRetry\(/g)].map((m) => m.index);
    assert.ok(calls.length >= 1, 'startRetry 未呼叫 publishRetry');
    for (const at of calls) {
      assert.ok(at > build,
        '發布排在整卷驗證之前——失敗就會變成回滾而不是「還沒開始」');
    }
  });

  test('grid 級別的發布掛在資源前置條件之後（D28.1 的第三個條件）', () => {
    // 〔堵〕預載了卻不看結果，等於多花一趟網路再照樣發布
    const src = startRetrySrc();
    const grid = src.indexOf('LEVELS[level].grid');
    assert.ok(grid > 0, 'startRetry 未針對 grid 級別做資源前置條件');
    const branch = src.slice(grid);
    assert.match(branch, /preloadGridImages\(quiz\)[\s\S]*?if \(!ok\)[\s\S]*?publishRetry\(/,
      'grid 分支的 publishRetry 未排在「預載全部成功」的判定之後');
  });

  test('catch 的每一條路徑都不發布（具名代碼是例示，不是 allowlist）', () => {
    // 〔堵〕`if (e.code === 'A') … if (e.code === 'B') …` 之後沒有 catch-all，
    //       未列舉的違規代碼就會掉出 catch 繼續往下走到發布點
    const src = startRetrySrc();
    const catchAt = src.indexOf('} catch (e) {');
    assert.ok(catchAt > 0, 'startRetry 必須攔截建構失敗');
    const catchBody = src.slice(catchAt, src.indexOf('LEVELS[level].grid'));
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
    // 級別徽章列入 D29 的**正面**契約（覆審 M-10）：它不是數字，也不是跨回合
    // 可比的量——缺了反而讓使用者無從判斷這份複習屬於哪一卷
    assert.equal($('resultBadge').textContent, '困難級', '複習結算頁未顯示原卷級別徽章');
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

  test('提示後答對照樣計入 M（M 是題數不是分數）', () => {
    // 〔堵〕D29 明寫「提示後答對**照樣計入 M**」，而只驗未提示答對是驗不出東西的：
    //       `got` 若誤用加權分數（HINTED_MARK = 0.5），未提示的題照樣計 1，
    //       兩種實作在「全部未提示」的樣本上完全一致（覆審 M-18）
    store.reset();
    const expected = playL3(3204, P_15WRONG);
    const wrongKeys = expected.filter((_, i) => !flags(P_15WRONG)[i]).map((q) => q.item.ans);
    $('btnRetry').click();

    $('btnHint').click();                      // 第 1 題：用了提示才答對
    $('qInput').value = wrongKeys[0];
    $('btnSubmit').click();
    assert.match($('qVerdict').innerHTML, /提示/, '前置條件：第 1 題必須被記為用過提示');
    $('btnNext').click();

    $('qInput').value = wrongKeys[1];          // 第 2 題：未提示答對
    $('btnSubmit').click();
    $('btnNext').click();

    for (let i = 2; i < 15; i++) {             // 其餘全錯
      $('qInput').value = 'ZZZWRONGNAME';
      $('btnSubmit').click();
      $('btnNext').click();
    }
    // 加權實作會印出「答對 1.5 題」
    assert.equal($('resultSub').textContent, '本次 15 題答對 2 題');
    assert.match($('reviewBody').innerHTML, /（提示）/, '逐題檢討未標出用過提示的那題');
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

  /**
   * 清空所有排程（C28 條文的後半句，覆審 M-3）。
   *
   * 只在同步流程結束後比對 mutation 數，`setTimeout(() => writeRecords(...), 0)`
   * 這種延後寫入完全抓不到——而那正是這一條原本要防的東西。
   * 樁的計時器都掛在 macrotask 上，連跑幾輪即可讓已排定的工作全部落地。
   */
  const drain = async () => { for (let i = 0; i < 4; i++) await dom.settle(); };

  test('全程 setItem／removeItem／clear 皆為 0，且清空排程後仍為 0', async () => {
    // 〔堵〕先 setItem 再還原，前後快照相同仍會通過「前後比較」那種寫法
    store.reset();
    playL3(3301, P_15WRONG);          // 這一回合會寫紀錄（正常）
    await drain();
    const beforeMut = store.mutations().length;
    $('btnRetry').click();
    playRetryWrong();
    // 返回路徑另外驗更強的性質：**連讀都不該讀**。
    // 〔堵〕若返回時仍呼叫 writeRecords，值與原回合相同 → 不是嚴格大於 → 零 mutation，
    //       用 mutation 數量看不出來；但它會重跑一次寫入判定，
    //       而那一輪若剛好被另一分頁提高過紀錄，語意就變成「顯示畫面時順便寫入」
    const beforeAll = store.calls.length;
    $('btnBackToOrigin').click();
    await drain();                    // ← 延後寫入在這裡才會落地
    const muts = store.mutations().slice(beforeMut);
    assert.deepEqual(muts, [], `複習期間發生了 ${muts.length} 次 storage mutation`);
    assert.deepEqual(store.calls.slice(beforeAll), [],
      '返回原成績時觸碰了 storage —— 紀錄是「完成回合」的副作用，不是「顯示」的');
  });

  test('複習後的下一個正常回合：bestScore 與 bestStreak 都不受複習污染', async () => {
    // 〔堵〕用 100 分當「後續正常回合」是**看不出污染的**（覆審 M-4）：
    //       retry 若把 bestScore 污染成 60，100 分照樣覆寫過去。
    //       因此兩項各自建立對抗值——**複習的值高於後續正常回合**，
    //       污染一旦發生就再也覆蓋不掉，才顯現得出來。
    store.reset();
    const expected = playL3(3302, P_15WRONG);         // 25 分、最長連對 5
    const wrongKeys = expected.filter((_, i) => !flags(P_15WRONG)[i]).map((q) => q.item.ans);
    assert.equal(wrongKeys.length, 15);
    const afterFirst = JSON.parse(store.map.get(KEY));
    assert.equal(afterFirst.L3.bestScore.value, 25, '前置條件：原回合 25 分');
    assert.equal(afterFirst.L3.bestStreak.value, 5, '前置條件：原回合最長連對 5');

    // 複習卷 15 題**全部答對** → 若污染，bestScore=100、bestStreak=15
    $('btnRetry').click();
    for (const k of wrongKeys) {
      $('qInput').value = k;
      $('btnSubmit').click();
      $('btnNext').click();
    }
    assert.equal($('resultSub').textContent, '本次 15 題答對 15 題',
      '前置條件：複習必須全對，否則對抗值不夠高');
    $('btnBackToOrigin').click();
    await drain();
    assert.deepEqual(JSON.parse(store.map.get(KEY)), afterFirst, '返回時不得寫紀錄');

    // 後續正常回合：50 分、最長連對 10 —— **兩者都低於複習的 100／15**
    playL3(3303, P_10RIGHT);
    await drain();
    const now = JSON.parse(store.map.get(KEY));
    assert.equal(now.L3.bestScore.value, 50,
      'bestScore 被複習污染成 100 —— 後續回合的 50 分覆蓋不掉');
    assert.equal(now.L3.bestStreak.value, 10,
      'bestStreak 被複習污染成 15 —— 後續回合的 10 連對覆蓋不掉');
  });
});

describe('C29 返回後由原卷快照重新衍生', () => {
  before(needPool);

  test('原卷與複習卷在題數、作答、正誤上刻意不同；quizLevel 必須從 origin 恢復', () => {
    // v4.6 的 C29 原文要求「origin 與 retry **級別不同**」——那與 D28
    // 「複習卷沿用原級別」**在產品上不可能同時成立**（覆審 M-15）。
    // 條文已改為「`quizLevel` 必須從 origin 恢復」，而要觀察得到這件事，
    // **原卷必須用非預設級別**：`state.quizLevel ?? Level.L3` 這種寫法在
    // L3 原卷上永遠看不出差別。因此這一條刻意跑 L1
    store.reset();
    dom.img.reset();
    const expected = playL1(3401, P_15WRONG);
    const wrongKeys = expected.filter((_, i) => !flags(P_15WRONG)[i]).map((q) => q.item.ans);
    const originTitle = $('resultTitle').textContent;
    const originBadge = $('resultBadge').textContent;
    const originSub = $('resultSub').textContent;
    const originMetrics = $('resultMetrics').innerHTML;
    const originRank = $('rankTitle').textContent;
    const originReview = $('reviewBody').innerHTML;
    const originHead = $('reviewHead').innerHTML;
    assert.equal(originBadge, '簡單級', '前置條件：原卷必須是非預設級別');

    $('btnRetry').click();
    // D28：複習卷沿用原級別 → 複習結算頁的徽章也必須是簡單級（D29 正面契約）
    assert.equal(Number($('qTotal').textContent), 15);
    // 作答與正誤刻意與原卷相反：原卷 5 對 15 錯，複習卷 15 題全對
    for (const k of wrongKeys) {
      const j = optionAns().indexOf(k);
      assert.ok(j >= 0, `複習卷的選項不含正解 ${k}`);
      $('qOptions').querySelectorAll('.opt')[j].click();
      $('btnNext').click();
    }
    assert.equal($('resultSub').textContent, '本次 15 題答對 15 題');
    assert.equal($('resultBadge').textContent, '簡單級', '複習卷未沿用原級別（D28）');

    $('btnBackToOrigin').click();

    assert.equal($('resultTitle').textContent, originTitle);
    assert.equal($('resultBadge').textContent, originBadge, 'quizLevel 未從 origin 恢復');
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

describe('H-1 逐題檢討的欄數（四種組合 ＋ 作廢列）', () => {
  before(needPool);

  // 覆審輪確認欄數正確，但那是**讀程式碼**得出的結論——套件裡沒有任何一條
  // 測試在驗它。`renderReview()` 這輪從無參數改成帶 `retry`，欄數算式散在
  // 三處（header、`cols`、VOID 列的 colspan），是典型會漂移的地方。
  // 〔堵〕C29 只比對「返回後的 innerHTML 等於原卷的 innerHTML」——
  //       表頭與內容**一起壞掉**照樣相等

  /** 表頭的 th 數，與每一列的 td＋colspan 總寬 */
  function reviewCols() {
    const th = [...$('reviewHead').innerHTML.matchAll(/<th>/g)].length;
    const widths = $('reviewBody').innerHTML
      .split('</tr>')
      .filter((r) => r.includes('<td'))
      .map((r) => [...r.matchAll(/<td[^>]*>/g)]
        .reduce((n, m) => n + Number((/colspan="(\d+)"/.exec(m[0]) || [])[1] ?? 1), 0));
    return { th, widths };
  }

  function assertRectangular(label, expectTh) {
    const { th, widths } = reviewCols();
    assert.equal(th, expectTh, `${label}：表頭應為 ${expectTh} 欄，實得 ${th}`);
    assert.ok(widths.length > 0, `${label}：逐題檢討沒有任何列`);
    widths.forEach((w, i) => {
      assert.equal(w, th, `${label}：第 ${i + 1} 列寬度 ${w} ≠ 表頭 ${th} 欄`);
    });
  }

  test('輸入題（L3）：正常 5→4 欄、複習 4→3 欄，每列寬度都等於表頭', () => {
    store.reset();
    playL3(4101, P_15WRONG);
    assertRectangular('正常 × 輸入題', 4);          // #、正解、你的作答、得分
    $('btnRetry').click();
    playRetryWrong();
    assertRectangular('複習 × 輸入題', 3);          // 少「得分」欄（D29）
    $('btnBackToOrigin').click();
    assertRectangular('返回後 × 輸入題', 4);
  });

  test('選擇題（L1）：正常 5 欄、複習 4 欄，每列寬度都等於表頭', () => {
    store.reset();
    dom.img.reset();
    playL1(4102, P_15WRONG);
    assertRectangular('正常 × 選擇題', 5);          // #、正解、你選的、結果、得分
    $('btnRetry').click();
    for (let i = 0; i < 15; i++) {
      $('qOptions').querySelectorAll('.opt')[0].click();
      $('btnNext').click();
    }
    assertRectangular('複習 × 選擇題', 4);
    $('btnBackToOrigin').click();
    assertRectangular('返回後 × 選擇題', 5);
  });

  test('作廢列的 colspan 讓該列寬度仍等於表頭欄數', async () => {
    // VOID 列走的是另一條 return（跨欄說明 ＋ 條件式的「作廢」格），
    // 而跨欄寬度隨得分欄的有無而變 —— 三處算式中最容易漂的一處
    store.reset();
    dom.img.reset();
    $('btnAgain').click();
    const expected = startLevel(Level.L3, 4103);
    dom.img.fail.add(srcOf(expected[0].item));      // 第 1 題的圖載不動
    await dom.settle();
    assert.equal(Number($('qIdx').textContent), 2, '第 1 題未因圖片失敗而作廢遞補');

    for (let i = 0; i < QUIZ_SIZE + 2 && hidden('result'); i++) {
      $('qInput').value = 'ZZZWRONGNAME';
      $('btnSubmit').click();
      $('btnNext').click();
    }
    assert.ok(!hidden('result'), '未走到成績頁');
    assert.match($('reviewBody').innerHTML, /資源載入失敗/, '未產生作廢列');
    assertRectangular('正常 × 輸入題 ＋ 作廢列', 4);
  });
});

describe('C30 零錯題時無副作用', () => {
  before(needPool);

  test('全對回合：控制項不可及（hidden ＋ 程式化呼叫 no-op），且未啟動任何重建', () => {
    // D33 的「不可及」＝**不可見且程式化呼叫為 no-op**（v4.7 依覆審 M-6 修訂措辭：
    // 實作用的是 hidden class，節點與 listener 始終存在）。
    // 〔堵〕**只驗 (a) 不算數**——那等於把「按鈕看不見但按得動」判為通過
    store.reset();
    playL3(3501, P_ALL);
    // (a) 不可見
    assert.ok(hidden('btnRetry'), '零錯題時「錯題再戰」控制項必須不可見');

    const snap = {
      title: $('resultTitle').textContent,
      sub: $('resultSub').textContent,
      metrics: $('resultMetrics').innerHTML,
      review: $('reviewBody').innerHTML,
      records: store.map.get(KEY),
      quizHidden: hidden('quiz'),
    };
    const mutBefore = store.mutations().length;

    // (b) 程式化呼叫為 no-op，**且未啟動任何重建**（覆審 M-20）。
    // 〔堵〕C30 的條文明寫「並斷言未啟動任何重建」，而比對前後狀態相同
    //       **抓不到「建構後丟棄」**——組裝一份複習卷再扔掉，畫面與 storage
    //       完全一樣。組裝必經抽籤，因此直接觀測這條路徑上的 RNG 呼叫次數
    const spied = Math.random;
    let rngCalls = 0;
    Math.random = () => { rngCalls++; return spied(); };
    $('btnRetry').click();                     // 防禦性：即使被程式化觸發
    Math.random = spied;
    assert.equal(rngCalls, 0,
      `零錯題時發生了 ${rngCalls} 次抽籤 —— 啟動了重建（即使結果被丟棄）`);

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
    // (a) 不可見：整個動作列在複習結算頁隱藏
    assert.ok(hidden('resultActions'), '複習結算頁不得出現「錯題再戰」控制項');
    // (b) 程式化觸發也必須 no-op：不得堆疊出第二層（D33「不可及」的定義）。
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
    // 〔堵〕D33 的條文是「使用者**任何時候**都看得出『這是複習，不計入紀錄』」，
    //       原本只比對 /複習/ —— 契約寫得比它要驗的東西弱，
    //       答題頁少了後半句仍會全綠（覆審 M-7）
    assert.match(tag[1], /複習/, '答題頁的複習標示看不出是複習');
    assert.match(tag[1], /不計入紀錄/, '答題頁的複習標示未寫明「不計入紀錄」');
    assert.match(HTML, /id="btnRetry"[\s\S]{0,80}錯題再戰/, '控制項文字看不出是錯題再戰');
    assert.match(HTML, /id="btnBackToOrigin"[^>]*>[^<]*返回原成績/, '返回控制項文字不明確');
  });

  test('沒有把 M5 元素無條件設為 display:none／visibility:hidden／opacity:0', () => {
    // 〔堵〕樁可以點擊 display:none 的元素。「測試點得到」不等於「使用者看得到」——
    //       真實可見性、對比與觸控尺寸另做人工瀏覽器留檔（F13）
    const css = /<style>([\s\S]*?)<\/style>/.exec(HTML)[1];

    // ── 掃描器必須 fail-closed（覆審 M-16）──
    // 這是本 repo 假綠燈的**第四種形態**：掃描範圍對了，但「什麼算命中」
    // 與「解析失敗怎麼辦」沒跟著擴大。原本用 `s === t || s.endsWith(' ' + t)`
    // 比對，於是 `.retry-note.foo`、`:is(#btnRetry, x)`、`[id="btnRetry"]`、
    // `.card > #btnRetry` 全部漏掉；而漏掉的規則靜默視為「與 M5 無關」。
    // 現在改為 **token 命中**，且無法解析的規則**直接判失敗**。
    const TARGETS = ['btnRetry', 'btnBackToOrigin', 'retryNote', 'qRetryTag',
      'retryActions', 'resultActions', 'retry-note', 'retry-tag', 'retry-fail'];
    // at-rule（@media／@supports…）的 body 內還有巢狀規則，先攤平再逐條掃
    const flat = css.replace(/@[^{]+\{/g, ' ').replace(/\}\s*\}/g, '} ');
    const rules = [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((m) => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }))
      .filter((r) => r.sel.length > 0);
    assert.ok(rules.length > 0, 'CSS 解析不出任何規則 —— 掃描器已失效，不得視為通過');

    // fail-closed：把已解析的規則全部消掉後，不得再剩下任何 `{`——
    // 剩下就代表有語法沒被拆出來，而**沒被拆出來的規則等於沒被掃描**
    const leftover = flat.replace(/[^{}]+\{[^{}]*\}/g, '').trim();
    assert.ok(!leftover.includes('{'),
      `CSS 有規則未被解析出來，判失敗而非放行：${leftover.slice(0, 120)}`);

    let scanned = 0;
    for (const r of rules) {
      // token 命中：selector 內出現目標名稱且前後不是識別字字元。
      // 組合選擇器（`.retry-note.foo`）、`:is()`、attribute selector 都算命中
      const hit = TARGETS.some((t) => new RegExp(`[#.\\[="']${t}(?![\\w-])`).test(r.sel));
      if (!hit) continue;
      scanned++;
      assert.doesNotMatch(r.body, /display\s*:\s*none/, `${r.sel} 無條件隱藏了 M5 控制項`);
      assert.doesNotMatch(r.body, /visibility\s*:\s*hidden/, `${r.sel} 無條件隱藏了 M5 控制項`);
      // `opacity: 0`、`opacity: .0`、`opacity: 0%`、`opacity: calc(0)` 都要算
      assert.doesNotMatch(r.body, /opacity\s*:\s*(calc\(\s*)?\.?0+(\.0*)?\s*%?\s*\)?\s*(;|$)/,
        `${r.sel} 無條件隱藏了 M5 控制項`);
    }
    // 〔堵〕命中判定寫壞時最可能的樣態是「一條都沒掃到」而測試照樣全綠
    assert.ok(scanned > 0, '沒有掃到任何 M5 相關的 CSS 規則 —— 命中判定失效');
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
