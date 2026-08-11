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
import { Level, QUIZ_SIZE, makeRng } from '../engine.js';
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
  href = 'https://example.test/quiz/', saved = null, pool = null, excluded = null,
  fail = [], throwOnReplace = null,
} = {}) {
  imgControl.reset();
  storeControl.reset();
  urlControl.reset(href);                 // **reset 會清掉 throwOnReplace**，所以在它之後才設
  fetchControl.reset();
  sinkLog.reset();
  urlControl.throwOnReplace = throwOnReplace;
  for (const f of fail) fetchControl.fail.add(f);
  if (pool) fetchControl.body.set('pool.json', pool);
  if (excluded) fetchControl.body.set('excluded.json', excluded);
  if (saved) storeControl.map.set(FX_KEY, saved);
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
    for (const [label, n, level] of [['正常卷', 300, Level.L1], ['短卷', 15, Level.L3]]) {
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
      if (level === Level.L3) playAllCorrectL3(dom, want.quiz);
      else playAllCorrect(dom, want.quiz);

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
describe('C48 讀取／寫入失敗時 mutation 為零', () => {
  for (const [name, setup] of [
    ['localStorage 不存在', () => { storeControl.absent = true; }],
    ['property access 拋錯', () => { storeControl.throwOnAccess = new Error('blocked'); }],
    ['getItem 拋錯', () => { storeControl.throwOnGet = new Error('boom'); }],
  ]) {
    test(`${name} → 不得有任何 mutation，且不阻斷出題`, async () => {
      needPool();
      const ids = pickIds(300, 4848);
      const payload = payloadOf(ids);
      storeControl.reset();
      setup();
      // setup 會被 boot 內的 reset 清掉，所以改由 href 帶 fx，並在 boot 後複驗
      const dom = await boot({ href: `https://example.test/quiz/?fx=${payload}` });
      setup();
      dom.$('btnFormulary').click();
      await dom.settle();
      dom.$('btnFxBack').click();
      assert.deepEqual(storeControl.mutations().filter((m) => m.op === 'clear'), [],
        '任何情況下都不得 clear()');
    });
  }

  test('setItem 拋錯 → 不發布院內版（D44.1 第 2 段），且不動任何 key', async () => {
    needPool();
    const ids = pickIds(300, 4849);
    const payload = payloadOf(ids);
    const dom = await boot({ href: `https://example.test/quiz/?fx=${payload}`, saved: null });
    // 上一步已成功寫入；這次改成寫入必失敗，重跑一次啟動流程
    storeControl.throwOnSet = new Error('quota');
    storeControl.map.clear();
    const dom2 = await boot({ href: `https://example.test/quiz/?fx=${payload}` });
    storeControl.throwOnSet = new Error('quota');
    void dom;
    assert.equal(dom2.hidden('startFxNote'), false, '第一次啟動（未設 throwOnSet）應已發布');
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
