/**
 * 快速閃卡（不計分）— 純函式 + UI 接線 + 行動裝置版面
 *
 *   node --test
 *
 * 閃卡沒有分數可以驗證，因此「看起來會動」與「是對的」之間沒有天然的護欄：
 * 少列一個相似品項、翻面前就把答案放進 DOM、圖片失敗後靜默跳卡，
 * 三者在畫面上都毫無異狀。這裡的斷言就是針對這三條。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installDom, ROOT } from './_ui-harness.mjs';
import {
  DECK_SIZE, makeRng, buildIndex, buildLookAlikeIndex, lookAlikesOf,
  newCard, flipCard, drawDeck, drawSpareCard, l2Key,
} from '../engine.js';

// ══ 純函式 ═══════════════════════════════════════════════════════════

/** 最小合成題庫：前兩筆刻意同外觀不同品名 */
const mk = (ans, mark1, extra = {}) => ({
  id: `證字第${ans}號`, ans, full: `${ans} TABLETS`, zh: `${ans}錠`,
  img: `img/${ans}.webp`, shape: ['圓形'], color: ['白'],
  score_mark: ['無'], size: '8', mark1, mark2: null, ...extra,
});
const FIX = [
  mk('ALPHA', 'AB 1'),
  mk('BRAVO', 'AB1'),              // squash 後與 ALPHA 同鍵 → 外觀重複組
  mk('CHARLIE', 'CC 2'),
  mk('DELTA', 'DD 3'),
];

describe('閃卡純函式', () => {
  test('buildLookAlikeIndex 依 l2Key 分組，同鍵收集所有相異答案鍵', () => {
    const idx = buildLookAlikeIndex(FIX);
    assert.equal(idx.get(l2Key(FIX[0])).length, 2);
    assert.deepEqual(idx.get(l2Key(FIX[0])), ['ALPHA', 'BRAVO']);
    assert.deepEqual(idx.get(l2Key(FIX[2])), ['CHARLIE']);
  });

  test('lookAlikesOf 排除自己；外觀唯一者回傳空陣列', () => {
    const idx = buildLookAlikeIndex(FIX);
    assert.deepEqual(lookAlikesOf(FIX[0], idx), ['BRAVO']);
    assert.deepEqual(lookAlikesOf(FIX[1], idx), ['ALPHA']);
    assert.deepEqual(lookAlikesOf(FIX[2], idx), []);
  });

  test('分組鍵是 l2Key 而不是 score_mark／size', () => {
    // 〔堵〕改用含 score_mark／size 的鍵，只差刻痕的兩顆藥會被判為「外觀唯一」，
    //       背面就不會提醒——而那正是照片上分不出來的情形（D12）
    const pair = [mk('ECHO', 'EE 4'), mk('FOXTROT', 'EE4', { score_mark: ['一線'], size: '11' })];
    const idx = buildLookAlikeIndex(pair);
    assert.deepEqual(lookAlikesOf(pair[0], idx), ['FOXTROT']);
  });

  test('newCard 不帶 state／mark／correct／chance', () => {
    // 〔堵〕借用 newQuestion 的形狀，閃卡就會被 scoreQuiz 算進分母
    const c = newCard(FIX[0], 1);
    for (const k of ['state', 'mark', 'correct', 'chance', 'options', 'answerIdx']) {
      assert.equal(k in c, false, `閃卡不該有 ${k} 欄位`);
    }
    assert.equal(c.flipped, false);
    assert.equal(c.token, 1);
  });

  test('flipCard 翻面；已翻面回傳同一物件', () => {
    const c = newCard(FIX[0], 1);
    const f = flipCard(c);
    assert.equal(f.flipped, true);
    assert.equal(c.flipped, false, '原物件不可被就地改寫');
    assert.equal(flipCard(f), f, '重複翻面不得產生新物件');
  });

  test('drawDeck 抽滿 DECK_SIZE 張、答案鍵不重複、token 自 1 起連號', () => {
    const items = Array.from({ length: 40 }, (_, i) => mk(`D${i}`, `M${i}`));
    const deck = drawDeck(items, { n: DECK_SIZE, rng: makeRng(7) });
    assert.equal(deck.length, DECK_SIZE);
    assert.equal(new Set(deck.map((c) => c.item.ans)).size, DECK_SIZE);
    assert.deepEqual(deck.map((c) => c.token), Array.from({ length: DECK_SIZE }, (_, i) => i + 1));
    assert.ok(deck.every((c) => c.flipped === false));
  });

  test('drawDeck 相異品名不足時丟 INSUFFICIENT_KEYS', () => {
    assert.throws(
      () => drawDeck(FIX, { n: DECK_SIZE, rng: makeRng(1) }),
      (e) => e.code === 'INSUFFICIENT_KEYS' && e.available === 4,
    );
  });

  test('drawSpareCard 避開本疊歷史上出現過的所有答案鍵，不只 deck 現況', () => {
    // 〔堵〕從 deck 現況推導排除集合。遞補是覆蓋寫入，被換掉那張的答案鍵
    //       會從 deck 消失，下一次失敗就把它抽回來——同一疊裡同一顆藥出現兩次。
    //       本測試必須真的把 spare 寫回 deck 再抽下一張，否則測不到這條
    //       （只重複呼叫、傳同一個沒改過的 deck，是假綠燈）
    const items = Array.from({ length: 25 }, (_, i) => mk(`D${i}`, `M${i}`));
    const index = buildIndex(items);
    const deck = drawDeck(items, { n: DECK_SIZE, rng: makeRng(3) });
    const history = new Set(deck.map((c) => c.item.ans));

    // 25 個鍵、20 張在架上 → 至多 5 次遞補後耗盡
    let drawn = 0;
    for (let i = 0; i < 10; i++) {
      const spare = drawSpareCard({ index, exclude: history, token: 99 + i, rng: makeRng(i) });
      if (!spare) break;
      assert.equal(history.has(spare.item.ans), false,
        `第 ${i + 1} 次遞補抽回了本疊已出現過的 ${spare.item.ans}`);
      assert.equal(spare.flipped, false);
      assert.equal(spare.token, 99 + i);
      history.add(spare.item.ans);
      deck[0] = spare;                       // app.js replaceCard 的覆蓋寫入
      drawn++;
    }
    assert.equal(drawn, 5, '25 個鍵扣掉整疊 20 張，應恰好遞補 5 次後耗盡');
    assert.equal(history.size, 25);
  });

  test('drawSpareCard 候選耗盡回傳 null', () => {
    const items = Array.from({ length: DECK_SIZE }, (_, i) => mk(`D${i}`, `M${i}`));
    const index = buildIndex(items);
    const deck = drawDeck(items, { n: DECK_SIZE, rng: makeRng(5) });
    const history = new Set(deck.map((c) => c.item.ans));
    assert.equal(drawSpareCard({ index, exclude: history, token: 99, rng: makeRng(1) }), null);
  });

  test('drawDeck 的 startToken 讓跨疊 token 不重號', () => {
    // 〔堵〕每疊都從 1 起算，上一疊的遲到事件會與新疊的卡撞號，
    //       而 token 正是分辨「事件屬於哪張卡」的唯一依據
    const items = Array.from({ length: 40 }, (_, i) => mk(`D${i}`, `M${i}`));
    const d1 = drawDeck(items, { n: DECK_SIZE, rng: makeRng(11), startToken: 1 });
    const d2 = drawDeck(items, { n: DECK_SIZE, rng: makeRng(12), startToken: 1 + DECK_SIZE });
    const all = new Set([...d1, ...d2].map((c) => c.token));
    assert.equal(all.size, DECK_SIZE * 2, '兩疊的 token 不得重疊');
    assert.equal(d2[0].token, DECK_SIZE + 1);
  });
});

// ══ UI 接線 ══════════════════════════════════════════════════════════

const hasPool = fs.existsSync(path.join(ROOT, 'data/pool.json'));
const dom = installDom();
const { $, hidden } = dom;

if (hasPool) {
  await import(`file://${path.join(ROOT, 'app.js').replace(/\\/g, '/')}`);
  await new Promise((r) => setTimeout(r, 300));
}

const needPool = () => assert.ok(hasPool, 'data/pool.json 不存在，請先執行 npm run build:pool');
const POOL = hasPool
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data/pool.json'), 'utf8'))
  : { items: [] };
let LA = null;
const la = () => (LA ||= buildLookAlikeIndex(POOL.items));
const srcOf = (item) => `data/${item.img}`;

/** 走一條已知的 RNG 序列，測試因而事先知道每一張卡是誰 */
function startDeckDeterministic(seed) {
  const expected = drawDeck(POOL.items, { n: DECK_SIZE, rng: makeRng(seed) });
  Math.random = makeRng(seed);
  $('btnFlash').click();
  return expected;
}

describe('F1 進入與離開閃卡', () => {
  before(needPool);

  test('不需選難度即可開始，且不觸發難度警告', async () => {
    dom.img.reset();
    startDeckDeterministic(101);
    await dom.settle();
    assert.equal(hidden('flash'), false);
    assert.equal(hidden('start'), true);
    assert.equal(hidden('levelWarn'), true, '閃卡不該要求選難度');
    assert.equal($('fTotal').textContent, DECK_SIZE);
    assert.equal($('fIdx').textContent, 1);
  });

  test('結束後回開始頁，難度重設為未選', async () => {
    startDeckDeterministic(102);
    await dom.settle();
    $('btnFlashQuit').click();
    assert.equal(hidden('flashDone'), false);
    assert.equal(hidden('flash'), true);

    $('btnToQuiz').click();
    assert.equal(hidden('start'), false);
    assert.equal(hidden('flashDone'), true);
    assert.equal($('btnStart').disabled, true, '回開始頁必須重新選難度（§6.1）');
  });
});

describe('F3 ready-gate：圖片確認載入前不得翻面', () => {
  before(needPool);

  test('圖片仍 pending 時翻面停用，硬點也不得顯示藥名', async () => {
    // 〔堵〕沒有 ready-gate，使用者會在空白或上一張的 bitmap 上翻出新卡的藥名，
    //       這正是「圖片與藥名錯位」——本工具最怕的失效模式
    dom.img.reset();
    const deck = drawDeck(POOL.items, { n: DECK_SIZE, rng: makeRng(901) });
    dom.img.pending.add(srcOf(deck[0].item));      // 永不 settle
    Math.random = makeRng(901);
    $('btnFlash').click();
    await dom.settle();

    assert.equal($('btnFlip').disabled, true, '圖片未 ready 時翻面必須停用');
    $('btnFlip').click();                          // disabled 只是外觀，state 才是守門
    assert.equal(hidden('fBack'), true, 'ready 前不得翻面');
    assert.equal($('fBack').innerHTML, '', 'ready 前 DOM 不得出現藥名');
    assert.ok(!$('fBack').innerHTML.includes(deck[0].item.ans));

    dom.img.reset();
  });

  test('圖片載入成功後才啟用翻面', async () => {
    dom.img.reset();
    startDeckDeterministic(902);
    await dom.settle();
    assert.equal($('btnFlip').disabled, false, '載入成功後應可翻面');
    $('btnFlip').click();
    assert.equal(hidden('fBack'), false);
  });

  test('載入成功後的遲到 onerror 不得替換已翻面的卡', async () => {
    // 圖片已 settle，後續事件一律忽略——否則使用者看著的卡會被抽換掉
    dom.img.reset();
    const deck = startDeckDeterministic(903);
    await dom.settle();
    $('btnFlip').click();
    const backBefore = $('fBack').innerHTML;

    $('fImg').onerror?.();                         // C11 手法：強制 late-dispatch
    await dom.settle();

    assert.equal($('fBack').innerHTML, backBefore, '遲到事件改變了已翻面的卡');
    assert.equal($('fIdx').textContent, 1, '遲到事件造成了跳卡');
    assert.equal(hidden('fWarnBox'), true);
    assert.ok(backBefore.includes(deck[0].item.ans));
  });
});

describe('F3 翻面與相似品項', () => {
  before(needPool);

  test('翻面前背面是空的，不是先渲染再隱藏', async () => {
    // 〔堵〕預先渲染再用 hidden 蓋住，畫面一模一樣，
    //       但答案已經在 DOM 裡，讀屏與檢視原始碼都拿得到
    const deck = startDeckDeterministic(201);
    await dom.settle();
    assert.equal(hidden('fBack'), true);
    assert.equal($('fBack').innerHTML, '');
    assert.doesNotMatch($('fBack').innerHTML, new RegExp(deck[0].item.ans));
    assert.equal(hidden('btnFlip'), false);
    assert.equal(hidden('btnFlashNext'), true);
  });

  test('翻面後顯示品名、完整品名與許可證字號，並切換按鈕', async () => {
    const deck = startDeckDeterministic(202);
    await dom.settle();
    $('btnFlip').click();

    const back = $('fBack').innerHTML;
    assert.equal(hidden('fBack'), false);
    assert.match(back, new RegExp(deck[0].item.ans.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(back.includes(deck[0].item.id), '應顯示許可證字號');
    assert.equal(hidden('btnFlip'), true);
    assert.equal(hidden('btnFlashNext'), false);
  });

  test('外觀有相似品項時，背面必須逐一列出', async () => {
    // 〔堵〕漏列相似品項是本模式最主要的失效模式：
    //       使用者會建立「這個外觀＝這顆藥」的錯誤唯一對應
    const withAlts = POOL.items.find((it) => lookAlikesOf(it, la()).length >= 2);
    assert.ok(withAlts, '題庫中應存在外觀重複組（實測 124 組）');

    // 直接抽到該筆的機率太低，改以整疊搜尋：找出第一張有相似品項的卡
    let deck = null;
    let hit = -1;
    for (let seed = 300; seed < 340 && hit < 0; seed++) {
      deck = startDeckDeterministic(seed);
      hit = deck.findIndex((c) => lookAlikesOf(c.item, la()).length > 0);
    }
    assert.ok(hit >= 0, '40 疊中應至少出現一張有相似品項的卡（母體 7.9%）');
    await dom.settle();

    for (let i = 0; i < hit; i++) { $('btnFlip').click(); $('btnFlashNext').click(); await dom.settle(); }
    $('btnFlip').click();

    const back = $('fBack').innerHTML;
    const alts = lookAlikesOf(deck[hit].item, la());
    assert.match(back, /look-alike/, '有相似品項時必須出現警示區塊');
    for (const a of alts) {
      assert.ok(back.includes(a), `背面漏列相似品項 ${a}`);
    }
  });

  test('外觀唯一時不出現相似品項區塊', async () => {
    let deck = null;
    let hit = -1;
    for (let seed = 400; seed < 420 && hit < 0; seed++) {
      deck = startDeckDeterministic(seed);
      hit = deck.findIndex((c) => lookAlikesOf(c.item, la()).length === 0);
    }
    assert.ok(hit >= 0);
    await dom.settle();
    for (let i = 0; i < hit; i++) { $('btnFlip').click(); $('btnFlashNext').click(); await dom.settle(); }
    $('btnFlip').click();
    assert.doesNotMatch($('fBack').innerHTML, /look-alike/);
  });
});

describe('F2 走完一整疊', () => {
  before(needPool);

  test('20 張翻完進入完成頁，張數、進度條與統計正確', async () => {
    const deck = startDeckDeterministic(501);
    await dom.settle();
    for (let i = 0; i < DECK_SIZE; i++) {
      assert.equal(hidden('flash'), false, `第 ${i + 1} 張時不該已結束`);
      assert.equal($('fIdx').textContent, i + 1);
      // 進度條代表「已完成張數」：第 1 張時是 0%，不是 5%
      assert.equal($('fBar').style.width, `${(i / DECK_SIZE) * 100}%`,
        `第 ${i + 1} 張的進度條不對`);
      $('btnFlip').click();
      $('btnFlashNext').click();
      await dom.settle();
    }
    assert.equal(hidden('flashDone'), false);
    assert.equal(hidden('flash'), true);
    assert.match($('flashDoneSub').textContent, /看過 20 \/ 20 張/);
    assert.match($('flashDoneSub').textContent, /翻開 20 張/);
    assert.match($('flashDoneSub').textContent, /不計分/);

    const withAlts = deck.filter((c) => lookAlikesOf(c.item, la()).length).length;
    if (withAlts) assert.match($('flashDoneSub').textContent, new RegExp(`${withAlts} 張的外觀另有相似品項`));
  });

  test('未翻面直接跳過的卡不計入「翻開」數', async () => {
    startDeckDeterministic(502);
    await dom.settle();
    $('btnFlip').click();          // 只翻第 1 張
    $('btnFlashNext').click();
    await dom.settle();
    $('btnFlashQuit').click();
    assert.match($('flashDoneSub').textContent, /翻開 1 張/);
  });

  test('中途結束時摘要只算實際看過的張數，不是整疊 20', async () => {
    // 〔堵〕固定讀 deck.length。遞補是覆蓋寫入、張數恆為 20，
    //       中途離開就會把還沒顯示出來的卡也算成「看過」（CR-5）
    startDeckDeterministic(503);
    await dom.settle();
    for (let i = 0; i < 4; i++) { $('btnFlip').click(); $('btnFlashNext').click(); await dom.settle(); }
    $('btnFlashQuit').click();                    // 停在第 5 張
    assert.match($('flashDoneSub').textContent, /看過 5 \/ 20 張/);
    assert.doesNotMatch($('flashDoneSub').textContent, /看過 20/);
  });
});

describe('F4 圖片載入失敗', () => {
  before(needPool);

  test('單張失敗即換一張，且不與整疊重複', async () => {
    dom.img.reset();
    let deck = null;
    for (let seed = 600; seed < 620; seed++) {
      deck = drawDeck(POOL.items, { n: DECK_SIZE, rng: makeRng(seed) });
      dom.img.fail.add(srcOf(deck[0].item));
      Math.random = makeRng(seed);
      $('btnFlash').click();
      await dom.settle();
      break;
    }
    assert.equal(hidden('flash'), false, '換卡後應仍在閃卡畫面');
    assert.equal(hidden('fWarnBox'), true, '單張失敗不該立刻跳警示');
    assert.equal($('fIdx').textContent, 1, '換卡不推進張數');

    $('btnFlip').click();
    const back = $('fBack').innerHTML;
    assert.ok(!back.includes(deck[0].item.ans), '不得顯示載入失敗那張的品名');
    for (let i = 1; i < DECK_SIZE; i++) {
      assert.ok(!back.includes(deck[i].item.ans), `遞補卡與整疊第 ${i + 1} 張重複`);
    }
    dom.img.reset();
  });

  test('本疊累計 3 張失敗 → 停下來問使用者，不靜默換完整疊', async () => {
    // 〔堵〕沒有這道閘，離線時整疊會被安靜換完，使用者只看到卡片一直跳
    dom.img.reset();
    // 讓所有圖都失敗：遞補幾次都會再失敗，必然撞到上限
    for (const it of POOL.items) dom.img.fail.add(srcOf(it));
    Math.random = makeRng(701);
    $('btnFlash').click();
    await dom.settle();

    assert.equal(hidden('fWarnBox'), false, '達上限應顯示警示');
    assert.match($('fWarnMsg').textContent, /載入失敗/);
    assert.equal(hidden('btnFlip'), true, '警示中不得繼續翻牌');
    assert.equal($('fImg').getAttribute('src'), undefined, '警示中不應繼續打圖床');
    // 停在原地等使用者決定：不得靜默換完整疊，也不得逕自進完成頁
    assert.equal(hidden('flashDone'), true, '警示時不該已結束');
    assert.equal(hidden('flash'), false);

    // 張數有沒有被偷推進，要等 resume 重繪才看得到——警示路徑不走 renderCard，
    // 直接斷言 fIdx 的 DOM 值恆為 1，測不到任何東西
    dom.img.reset();                               // 網路恢復
    $('btnFlashResume').click();
    await dom.settle();
    assert.equal($('fIdx').textContent, 1, '警示期間推進了張數，使用者會跳過沒看到的卡');
    assert.equal(hidden('flash'), false);

    dom.img.reset();
  });

  test('按「繼續」把計數歸零（留在同一疊驗證，不靠新開一疊）', async () => {
    // 〔堵〕resumeFlash 不歸零。若在 resume 後另開一疊來驗，startFlash 本身
    //       就會歸零，斷言於是恆為真——那是假綠燈。這裡留在同一疊，
    //       用警示訊息裡的張數辨別：沒歸零的話第 1 次失敗就跳，且會顯示「已有 4 張」
    dom.img.reset();
    for (const it of POOL.items) dom.img.fail.add(srcOf(it));
    Math.random = makeRng(702);
    $('btnFlash').click();
    await dom.settle();
    assert.equal(hidden('fWarnBox'), false);
    assert.match($('fWarnMsg').textContent, /已有 3 張/);

    $('btnFlashResume').click();           // 網路仍壞，直接再撞一輪
    await dom.settle();
    assert.equal(hidden('fWarnBox'), false, 'resume 後圖仍全壞，應再次跳警示');
    assert.match($('fWarnMsg').textContent, /已有 3 張/,
      'resume 未把計數歸零（訊息顯示的是累加值）');

    dom.img.reset();                       // 網路恢復
    $('btnFlashResume').click();
    await dom.settle();
    assert.equal(hidden('fWarnBox'), true);
    assert.equal(hidden('flash'), false);
    assert.equal(hidden('btnFlip'), false, '恢復後應可繼續翻牌');
    assert.equal($('btnFlip').disabled, false, '恢復後圖片載入成功，應可翻面');
  });

  test('按「結束這疊」進完成頁', async () => {
    dom.img.reset();
    for (const it of POOL.items) dom.img.fail.add(srcOf(it));
    Math.random = makeRng(703);
    $('btnFlash').click();
    await dom.settle();
    assert.equal(hidden('fWarnBox'), false);
    $('btnFlashStop').click();
    assert.equal(hidden('flashDone'), false);
    assert.match($('flashDoneSub').textContent, /已結束這疊/);
    dom.img.reset();
  });

  test('警示畫面上不得殘留任何藥名', async () => {
    // 目前由兩道保證：renderCard 每次清背面、replaceCard 進警示前再清一次。
    // 後者是防禦性的——ready-gate 讓「翻面後同一張才失敗」走不到，
    // 但 gate 若被改動，這條不變量仍須成立
    dom.img.reset();
    startDeckDeterministic(704);
    await dom.settle();
    $('btnFlip').click();                          // 先翻開第 1 張
    const shown = $('fBack').innerHTML;
    assert.notEqual(shown, '');

    for (const it of POOL.items) dom.img.fail.add(srcOf(it));
    $('btnFlashNext').click();                     // 之後每張都載不到
    await dom.settle();

    assert.equal(hidden('fWarnBox'), false);
    assert.equal($('fBack').innerHTML, '', '警示時背面必須是空的');
    assert.equal(hidden('fBack'), true);
    dom.img.reset();
  });
});

describe('F6 閃卡與測驗互不汙染', () => {
  before(needPool);

  test('閃完一疊再測驗，分母仍是 20 題', async () => {
    // 〔堵〕共用 state.questions／state.idx 會讓閃卡的殘留索引流進成績頁
    dom.img.reset();
    startDeckDeterministic(801);
    await dom.settle();
    for (let i = 0; i < 5; i++) { $('btnFlip').click(); $('btnFlashNext').click(); await dom.settle(); }
    $('btnFlashQuit').click();
    $('btnToQuiz').click();

    $('levelPick').querySelectorAll('.level').find((l) => l.dataset.level === 'L1').click();
    $('btnStart').click();
    for (let i = 0; i < 25 && hidden('result'); i++) {
      $('qOptions').querySelectorAll('.opt')[i % 4].click();
      $('btnNext').click();
      await dom.settle();
    }
    assert.equal(hidden('result'), false);
    assert.match($('resultSub').textContent, /計分 20 題/);
  });
});

// ══ 行動裝置版面 ═════════════════════════════════════════════════════

describe('F5 閃卡在手機上可用', () => {
  const html = () => fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  test('閃卡圖片沿用 .q-img 的 responsive 樣式，不另設固定寬度', () => {
    const h = html();
    assert.match(h, /id="fImg"[^>]*class="q-img"|class="q-img"[^>]*id="fImg"/);
    // .q-img 是 width:100% + max-width 上限，隨螢幕縮放；閃卡不得另設固定 px 寬
    assert.match(h, /\.q-img\s*\{[^}]*width:\s*100%/);
    assert.match(h, /\.q-img\s*\{[^}]*max-width:\s*\d+px/);
    const flashCss = h.slice(h.indexOf('/* 快速閃卡 */'), h.indexOf('</style>'));
    assert.doesNotMatch(flashCss, /#fImg[^}]*width:\s*\d+px/);
  });

  test('閃卡新增的樣式未覆寫按鈕 44px 觸控下限', () => {
    // 〔堵〕在 .btn-row 或 .flash-back 內縮小按鈕，桌機看不出差別，
    //       手機上就變成點不準的目標
    const h = html();
    const flashCss = h.slice(h.indexOf('/* 快速閃卡 */'), h.indexOf('</style>'));
    assert.doesNotMatch(flashCss, /button[^{]*\{[^}]*min-height:\s*(?!44)/);
    assert.match(h, /min-height:\s*44px/);
  });

  test('相似品項清單長品名可斷行，不撐破版面', () => {
    const h = html();
    assert.match(h, /\.look-alike li \{[^}]*word-break/);
    assert.match(h, /\.flash-back \.ans \{[^}]*word-break/);
  });

  test('閃卡未停用縮放，也未停用放大後的平移（D22）', () => {
    // `touch-action: pinch-zoom` 本身允許縮放，但**禁止單指平移**——
    // 放大後就無法移動去看刻字，對可解性的傷害與停用縮放同級，因此一併擋。
    // 名稱只寫「縮放」會讓後人以為這個值是被誤擋的（覆審 TG-8）
    const h = html();
    assert.doesNotMatch(h, /touch-action:\s*(none|pinch-zoom)/i);
    assert.doesNotMatch(h.match(/<meta\s+name="viewport"\s+content="([^"]*)"/i)[1], /user-scalable\s*=\s*no/i);
  });
});
