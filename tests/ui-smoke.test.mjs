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
import {
  Level, buildIndex, eligibleKeys, drawLeveledQuiz, makeRng, QState, CHOICE_COUNT, displayZh,
} from '../engine.js';

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

const POOL = hasPool
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data/pool.json'), 'utf8'))
  : { items: [] };
let IDX = null;
const idx = () => (IDX ||= buildIndex(POOL.items));
const srcOf = (item) => `data/${item.img}`;

/**
 * 讓 app.js 走一條**已知**的 RNG 序列，測試因而能事先知道
 * 每一題的正解格、每一格的圖片與備援——否則「讓誘答圖失敗」這種測試
 * 只能亂猜哪一格是誘答，測不出 C9/C10 的差別。
 */
function startLevelDeterministic(level, seed) {
  const expected = drawLeveledQuiz(POOL.items, {
    level, n: 20, rng: makeRng(seed), index: idx(), eligible: eligibleKeys(idx(), level),
  });
  Math.random = makeRng(seed);
  levelCards().find((l) => l.dataset.level === level).click();
  $('btnStart').click();
  return expected;
}

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
    assert.deepEqual(ids, ['L1', 'L2', 'L3']);
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
      ['false', 'false', 'false'],
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

describe('L1 選項附中文品名', () => {
  before(needPool);

  /** app.js 的 escapeHtml 等價實作——品名含 " 與 ' 時 DOM 內是實體 */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** 取出所有 <span class="zh"> 的內容 */
  const zhCells = () => [...$('qOptions').innerHTML.matchAll(/<span class="zh">([\s\S]*?)<\/span>/g)]
    .map((m) => m[1]);

  test('四個選項各自顯示英文與中文品名', () => {
    const expected = startLevelDeterministic(Level.L1, 9101);
    const html = $('qOptions').innerHTML;
    for (const o of expected[0].options) {
      assert.ok(html.includes(esc(o.ans)), `選項缺英文品名 ${o.ans}`);
      assert.ok(html.includes(esc(displayZh(o.zh))), `選項缺中文品名 ${o.zh}`);
    }
    assert.equal(zhCells().length, CHOICE_COUNT, '四格都要有中文品名欄');
  });

  test('渲染出的中文品名沒有連續空白', () => {
    // 只檢查 zh 欄本身——模板本來就有縮排空白，掃整段 HTML 測不到東西。
    //
    // **這條的守備力取決於題庫當下的髒資料量。** 目前 3,913 筆裡只有 1 筆
    // 帶全形空白 padding，隨機 20 題幾乎抽不到——變異驗證證實：把 displayZh
    // 拿掉改印 raw zh，這條仍全綠。真正守住清理邏輯的是 engine.test.mjs 的
    // displayZh 測試（用固定的髒字串）。這裡留著是為了將來髒資料變多時能擋，
    // 不是因為它現在擋得住。
    startLevelDeterministic(Level.L1, 9102);
    for (const zh of zhCells()) {
      assert.doesNotMatch(zh, /　{2,}/, `中文品名有連續全形空白：${JSON.stringify(zh)}`);
      assert.doesNotMatch(zh, /\s{2,}/, `中文品名有連續空白：${JSON.stringify(zh)}`);
      assert.equal(zh, zh.trim(), '中文品名頭尾有空白');
    }
  });

  test('選項版面：長品名可斷行，序號對齊第一行', () => {
    // 〔堵〕flex 子項少了 min-width:0 就不會斷行，長中文品名會把按鈕撐出容器
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /\.opt \.txt \{[^}]*min-width:\s*0/);
    assert.match(html, /\.opt \{[^}]*align-items:\s*flex-start/);
    assert.match(html, /\.opt \{[^}]*word-break/);
  });

  test('中文品名不影響判定：正解仍由 answerIdx 決定', () => {
    // 〔堵〕改用品名字串比對來判定。顯示層加欄位不該動到判定路徑
    const expected = startLevelDeterministic(Level.L1, 9103);
    const q0 = expected[0];
    const opts = $('qOptions').querySelectorAll('.opt');
    opts[q0.answerIdx].click();
    assert.match($('qVerdict').innerHTML, /答對/);
    assert.match($('qVerdict').className, /ok/);
  });

  test('L1 難度說明有標示中文品名會透露劑型', () => {
    // L1 誘答刻意 shape／color 不相交，而中文品名幾乎都含劑型詞，
    // 實測 22.4% 的題目可只靠劑型詞命中。這是知情接受的取捨，
    // 但必須讓使用者看得到，否則分數會被誤讀為外觀辨識能力
    $('btnAgain').click();
    const html = $('levelPick').innerHTML;      // 卡片內容在容器的 innerHTML 上
    const l1Block = html.slice(html.indexOf('data-level="L1"'), html.indexOf('data-level="L2"'));
    assert.match(l1Block, /中文品名/);
    assert.match(l1Block, /劑型/);
  });
});

describe('C8 品名不得洩漏到 L2 的格子', () => {
  before(needPool);

  test('L2 四宮格作答前不含任何選項的英文或中文品名', () => {
    // L2 是「給藥名選圖」，題幹本來就有品名；但格子本身作答前
    // 不得出現任何品名，否則直接送分。
    // 不能斷言「格子不含中文字」——alt 的中性描述（「選項 A 藥品外觀」）
    // 本來就是中文，那樣寫會變成永遠失敗的錯誤斷言
    const expected = startLevelDeterministic(Level.L2, 9201);
    const grid = $('qGrid').innerHTML;
    for (const o of expected[0].options) {
      assert.ok(!grid.includes(o.ans), `L2 格子洩漏英文品名 ${o.ans}`);
      assert.ok(!grid.includes(displayZh(o.zh)), `L2 格子洩漏中文品名 ${o.zh}`);
    }
  });
});

describe('C17 縮放未被停用（D22）', () => {
  test('viewport 不得停用縮放，也不得停用放大後的平移', () => {
    // 〔堵〕為了「像 app 一點」加上 user-scalable=no，畫面完全正常，
    //       但 L2 的可解性建立在 pinch-zoom 之上，會靜默失效
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const m = html.match(/<meta\s+name="viewport"\s+content="([^"]*)"/i);
    assert.ok(m, 'index.html 必須有 viewport meta');
    const content = m[1];
    assert.doesNotMatch(content, /user-scalable\s*=\s*no/i);
    assert.doesNotMatch(content, /maximum-scale\s*=\s*[1-4](\.|,|$|\s)/i);
    // `pinch-zoom` 這個值允許縮放但**禁止單指平移**，放大後就移不到要看的刻字，
    // 對可解性的傷害與停用縮放同級——它出現在這條斷言裡不是誤擋（覆審 TG-8）
    assert.doesNotMatch(html, /touch-action:\s*(none|pinch-zoom)/i);
  });
});

// ══ L2：中級（給藥名，四張圖擇一）═══════════════════════════════════

describe('L2 ready-gate 與 C8 特徵遮蔽', () => {
  before(needPool);

  test('D21 四格載入完成前不得作答、不得取提示', async () => {
    const expected = startLevelDeterministic(Level.L2, 4001);
    const q0 = expected[0];

    // 尚未 settle：全部格子 disabled、提示停用、note 顯示載入進度
    assert.equal(dom.cells().length, CHOICE_COUNT);
    assert.ok(dom.cells().every((c) => c.disabled), '載入中不得可點');
    assert.equal($('btnHintChoice').disabled, true, '載入中不得取提示');
    assert.match($('qGridNote').textContent, /載入中/);

    // 未 ready 時點擊不得鎖定
    dom.cells()[0].click();
    assert.ok(hidden('qVerdict'), '未 ready 卻接受了作答');

    await dom.settle();
    assert.ok(dom.cells().every((c) => !c.disabled), 'ready 後應可點');
    assert.equal($('btnHintChoice').disabled, false);
    assert.doesNotMatch($('qGridNote').textContent, /載入中/);
    assert.equal(dom.cells()[q0.answerIdx].querySelector('img').getAttribute('src'), srcOf(q0.item));
  });

  test('C8 題面與可及性樹不得出現任何外觀特徵值', async () => {
    const q = drawLeveledQuiz(POOL.items, {
      level: Level.L2, n: 20, rng: makeRng(4001), index: idx(),
      eligible: eligibleKeys(idx(), Level.L2),
    })[0];

    const surface = [
      $('qPrompt').innerHTML,
      $('qGridNote').textContent,
      ...dom.cells().map((c) => `${c.innerHTML} ${c.querySelector('img').getAttribute('alt')}`),
    ].join(' ');

    const leaks = [
      ...q.item.shape, ...q.item.color, ...q.item.score_mark,
      q.item.mark1, q.item.mark2, q.item.size,
    ].filter(Boolean).filter((v) => String(v).length >= 2 && surface.includes(String(v)));
    assert.deepEqual(leaks, [], `L2 題面洩漏外觀特徵：${leaks.join('、')}`);

    assert.ok(hidden('qFeatures'), 'L2 不得顯示外觀特徵格');
    assert.ok(hidden('qImgWrap'), 'L2 不得顯示單張大圖');
    // 正向：題幹確實有品名
    assert.ok($('qPrompt').innerHTML.includes(q.item.ans.split(' ')[0]), '題幹應顯示英文品名');
  });
});

describe('C9/C10 L2 資源失敗', () => {
  before(needPool);

  test('C9 誘答圖失敗 → 換入備援，格位不變、分母不變', async () => {
    dom.img.reset();
    $('btnAgain').click();
    const expected = drawLeveledQuiz(POOL.items, {
      level: Level.L2, n: 20, rng: makeRng(5150), index: idx(),
      eligible: eligibleKeys(idx(), Level.L2),
    });
    const q0 = expected[0];
    const slot = q0.answerIdx === 0 ? 1 : 0;          // 任一誘答格
    dom.img.fail.add(srcOf(q0.options[slot]));
    const spare = srcOf(q0.spares[0]);

    startLevelDeterministic(Level.L2, 5150);
    await dom.settle();
    await dom.settle();

    const img = dom.cells()[slot].querySelector('img');
    assert.equal(img.getAttribute('src'), spare, '該格應換成第一個備援');
    assert.equal(dom.cells().length, CHOICE_COUNT, '仍須是四格');
    assert.equal(
      dom.cells()[q0.answerIdx].querySelector('img').getAttribute('src'), srcOf(q0.item),
      '正解格不得受影響',
    );
    assert.ok(dom.cells().every((c) => !c.disabled), '替換完成後應可作答');
    assert.equal($('qIdx').textContent, 1, '不得跳題');

    dom.cells()[q0.answerIdx].click();
    assert.ok(!hidden('qVerdict'));
  });

  test('C10 正解圖失敗 → 該題作廢並遞補，不計入分母', async () => {
    dom.img.reset();
    $('btnAgain').click();
    const expected = drawLeveledQuiz(POOL.items, {
      level: Level.L2, n: 20, rng: makeRng(6270), index: idx(),
      eligible: eligibleKeys(idx(), Level.L2),
    });
    dom.img.fail.add(srcOf(expected[0].item));

    startLevelDeterministic(Level.L2, 6270);
    await dom.settle();
    await dom.settle();

    assert.equal($('qIdx').textContent, 2, '作廢後應自動前進到下一題');
    assert.ok(hidden('result'), '不得因單題作廢就結束');

    for (let i = 0; i < 25 && hidden('result'); i++) {
      await dom.settle();
      const cells = dom.cells();
      if (!cells.length || cells.every((c) => c.disabled)) break;
      cells[0].click();
      $('btnNext').click();
    }
    assert.ok(!hidden('result'), '未走到成績頁');
    assert.match($('resultSub').textContent, /作廢 1 題/, '成績頁應標示作廢題數');
    assert.match($('resultSub').textContent, /計分 20 題/, '分母應維持 20');

    // 此處**刻意不驗**「遞補正解不是原卷的誘答」：單次遞補從約 3,000 個候選中
    // 撞上原卷約 120 個誘答的機率僅約 4%，寫成斷言等於恆真——實測以舊屏障
    // （只避開正解）跑本測試仍全綠。要在 UI 層驗這條，得能注入受控的候選集合
    // 或讀取 session 快照，併入待修 #12。engine 層由 A21 以 40 次抽樣＋mutation 守住。
  });
});

describe('C11 L2 遲到事件', () => {
  before(needPool);

  test('鎖定後的圖片錯誤不得改變任何狀態', async () => {
    dom.img.reset();
    $('btnAgain').click();
    const expected = startLevelDeterministic(Level.L2, 7311);
    await dom.settle();

    const q0 = expected[0];
    dom.cells()[q0.answerIdx].click();               // 答對並鎖定
    const verdictBefore = $('qVerdict').innerHTML;
    const idxBefore = $('qIdx').textContent;

    dom.cells().forEach((c) => c.querySelector('img').onerror?.());
    await dom.settle();

    assert.equal($('qVerdict').innerHTML, verdictBefore, '鎖定後的錯誤改變了判定');
    assert.equal($('qIdx').textContent, idxBefore, '鎖定後的錯誤造成了跳題');
    assert.ok(hidden('fatal'), '鎖定後的錯誤觸發了中止');
  });

  test('換題後舊格的錯誤不得影響新題', async () => {
    const stale = dom.cells().map((c) => c.querySelector('img'));
    $('btnNext').click();
    await dom.settle();
    const idxNow = $('qIdx').textContent;
    const srcsNow = dom.cells().map((c) => c.querySelector('img').getAttribute('src'));

    stale.forEach((img) => img.onerror?.());
    await dom.settle();

    assert.equal($('qIdx').textContent, idxNow, '舊題的錯誤作廢了新題');
    assert.deepEqual(dom.cells().map((c) => c.querySelector('img').getAttribute('src')), srcsNow,
      '舊題的錯誤替換了新題的格子');
    assert.ok(hidden('fatal'));
  });
});

describe('D16 L2 提示', () => {
  before(needPool);

  test('刪去一個誘答格：不是正解、不可點選、只刪一格、扣分只一次', async () => {
    dom.img.reset();
    $('btnAgain').click();
    const expected = startLevelDeterministic(Level.L2, 8422);
    await dom.settle();
    const q0 = expected[0];

    $('btnHintChoice').click();
    const gone = dom.cells().filter((c) => c.classList.contains('gone'));
    assert.equal(gone.length, 1, '應恰好刪去一格');
    const goneIdx = Number(gone[0].dataset.k);
    assert.notEqual(goneIdx, q0.answerIdx, '不得刪去正解');
    assert.equal(gone[0].disabled, true, '已排除的格必須不可點選');
    assert.ok(!hidden('qHint'));

    $('btnHintChoice').click();
    assert.equal(dom.cells().filter((c) => c.classList.contains('gone')).length, 1,
      '重複提示產生了第二個排除格');

    gone[0].click();
    assert.ok(hidden('qVerdict'), '已排除的格竟然接受了作答');

    dom.cells()[q0.answerIdx].click();
    assert.match($('qVerdict').innerHTML, /0\.5/, '用過提示後滿分應為 0.5');
  });
});

describe('C16 L2 完整回合', () => {
  before(needPool);

  test('選 L2 → 作答 20 題 → 成績頁與成績卡', async () => {
    dom.img.reset();
    $('btnAgain').click();
    startLevelDeterministic(Level.L2, 9533);
    let answered = 0;
    for (let i = 0; i < 25 && hidden('result'); i++) {
      await dom.settle();
      const cells = dom.cells();
      assert.equal(cells.length, CHOICE_COUNT, `第 ${i + 1} 題格數應為 4`);
      cells[i % CHOICE_COUNT].click();
      answered++;
      assert.ok(!hidden('qVerdict'), `第 ${i + 1} 題未顯示判定`);
      // 鎖定後每格都應補上品名（該級的學習點）
      assert.ok(cells.every((c) => c.visibleText.trim().length > 0), '鎖定後未顯示各格品名');
      $('btnNext').click();
    }
    assert.equal(answered, 20);
    assert.ok(!hidden('result'));
    assert.equal($('resultBadge').textContent, '中級');
    assert.match($('reviewHead').innerHTML, /你選的/);

    drawn.length = 0;
    $('btnDownload').click();
    await new Promise((r) => setTimeout(r, 200));
    assert.match(drawn.join(' '), /中級/, '成績卡未印出級別');
  });
});
