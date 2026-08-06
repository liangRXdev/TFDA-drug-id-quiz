/**
 * 娛樂性強化 批次 A — 跨層接線
 * 對應 .ai-review/plan-v4-engagement.md §6 的 C18–C22、C23a、C24、C26（DOM）、C32、C33
 *
 *   node --test
 *
 * **這個檔存在的唯一理由是 D32。**
 * v4.0 的 A23–A29 全是 engine 層證據，沒有任何一條證明 streak 與稱號真的接到畫面上——
 * 與上一輪「測試全綠、功能靜默不存在」是同一個形狀。engine 算得對是這裡的前提，
 * 不是這裡的內容。
 *
 * 樁的 `getElementById` 會**自動生出**沒宣告過的元素，因此忘記改 index.html 時
 * 這裡仍會全綠——那個假綠燈由 `engagement.test.mjs` 的「新增 DOM 掛點」那組守著。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, ROOT } from './_ui-harness.mjs';
import {
  Level, QUIZ_SIZE, CHOICE_COUNT, buildIndex, eligibleKeys, drawLeveledQuiz, makeRng,
  rankTitle,
} from '../engine.js';

const hasPool = fs.existsSync(path.join(ROOT, 'data/pool.json'));
const dom = installDom();
const { $, drawn, drawnImages, hidden, store } = dom;

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
const srcOf = (item) => `data/${item.img}`;
const stored = () => {
  const raw = store.map.get(KEY);
  return raw == null ? null : JSON.parse(raw);
};

/**
 * 〔TG-4〕`startLevel()` 覆寫 `Math.random` 後**刻意不即時還原**——
 * 還原了後續的作廢遞補、誘答重抽就不再是已知序列，測試也就無從預期正解格。
 * 但整份檔跑完必須還原，否則同一 process 內的其他檔會拿到被釘住的 RNG。
 */
const REAL_RANDOM = Math.random;
after(() => { Math.random = REAL_RANDOM; });

/** 走一條**已知**的 RNG 序列，測試因而事先知道每題的正解格 */
function startLevel(level, seed) {
  const expected = drawLeveledQuiz(POOL.items, {
    level, n: QUIZ_SIZE, rng: makeRng(seed), index: idx(), eligible: eligibleKeys(idx(), level),
  });
  Math.random = makeRng(seed);
  levelCards().find((l) => l.dataset.level === level).click();
  $('btnStart').click();
  return expected;
}

const flags = (s) => [...s].map((c) => c === 'T');

/**
 * 走完一整回合 L1，逐題依 `pattern` 決定答對或答錯。
 *
 * 分數＝答對數×5，最長連對＝pattern 裡最長的一段 T——
 * 兩者都由測試指定，才驗得出「分數高但連對短」這種交叉方向（C18）。
 */
function playL1(seed, pattern, { reset = true } = {}) {
  const f = flags(pattern);
  assert.equal(f.length, QUIZ_SIZE, 'pattern 長度必須等於整卷題數');
  if (reset) $('btnAgain').click();
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

/** L3：輸入作答。正確時直接輸入答案鍵（normalize 後恰好相等） */
function playL3(seed, pattern, { reset = true } = {}) {
  const f = flags(pattern);
  if (reset) $('btnAgain').click();
  const expected = startLevel(Level.L3, seed);
  for (let i = 0; i < QUIZ_SIZE; i++) {
    $('qInput').value = f[i] ? expected[i].item.ans : 'ZZZWRONGNAME';
    $('btnSubmit').click();
    $('btnNext').click();
  }
  assert.ok(!hidden('result'));
  return expected;
}

/** L2：四張圖擇一，每題都要等 ready-gate 放行 */
async function playL2(seed, pattern, { reset = true } = {}) {
  const f = flags(pattern);
  if (reset) $('btnAgain').click();
  dom.img.reset();
  const expected = startLevel(Level.L2, seed);
  for (let i = 0; i < QUIZ_SIZE; i++) {
    await dom.settle();
    const cells = dom.cells();
    const ai = expected[i].answerIdx;
    cells[f[i] ? ai : (ai + 1) % CHOICE_COUNT].click();
    $('btnNext').click();
  }
  assert.ok(!hidden('result'));
  return expected;
}

// 分數／連對都由 pattern 決定，四個 pattern 覆蓋 C18 要的兩個交叉方向與相等
const P_60_8 = 'TTTTTTTTFTTTTFFFFFFF';   // 12 對 → 60 分，最長連對 8
const P_75_3 = 'TTTFTTTFTTTFTTTFTTTF';   // 15 對 → 75 分，最長連對 3
const P_50_10 = 'TTTTTTTTTTFFFFFFFFFF';  // 10 對 → 50 分，最長連對 10
const P_75_10 = 'TTTTTTTTTTFTTTTTFFFF';  // 15 對 → 75 分，最長連對 10
const P_ALL = 'T'.repeat(QUIZ_SIZE);      // 20 對 → 100 分，最長連對 20

/**
 * C20 對每一條失效情境的共同要求：完整回合走到結算、分數與逐題檢討完整渲染、
 * 無未捕捉例外。〔TG-6〕原本定義在 C20 的 describe 內，E7 在 C21 用不到，
 * 這是 E7 當初只驗清除流程的直接原因——提到模組層。
 */
const assertResultIntact = () => {
  assert.ok(!hidden('result'), '未走到成績頁');
  assert.match($('resultMetrics').innerHTML, /總分/, '分數未渲染');
  assert.match($('resultMetrics').innerHTML, /最長連對/, '最長連對未渲染');
  assert.match($('reviewBody').innerHTML, /<tr>/, '逐題檢討空白');
  assert.ok(hidden('fatal'), '觸發了中止畫面');
};

describe('C18 最佳紀錄的兩個交叉方向、相等、讀回顯示', () => {
  before(needPool);

  test('第一個回合建立兩項紀錄，並顯示「新紀錄！」', () => {
    store.reset();
    playL1(1001, P_60_8);
    const rec = stored();
    assert.equal(rec.schema, 1);
    assert.equal(rec.L1.bestScore.value, 60);
    assert.equal(rec.L1.bestStreak.value, 8);
    assert.match(rec.L1.bestScore.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(rec.L1.bestScore.pool, POOL_HASH);
    assert.ok(!hidden('recordFlash'));
    assert.match($('recordFlash').textContent, /新紀錄/);
  });

  test('(b) 分數更高但連對更短 → 只更新 bestScore，bestStreak 不得降低', () => {
    // 〔堵〕整包覆寫在這個方向會把最長連對從 8 洗成 3
    const before8 = stored().L1.bestStreak;
    playL1(1002, P_75_3);
    const rec = stored();
    assert.equal(rec.L1.bestScore.value, 75);
    assert.deepEqual(rec.L1.bestStreak, before8, 'bestStreak 逐欄都不得改變');
  });

  test('(a) 分數更低但連對更長 → 只更新 bestStreak', () => {
    const beforeScore = stored().L1.bestScore;
    playL1(1003, P_50_10);
    const rec = stored();
    assert.equal(rec.L1.bestStreak.value, 10);
    assert.deepEqual(rec.L1.bestScore, beforeScore, 'bestScore 逐欄都不得改變');
  });

  test('(c) 兩者皆相等 → 零 storage mutation，且不顯示「新紀錄！」', () => {
    // 相等就刷新日期，會讓「最佳紀錄的日期」變成「最近一次打平的日期」
    const snapshot = JSON.stringify(stored());
    const before = store.mutations().length;
    playL1(1004, P_75_10);
    assert.equal(store.mutations().length, before, '打平不得產生任何 storage mutation');
    assert.equal(JSON.stringify(stored()), snapshot);
    assert.ok(hidden('recordFlash'), '沒破紀錄卻顯示了「新紀錄！」');
  });

  test('(d) 回到起始頁後逐欄顯示 value／date／pool', () => {
    // 〔堵〕持久化正確但 UI 完全沒顯示
    $('btnAgain').click();
    assert.ok(!hidden('recordsBox'), '有紀錄卻沒顯示紀錄區塊');
    const html = $('recordsBody').innerHTML;
    const rec = stored().L1;
    assert.match(html, /簡單級/);
    assert.ok(html.includes(rec.bestScore.value.toFixed(1)), '未顯示最高分的 value');
    assert.ok(html.includes(`${rec.bestStreak.value} 題`), '未顯示最長連對的 value');
    assert.ok(html.includes(rec.bestScore.date), '未顯示 date');
    assert.ok(html.includes(POOL_HASH), '未顯示 pool 診斷小字');
  });
});

describe('C19 三級各自路由', () => {
  // 〔TG-4〕原本直接讀 C18 留下的 `stored().L1`——跨 describe 順序耦合，
  //         `store.reset()` 只清 localStorage 樁、不重建 app module 與 state，
  //         所以單獨跑這個 describe 會在第一行就 TypeError。改為自備前置。
  before(() => {
    needPool();
    store.reset();
    playL1(1901, P_60_8);        // L1 = 60 分／連對 8
  });

  test('L2 的紀錄不得寫進 L1／L3', async () => {
    // 〔堵〕把三級結果全寫進同一個欄位——只測 L1 是看不出來的
    const beforeL1 = stored().L1;
    await playL2(2001, P_60_8);
    const rec = stored();
    assert.equal(rec.L2.bestScore.value, 60);
    assert.equal(rec.L2.bestStreak.value, 8);
    assert.deepEqual(rec.L1, beforeL1, 'L1 逐欄都不得改變');
    assert.equal(rec.L3, undefined);
  });

  test('L3 的紀錄不得寫進 L1／L2', () => {
    const rec0 = stored();
    playL3(2002, P_50_10);
    const rec = stored();
    assert.equal(rec.L3.bestScore.value, 50);
    assert.equal(rec.L3.bestStreak.value, 10);
    assert.deepEqual(rec.L1, rec0.L1, 'L1 逐欄都不得改變');
    assert.deepEqual(rec.L2, rec0.L2, 'L2 逐欄都不得改變');
  });

  test('三級的紀錄同時顯示在起始頁', () => {
    $('btnAgain').click();
    const html = $('recordsBody').innerHTML;
    for (const badge of ['簡單級', '中級', '困難級']) {
      assert.ok(html.includes(badge), `紀錄區塊缺少 ${badge}`);
    }
  });
});

describe('C33 跨分頁寫入合併', () => {
  before(needPool);

  /**
   * 建立基準紀錄（75 分／連對 10），讓本頁持有這份**舊**快照，
   * 然後模擬另一分頁直接改寫 storage。
   * 〔TG-4〕原本沿用前面 describe 留下的紀錄，單獨跑這個 describe 會取不到值。
   */
  const foreignWrite = (patch) => {
    store.reset();
    playL1(3000, P_75_10);
    $('btnAgain').click();                       // 此刻本頁持有的是舊快照
    const rec = stored();
    Object.assign(rec.L1, patch);
    store.map.set(KEY, JSON.stringify(rec));     // 模擬另一分頁的寫入
  };

  test('另一分頁提高 bestStreak／本頁提高 bestScore → 連對不得倒退', () => {
    // 〔堵〕直接以記憶體快照整包覆寫，另一分頁剛創的紀錄被倒退
    foreignWrite({ bestStreak: { value: 18, date: '2026-01-01', pool: POOL_HASH } });

    // 16 對 → 80 分（高於既有 75），最長連對 4（低於 18）
    playL1(3001, 'TTTTFTTTTFTTTTFTTTTF', { reset: false });

    const after = stored();
    assert.equal(after.L1.bestScore.value, 80, '分數應更新');
    assert.equal(after.L1.bestStreak.value, 18, '另一分頁的更高連對被倒退覆蓋了');
    assert.equal(after.L1.bestStreak.date, '2026-01-01', 'date 也不得被覆蓋');
  });

  test('另一分頁提高 bestScore／本頁提高 bestStreak → 分數不得倒退', () => {
    // 〔TG-5〕只有上面那一個方向的話，「對 streak 重讀、對 score 沿用舊快照」
    //         的弱化實作可以全過——與 C18 當初特意補兩個交叉方向同一個道理
    foreignWrite({ bestScore: { value: 95, date: '2026-01-01', pool: POOL_HASH } });

    // 18 對 → 90 分（低於 95），最長連對 18（高於 10）
    playL1(3002, 'T'.repeat(18) + 'FF', { reset: false });

    const after = stored();
    assert.equal(after.L1.bestStreak.value, 18, '連對應更新');
    assert.equal(after.L1.bestScore.value, 95, '另一分頁的更高分數被倒退覆蓋了');
    assert.equal(after.L1.bestScore.date, '2026-01-01', 'date 也不得被覆蓋');
  });
});

describe('C20 失效情境 E1–E7 逐條', () => {
  before(needPool);

  test('E1 localStorage 不存在 → 靜默降級，其餘照常', () => {
    store.reset();
    store.absent = true;
    playL1(4001, P_60_8);
    assertResultIntact();
    assert.ok(hidden('recordFlash'), '無 storage 卻宣稱有新紀錄');
    $('btnAgain').click();
    assert.ok(hidden('recordsBox'), '無 storage 時不得顯示紀錄區塊');
    store.absent = false;
  });

  test('E1b 存取 localStorage property 本身就拋 → 同 E1', () => {
    store.reset();
    store.throwOnAccess = new Error('第三方 cookie 被封鎖');
    playL1(4002, P_60_8);
    assertResultIntact();
    assert.ok(hidden('recordFlash'));
    store.throwOnAccess = null;
  });

  test('E2 讀取拋任意例外（不限 SecurityError）→ 同 E1，且不得寫入', () => {
    // 〔堵〕只捕捉 SecurityError，其他例外照樣炸；
    //       或讀不到就當成沒紀錄照寫——那會覆蓋掉一筆看不見的更佳紀錄
    store.reset();
    store.throwOnGet = new TypeError('任意例外');
    const before = store.mutations().length;
    playL1(4003, P_60_8);
    assertResultIntact();
    assert.equal(store.mutations().length, before, '讀不到卻仍然寫入');
    assert.ok(hidden('recordFlash'));
    store.throwOnGet = null;
  });

  test('E3 寫入拋任意例外 → 靜默吞掉，且不得顯示「新紀錄！」', () => {
    // 〔堵〕只 try/catch 讀取而漏掉寫入，結算頁渲染到一半中斷——
    //       分數看得到但逐題檢討空白
    store.reset();
    store.throwOnSet = new Error('QuotaExceeded 之外的任意例外');
    playL1(4004, P_60_8);
    assertResultIntact();
    assert.ok(store.calls.some((c) => c.op === 'setItem'), '應該有嘗試過寫入');
    assert.equal(store.map.size, 0, '寫入失敗卻留下了資料');
    assert.ok(hidden('recordFlash'), '寫入失敗卻宣稱已保存新紀錄');
    store.throwOnSet = null;
  });

  test('E4 非法 JSON → 視為無紀錄，且在破紀錄前零 storage mutation', () => {
    store.reset();
    store.map.set(KEY, '{"schema":1, 壞掉的');
    const before = store.mutations().length;
    $('btnAgain').click();
    assert.equal(store.mutations().length, before, '讀到壞資料就順手清掉了');
    assert.ok(hidden('recordsBox'));
    playL1(4005, P_60_8);
    assert.equal(stored().L1.bestScore.value, 60, '正常回合完成後應有權覆寫');
  });

  test('E6 單一難度損毀 → 只有該難度視為無紀錄，其他兩級原值保留', () => {
    store.reset();
    const good = (v, s) => ({
      bestScore: { value: v, date: '2026-08-01', pool: POOL_HASH },
      bestStreak: { value: s, date: '2026-08-01', pool: POOL_HASH },
    });
    store.map.set(KEY, JSON.stringify({
      schema: 1,
      L1: good(90, 12),
      L2: { bestScore: { value: 'x' }, bestStreak: good(1, 1).bestStreak },   // 型別錯誤
      L3: good(70, 5),
    }));
    $('btnAgain').click();
    const html = $('recordsBody').innerHTML;
    assert.ok(html.includes('簡單級'), 'L1 應保留');
    assert.ok(html.includes('困難級'), 'L3 應保留');
    assert.ok(!html.includes('中級'), '損毀的 L2 不得顯示');
    assert.ok(html.includes('90.0') && html.includes('12 題'), 'L1 原值未保留');

    // 〔TG-6〕C20 明寫「每條皆須：完整回合可走到結算、分數與逐題檢討完整渲染」，
    //         E6 原本只驗起始頁讀取就結束。刻意選會**破紀錄**的回合——
    //         寫回路徑才是風險所在：整包覆寫會連同 L3 的原值一起洗掉，
    //         而那正是 E6 承諾「其他難度原值保留」的地方
    playL1(4006, P_ALL);
    assertResultIntact();
    assert.ok(!hidden('recordFlash'), '100 分卻沒認定為新紀錄');
    const rec = stored();
    assert.equal(rec.L1.bestScore.value, 100, 'L1 新紀錄未寫入');
    assert.equal(rec.L1.bestStreak.value, QUIZ_SIZE);
    assert.equal(rec.L3.bestScore.value, 70, '寫回 L1 時洗掉了 L3 的最高分');
    assert.equal(rec.L3.bestStreak.value, 5, '寫回 L1 時洗掉了 L3 的最長連對');
    assert.equal(rec.L3.bestScore.date, '2026-08-01', 'L3 的 date 也不得被動到');
  });

  test('E6b 不符 predicate 的值（超界、非整數、日期格式錯）一律降級', () => {
    const bad = [
      { bestScore: { value: 101, date: '2026-08-01', pool: POOL_HASH }, bestStreak: { value: 3, date: '2026-08-01', pool: POOL_HASH } },
      { bestScore: { value: 50, date: '2026-08-01', pool: POOL_HASH }, bestStreak: { value: 3.5, date: '2026-08-01', pool: POOL_HASH } },
      { bestScore: { value: 50, date: '2026-08-01', pool: POOL_HASH }, bestStreak: { value: 21, date: '2026-08-01', pool: POOL_HASH } },
      { bestScore: { value: 50, date: '2026/08/01', pool: POOL_HASH }, bestStreak: { value: 3, date: '2026-08-01', pool: POOL_HASH } },
      { bestScore: { value: 50, date: '2026-08-01', pool: 'ZZZ' }, bestStreak: { value: 3, date: '2026-08-01', pool: POOL_HASH } },
      { bestScore: { value: Number.NaN, date: '2026-08-01', pool: POOL_HASH }, bestStreak: { value: 3, date: '2026-08-01', pool: POOL_HASH } },
    ];
    for (const [i, rec] of bad.entries()) {
      store.reset();
      store.map.set(KEY, JSON.stringify({ schema: 1, L1: rec }));
      $('btnAgain').click();
      assert.ok(hidden('recordsBox'), `第 ${i + 1} 個不合法紀錄被採信了`);
    }
  });
});

describe('C22 未來 schema 的資料不得被靜默刪除（E5）', () => {
  before(needPool);

  test('破紀錄前 setItem／removeItem／clear 皆為 0，破紀錄後才覆寫', () => {
    // 〔堵〕破紀錄前呼叫 removeItem 清掉未來 schema，仍符合「沒有呼叫 setItem」
    store.reset();
    store.map.set(KEY, JSON.stringify({ schema: 99, L1: { anything: true } }));
    const before = store.mutations().length;
    $('btnAgain').click();
    assert.equal(store.mutations().length, before, '讀到未來 schema 就做了 mutation');
    assert.ok(hidden('recordsBox'));

    playL1(5001, P_60_8);
    const rec = stored();
    assert.equal(rec.schema, 1, '寫回的 schema 必須是本版本的 1');
    assert.equal(rec.L1.bestScore.value, 60);
    assert.equal(rec.L1.bestStreak.value, 8);
  });
});

describe('C21 清除紀錄：精確 key 與取消路徑', () => {
  before(needPool);

  const FOREIGN = {
    'pharmacy-portal:foo': '1',
    'other-tool:bar': '2',
    'tfda-drug-id-quiz:something-else': '3',
  };

  const seed = () => {
    store.reset();
    for (const [k, v] of Object.entries(FOREIGN)) store.map.set(k, v);
    store.map.set(KEY, JSON.stringify({
      schema: 1,
      L1: {
        bestScore: { value: 88, date: '2026-08-01', pool: POOL_HASH },
        bestStreak: { value: 9, date: '2026-08-01', pool: POOL_HASH },
      },
    }));
    $('btnAgain').click();
  };

  test('取消確認 → 零 mutation，紀錄仍在', () => {
    seed();
    const before = store.mutations().length;
    $('btnClearRecords').click();
    assert.ok(!hidden('clearConfirm'), '未顯示二次確認');
    $('btnClearNo').click();
    assert.ok(hidden('clearConfirm'));
    assert.equal(store.mutations().length, before, '取消卻動了 storage');
    assert.ok(store.map.has(KEY), '取消卻清掉了紀錄');
    assert.ok(!hidden('recordsBox'));
  });

  test('確認清除 → 恰一次 removeItem，目標為精確的 key', () => {
    // 〔堵〕localStorage.clear() 清光同源其他 16 個工具；
    //       前綴掃描今日無害，未來新增 `:settings` 就會被誤刪
    seed();
    const before = store.mutations().length;
    $('btnClearRecords').click();
    $('btnClearYes').click();

    const ops = store.mutations().slice(before);
    assert.deepEqual(ops, [{ op: 'removeItem', key: KEY }], `mutation 應恰為一次精確 removeItem：${JSON.stringify(ops)}`);
    for (const k of Object.keys(FOREIGN)) {
      assert.ok(store.map.has(k), `同源的其他 key 被誤刪：${k}`);
    }
    assert.ok(hidden('recordsBox'), '清除後仍顯示紀錄區塊');
    assert.match($('recordsNote').textContent, /已清除/);
  });

  test('移除失敗 → 不得顯示已清除', () => {
    seed();
    store.throwOnRemove = new Error('移除失敗');
    $('btnClearRecords').click();
    $('btnClearYes').click();
    assert.ok(store.map.has(KEY), '紀錄其實還在');
    assert.doesNotMatch($('recordsNote').textContent, /已清除/);
    assert.match($('recordsNote').textContent, /失敗/);
    assert.ok(!hidden('recordsBox'), '紀錄還在就應該繼續顯示');
    store.throwOnRemove = null;
  });

  test('E7 清除後仍可走完整回合，並重新建立紀錄', () => {
    // 〔TG-6〕E7 原本只驗清除流程本身，沒有走過 C20 要求的完整回合。
    //         清除把 in-memory 快照與 storage 同時歸零，是「回合中途讀到
    //         自己剛清掉的東西」最容易炸的一條路徑
    seed();
    $('btnClearRecords').click();
    $('btnClearYes').click();
    assert.ok(hidden('recordsBox'), '前置條件：紀錄已清除');

    playL1(4007, P_60_8);
    assertResultIntact();
    assert.ok(!hidden('recordFlash'), '清除後的第一個回合必定是新紀錄');
    const rec = stored();
    assert.equal(rec.L1.bestScore.value, 60);
    assert.equal(rec.L1.bestStreak.value, 8);   // 清除前是 88／9，復活的話這兩條會紅
  });
});

describe('C32 M1／M2／M3 跨層 e2e', () => {
  before(needPool);

  test('live streak 的確切值、更新時點與 0 時隱藏', () => {
    // 〔堵〕A23–A29 全綠但 header 與結算頁根本沒接線——上一輪的失效形狀
    store.reset();
    $('btnAgain').click();
    const expected = startLevel(Level.L1, 6001);
    const pattern = flags('TTFTTTTFTTTTTTTTTTTT');
    const streakAfter = [1, 2, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    assert.ok(hidden('qStreak'), '第 1 題作答前不得顯示連對');
    for (let i = 0; i < QUIZ_SIZE; i++) {
      const opts = $('qOptions').querySelectorAll('.opt');
      const ai = expected[i].answerIdx;
      opts[pattern[i] ? ai : (ai + 1) % CHOICE_COUNT].click();
      assert.equal($('qStreakN').textContent, streakAfter[i], `第 ${i + 1} 題作答後的連對值`);
      assert.equal(hidden('qStreak'), streakAfter[i] === 0, `第 ${i + 1} 題後的顯示／隱藏`);
      $('btnNext').click();
      if (i + 1 < QUIZ_SIZE) {
        assert.equal($('qStreakN').textContent, streakAfter[i], `第 ${i + 2} 題渲染後應沿用前一題的值`);
      }
    }
    assert.ok(!hidden('result'));
  });

  test('結算頁顯示最長連對，稱號由實際 level+score 查表', () => {
    // 上一題：16 對 → 80 分，最長連對 12
    assert.match($('resultMetrics').innerHTML, /最長連對/);
    assert.match($('resultMetrics').innerHTML, /12 題/);
    assert.ok(!hidden('resultRank'));
    assert.equal($('rankBadge').textContent, '簡單級', '稱號必須與級別徽章同框');
    assert.equal($('rankTitle').textContent, rankTitle(Level.L1, 80));
    assert.equal($('rankTitle').textContent, '記得住外觀');
  });

  test('提示題計入連對並標「含 M 題提示」；作廢不改變顯示值', async () => {
    store.reset();
    dom.img.reset();
    $('btnAgain').click();
    const expected = drawLeveledQuiz(POOL.items, {
      level: Level.L3, n: QUIZ_SIZE, rng: makeRng(6002),
      index: idx(), eligible: eligibleKeys(idx(), Level.L3),
    });
    dom.img.fail.add(srcOf(expected[2].item));      // 第 3 題圖片失敗 → 作廢並遞補

    Math.random = makeRng(6002);
    levelCards().find((l) => l.dataset.level === 'L3').click();
    $('btnStart').click();
    await dom.settle();

    // 第 1 題：直接答對
    $('qInput').value = expected[0].item.ans;
    $('btnSubmit').click();
    assert.equal($('qStreakN').textContent, 1);
    $('btnNext').click();
    await dom.settle();

    // 第 2 題：先取提示再答對 → 仍 +1
    $('btnHint').click();
    assert.ok(!hidden('qHint'));
    $('qInput').value = expected[1].item.ans;
    $('btnSubmit').click();
    assert.equal($('qStreakN').textContent, 2, '用提示答對必須計入連對');
    $('btnNext').click();
    await dom.settle();

    // 第 3 題圖片失敗 → 作廢並自動前進
    assert.equal($('qIdx').textContent, 4, '作廢後應前進到第 4 題');
    assert.equal($('qStreakN').textContent, 2, '作廢改變了連對顯示值');
    assert.ok(!hidden('qStreak'));

    // 其餘全部答錯
    for (let i = 0; i < 25 && hidden('result'); i++) {
      $('qInput').value = 'ZZZWRONGNAME';
      $('btnSubmit').click();
      $('btnNext').click();
      await dom.settle();
    }
    assert.ok(!hidden('result'));
    assert.match($('resultSub').textContent, /作廢 1 題/);
    const m = $('resultMetrics').innerHTML;
    assert.match(m, /最長連對/);
    assert.match(m, /2 題/);
    assert.match(m, /含 1 題提示/, '未標示連對段內的提示題數');
  });

  test('連對 0 題時結算頁不出現「含 N 題提示」的括號', () => {
    store.reset();
    playL1(6003, 'F'.repeat(QUIZ_SIZE));
    const m = $('resultMetrics').innerHTML;
    assert.match(m, /最長連對/);
    assert.match(m, /0 題/);
    assert.doesNotMatch(m, /含 \d+ 題提示/);
  });

  test('起始頁讀回並顯示紀錄（跨回合持久化真的成立）', () => {
    $('btnAgain').click();
    assert.ok(!hidden('recordsBox'));
    assert.match($('recordsBody').innerHTML, /簡單級/);
    assert.match($('recordsBody').innerHTML, /0\.0/);
  });
});

describe('C23a 稱號的 DOM 接線', () => {
  before(needPool);

  test('至少三組不同 (level, score) 的稱號都等於查表結果', () => {
    // 〔堵〕固定文字；或查表時用了錯的 level
    store.reset();
    const cases = [
      [Level.L1, 'T'.repeat(19) + 'F', 95, '簡單級'],
      [Level.L1, P_50_10, 50, '簡單級'],
      [Level.L3, P_75_3, 75, '困難級'],
    ];
    for (const [lv, pattern, score, badge] of cases) {
      if (lv === Level.L1) playL1(7000 + score, pattern);
      else playL3(7000 + score, pattern);
      assert.equal($('rankBadge').textContent, badge, `${lv} 的徽章`);
      assert.equal($('rankTitle').textContent, rankTitle(lv, score), `${lv} @ ${score}`);
      assert.ok($('rankTitle').textContent.length > 0);
      assert.ok(!hidden('resultRank'));
    }
  });

  test('L1 與 L3 同分時稱號不同（證明 level 真的有進查表）', () => {
    // 〔堵〕查表時把 level 寫死成某一級——同分不同級會露餡
    assert.notEqual(rankTitle(Level.L1, 75), rankTitle(Level.L3, 75));
  });
});

describe('C24 成績卡未退化且不含稱號', () => {
  before(needPool);

  test('仍繪製級別、分數、基線；未繪製稱號；未嘗試繪製任何藥品圖片', async () => {
    // 〔堵〕v4.0 的「若稱號進卡」是條件分支，漏畫也通過；
    //       只禁跨域圖片仍允許畫其他藥品圖片
    store.reset();
    playL1(8001, P_75_3);
    const title = $('rankTitle').textContent;
    assert.ok(title.length > 0, '前置條件：這一回合確實有稱號');

    drawn.length = 0;
    drawnImages.length = 0;
    $('btnDownload').click();
    await new Promise((r) => setTimeout(r, 200));

    const txt = drawn.join(' ');
    assert.match(txt, /簡單級/, '成績卡未繪製級別');
    assert.match(txt, /75\.0/, '成績卡未繪製分數');
    assert.match(txt, /亂猜基線/, '成績卡未繪製基線');
    assert.match(txt, /不可跨難度比較/);
    assert.ok(!txt.includes(title), `成績卡繪製了稱號「${title}」——那是唯一會外流的產物`);
    assert.deepEqual(drawnImages, [], '成績卡嘗試繪製圖片');
  });
});

describe('C26 揭曉不得被延後（DOM 部分）', () => {
  before(needPool);

  test('lockAndReveal 返回的同一 tick 內資訊已到位且可操作', () => {
    store.reset();
    $('btnAgain').click();
    const expected = startLevel(Level.L1, 9001);
    const ai = expected[0].answerIdx;

    // 〔堵〕改用 microtask 或 rAF 延後，即可繞過只堵 setTimeout 的斷言
    const orig = {
      st: globalThis.setTimeout,
      qm: globalThis.queueMicrotask,
      raf: globalThis.requestAnimationFrame,
    };
    let scheduled = 0;
    globalThis.setTimeout = (...a) => { scheduled++; return orig.st(...a); };
    globalThis.queueMicrotask = (f) => { scheduled++; return orig.qm(f); };
    globalThis.requestAnimationFrame = () => { scheduled++; return 0; };
    try {
      const opts = $('qOptions').querySelectorAll('.opt');
      opts[ai].click();
      // 不 await、不讓出：以下全部必須已是最終狀態
      assert.ok(!hidden('qVerdict'), '判定未在同一 tick 顯示');
      assert.match($('qVerdict').innerHTML, /答對/);
      // 品名含 " 與 '，DOM 內是 HTML 實體——比對前要走同一套轉義
      const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      assert.ok($('qVerdict').innerHTML.includes(esc(expected[0].item.full)), '正解未在同一 tick 顯示');
      assert.ok(opts[ai].classList.contains('ok'), '正解格標記未在同一 tick 標上');
      assert.ok(!hidden('btnNext'), '下一題按鈕未在同一 tick 顯示');
      assert.equal($('btnNext').disabled, false, '下一題按鈕仍是 disabled');
      assert.equal(scheduled, 0, '揭曉路徑排入了延後執行的排程');
    } finally {
      globalThis.setTimeout = orig.st;
      globalThis.queueMicrotask = orig.qm;
      globalThis.requestAnimationFrame = orig.raf;
    }
  });
});
