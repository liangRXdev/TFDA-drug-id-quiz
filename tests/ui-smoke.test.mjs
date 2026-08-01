/**
 * UI 接線層測試 — 對應 .ai-review/plan-v3-levels.md §7 的 C7／C13／C16 與 §6.1
 *
 *   node --test
 *
 * 實際 import app.js 並用最小 DOM 樁驅動完整回合。
 * engine 的純函式測試證明「算得對」，這裡證明「接得對」——
 * 級別分派接錯、成績卡漏印級別、再測一回沿用舊級別，
 * 都是 engine 全綠而功能靜默失效的路徑。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, ROOT } from './_ui-harness.mjs';

const hasPool = fs.existsSync(path.join(ROOT, 'data/pool.json'));
const dom = installDom();
const { $, drawn, hidden } = dom;

// app.js 在 import 時就會 loadPool() 並綁定事件，樁必須先裝好
if (hasPool) {
  await import(`file://${path.join(ROOT, 'app.js').replace(/\\/g, '/')}`);
  await new Promise((r) => setTimeout(r, 300));
}

const needPool = () => assert.ok(hasPool, 'data/pool.json 不存在，請先執行 npm run build:pool');
const levelCards = () => $('levelPick').querySelectorAll('.level');

/** 走完一整回合，回傳實際作答題數 */
function playRound(level) {
  levelCards().find((l) => l.dataset.level === level).click();
  $('btnStart').click();
  let answered = 0;
  for (let i = 0; i < 25 && hidden('result'); i++) {
    if (level === 'L1') {
      const opts = $('qOptions').querySelectorAll('.opt');
      assert.equal(opts.length, 4, `第 ${i + 1} 題選項數應為 4`);
      opts[i % 4].click();
      const marked = opts.filter((o) => o.classList.contains('ok'));
      assert.equal(marked.length, 1, '作答後應恰有一格標為正解');
      opts[(i + 1) % 4].click();       // 重複點擊不得改變狀態
    } else {
      $('qInput').value = i % 3 === 0 ? 'ZZZWRONGNAME' : 'ISOPTIN';
      $('btnSubmit').click();
    }
    answered++;
    assert.ok(!hidden('qVerdict'), `第 ${i + 1} 題未顯示判定`);
    $('btnNext').click();
  }
  return answered;
}

describe('載入與難度選擇', () => {
  before(needPool);

  test('載入題庫後顯示開始畫面', () => {
    assert.ok(!hidden('start'));
    assert.match($('poolInfo').innerHTML, /題庫/);
  });

  test('C7 未選級別時開始鈕 disabled', () => {
    assert.equal($('btnStart').disabled, true);
  });

  test('C7 未選級別時直接觸發 handler 也不得建立題卷', () => {
    // 〔堵〕只加 disabled 外觀，直接呼叫 handler 或按 Enter 仍能開始
    $('btnStart').click();
    assert.ok(hidden('quiz'), '未選級別卻進入了作答畫面');
    assert.equal($('qOptions').innerHTML, '', '未選級別卻渲染了選項');
    assert.ok(!hidden('levelWarn'), '應顯示「請先選擇難度」提示');
  });

  test('級別卡渲染且 data-level 正確', () => {
    const ids = levelCards().map((l) => l.dataset.level);
    assert.deepEqual(ids, ['L1', 'L3']);
  });
});

describe('C16 L1 完整回合', () => {
  before(needPool);

  test('選 L1 → 作答 20 題 → 成績頁', () => {
    assert.equal(playRound('L1'), 20);
    assert.ok(!hidden('result'));
  });

  test('級別徽章為「簡單級」', () => {
    assert.equal($('resultBadge').textContent, '簡單級');
  });

  test('D14 成績頁顯示亂猜基線與淨值', () => {
    const m = $('resultMetrics').innerHTML;
    assert.match(m, /亂猜基線/);
    assert.match(m, /淨\s*[+-]/);
  });

  test('L1 逐題檢討含「你選的」欄', () => {
    assert.match($('reviewHead').innerHTML, /你選的/);
    assert.match($('reviewBody').innerHTML, /<tr>/);
  });

  test('C13 成績卡實際繪製出級別與基線', async () => {
    // 〔堵〕頁面 DOM 上有就宣稱「畫面上印有」，但下載的 PNG 內沒有
    drawn.length = 0;
    $('btnDownload').click();
    await new Promise((r) => setTimeout(r, 200));
    const txt = drawn.join(' ');
    assert.match(txt, /簡單級/, '成績卡未繪製級別');
    assert.match(txt, /亂猜基線/, '成績卡未繪製亂猜基線');
    assert.match(txt, /不可跨難度比較/, '成績卡未繪製跨級不可比的警語');
  });

  test('§6.1 再測一回後級別重設為未選', () => {
    $('btnAgain').click();
    assert.equal($('btnStart').disabled, true);
    assert.ok(!hidden('start'));
    assert.deepEqual(
      levelCards().map((l) => l.getAttribute('aria-checked')),
      ['false', 'false'],
      '再測一回後仍保留上次選取 → 成績卡會印出非預期的級別',
    );
  });
});

describe('C16 L3 完整回合（v2 行為不得回歸）', () => {
  before(needPool);

  test('選 L3 → 輸入作答 20 題 → 成績頁', () => {
    assert.equal(playRound('L3'), 20);
    assert.ok(!hidden('result'));
  });

  test('級別徽章為「困難級」，且基線為 0', () => {
    assert.equal($('resultBadge').textContent, '困難級');
    assert.match($('resultMetrics').innerHTML, /亂猜基線/);
  });

  test('L3 逐題檢討維持四欄（無「你選的」）', () => {
    assert.doesNotMatch($('reviewHead').innerHTML, /你選的/);
  });

  test('C13 L3 成績卡印出「困難級」', async () => {
    drawn.length = 0;
    $('btnDownload').click();
    await new Promise((r) => setTimeout(r, 200));
    assert.match(drawn.join(' '), /困難級/);
  });
});

describe('C17 縮放未被停用（D22）', () => {
  test('viewport 不得停用縮放', () => {
    // 〔堵〕為了「像 app 一點」加上 user-scalable=no，畫面完全正常，
    //       但 L2 的可解性建立在 pinch-zoom 之上，會靜默失效
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const m = html.match(/<meta\s+name="viewport"\s+content="([^"]*)"/i);
    assert.ok(m, 'index.html 必須有 viewport meta');
    const content = m[1];
    assert.doesNotMatch(content, /user-scalable\s*=\s*no/i);
    assert.doesNotMatch(content, /maximum-scale\s*=\s*[1-4](\.|,|$|\s)/i);
    assert.doesNotMatch(html, /touch-action:\s*(none|pinch-zoom)/i);
  });
});
