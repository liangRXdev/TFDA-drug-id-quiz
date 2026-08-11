/**
 * V5 院內清單 — 跨層（規格 plan-v5-formulary.md v5.9 的 C40–C50、C52）
 *
 *   node --test
 *
 * `formulary.test.mjs` 證明 codec、分類與可用性判定算得對，證明不了
 * 「連結真的載得進來、禁用的級別真的按不動、院內版真的沒寫紀錄」。
 * 純函式全綠而功能靜默不存在，是這個 repo 已經發生過四次的形狀。
 *
 * **每個情境都重新 import 一次 app.js**（帶 cache-busting query）：
 * `bootFormulary()` 在模組載入時就跑完，一個 module 實例只能驗一種啟動情境。
 *
 * 樁的 `getElementById` 會自動生出沒宣告過的元素 → 忘記改 index.html 仍會全綠。
 * 那個假綠燈由本檔最後的「DOM 掛點確實存在於 index.html」那組守著。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  installDom, ROOT, imgControl, storeControl, urlControl, fetchControl, sinkLog,
} from './_ui-harness.mjs';
import {
  Level, QUIZ_SIZE, DECK_SIZE, makeRng, buildIndex, eligibleKeys, drawLeveledQuiz, drawDeck,
} from '../engine.js';
import {
  encodeFormulary, prepareFormulary, probeLevel, Category, CATEGORY_LABEL,
} from '../formulary.js';

const APP = `file://${path.join(ROOT, 'app.js').replace(/\\/g, '/')}`;
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const hasPool = fs.existsSync(path.join(ROOT, 'data/pool.json'));
const POOL = hasPool ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data/pool.json'), 'utf8')) : { items: [] };
const EXCLUDED = hasPool ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data/excluded.json'), 'utf8')) : { items: [] };
const needPool = () => assert.ok(hasPool, 'data/pool.json 不存在，請先執行 npm run build:pool');

const FX_KEY = 'tfda-drug-id-quiz:formulary';
const REC_KEY = 'tfda-drug-id-quiz:records';
const REAL_RANDOM = Math.random;
after(() => { Math.random = REAL_RANDOM; });

/** 決定性子集：以固定 seed 從真實 pool 抽 n 筆（與 A41 同一手法） */
function pickIds(n, seed) {
  const rng = makeRng(seed);
  const ids = POOL.items.map((it) => it.id);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (ids.length - i));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, n).sort();
}

const payloadOf = (ids, unlisted = 0) => encodeFormulary(ids, unlisted);

/** 通用版 L1 的期望題卷——與 app 的 `startQuiz()` 用同一個 seed，各自獨立算一次 */
const drawLeveledQuizForTest = (seed, index) => drawLeveledQuiz(POOL.items, {
  level: Level.L1, n: QUIZ_SIZE, rng: makeRng(seed),
  index, eligible: eligibleKeys(index, Level.L1),
});

/** 測試自己算出來的 probe 結果——**不是**從受測 app 讀回來的 */
function expectProbe(payload, level, ids, items = POOL.items) {
  const prep = prepareFormulary(items, new Set(ids));
  return probeLevel({ payload, level, items: prep.items, index: prep.index });
}

let bootN = 0;

/**
 * 起一個乾淨的 app 實例。
 *
 * `saved` 直接放進 storage（模擬上次已載入的清單），`href` 決定網址上的 `fx`。
 */
async function boot({
  href = 'https://example.test/quiz/', saved = null, savedRaw = null, records = null,
  pool = null, excluded = null, fail = [], defer = [], throwOnReplace = null, store = null,
} = {}) {
  imgControl.reset();
  storeControl.reset();
  urlControl.reset(href);                 // **reset 會清掉 throwOnReplace**，所以在它之後才設
  fetchControl.reset();
  sinkLog.reset();
  urlControl.throwOnReplace = throwOnReplace;
  for (const f of fail) fetchControl.fail.add(f);
  for (const d of defer) fetchControl.defer.add(d);
  if (pool) fetchControl.body.set('pool.json', pool);
  if (excluded) fetchControl.body.set('excluded.json', excluded);
  if (saved) storeControl.map.set(FX_KEY, saved);
  if (savedRaw !== null) storeControl.map.set(FX_KEY, savedRaw);
  if (records) storeControl.map.set(REC_KEY, records);
  // **storage 的失效必須在 reset 之後、import 之前套用**（codex-review TG-1）：
  // 原本在 `boot()` 之前呼叫 setup()，一進來就被 `storeControl.reset()` 清掉，
  // 於是三條「讀取失敗」的測試從來沒有真的注入過失敗。
  if (store) Object.assign(storeControl, store);
  const dom = installDom();
  await import(`${APP}?boot=${++bootN}`);
  await new Promise((r) => setTimeout(r, 60));
  return dom;
}

const savedJson = (payload) => JSON.stringify({
  v: 1, payload, savedAt: '2026-08-11T00:00:00.000Z', srcVersion: POOL.meta?.source_version ?? null,
});

const levelCards = (dom) => dom.$('levelPick').querySelectorAll('.level');
const cardFor = (dom, lv) => levelCards(dom).find((c) => c.dataset.level === lv);
/** 目前題目的四個選項藥名（從實際渲染出去的 HTML 取，不從 state 讀） */
const optionNames = (dom) =>
  [...dom.$('qOptions').innerHTML.matchAll(/<span class="en">([^<]*)<\/span>/g)].map((m) => m[1]);

/**
 * 以「點正確答案」走完一整卷 L1 選擇題。
 *
 * **最後一題也要按 `btnNext`**（那時它的字是「看成績」）——少按這一下，
 * `finish()` 就不會跑，結算頁與紀錄寫入這兩條路徑都沒被走到，
 * 而測試看起來只是「結果頁沒出現」。
 */
function playAllCorrect(dom, quiz) {
  for (let i = 0; i < quiz.length; i++) {
    const names = optionNames(dom);
    const k = names.indexOf(quiz[i].item.ans);
    assert.ok(k >= 0, `第 ${i + 1} 題的選項裡找不到正解 ${quiz[i].item.ans}`);
    dom.$('qOptions').querySelectorAll('.opt')[k].click();
    dom.$('btnNext').click();
  }
}

/** L3 是輸入題：填答案鍵、送出、下一題 */
function playAllCorrectL3(dom, quiz) {
  for (let i = 0; i < quiz.length; i++) {
    dom.$('qInput').value = quiz[i].item.ans;
    dom.$('btnSubmit').click();
    dom.$('btnNext').click();
  }
}

/** L2 是四張圖擇一：等四張圖 settle（ready-gate）後點正解格 */
async function playAllCorrectL2(dom, quiz) {
  for (let i = 0; i < quiz.length; i++) {
    await dom.settle();
    dom.cells()[quiz[i].answerIdx].click();
    dom.$('btnNext').click();
  }
}

const play = (dom, level, quiz) => (
  level === Level.L1 ? playAllCorrect(dom, quiz)
    : level === Level.L3 ? playAllCorrectL3(dom, quiz)
      : playAllCorrectL2(dom, quiz));

/**
 * 目前這一題**渲染出去的**識別特徵，三級各不相同。
 *
 * C52 要證明「按下開始用的就是 probe 那一卷」，而三級的畫面完全不一樣——
 * 只驗 L1 的選項名稱，L2／L3 在開始時重抽也不會被抓到（codex-review TG-4）。
 */
async function shownIdentity(dom, level) {
  if (level === Level.L1) return optionNames(dom);
  if (level === Level.L3) return [dom.$('qImg').src];
  await dom.settle();
  return dom.cells().map((c) => c.querySelector('img').src);
}

function wantIdentity(level, q) {
  if (level === Level.L1) return q.options.map((o) => o.ans);
  if (level === Level.L3) return [`data/${q.item.img}`];
  return q.options.map((o) => `data/${o.img}`);
}

// ════════════════════════════════════════════════════════════════════
describe('C40 揭露的數字與下載內容同源', () => {
  test('四類的精確 id 集合、順序契約，與下載檔重新解析後完全一致', async () => {
    needPool();
    const dom = await boot();

    // 逐類各取真實資料：命中取 pool、第一類取 excluded 的 Q1、第二類取 Q4
    const matched = POOL.items.slice(0, 3).map((it) => it.id);
    const q1 = EXCLUDED.items.filter((e) => e.stage === 'Q1').slice(0, 2).map((e) => e.id);
    const q4 = EXCLUDED.items.filter((e) => e.stage === 'Q4').slice(0, 2).map((e) => e.id);
    const ghost = '衛署藥製字第999998號';            // 格式合法、兩份檔案都沒有
    const junk = '衛署藥XX字第000001號';             // 未知前綴，正規化不出東西

    dom.$('fxInput').value = [...matched, ...q1, ...q4, ghost, junk].join('\n');
    dom.$('btnFormulary').click();
    await dom.settle();
    dom.$('btnFxAnalyze').click();

    // 〔堵〕UI hardcode 四個數字：逐類比對**精確的 id 集合**，不只比數量
    const breakdown = dom.$('fxBreakdown').innerHTML;
    const nums = [...breakdown.matchAll(/<span class="v">(\d+)<\/span>/g)].map((m) => Number(m[1]));
    // 第三類是 2：格式合法但兩份檔案都沒有的 ghost，加上未知前綴的 junk
    assert.deepEqual(nums, [3, 2, 2, 2], '命中／第一類／第二類／第三類的數字不符');

    const screen = dom.$('fxUnlistedList').textContent.split('\n');
    const expected = [
      ...q1.slice().sort().map((id) => `${Category.NON_SOLID_ORAL}\t${id}`),
      ...q4.slice().sort().map((id) => `${Category.LOW_QUALITY}\t${id}`),
      `${Category.UNLISTED}\t${ghost}`,
    ];
    // 第三類含未正規化的 junk（原樣保留），排序依去重鍵
    assert.ok(screen.some((l) => l.includes(junk)), '未命中明細應含未知前綴的原字串');
    for (const line of expected) assert.ok(screen.includes(line), `畫面缺少 ${line}`);

    // 下載檔**重新解析**後，類別歸屬與順序契約必須與畫面完全一致
    dom.$('btnFxDownload').click();
    assert.equal(dom.blobs.length, 1, '應產生一份下載內容');
    const text = await dom.blobs[0].text();
    const rows = text.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.deepEqual(rows.filter((r) => !r.includes(junk)), expected,
      '下載內容的類別歸屬或順序與畫面不一致');
    assert.ok(rows.some((r) => r.startsWith(`${Category.UNLISTED}\t`) && r.includes(junk)));
    // 命中的品項不進未命中檔，但檔頭要說出它有幾筆（不得靜默省略）
    assert.ok(text.includes('# 命中（可出題）3 筆'));
    for (const id of matched) {
      assert.ok(!rows.some((r) => r.endsWith(id)), `命中的 ${id} 不該出現在未命中檔`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
describe('D47 excluded.json 的降級：只停用產連結，不得拖垮出題', () => {
  for (const [name, opt] of [
    ['取不到（非 200）', { fail: ['excluded.json'] }],
    ['與 pool 不成對（content_hash 不同）', {
      excluded: { meta: { schema: 1, content_hash: 'sha256:0', source_version: 'x', count: 1 },
        items: [{ id: '衛署藥製字第000001號', stage: 'Q1' }] },
    }],
    ['單筆 stage 值域外', {
      excluded: () => ({
        meta: { ...EXCLUDED.meta },
        items: EXCLUDED.items.map((e, i) => (i === 3 ? { id: e.id, stage: 'Q9' } : e)),
      }),
    }],
  ]) {
    test(`${name} → 產連結停用並說明原因，出題完全不受影響`, async () => {
      needPool();
      const o = { ...opt };
      if (typeof o.excluded === 'function') o.excluded = o.excluded();
      const dom = await boot(o);

      dom.$('btnFormulary').click();
      await dom.settle();
      assert.equal(dom.hidden('fxError'), false, '必須說明為什麼不能產連結');
      assert.equal(dom.$('btnFxAnalyze').disabled, true, '產連結必須停用');

      // 〔堵〕半套分類：只要 excluded 不可信，一律不分類，不做逐筆容錯
      dom.$('btnFxAnalyze').click();
      assert.equal(dom.hidden('fxResult'), true, '不得產出任何分類結果');

      // **出題完全不受影響**（硬性要求）
      dom.$('btnFxBack').click();
      Math.random = makeRng(4747);
      cardFor(dom, Level.L1).click();
      dom.$('btnStart').click();
      Math.random = REAL_RANDOM;
      assert.equal(dom.hidden('quiz'), false, 'excluded.json 壞掉不得讓出題也壞掉');
      assert.equal(Number(dom.$('qTotal').textContent), QUIZ_SIZE);
    });
  }
});

// ════════════════════════════════════════════════════════════════════
describe('C41 載入後出題封閉於命中集合（防 vacuous pass）', () => {
  test('三級逐級：卷長正確、逐題正解與全部誘答都在子集內', async () => {
    needPool();
    const ids = pickIds(300, 4041);
    const payload = payloadOf(ids);
    const inSubset = new Set(ids);

    for (const level of [Level.L1, Level.L2, Level.L3]) {
      const dom = await boot({ saved: savedJson(payload) });
      const want = expectProbe(payload, level, ids);
      assert.equal(want.available, true, `${level} fixture 必須可組卷`);

      cardFor(dom, level).click();
      dom.$('btnStart').click();
      await dom.settle();

      // 先證明卷是真的出出來的——空卷的聯集自然是子集
      assert.equal(dom.hidden('quiz'), false, `${level} 應進入答題頁`);
      assert.equal(Number(dom.$('qTotal').textContent), want.quiz.length);
      assert.equal(want.quiz.length, QUIZ_SIZE);

      for (const q of want.quiz) {
        assert.ok(inSubset.has(q.item.id), `正解 ${q.item.id} 不在子集`);
        for (const o of q.options || []) assert.ok(inSubset.has(o.id), `誘答 ${o.id} 不在子集`);
        for (const s of q.spares || []) assert.ok(inSubset.has(s.id), `備援 ${s.id} 不在子集`);
      }
      // 畫面上真的渲染了子集內的藥名
      if (level === Level.L1) {
        for (const n of optionNames(dom)) {
          assert.ok(want.quiz[0].options.some((o) => o.ans === n), `畫面選項 ${n} 不屬於本題`);
        }
      }
    }
  });

  test('第二回合（probe 產物用完、走重抽路徑）同樣封閉於子集', async () => {
    // 〔堵〕只驗第一卷——第一卷是 probe 的產物，本來就封閉。
    //       真正會洩漏的是重抽路徑：它讀的是 `state.items`／`state.index`，
    //       那兩個若沒換成子集，畫面上完全看不出來（藥名都是真的，只是院內沒有）
    needPool();
    const ids = pickIds(300, 4142);
    const payload = payloadOf(ids);
    const subsetAns = new Set(POOL.items.filter((it) => ids.includes(it.id)).map((it) => it.ans));
    const dom = await boot({ saved: savedJson(payload) });
    const want = expectProbe(payload, Level.L1, ids);

    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    playAllCorrect(dom, want.quiz);
    dom.$('btnAgain').click();

    Math.random = makeRng(41420);
    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    Math.random = REAL_RANDOM;

    const total = Number(dom.$('qTotal').textContent);
    assert.equal(total, want.quiz.length, '第二回合的卷長也要照級別公式');
    for (let i = 0; i < total; i++) {
      const names = optionNames(dom);
      assert.equal(names.length, 4);
      for (const n of names) {
        assert.ok(subsetAns.has(n), `第 ${i + 1} 題出現院內清單以外的藥名 ${n}`);
      }
      dom.$('qOptions').querySelectorAll('.opt')[0].click();
      dom.$('btnNext').click();
    }
  });
});

// ════════════════════════════════════════════════════════════════════
describe('C42 解碼失敗不得改變任何狀態', () => {
  test('已載入清單 A 時開一條損毀連結：storage 位元組不變、fx 保留、A 仍能出卷', async () => {
    needPool();
    const ids = pickIds(300, 4242);
    const payload = payloadOf(ids);
    const saved = savedJson(payload);
    storeControl.reset();
    // 先放一筆成績 sentinel，證明損毀連結不會順手動到另一個 key
    const recSentinel = JSON.stringify({ v: 1, sentinel: true });

    const dom = await boot({ href: 'https://example.test/quiz/?fx=!!!not-base64!!!', saved });
    storeControl.map.set(REC_KEY, recSentinel);

    assert.equal(storeControl.map.get(FX_KEY), saved, 'formulary key 的位元組被動過');
    assert.equal(storeControl.map.get(REC_KEY), recSentinel);
    assert.deepEqual(storeControl.mutations(), [], '損毀連結不得產生任何 mutation');
    assert.deepEqual(urlControl.replaced, [], '失敗時 fx 必須保留在網址上');
    assert.ok(urlControl.href.includes('fx='));
    assert.equal(dom.hidden('startFxWarn'), false, '必須說明失敗原因，不得靜默');

    // 仍能從 A 正常組出一卷——這條才證明「A 還在」，而不是只有 key 還在
    const want = expectProbe(payload, Level.L1, ids);
    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    assert.equal(dom.hidden('quiz'), false);
    assert.equal(Number(dom.$('qTotal').textContent), want.quiz.length);
    assert.equal(Number(dom.$('sFxN').textContent), want.quiz.length ? new Set(ids).size : 0);
  });
});

// ════════════════════════════════════════════════════════════════════
describe('C43 涵蓋數字的語意與可及性', () => {
  // **三級逐級**（依 codex-review TG-4）：原本結算頁只驗 L1、L2 只驗切換後的答題頁、
  // L3 完全沒驗。上一輪（批次 3）才學到「變異要沿級別維度切」，這一批新寫的又只挑一級。
  for (const level of [Level.L1, Level.L2, Level.L3]) {
    test(`${level}：答題頁與結算頁的 N／K 都精確正確`, async () => {
      needPool();
      const ids = pickIds(300, 4340);
      const payload = payloadOf(ids, 5);
      const dom = await boot({ saved: savedJson(payload) });
      const want = expectProbe(payload, level, ids);
      assert.equal(want.available, true);

      cardFor(dom, level).click();
      dom.$('btnStart').click();
      assert.equal(dom.hidden('qFxNote'), false, `${level} 答題頁缺涵蓋節點`);
      assert.equal(dom.$('qFxN').textContent, '300');
      assert.equal(dom.$('qFxK').textContent, String(want.K));
      assert.ok(dom.$('qFxUnlisted').textContent.includes('5 筆'));

      await play(dom, level, want.quiz);
      assert.equal(dom.hidden('result'), false, `${level} 沒走完一整卷`);
      assert.equal(dom.hidden('resultFxNote'), false, `${level} 結算頁缺涵蓋節點`);
      assert.equal(dom.$('rFxN').textContent, '300');
      assert.equal(dom.$('rFxK').textContent, String(want.K));
    });
  }

  test('答題頁與結算頁都有節點，N 與 K 分別正確；切級別時 N 不變 K 變', async () => {
    needPool();
    const ids = pickIds(300, 4343);
    const payload = payloadOf(ids, 7);
    const dom = await boot({ saved: savedJson(payload) });

    const k1 = expectProbe(payload, Level.L1, ids);
    // 用 L2 當對照：L1 與 L3 的 K 在真實資料上常常相同（L3 的 K 就是全部答案鍵），
    // 拿那兩個比等於沒比
    const k2 = expectProbe(payload, Level.L2, ids);
    assert.notEqual(k1.K, k2.K, 'fixture 要能區分 K——兩級 K 相同的話這條驗不到東西');
    assert.equal(k2.available, true);

    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    assert.equal(dom.hidden('qFxNote'), false);
    assert.equal(dom.$('qFxN').textContent, String(300));
    assert.equal(dom.$('qFxK').textContent, String(k1.K));
    // 措辭必須與 D37.1 一致，不得暗示資料集涵蓋針劑
    assert.ok(dom.$('qFxUnlisted').textContent.includes('7 筆'));
    assert.ok(dom.$('qFxUnlisted').textContent.includes(CATEGORY_LABEL[Category.UNLISTED]));
    assert.ok(!dom.$('qFxUnlisted').textContent.includes('查無此證'));

    playAllCorrect(dom, k1.quiz);
    assert.equal(dom.hidden('resultFxNote'), false, '結算頁也必須有涵蓋數字');
    assert.equal(dom.$('rFxN').textContent, String(300));
    assert.equal(dom.$('rFxK').textContent, String(k1.K));

    // 〔堵〕對單一 fixture hardcode 正確 N/K，切級別後仍顯示舊 K
    dom.$('btnAgain').click();
    cardFor(dom, Level.L2).click();
    dom.$('btnStart').click();
    assert.equal(dom.$('qFxN').textContent, String(300), '切級別後 N 不該變');
    assert.equal(dom.$('qFxK').textContent, String(k2.K), '切級別後 K 必須跟著變');
  });

  test('月更降級後 N 與 K 都改變（各自斷言精確值）', async () => {
    needPool();
    const ids = pickIds(300, 4344);
    const payload = payloadOf(ids);
    const gone = new Set(ids.slice(0, 40));
    const shrunk = { ...POOL, items: POOL.items.filter((it) => !gone.has(it.id)) };

    const before = expectProbe(payload, Level.L1, ids);
    const after2 = expectProbe(payload, Level.L1, ids, shrunk.items);
    assert.equal(after2.available, true);

    const dom = await boot({ saved: savedJson(payload), pool: shrunk });
    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    assert.equal(dom.$('qFxN').textContent, String(260), '降級後 N 必須是實際命中的 260');
    assert.equal(dom.$('qFxK').textContent, String(after2.K));
    assert.notEqual(after2.K, before.K, '這個 fixture 沒有讓 K 改變，驗不到東西');
  });

  test('靜態契約：涵蓋節點未被無條件遮蔽（含 ancestor），且掃描器 fail-closed', () => {
    /**
     * **`class="… hidden"` 不算違規**：那是 `show()` 在執行期切換的，
     * 院內版節點本來就預設隱藏。這裡要抓的是**無條件**遮蔽——
     * `hidden` 屬性、`aria-hidden`、`inert`、寫死的 inline display/visibility。
     * 因此比對前先把 `class="…"` 整段剝掉。
     */
    const BAD = [
      [/\shidden(\s|=|>|\/)/, 'hidden 屬性'],
      [/aria-hidden="true"/, 'aria-hidden'],
      [/\sinert(\s|=|>|\/)/, 'inert'],
      [/display\s*:\s*none/, 'display:none'],
      [/visibility\s*:\s*hidden/, 'visibility:hidden'],
    ];
    const strip = (tag) => tag.replace(/class="[^"]*"/g, '');

    /** 回傳違規清單；解析不出或掃到 0 條規則一律視為失敗（fail-closed） */
    function scan(html, ids) {
      const bad = [];
      if (!html || html.length < 20) return ['掃描器輸入無法解析'];
      let checked = 0;
      for (const id of ids) {
        const at = html.indexOf(`id="${id}"`);
        if (at < 0) { bad.push(`找不到節點 ${id}`); continue; }
        checked++;
        const start = html.lastIndexOf('<', at);
        const tag = strip(html.slice(start, html.indexOf('>', at) + 1));
        for (const [re, name] of BAD) if (re.test(tag)) bad.push(`${id} 自身帶 ${name}`);
        // ancestor：往前找最近一個 <section>／<div> 的開標籤
        const head = html.slice(0, start);
        const openAt = Math.max(head.lastIndexOf('<section'), head.lastIndexOf('<div'));
        if (openAt >= 0) {
          const anc = strip(html.slice(openAt, html.indexOf('>', openAt) + 1));
          for (const [re, name] of BAD) if (re.test(anc)) bad.push(`${id} 的 ancestor 帶 ${name}`);
        }
      }
      if (!checked) return ['掃描器一條規則都沒掃到'];
      return bad;
    }

    const IDS = ['qFxNote', 'qFxN', 'qFxK', 'qFxUnlisted', 'resultFxNote', 'rFxN', 'rFxK', 'rFxUnlisted'];
    assert.deepEqual(scan(HTML, IDS), []);

    // 反向 sentinel：(i) 節點自身、(ii) ancestor、(iii) 規格列舉的每一項不可及屬性
    const FORMS = ['hidden', 'aria-hidden="true"', 'inert',
      'style="display:none"', 'style="visibility:hidden"'];
    for (const a of FORMS) {
      const self = `<section id="quiz"><p id="qFxNote" ${a}>x</p></section>`;
      assert.ok(scan(self, ['qFxNote']).length, `掃描器抓不到節點自身的 ${a}`);
      const anc = `<div ${a}><p id="qFxNote">x</p></div>`;
      assert.ok(scan(anc, ['qFxNote']).length, `掃描器抓不到 ancestor 的 ${a}`);
    }
    // 正向對照：執行期切換用的 class="hidden" **不得**被誤判成無條件遮蔽
    assert.deepEqual(scan('<div class="card hidden"><p id="qFxNote" class="fx-note hidden">x</p></div>',
      ['qFxNote']), []);
    // fail-closed：輸入解析不出、找不到節點、或一條都沒掃到，都必須直接失敗
    assert.ok(scan('', ['qFxNote']).length);
    assert.ok(scan(HTML, ['noSuchNode']).length);
    assert.ok(scan(HTML, []).length, '掃到 0 條規則必須失敗，不得回空陣列冒充通過');
  });
});

// ════════════════════════════════════════════════════════════════════
describe('C44 降級不覆寫原始清單', () => {
  test('品項消失：payload 位元組不變、命中集合精確縮小、仍完成一卷、恢復後回得來', async () => {
    needPool();
    const ids = pickIds(300, 4444);
    const payload = payloadOf(ids);
    const saved = savedJson(payload);
    const gone = ids.slice(0, 25);
    const shrunk = { ...POOL, items: POOL.items.filter((it) => !gone.includes(it.id)) };

    const dom = await boot({ saved, pool: shrunk });
    // 〔堵〕「未清除」只看 key 還在——實作可能已把原清單覆寫成殘餘集合
    assert.equal(storeControl.map.get(FX_KEY), saved, '持久化的 payload 位元組必須不變');
    assert.equal(dom.$('sFxN').textContent, String(275));
    assert.equal(dom.hidden('startFxWarn'), false);
    assert.ok(dom.$('startFxWarn').textContent.includes('25'), '要說出精確的消失數量');

    const want = expectProbe(payload, Level.L1, ids, shrunk.items);
    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    playAllCorrect(dom, want.quiz);
    assert.equal(dom.hidden('result'), false, '降級後仍必須完成得了一卷');

    // 品項重新出現 → 自動恢復（因為原清單沒被覆寫）
    const dom2 = await boot({ saved: storeControl.map.get(FX_KEY) });
    assert.equal(dom2.$('sFxN').textContent, String(300), '品項回來後應自動恢復');
    assert.equal(dom2.hidden('startFxWarn'), true);
  });
});

// ════════════════════════════════════════════════════════════════════
describe('C45 禁用級別是「可見且程式化 no-op」', () => {
  /**
   * **每一級各驗一次**（依 codex-review TG-4）。原本只驗 L2——
   * 弱化實作可以只對 L2 套 `levelOff()`，L1／L3 照樣讓人按下去。
   *
   * 三份 fixture 各自讓不同的級別撐不起來（實測值，K 與失敗代碼在測試內自檢）：
   * 16 品項 → L1 組不出卷、L3 還行；30 品項 → L2 湊不到同形同色誘答；9 品項 → 三級全禁。
   */
  for (const [level, n, seed] of [[Level.L1, 16, 4501], [Level.L2, 30, 4545], [Level.L3, 9, 4503]]) {
    test(`${level} 不可用時：狀態與原因都在，且程式化呼叫零副作用`, async () => {
      needPool();
      const ids = pickIds(n, seed);
      const payload = payloadOf(ids);
      const dom = await boot({ saved: savedJson(payload) });
      assert.equal(expectProbe(payload, level, ids).available, false,
        `${level} 的 fixture 必須真的不可用，否則這條驗不到東西`);

      const card = cardFor(dom, level);
      assert.equal(card.disabled, true, `${level} 的卡片必須是 disabled`);
      const html = dom.$('levelPick').innerHTML;
      assert.ok(html.includes('aria-disabled="true"'));
      assert.ok(/暫不可用/.test(html), '必須說得出原因');

      const snap = {
        store: JSON.stringify([...storeControl.map]),
        mut: storeControl.mutations().length,
        loaded: imgControl.loaded.length,
        btn: dom.$('btnStart').textContent,
        quizHidden: dom.hidden('quiz'),
      };
      card.click();                    // 樁的 click 不看 disabled，這就是程式化呼叫
      dom.$('btnStart').click();
      await dom.settle();
      assert.equal(JSON.stringify([...storeControl.map]), snap.store);
      assert.equal(storeControl.mutations().length, snap.mut);
      assert.equal(imgControl.loaded.length, snap.loaded, '不得偷偷啟動預載');
      assert.equal(dom.$('btnStart').textContent, snap.btn, '不得偷偷改 level');
      assert.equal(dom.hidden('quiz'), snap.quizHidden, '禁用的級別不得出題');
      assert.equal(dom.hidden('levelWarn'), false);
    });
  }

  test('三級全禁用時要提示重新產生連結（D41）', async () => {
    needPool();
    const ids = pickIds(9, 4503);
    const payload = payloadOf(ids);
    const dom = await boot({ saved: savedJson(payload) });
    for (const lv of [Level.L1, Level.L2, Level.L3]) {
      assert.equal(expectProbe(payload, lv, ids).available, false);
      assert.equal(cardFor(dom, lv).disabled, true);
    }
    assert.equal(dom.hidden('startFxWarn'), false);
    assert.ok(dom.$('startFxWarn').textContent.includes('重新產生連結'));
  });

  test('L2 撐不起時：狀態與原因文字都在，且程式化呼叫零副作用', async () => {
    needPool();
    // 30 品項：L1／L3 撐得住，L2 因為湊不到同形同色又刻字互異的誘答而不可用
    const ids = pickIds(30, 4545);
    const payload = payloadOf(ids);
    const dom = await boot({ saved: savedJson(payload) });

    const p2 = expectProbe(payload, Level.L2, ids);
    assert.equal(p2.available, false, 'fixture 必須讓 L2 不可用，否則這條驗不到東西');
    assert.equal(expectProbe(payload, Level.L1, ids).available, true);

    // (a) semantic disabled 與原因文字都存在，**不是** hidden
    const card = cardFor(dom, Level.L2);
    assert.equal(card.disabled, true);
    const html = dom.$('levelPick').innerHTML;
    assert.ok(html.includes('aria-disabled="true"'), '必須有 aria-disabled');
    assert.ok(/lv-off/.test(html) && /暫不可用/.test(html), '必須說得出原因');
    assert.ok(!/class="level[^"]*hidden/.test(html), '不得把 hidden 當 not-present');

    // (b) 程式化呼叫前後，完整 state／storage／timer／image-load log 皆不變
    const snap = {
      store: JSON.stringify([...storeControl.map]),
      mut: storeControl.mutations().length,
      loaded: imgControl.loaded.length,
      btn: dom.$('btnStart').textContent,
      disabled: dom.$('btnStart').disabled,
      quizHidden: dom.hidden('quiz'),
    };
    card.click();                       // 樁的 click 不看 disabled——這就是「程式化呼叫」
    dom.$('btnStart').click();          // 直接按開始也不得出題
    await dom.settle();

    assert.equal(JSON.stringify([...storeControl.map]), snap.store);
    assert.equal(storeControl.mutations().length, snap.mut);
    assert.equal(imgControl.loaded.length, snap.loaded, '不得偷偷啟動預載');
    assert.equal(dom.$('btnStart').textContent, snap.btn, '不得偷偷改 level');
    assert.equal(dom.$('btnStart').disabled, snap.disabled);
    assert.equal(dom.hidden('quiz'), snap.quizHidden, '禁用的級別不得出題');
    assert.equal(dom.hidden('levelWarn'), false, '要告訴使用者為什麼沒反應');
  });
});

// ════════════════════════════════════════════════════════════════════
describe('C46／C47 紀錄：院內版完全不寫，通用版照常', () => {
  test('C46 院內版跑完全對的正常卷與短卷，records key 位元組都不變', async () => {
    needPool();
    const sentinel = JSON.stringify({
      v: 1, [Level.L1]: { bestScore: { v: 1, date: '2020-01-01', pool: '000000000000' } },
    });

    /**
     * 短卷用 **L3**：真實資料上 L1 的小子集會通過 K 門檻卻在整卷組裝失敗
     * （K 是逐鍵局部判定、組裝受整卷 H2 約束——D38.2 講的就是這件事），
     * 因此 13 ≤ K ≤ 22 的 L1 短卷在真實 pool 上根本產不出來。
     * L3 不需要誘答，卷長就是 min(20, K)。
     */
    // **三級都要驗**（依 codex-review TG-4）：原本只有 L1 正常卷與 L3 短卷，
    // 院內版 L2 若仍寫 record 不會被抓到
    for (const [label, n, level] of [
      ['L1 正常卷', 300, Level.L1], ['L2 正常卷', 300, Level.L2],
      ['L3 正常卷', 300, Level.L3], ['短卷', 15, Level.L3],
    ]) {
      const ids = pickIds(n, 4600 + n);
      const payload = payloadOf(ids);
      const dom = await boot({ saved: savedJson(payload) });
      storeControl.map.set(REC_KEY, sentinel);
      const before = storeControl.calls.length;

      const want = expectProbe(payload, level, ids);
      assert.equal(want.available, true, `${label} fixture 必須可組卷`);
      if (label === '短卷') assert.ok(want.quiz.length < QUIZ_SIZE, '短卷 fixture 必須真的短');
      else assert.equal(want.quiz.length, QUIZ_SIZE);

      cardFor(dom, level).click();
      dom.$('btnStart').click();
      await play(dom, level, want.quiz);
      assert.equal(dom.hidden('result'), false, `${label}：回合必須真的走完`);

      assert.equal(storeControl.map.get(REC_KEY), sentinel, `${label}：records 被動過`);
      assert.deepEqual(storeControl.calls.slice(before).filter((c) => c.op !== 'getItem'), [],
        `${label}：院內版不得有任何 mutation`);
    }
  });

  test('C47 通用版跑一回合：records 精確更新，且只動那一個 key', async () => {
    needPool();
    const dom = await boot();
    assert.equal(dom.hidden('startFxNote'), true, '沒有 fx 時不得進院內版');

    Math.random = makeRng(4747);
    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    const total = Number(dom.$('qTotal').textContent);
    // 全部亂答（點第一個選項）走完，重點在「有沒有寫」而不是分數多少
    for (let i = 0; i < total; i++) {
      dom.$('qOptions').querySelectorAll('.opt')[0].click();
      dom.$('btnNext').click();
    }
    assert.equal(dom.hidden('result'), false, '回合必須真的走完，否則不會走到寫入路徑');
    const muts = storeControl.mutations();
    assert.ok(muts.length > 0, '通用版必須真的寫紀錄——兩種模式都不寫也會讓 C46 通過');
    assert.deepEqual([...new Set(muts.map((m) => m.key))], [REC_KEY], 'mutation 只能落在 records');
    assert.ok(storeControl.map.has(REC_KEY));
  });
});

// ════════════════════════════════════════════════════════════════════
describe('C48 讀取／寫入失敗時 mutation 為零（依 codex-review TG-1 整段重寫）', () => {
  /**
   * 原本這一組**完全沒有注入到失敗**：`setup()` 在 `boot()` 之前呼叫，
   * 而 `boot()` 開頭就 `storeControl.reset()`；斷言只看 `clear()`；
   * 「setItem 拋錯」那條最後斷言的還是「院內版**已發布**」——與測試名稱主張的相反。
   * 現在 fault 由 `boot({ store })` 在 reset 之後、import 之前套用。
   */
  const RECORD_SENTINEL = JSON.stringify({ v: 1, sentinel: 'records' });

  const READ_FAULTS = [
    ['localStorage 不存在', { absent: true }, null],
    ['property access 拋錯', { throwOnAccess: new Error('blocked') }, null],
    ['getItem 拋錯', { throwOnGet: new Error('boom') }, null],
    ['JSON 損毀', {}, '{ 這不是 JSON'],
    ['schema 不合（未來版本）', {}, JSON.stringify({ v: 99, payload: 'zzz' })],
    ['payload 解不開', {}, JSON.stringify({ v: 1, payload: '!!!not-base64!!!' })],
  ];

  for (const [name, store, savedRaw] of READ_FAULTS) {
    test(`${name} → 零 mutation、兩個 key 位元組不變、fx 保留、出題不受影響`, async () => {
      needPool();
      const ids = pickIds(300, 4848);
      const payload = payloadOf(ids);
      const dom = await boot({
        href: `https://example.test/quiz/?fx=${payload}`,
        store, savedRaw, records: RECORD_SENTINEL,
      });

      // 〔堵〕「讀不出來就當作沒有，照樣寫進去」——那會把未來版本寫的資料毀掉
      assert.deepEqual(storeControl.mutations(), [],
        `${name}：讀取失敗後仍發生 mutation：${JSON.stringify(storeControl.mutations())}`);
      if (savedRaw !== null) {
        assert.equal(storeControl.map.get(FX_KEY), savedRaw, '讀不出來的那份必須原封不動');
      }
      assert.equal(storeControl.map.get(REC_KEY), RECORD_SENTINEL, 'records 不得被波及');
      assert.ok(urlControl.href.includes('fx='), '沒保存就不得清掉網址上的 fx');
      assert.deepEqual(urlControl.replaced, []);

      // 讀不出來時仍讓這條連結在本頁生效，並說明為什麼不保存
      assert.equal(dom.hidden('startFxNote'), false, '本頁仍應可用院內版');
      assert.equal(dom.hidden('startFxWarn'), false, '必須說明不保存的原因');
      assert.ok(dom.$('startFxWarn').textContent.includes('不會保存'));

      // 出題完全不受影響
      const want = expectProbe(payload, Level.L1, ids);
      cardFor(dom, Level.L1).click();
      dom.$('btnStart').click();
      assert.equal(dom.hidden('quiz'), false);
      assert.equal(Number(dom.$('qTotal').textContent), want.quiz.length);
    });
  }

  test('key 不存在（正常情形）→ 允許寫入，且只寫 formulary 那一個 key', async () => {
    // 正向對照：若上面六條靠「一律不寫」通過，這條會紅
    needPool();
    const ids = pickIds(300, 4850);
    const payload = payloadOf(ids);
    await boot({ href: `https://example.test/quiz/?fx=${payload}`, records: RECORD_SENTINEL });
    const muts = storeControl.mutations();
    assert.ok(muts.length > 0, '正常情形必須真的保存');
    assert.deepEqual([...new Set(muts.map((m) => m.key))], [FX_KEY]);
    assert.equal(storeControl.map.get(REC_KEY), RECORD_SENTINEL);
  });

  test('setItem 拋錯 → 不發布院內版（D44.1 第 2 段），且沒有任何 key 被改動', async () => {
    needPool();
    const ids = pickIds(300, 4849);
    const payload = payloadOf(ids);
    const dom = await boot({
      href: `https://example.test/quiz/?fx=${payload}`,
      store: { throwOnSet: new Error('quota') },
      records: RECORD_SENTINEL,
    });
    assert.equal(dom.hidden('startFxNote'), true, '寫不進去就不得發布院內版');
    assert.equal(dom.hidden('startFxWarn'), false);
    assert.equal(storeControl.map.has(FX_KEY), false, '拋錯的 setItem 不得留下半份資料');
    assert.equal(storeControl.map.get(REC_KEY), RECORD_SENTINEL);
    assert.ok(urlControl.href.includes('fx='), '沒提交就不得清掉 fx');
    assert.deepEqual(storeControl.mutations().filter((m) => m.op !== 'setItem'), [],
      '除了那次失敗的 setItem 以外不得有其他 mutation');
  });

  test('任何情況下都不得 clear() 或前綴掃描', async () => {
    needPool();
    for (const store of [{ absent: true }, { throwOnGet: new Error('x') }, { throwOnSet: new Error('y') }]) {
      const dom = await boot({ href: 'https://example.test/quiz/?fx=zzz***', store });
      dom.$('btnFormulary').click();
      await dom.settle();
      dom.$('btnFxBack').click();
      assert.deepEqual(storeControl.calls.filter((c) => c.op === 'clear'), []);
      for (const c of storeControl.calls) {
        assert.ok(c.key === null || c.key === FX_KEY || c.key === REC_KEY,
          `碰到了不該碰的 key：${c.key}`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════
describe('C49 URL 消費範圍精確', () => {
  test('成功後只移除 fx，其餘 query 與 fragment 精確保留；不會有第二次 mutation', async () => {
    needPool();
    const ids = pickIds(300, 4949);
    const payload = payloadOf(ids);
    const href = `https://example.test/quiz/?a=1&fx=${payload}&b=%E4%B8%AD#frag`;
    const dom = await boot({ href });

    assert.equal(urlControl.replaced.length, 1);
    assert.equal(urlControl.replaced[0], '/quiz/?a=1&b=%E4%B8%AD#frag',
      '只能移除 fx，其餘參數與 fragment 必須逐字保留（含原本的百分號編碼）');
    assert.equal(dom.hidden('startFxNote'), false);
    const wrote = storeControl.mutations().length;

    // 重跑完整啟動流程（網址已無 fx，storage 有清單）→ 不得有第二次 formulary mutation
    const dom2 = await boot({ href: urlControl.href, saved: storeControl.map.get(FX_KEY) });
    assert.deepEqual(storeControl.mutations(), [], '第二次啟動不得再寫一次');
    assert.equal(dom2.hidden('startFxNote'), false);
    assert.ok(wrote > 0);
  });

  test('載入失敗時 fx 保留；cleanup 失敗時已載入的清單不得回滾', async () => {
    needPool();
    const ids = pickIds(300, 4950);
    const payload = payloadOf(ids);

    const bad = await boot({ href: 'https://example.test/quiz/?keep=1&fx=zzz***' });
    assert.deepEqual(urlControl.replaced, []);
    assert.ok(urlControl.href.includes('fx=zzz***'), '失敗時 fx 必須留著讓使用者重整重試');
    assert.equal(bad.hidden('startFxNote'), true);

    const dom = await boot({
      href: `https://example.test/quiz/?fx=${payload}`,
      throwOnReplace: new Error('replaceState blocked'),
    });
    urlControl.throwOnReplace = null;
    assert.deepEqual(urlControl.replaced, [], 'cleanup 應該真的失敗了，否則這條在驗空氣');
    assert.equal(dom.hidden('startFxNote'), false, 'cleanup 失敗不得讓清單回滾');
    assert.ok(storeControl.map.has(FX_KEY), 'cleanup 失敗不得撤銷已寫入的清單');
    // 而且清單要真的還能用——「畫面上還在」與「還組得出卷」是兩件事
    const want = expectProbe(payload, Level.L1, ids);
    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    assert.equal(dom.hidden('quiz'), false);
    assert.equal(Number(dom.$('qTotal').textContent), want.quiz.length);
  });
});

// ════════════════════════════════════════════════════════════════════
describe('C50 惡意字串走真實 decoder 路徑', () => {
  test('(a) 含非格式字元的 fx 由真實 decoder fail-closed', async () => {
    needPool();
    const dom = await boot({ href: 'https://example.test/quiz/?fx=<img src=x onerror=alert(1)>' });
    assert.equal(dom.hidden('startFxNote'), true, '不得載入');
    assert.equal(dom.hidden('startFxWarn'), false, '要說明原因');
    assert.deepEqual(sinkLog.taintedBy('onerror=alert'), [],
      '惡意字串不得進入任何非純文字 sink');
  });

  test('(b) 含 HTML 語法字元的 token 經真實 tokenizer 抵達 UNLISTED，且只經純文字 sink', async () => {
    needPool();
    const dom = await boot();
    const evil = '<img src=x onerror="alert(1)">';
    dom.$('fxInput').value = [POOL.items[0].id, evil].join('\n');
    dom.$('btnFormulary').click();
    await dom.settle();
    sinkLog.reset();
    dom.$('btnFxAnalyze').click();

    // 先證明它**真的抵達了**受測路徑——否則「零 sink 呼叫」只是因為它從未到場
    const shown = dom.$('fxUnlistedList').textContent;
    assert.ok(shown.includes(evil), '惡意 token 必須真的出現在畫面資料中');
    dom.$('btnFxDownload').click();
    const text = await dom.blobs[dom.blobs.length - 1].text();
    assert.ok(text.includes(`${Category.UNLISTED}\t${evil}`), '也必須出現在下載資料中');

    // 再驗它只經純文字 sink
    const tainted = sinkLog.taintedBy('onerror');
    assert.deepEqual(tainted, [], `惡意字串經由 ${tainted.map((t) => t.sink).join('、')} 進入 DOM`);
    assert.ok(sinkLog.ofSink('textContent').some((c) => c.value.includes(evil)));
  });

  test('sink 清冊：每一種監控都有反向 sentinel 證明它會觸發', async () => {
    needPool();
    const dom = await boot();
    sinkLog.reset();
    const el = dom.$('sinkProbe');
    el.innerHTML = '<b>SENTINEL_A</b>';
    el.outerHTML = '<b>SENTINEL_B</b>';
    el.insertAdjacentHTML('beforeend', '<b>SENTINEL_C</b>');
    el.setAttribute('title', 'SENTINEL_D');
    el.textContent = 'SENTINEL_E';
    dom.$('qImg').src = 'SENTINEL_F';
    const a = document.createElement('a');
    a.href = 'SENTINEL_G';
    a.download = 'SENTINEL_H';

    const seen = new Set(sinkLog.calls.map((c) => c.sink));
    for (const s of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'setAttribute:title',
      'textContent', 'img.src', 'a.href', 'a.download']) {
      assert.ok(seen.has(s), `sink 清冊漏了 ${s}——監控不到的 sink 等於沒有防線`);
    }
    // taintedBy 必須排除純文字 sink，否則所有斷言都會恆紅
    assert.deepEqual(sinkLog.taintedBy('SENTINEL_E'), []);
    assert.equal(sinkLog.taintedBy('SENTINEL_A').length, 1);
  });
});

// ════════════════════════════════════════════════════════════════════
describe('C52 probe 的成功產物就是按下開始後的第一卷', () => {
  // **三級逐級**（依 codex-review TG-4）：原本只驗 L1，
  // 實作可以只對 L1 消費 probe 產物、L2／L3 在開始時重抽而全綠
  for (const level of [Level.L1, Level.L2, Level.L3]) {
    test(`${level}：畫面上的第一題就是 probe 產物，且開始時零 RNG 消耗`, async () => {
      needPool();
      const ids = pickIds(300, 5250);
      const payload = payloadOf(ids);
      const dom = await boot({ saved: savedJson(payload) });
      const want = expectProbe(payload, level, ids);
      assert.equal(want.available, true);

      cardFor(dom, level).click();
      let rngCalls = 0;
      Math.random = () => { rngCalls++; return REAL_RANDOM(); };
      dom.$('btnStart').click();
      Math.random = REAL_RANDOM;

      assert.equal(rngCalls, 0, `${level} 按下開始時重抽了——D38.3 的判定會因此作廢`);
      assert.equal(Number(dom.$('qTotal').textContent), want.quiz.length);
      assert.deepEqual(await shownIdentity(dom, level), wantIdentity(level, want.quiz[0]),
        `${level} 畫面上的第一題不是 probe 產出的那一題`);
    });
  }

  test('逐題同一產物，且開始動作沒有第二次組卷、沒有額外 RNG 消耗', async () => {
    needPool();
    const ids = pickIds(300, 5252);
    const payload = payloadOf(ids);
    const dom = await boot({ saved: savedJson(payload) });
    const want = expectProbe(payload, Level.L1, ids);
    assert.equal(want.available, true);

    cardFor(dom, Level.L1).click();
    // RNG spy：重抽一定會消耗 Math.random（drawQuiz 的洗牌與 buildChoices 都會）
    let rngCalls = 0;
    Math.random = () => { rngCalls++; return REAL_RANDOM(); };
    dom.$('btnStart').click();
    Math.random = REAL_RANDOM;

    assert.equal(rngCalls, 0, '按下開始時不得再抽一次——這正是「檢查時成功、開始時失敗」的復發路徑');
    assert.equal(Number(dom.$('qTotal').textContent), want.quiz.length);
    // 逐題斷言使用同一產物（正解與全部選項的 id 序列）
    for (let i = 0; i < want.quiz.length; i++) {
      const names = optionNames(dom);
      assert.deepEqual(names, want.quiz[i].options.map((o) => o.ans),
        `第 ${i + 1} 題的選項序列與 probe 產物不同`);
      const k = names.indexOf(want.quiz[i].item.ans);
      dom.$('qOptions').querySelectorAll('.opt')[k].click();
      if (i < want.quiz.length - 1) dom.$('btnNext').click();
    }
  });

  test('同一 session 的下一回合會重新抽（probe 產物只用一次）', async () => {
    needPool();
    const ids = pickIds(300, 5253);
    const payload = payloadOf(ids);
    const dom = await boot({ saved: savedJson(payload) });
    const want = expectProbe(payload, Level.L1, ids);

    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    playAllCorrect(dom, want.quiz);
    dom.$('btnAgain').click();

    Math.random = makeRng(999);
    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    Math.random = REAL_RANDOM;
    assert.notDeepEqual(optionNames(dom), want.quiz[0].options.map((o) => o.ans),
      '第二回合仍給同一份題目——probe 產物只該用一次');
  });
});

// ════════════════════════════════════════════════════════════════════
describe('主持人自查 S-1／S-2（批次 4 覆審期間發現）', () => {
  test('S-1 成績卡不得在院內版宣稱抽自全庫', async () => {
    // 成績卡是新人會截圖給帶教藥師看的東西。印「題庫 3,941 題」等於宣稱
    // 這一卷抽自全庫，而它只抽自院內的 N 個品項——分數的意義完全不同
    needPool();
    const ids = pickIds(300, 5151);
    const payload = payloadOf(ids);
    const dom = await boot({ saved: savedJson(payload) });
    const want = expectProbe(payload, Level.L1, ids);

    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    playAllCorrect(dom, want.quiz);
    dom.drawn.length = 0;
    dom.$('btnDownload').click();
    await dom.settle();

    const txt = dom.drawn.join(' ');
    assert.ok(txt.includes('院內清單 300 品項'), `成績卡未標明院內母體：${txt.slice(-160)}`);
    assert.ok(!txt.includes(`題庫 ${POOL.meta.count.toLocaleString()} 題`),
      '院內版的成績卡不得宣稱抽自全庫');
  });

  test('S-1 通用版的成績卡照舊印題庫題數（不得兩種模式都改掉）', async () => {
    needPool();
    const dom = await boot();
    Math.random = makeRng(5152);
    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    const total = Number(dom.$('qTotal').textContent);
    for (let i = 0; i < total; i++) {
      dom.$('qOptions').querySelectorAll('.opt')[0].click();
      dom.$('btnNext').click();
    }
    Math.random = REAL_RANDOM;
    dom.drawn.length = 0;
    dom.$('btnDownload').click();
    await dom.settle();
    const txt = dom.drawn.join(' ');
    assert.ok(txt.includes(`題庫 ${POOL.meta.count.toLocaleString()} 題`), txt.slice(-160));
    assert.ok(!txt.includes('院內清單'));
  });

  test('S-2 院內版重抽失敗只退回起始頁，不得把整個 app 打死', async () => {
    /**
     * 實測：30 品項的清單 probe 判定 L1 可用（K=29），但重抽 200 次失敗 105 次。
     * 第一回合有 probe 產物護著，第二回合起是擲硬幣——
     * 那條路徑原本走 `fatal()`，會把起始頁與答題頁全部藏掉，只能重新整理。
     */
    needPool();
    const ids = pickIds(30, 4545);
    const payload = payloadOf(ids);
    const dom = await boot({ saved: savedJson(payload) });
    const want = expectProbe(payload, Level.L1, ids);
    assert.equal(want.available, true);

    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();                 // 第一回合：用 probe 產物，必成功
    playAllCorrect(dom, want.quiz);
    dom.$('btnAgain').click();

    // seed 1 是實測會失敗的種子；seed 0 是實測會成功的
    cardFor(dom, Level.L1).click();
    Math.random = makeRng(1);
    dom.$('btnStart').click();
    Math.random = REAL_RANDOM;

    assert.equal(dom.hidden('fatal'), true, '可預期的隨機失敗不得走 fatal()');
    assert.equal(dom.hidden('start'), false, '必須留在起始頁讓使用者再按一次');
    assert.equal(dom.hidden('quiz'), true);
    assert.equal(dom.hidden('levelWarn'), false, '要說明為什麼沒開始');
    assert.ok(dom.$('levelWarn').textContent.includes('再按一次'));

    // 再按一次真的救得回來——否則上面那句話是空頭支票
    Math.random = makeRng(0);
    dom.$('btnStart').click();
    Math.random = REAL_RANDOM;
    assert.equal(dom.hidden('quiz'), false, '換一個 seed 應該就組得出來');
    assert.equal(Number(dom.$('qTotal').textContent), want.quiz.length);
  });
});

// ════════════════════════════════════════════════════════════════════
describe('D46 一次只有一個進行中的操作（依 codex-review CR-2／TG-2 新增）', () => {
  /**
   * 沒有 deferred fetch 就寫不出這一組——而寫不出來的後果是：
   * 「只在成功路徑檢查 epoch、失敗路徑照樣 commit」這個弱化實作全綠。
   */
  const openTwice = async (dom) => {
    dom.$('btnFormulary').click();          // A
    await dom.settle();
    dom.$('btnFxBack').click();
    dom.$('btnFormulary').click();          // B
    await dom.settle();
    assert.equal(fetchControl.pending.length, 2, '兩次開頁應各發一個請求');
    return fetchControl.pending;
  };

  test('B 先成功、A 晚到才失敗 → A 的失敗不得蓋掉 B', async () => {
    needPool();
    const dom = await boot({ defer: ['excluded.json'] });
    const [A, B] = await openTwice(dom);

    B.ok(EXCLUDED);
    await dom.settle();
    A.fail('late network failure');
    await dom.settle();

    assert.equal(dom.$('btnFxAnalyze').disabled, false, '較舊的失敗把產連結誤停用了');
    dom.$('fxInput').value = POOL.items.slice(0, 300).map((i) => i.id).join('\n');
    dom.$('btnFxAnalyze').click();
    assert.equal(dom.hidden('fxResult'), false, '分類應該要能跑');
    assert.equal(dom.hidden('fxError'), true, `不該有錯誤：${dom.$('fxError').textContent}`);
  });

  test('A 先失敗、B 後成功 → 最終以 B 為準', async () => {
    needPool();
    const dom = await boot({ defer: ['excluded.json'] });
    const [A, B] = await openTwice(dom);

    A.fail('early failure');
    await dom.settle();
    B.ok(EXCLUDED);
    await dom.settle();

    assert.equal(dom.$('btnFxAnalyze').disabled, false);
    dom.$('fxInput').value = POOL.items.slice(0, 300).map((i) => i.id).join('\n');
    dom.$('btnFxAnalyze').click();
    assert.equal(dom.hidden('fxResult'), false);
    assert.equal(dom.hidden('fxError'), true, `不該有錯誤：${dom.$('fxError').textContent}`);
  });

  test('只有一個操作時，失敗仍然必須停用產連結（正向對照）', async () => {
    // 〔堵〕把 catch 整段跳過也會讓上面兩條通過——那等於失敗永遠不被記錄
    needPool();
    const dom = await boot({ defer: ['excluded.json'] });
    dom.$('btnFormulary').click();
    await dom.settle();
    fetchControl.pending[0].fail('only request failed');
    await dom.settle();
    assert.equal(dom.$('btnFxAnalyze').disabled, true, '唯一的那次失敗必須生效');
    assert.equal(dom.hidden('fxError'), false);
  });
});

// ════════════════════════════════════════════════════════════════════
describe('D36 執行期路徑的子集封閉性（依 codex-review TG-3 新增）', () => {
  /**
   * C41 只驗了「主抽題」。真正沒被守住的是**執行期才走到**的四條：
   * 圖片作廢遞補、L2 誘答備援替換、閃卡遞補、錯題複習卷。
   * 那四條各自讀 `state.items`／`state.index`，任一條改回全庫都不會被現有測試抓到。
   */
  const IDS = () => pickIds(300, 3601);
  const subsetAns = (ids) => new Set(POOL.items.filter((it) => ids.includes(it.id)).map((it) => it.ans));
  const subsetSrc = (ids) => new Set(POOL.items.filter((it) => ids.includes(it.id)).map((it) => `data/${it.img}`));

  test('L1 正解圖失敗 → 遞補題仍封閉於子集', async () => {
    needPool();
    const ids = IDS();
    const payload = payloadOf(ids);
    const dom = await boot({ saved: savedJson(payload) });
    const want = expectProbe(payload, Level.L1, ids);

    imgControl.fail.add(`data/${want.quiz[0].item.img}`);
    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    await dom.settle();

    // 遞補真的發生了（原本那題被換掉），且換進來的仍在子集內
    const names = optionNames(dom);
    assert.notDeepEqual(names, want.quiz[0].options.map((o) => o.ans), '遞補沒有發生，這條在驗空氣');
    const ans = subsetAns(ids);
    for (const n of names) assert.ok(ans.has(n), `遞補題出現子集外的藥名 ${n}`);
    assert.ok(subsetSrc(ids).has(dom.$('qImg').src), `遞補題的圖 ${dom.$('qImg').src} 不在子集`);
  });

  test('L2 誘答圖失敗 → 備援替換仍封閉於子集', async () => {
    needPool();
    const ids = IDS();
    const payload = payloadOf(ids);
    const dom = await boot({ saved: savedJson(payload) });
    const want = expectProbe(payload, Level.L2, ids);
    const q0 = want.quiz[0];
    const victim = q0.options.findIndex((_, k) => k !== q0.answerIdx);
    imgControl.fail.add(`data/${q0.options[victim].img}`);

    cardFor(dom, Level.L2).click();
    dom.$('btnStart').click();
    await dom.settle();
    await dom.settle();

    const srcs = dom.cells().map((c) => c.querySelector('img').src);
    assert.notEqual(srcs[victim], `data/${q0.options[victim].img}`, '備援替換沒有發生');
    const ok = subsetSrc(ids);
    for (const s of srcs) assert.ok(ok.has(s), `L2 格位出現子集外的圖 ${s}`);
  });

  test('閃卡（含遞補）封閉於子集：小子集 ＋ 多個 seed，不靠運氣', async () => {
    /**
     * 遞補一次只抽一張，**單一樣本擋不住洩漏**：300 品項的子集下，
     * 誤用全庫索引仍有 300/3941 ≈ 7.6% 機率剛好抽回子集內——實測就這麼發生過，
     * 變異因此存活（A41 的〔堵〕(b)「隨機抽樣可能剛好沒抽到洩漏品項」同型）。
     *
     * 改成 **40 品項的小子集**（誤用全庫時 99% 會抽到外面）**再跑 3 個 seed**，
     * 三次都碰巧抽回子集的機率約 1e-6。
     */
    needPool();
    const ids = pickIds(40, 3620);
    const payload = payloadOf(ids);
    const ok = subsetSrc(ids);

    for (const SEED of [3621, 3622, 3623]) {
      // 第一趟：只為了知道「這個 seed 下第一張是哪一張」。不預測 deck——
      // 預測錯的話 `notEqual` 會碰巧成立，而遞補其實從未發生（實際踩過）
      const a = await boot({ saved: savedJson(payload) });
      Math.random = makeRng(SEED);
      a.$('btnFlash').click();
      await a.settle();
      Math.random = REAL_RANDOM;
      const firstSrc = a.$('fImg').src;
      assert.ok(ok.has(firstSrc), `seed ${SEED}：閃卡第一張 ${firstSrc} 不在子集`);

      // 第二趟：讓那一張注定失敗 → 一定會走到 `drawSpareCard()`
      const b = await boot({ saved: savedJson(payload) });
      imgControl.fail.add(firstSrc);
      Math.random = makeRng(SEED);
      b.$('btnFlash').click();
      await b.settle();
      Math.random = REAL_RANDOM;
      await b.settle();

      assert.notEqual(b.$('fImg').src, firstSrc, `seed ${SEED}：遞補沒有被觸發`);
      assert.ok(ok.has(b.$('fImg').src), `seed ${SEED}：遞補後的卡 ${b.$('fImg').src} 不在子集`);
    }
  });

  test('閃卡整疊封閉於子集', async () => {
    /**
     * **遞補必須真的被觸發。** 第一版是等第一張載入成功之後才把它加進 fail 清單——
     * 那時 `onerror` 早就不會來了，`drawSpareCard()` 一次都沒被呼叫，
     * 於是「閃卡遞補改用全庫索引」這個變異全綠（P15）。
     * 現在改成：先用同一個 seed 算出這疊，**在點下去之前**讓第一張的圖注定失敗。
     */
    needPool();
    const ids = IDS();
    const payload = payloadOf(ids);
    const dom = await boot({ saved: savedJson(payload) });
    const ok = subsetSrc(ids);

    dom.$('btnFlash').click();
    await dom.settle();
    assert.ok(ok.has(dom.$('fImg').src), `閃卡第一張 ${dom.$('fImg').src} 不在子集`);

    for (let i = 0; i < 5; i++) {
      dom.$('btnFlashNext').click();
      await dom.settle();
      assert.ok(ok.has(dom.$('fImg').src), `閃卡第 ${i + 2} 張 ${dom.$('fImg').src} 不在子集`);
    }
  });

  test('錯題複習卷封閉於子集', async () => {
    needPool();
    const ids = IDS();
    const payload = payloadOf(ids);
    const dom = await boot({ saved: savedJson(payload) });
    const want = expectProbe(payload, Level.L1, ids);

    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    // 全部答錯：點一個不是正解的選項
    for (let i = 0; i < want.quiz.length; i++) {
      const names = optionNames(dom);
      const wrong = names.findIndex((n) => n !== want.quiz[i].item.ans);
      dom.$('qOptions').querySelectorAll('.opt')[wrong].click();
      dom.$('btnNext').click();
    }
    assert.equal(dom.hidden('btnRetry'), false, '全錯應該要有錯題再戰');
    dom.$('btnRetry').click();
    await dom.settle();

    const ans = subsetAns(ids);
    const total = Number(dom.$('qTotal').textContent);
    assert.ok(total > 0);
    for (let i = 0; i < total; i++) {
      for (const n of optionNames(dom)) assert.ok(ans.has(n), `複習卷出現子集外的藥名 ${n}`);
      dom.$('qOptions').querySelectorAll('.opt')[0].click();
      dom.$('btnNext').click();
    }
  });
});

// ════════════════════════════════════════════════════════════════════
describe('D44.3 URL 邊界（依 codex-review CR-3／CR-4 新增）', () => {
  const P = () => payloadOf(pickIds(300, 4433));

  test('encoded key `%66x` 也要被移除——消費了卻留在網址上是最糟的狀態', async () => {
    needPool();
    const dom = await boot({ href: `https://example.test/quiz/?%66x=${P()}&b=2` });
    assert.equal(dom.hidden('startFxNote'), false, '`%66x` 解碼後就是 fx，必須被消費');
    assert.deepEqual(urlControl.replaced, ['/quiz/?b=2']);
  });

  test('空 segment 屬於「其餘 query」，不得順手正規化掉', async () => {
    needPool();
    const dom = await boot({ href: `https://example.test/quiz/?a=1&&fx=${P()}&b=2&#f` });
    assert.equal(dom.hidden('startFxNote'), false);
    assert.deepEqual(urlControl.replaced, ['/quiz/?a=1&&b=2&#f']);
  });

  test('`fxx`／`afx` 不得被誤刪', async () => {
    needPool();
    await boot({ href: `https://example.test/quiz/?fxx=1&afx=2&fx=${P()}` });
    assert.deepEqual(urlControl.replaced, ['/quiz/?fxx=1&afx=2']);
  });

  test('`?fx=`（空值）是壞連結：要走 decoder、要提示、要保留', async () => {
    // 〔堵〕`if (fx)` 把空字串當成沒有參數 → 靜默當通用版，使用者不知道連結壞了
    needPool();
    const dom = await boot({ href: 'https://example.test/quiz/?fx=&keep=1' });
    assert.equal(dom.hidden('startFxNote'), true);
    assert.equal(dom.hidden('startFxWarn'), false, '必須提示連結有問題');
    assert.deepEqual(urlControl.replaced, [], '失敗時不得動網址');
  });
});

// ════════════════════════════════════════════════════════════════════
describe('C47 通用版紀錄的精確內容（依 codex-review TG-5 強化）', () => {
  test('逐欄比對 schema／level／score／streak／date／pool hash', async () => {
    needPool();
    const dom = await boot();
    const SEED = 4750;
    const idx = buildIndex(POOL.items);
    const expected = drawLeveledQuizForTest(SEED, idx);

    Math.random = makeRng(SEED);
    cardFor(dom, Level.L1).click();
    dom.$('btnStart').click();
    Math.random = REAL_RANDOM;
    // 與獨立算出來的題卷比對，證明 seed 對齊——否則下面的分數期望值沒有意義
    assert.deepEqual(optionNames(dom), expected[0].options.map((o) => o.ans));
    playAllCorrect(dom, expected);

    const rec = JSON.parse(storeControl.map.get(REC_KEY));
    const today = new Date().toISOString().slice(0, 10);
    const poolHash = String(POOL.meta.content_hash || '').replace(/^sha256:/, '').slice(0, 12);
    assert.equal(rec.schema, 1);
    assert.deepEqual(Object.keys(rec).filter((k) => k !== 'schema'), [Level.L1], '只該寫這一級');
    assert.deepEqual(rec[Level.L1].bestScore, { value: 100, date: today, pool: poolHash });
    assert.deepEqual(rec[Level.L1].bestStreak, { value: QUIZ_SIZE, date: today, pool: poolHash });
  });
});

// ════════════════════════════════════════════════════════════════════
describe('§5.2 不產連結的每一種情形都要說明原因（依 codex-review TG-8 新增）', () => {
  async function analyze(dom, text) {
    dom.$('fxInput').value = text;
    dom.$('btnFxAnalyze').click();
    await dom.settle();
  }

  test('四種拒絕情形：原因非空、且不得留下上一輪的連結', async () => {
    needPool();
    const dom = await boot();
    dom.$('btnFormulary').click();
    await dom.settle();

    // 先成功產一條連結，後面每一種拒絕都必須把它收掉
    await analyze(dom, POOL.items.slice(0, 300).map((i) => i.id).join('\n'));
    assert.equal(dom.hidden('fxLinkBox'), false, '這批應該產得出連結');

    const CASES = [
      ['空輸入', '', /沒有任何 token|無法解析/],
      ['命中 0 筆', '衛署藥製字第999998號', /沒有任何品項/],
      ['三級全不可用', POOL.items.slice(0, 9).map((i) => i.id).join('\n'), /組不出/],
      ['超出網址上限', POOL.items.slice(0, 1500).map((i) => i.id).join('\n'), /超出可分享連結上限/],
    ];
    for (const [name, text, re] of CASES) {
      await analyze(dom, text);
      assert.equal(dom.hidden('fxError'), false, `${name}：必須說明原因`);
      assert.ok(re.test(dom.$('fxError').textContent),
        `${name}：訊息不符——實得「${dom.$('fxError').textContent}」`);
      assert.equal(dom.hidden('fxLinkBox'), true, `${name}：不得留著上一輪的連結`);
    }
  });

  test('超限訊息的三個數字各自正確（CR-5）', async () => {
    needPool();
    const dom = await boot();
    dom.$('btnFormulary').click();
    await dom.settle();
    const ids = POOL.items.slice(0, 1500).map((i) => i.id);
    await analyze(dom, ids.join('\n'));
    const msg = dom.$('fxError').textContent;
    assert.ok(msg.includes(`清單 ${ids.length} 筆相異字號`), `清單總數應為 distinct：${msg}`);
    assert.ok(/其中 \d+ 筆進入連結/.test(msg), `要說出進 payload 的筆數：${msg}`);
    assert.ok(/網址 \d+ 字元/.test(msg));
  });

  test('5000 行輸入：畫面明細有上限、下載仍完整', async () => {
    needPool();
    const dom = await boot();
    dom.$('btnFormulary').click();
    await dom.settle();
    const junk = Array.from({ length: 5000 }, (_, i) => `衛署藥XX字第${String(i + 1).padStart(6, '0')}號`);
    await analyze(dom, [POOL.items[0].id, ...junk].join('\n'));

    const shown = dom.$('fxUnlistedList').textContent.split('\n');
    assert.ok(shown.length <= 51, `畫面明細應有上限，實得 ${shown.length} 行`);
    assert.ok(shown[shown.length - 1].includes('共 5000 筆'));
    dom.$('btnFxDownload').click();
    const text = await dom.blobs[dom.blobs.length - 1].text();
    assert.equal(text.split('\n').filter((l) => l && !l.startsWith('#')).length, 5000,
      '下載檔必須是完整的，不能跟著畫面截斷');
  });
});

// ════════════════════════════════════════════════════════════════════
describe('樁本身的守備力（依 codex-review TG-6／TG-7）', () => {
  test('property assignment sink：value 與 alt 都在清冊內且有 sentinel', async () => {
    needPool();
    const dom = await boot();
    sinkLog.reset();
    dom.$('fxLink').value = 'SENTINEL_VALUE';
    dom.$('qImg').alt = 'SENTINEL_ALT';
    const seen = new Set(sinkLog.calls.map((c) => c.sink));
    assert.ok(seen.has('value'), 'value 是字串 property sink，必須監控');
    assert.ok(seen.has('alt'), 'alt 是字串 property sink，必須監控');
    assert.equal(sinkLog.taintedBy('SENTINEL_VALUE').length, 1);
  });

  test('排除項必須明列理由，不得默默漏列', () => {
    // C50 的原意是「不得默默漏列」，不是「什麼都要監控」——
    // 排除 disabled／style.width／classList 的理由寫在樁裡，這條把它釘住
    for (const k of ['disabled', 'style.width', 'classList']) {
      assert.ok(sinkLog.excluded[k] && sinkLog.excluded[k].length > 4,
        `排除項 ${k} 必須寫明理由`);
    }
  });

  test('boot 之間不會有舊實例的 pending 請求殘留', async () => {
    // 樁無法讓舊 module 實例綁到舊 document（app.js 是在 callback 當下讀 global），
    // 因此隔離靠的是「boot 會把所有 pending handle 丟掉」——這條把那個前提釘住
    needPool();
    const dom = await boot({ defer: ['excluded.json'] });
    dom.$('btnFormulary').click();
    await dom.settle();
    assert.equal(fetchControl.pending.length, 1);
    await boot();
    assert.deepEqual(fetchControl.pending, [], 'boot 後不得還有上一個實例的待決請求');
  });
});

// ════════════════════════════════════════════════════════════════════
describe('DOM 掛點確實存在於 index.html（樁會自動生元素，這條防它）', () => {
  const IDS = [
    'btnFormulary', 'formulary', 'fxInput', 'fxDelim', 'fxColumn', 'fxHeader',
    'btnFxAnalyze', 'btnFxBack', 'fxError', 'fxResult', 'fxSummary', 'fxBreakdown',
    'fxUnlistedList', 'btnFxDownload', 'fxLevels', 'fxLinkBox', 'fxLink', 'btnFxCopy',
    'startFxNote', 'sFxN', 'sFxUnlisted', 'startFxWarn',
    'qFxNote', 'qFxN', 'qFxK', 'qFxUnlisted',
    'resultFxNote', 'rFxN', 'rFxK', 'rFxUnlisted',
  ];
  for (const id of IDS) {
    test(`#${id} 在 index.html 內`, () => {
      assert.ok(HTML.includes(`id="${id}"`), `index.html 缺少 #${id}`);
    });
  }
});
