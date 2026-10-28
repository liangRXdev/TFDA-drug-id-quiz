/**
 * 2026-10 覆審修正的 UI 接線層 — M1（noSquash 接線）、M3（featureCell／source_file 跳脫）、
 * startQuiz catch 內的未定義識別字
 *
 *   node --test
 *
 * engine 的 judge 有了 noSquash 旗標不代表 app 真的會傳——「純函式全綠而功能靜默不存在」
 * 是本 repo 記過的形狀。這裡實際 import app.js、餵自訂題庫、走完整回合。
 *
 * **證據層級**：零依賴 DOM 樁不解析 HTML，「不產生元素」以 sink 清冊判定——
 * 原始標籤字串是否經由 innerHTML 進入 DOM（`sinkLog.taintedBy`）。
 * 有沒有跳脫在這一層就決定了，瀏覽器解析器不會把 `&lt;img` 變回標籤。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  installDom, ROOT, imgControl, storeControl, urlControl, fetchControl, sinkLog,
} from './_ui-harness.mjs';

const APP = `file://${path.join(ROOT, 'app.js').replace(/\\/g, '/')}`;
const POOL = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/pool.json'), 'utf8'));
const REAL_RANDOM = Math.random;
after(() => { Math.random = REAL_RANDOM; });

let bootN = 0;
async function boot(pool) {
  imgControl.reset();
  storeControl.reset();
  urlControl.reset('https://example.test/quiz/');
  fetchControl.reset();
  sinkLog.reset();
  fetchControl.body.set('pool.json', pool);
  const dom = installDom();
  await import(`${APP}?hardening=${++bootN}`);
  await new Promise((r) => setTimeout(r, 60));
  return dom;
}

/** 恰 20 個相異答案鍵的題庫：L3 一卷 20 題必定抽到每一個 */
function poolOf(picked, meta = {}) {
  const items = structuredClone(picked);
  assert.equal(new Set(items.map((i) => i.ans)).size, 20, 'fixture 必須恰 20 個相異答案鍵');
  return { meta: { ...POOL.meta, count: items.length, ...meta }, items };
}

function startL3(dom) {
  dom.$('levelPick').querySelectorAll('.level').find((l) => l.dataset.level === 'L3').click();
  dom.$('btnStart').click();
  assert.ok(!dom.hidden('quiz'), '未進入作答畫面');
}

describe('M1 app 對 no_squash 的答案鍵停用去空白比對', () => {
  const byAns = (a) => POOL.items.find((i) => i.ans === a);
  const twinA = { ...byAns('SUMIN') };
  const twinB = { ...byAns('SU MIN') };
  const others = [];
  for (const it of POOL.items) {
    if (others.length === 18) break;
    if (/^SU ?MIN$/.test(it.ans) || others.some((o) => o.ans === it.ans)) continue;
    others.push(it);
  }

  /** 每題都輸入同一字串，回傳 {ans → 是否判對}（從畫面上的判定讀，不從 state 讀） */
  async function roundTyping(input) {
    const dom = await boot(poolOf([twinA, twinB, ...others], { no_squash: ['SUMIN'] }));
    startL3(dom);
    const got = new Map();
    for (let i = 0; i < 25 && dom.hidden('result'); i++) {
      dom.$('qInput').value = input;
      dom.$('btnSubmit').click();
      const v = dom.$('qVerdict').innerHTML;
      const ok = v.includes('✓ 答對');
      if (v.includes('SUMIN TABLETS')) got.set('SUMIN', ok);
      if (v.includes('Su-min')) got.set('SU MIN', ok);
      dom.$('btnNext').click();
    }
    assert.equal(got.size, 2, '兩個雙胞胎都必須出現在這一卷');
    return got;
  }

  test('前提：fixture 的兩筆確實是去空白同字的相異答案鍵', () => {
    assert.ok(twinA.ans && twinB.ans, '題庫已無 SUMIN／SU MIN，請改用其他 distinct 裁決的雙胞胎');
    assert.notEqual(twinA.ans, twinB.ans);
    assert.equal(twinA.ans.replace(/\s/g, ''), twinB.ans.replace(/\s/g, ''));
  });

  test('輸入 SU MIN：正解 SUMIN 判錯、正解 SU MIN 判對', async () => {
    const got = await roundTyping('SU MIN');
    assert.equal(got.get('SUMIN'), false, '正解 SUMIN（適敏）卻接受了另一個產品的名字 SU MIN');
    assert.equal(got.get('SU MIN'), true);
  });

  test('輸入 SUMIN：正解 SU MIN 判錯、正解 SUMIN 判對', async () => {
    const got = await roundTyping('SUMIN');
    assert.equal(got.get('SU MIN'), false, '正解 SU MIN（抒敏）卻接受了另一個產品的名字 SUMIN');
    assert.equal(got.get('SUMIN'), true);
  });
});

describe('M3 外觀特徵與題庫 meta 一律跳脫後才進 innerHTML', () => {
  /** 只看會**解析 HTML** 的 sink；`alt`／`textContent` 等純文字 sink 本來就不產生元素 */
  const HTML_SINKS = new Set(['innerHTML', 'outerHTML', 'insertAdjacentHTML']);
  const htmlTainted = (needle) =>
    sinkLog.calls.filter((c) => HTML_SINKS.has(c.sink) && c.value.includes(needle));
  const EVIL1 = '<img src=x onerror=1>';
  const EVIL2 = '<svg onload=2>';
  const EVIL_FILE = '<img src=y onerror=3>.json';
  const evilPool = () => {
    const seen = new Set();
    const picked = [];
    for (const it of POOL.items) {
      if (seen.has(it.ans)) continue;
      seen.add(it.ans);
      picked.push({ ...it, mark1: EVIL1, mark2: EVIL2, size: '<i>8</i>', shape: ['<b>圓形</b>'] });
      if (picked.length === 20) break;
    }
    return poolOf(picked, { source_file: EVIL_FILE, source: '<u>src</u>' });
  };

  test('起始頁：source_file／source 不得以原始標籤進入 DOM', async () => {
    const dom = await boot(evilPool());
    assert.ok(!dom.hidden('start'), '題庫未載入成功，這條什麼也沒驗到');
    assert.deepEqual(htmlTainted(EVIL_FILE), [], 'source_file 未跳脫');
    assert.deepEqual(htmlTainted('<u>src</u>'), [], 'source 未跳脫');
    assert.match(dom.$('poolInfo').innerHTML, /&lt;img src=y onerror=3&gt;/, '跳脫後的文字仍須顯示');
  });

  test('作答頁 qFeatures：mark1／mark2／size／shape 不產生元素', async () => {
    const dom = await boot(evilPool());
    startL3(dom);
    const html = dom.$('qFeatures').innerHTML;
    assert.ok(html.includes('&lt;img src=x onerror=1&gt;'), '標記一應以跳脫後的文字顯示');
    for (const evil of [EVIL1, EVIL2, '<i>8</i>', '<b>圓形</b>']) {
      assert.deepEqual(htmlTainted(evil), [], `${evil} 以原始標籤進入 innerHTML`);
    }
  });

  test('閃卡 fFeatures：同一個 featureCell，同樣不產生元素', async () => {
    const dom = await boot(evilPool());
    dom.$('btnFlash').click();
    await dom.settle();
    assert.ok(dom.$('fFeatures').innerHTML.includes('&lt;svg onload=2&gt;'), '閃卡未渲染特徵，這條什麼也沒驗到');
    for (const evil of [EVIL1, EVIL2]) assert.deepEqual(htmlTainted(evil), []);
  });
});

describe('startQuiz 的錯誤分支不得引用未定義識別字', () => {
  test('INSUFFICIENT_KEYS 訊息用的是卷長 len，不是不存在的 n（靜態）', () => {
    // 證據層級：靜態原始碼契約。通用版的這條分支在 UI 上到不了——
    // `lenOff()` 以同一個 eligible 集合做算術收斂，先擋下了；它是縱深防禦。
    // 但真的走到時 `${n}` 會在 catch 內拋 ReferenceError，使用者只看到一片空白
    const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const start = src.indexOf('function startQuiz()');
    const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
    assert.ok(body.includes("e.code === 'INSUFFICIENT_KEYS'"), '找不到目標分支，這條已沒打中');
    const exprs = [...body.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
    assert.deepEqual(exprs.filter((x) => /(^|[^.\w])n([^\w]|$)/.test(x)), [],
      'startQuiz 的樣板字串引用了未宣告的 n');
  });
});
