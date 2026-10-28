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
