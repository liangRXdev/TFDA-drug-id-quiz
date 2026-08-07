/**
 * 娛樂性強化 批次 A — 純函式與靜態原始碼契約
 * 對應 .ai-review/plan-v4-engagement.md §6 的 A23–A29、C23b、C25、C26（樣式）、C27（靜態）
 *
 *   node --test
 *
 * **證據強度分兩層，刻意分開寫：**
 *
 * 1. A 組是行為測試（純函式，最強）。
 * 2. C23b／C25／C27 是**靜態原始碼契約**——證據強度低於行為測試。
 *    理由是 F13：`_ui-harness.mjs` 的 `style` 是純物件，沒有 `getComputedStyle`、
 *    `getBoundingClientRect`、`matchMedia`，而且檔頭明寫刻意不引入 jsdom。
 *    在那個樁上寫 CSS cascade／media query／幾何斷言，**必然是永遠綠的假斷言**，
 *    比沒有測試更糟——後人會以為那條守住了。既有的正確先例是 C17
 *    （對 index.html 原始碼做文字契約）。字級對比、reduced-motion 的兩態實際行為、
 *    動畫期間的 flow 位移，一律另做人工瀏覽器留檔，不在這裡假裝。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './_ui-harness.mjs';
import {
  QState, FULL_MARK, HINTED_MARK, Level, QUIZ_SIZE,
  longestStreak, currentStreak, rankTitle, RANK_TITLES, RANK_BANDS, scoreQuiz,
} from '../engine.js';

// ══ 題目序列建構 ══════════════════════════════════════════════════════
// O=答對 H=用提示答對 X=答錯 x=用提示答錯 V=作廢 P=未作答 N=已提示未作答
const MAKE = {
  O: () => ({ state: QState.LOCKED, correct: true, mark: FULL_MARK }),
  H: () => ({ state: QState.LOCKED, correct: true, mark: HINTED_MARK }),
  X: () => ({ state: QState.LOCKED, correct: false, mark: FULL_MARK }),
  x: () => ({ state: QState.LOCKED, correct: false, mark: HINTED_MARK }),
  V: () => ({ state: QState.VOID, correct: false, mark: 0 }),
  P: () => ({ state: QState.PENDING, correct: false, mark: FULL_MARK }),
  N: () => ({ state: QState.HINTED, correct: false, mark: HINTED_MARK }),
};
const seq = (s) => [...s].map((c) => {
  if (!MAKE[c]) throw new Error(`未知的序列符號 ${c}`);
  return MAKE[c]();
});
const len = (s) => longestStreak(seq(s)).length;

describe('A23 longestStreak 是最長段，不是答對總數', () => {
  // 〔堵〕**回傳全卷答對總數**可以通過「全對→20」「全錯→0」「作廢跳過」等所有邊界。
  //       (c)(d) 是唯一能區分「最長段」與「總數」的案例，缺了它們這條就白寫
  test('(a) 全對 20 題 → 20', () => assert.equal(len('O'.repeat(20)), 20));
  test('(b) 全錯 → 0', () => assert.equal(len('X'.repeat(20)), 0));
  test('(c) 對、錯、對 → 1（答對總數為 2）', () => assert.equal(len('OXO'), 1));
  test('(d) 對×3、錯、對×2 → 3（答對總數為 5）', () => assert.equal(len('OOOXOO'), 3));
  test('(e) 作廢夾在連對中間 → 4（不切段）', () => assert.equal(len('OOVOO'), 4));
  test('(f) 作廢在開頭／結尾', () => {
    assert.equal(len('VOOO'), 3);
    assert.equal(len('OOOV'), 3);
  });
  test('(g) 連續多個作廢夾中間 → 4', () => assert.equal(len('OOVVVOO'), 4));
  test('(h) 全部作廢（counted=0）→ 0 且不拋例外', () => {
    assert.equal(len('VVVV'), 0);
    assert.deepEqual(longestStreak([]), { length: 0, hinted: 0 });
    assert.deepEqual(longestStreak(undefined), { length: 0, hinted: 0 });
  });
  test('作廢不切段這件事，與答錯切段是兩回事', () => {
    // 正面對照：同樣位置換成答錯就必須切段
    assert.equal(len('OOXOO'), 2);
  });
});

describe('A24 回傳契約與 hinted 的歸屬', () => {
  test('回傳形狀恰為 {length, hinted}，兩者皆為整數', () => {
    const r = longestStreak(seq('OHO'));
    assert.deepEqual(Object.keys(r).sort(), ['hinted', 'length']);
    assert.ok(Number.isInteger(r.length) && Number.isInteger(r.hinted));
  });

  test('同長度取最早出現的那一段，hinted 隨之', () => {
    // 〔堵〕另算一個「與最長段無關的全卷提示總數」——這個 fixture 下它會回 2
    const r = longestStreak(seq('OOO' + 'X' + 'HHO'));
    assert.deepEqual(r, { length: 3, hinted: 0 });
  });

  test('hinted 只算被選中那一段之內的提示', () => {
    // 全卷 5 題提示，最長段（末段 O,H,O）內只有 1 題
    const r = longestStreak(seq('HXHXHXHXOHO'));
    assert.deepEqual(r, { length: 3, hinted: 1 });
  });

  test('用提示答對仍 +1（未提示對、提示對、未提示對 → 3）', () => {
    assert.deepEqual(longestStreak(seq('OHO')), { length: 3, hinted: 1 });
  });

  test('用提示答錯歸零', () => {
    assert.equal(len('OOxO'), 2);
    assert.equal(len('OOxOOO'), 3);
  });
});

describe('A25 最長段可以在中間', () => {
  // 〔堵〕`max(開頭段, 結尾段)` 可以通過 (a)(b)；(c)(d) 才抓得到
  test('(a) 對×5、錯、對×2 → 5', () => assert.equal(len('OOOOOXOO'), 5));
  test('(b) 對×2、錯、對×5 → 5', () => assert.equal(len('OOXOOOOO'), 5));
  test('(c) 錯、對×4、錯、對×2 → 4', () => assert.equal(len('XOOOOXOO'), 4));
  test('(d) 對×2、錯、對×4、錯、對 → 4', () => assert.equal(len('OOXOOOOXO'), 4));
});

describe('A26 currentStreak 的正向值與 exclusive 語意', () => {
  // 〔堵〕**永遠回傳 0** 可以通過任何只驗「不拋例外」的邊界測試，
  //       而 live header 於是靜默恆為 0，畫面上看起來就只是「沒有連對」
  test('upTo 是 exclusive：不含 upTo 指到的那一題', () => {
    const q = seq('OOXOO');
    assert.equal(currentStreak(q, 2), 2, 'upTo=2 應只看前兩題');
    assert.equal(currentStreak(q, 3), 0, 'upTo=3 含了第 3 題（答錯）→ 歸零');
    assert.equal(currentStreak(q, 5), 2, '末端兩題連對');
  });

  test('upTo=0 → 0；逐一遞增的確切值', () => {
    const q = seq('OOO');
    assert.equal(currentStreak(q, 0), 0);
    assert.equal(currentStreak(q, 1), 1);
    assert.equal(currentStreak(q, 2), 2);
    assert.equal(currentStreak(q, 3), 3);
  });

  test('停在 VOID 前後的值相同', () => {
    const q = seq('OOV');
    assert.equal(currentStreak(q, 2), 2);
    assert.equal(currentStreak(q, 3), 2, '作廢不得改變 live 顯示值');
  });

  test('未進入終態的題不計入也不歸零', () => {
    assert.equal(currentStreak(seq('OOP'), 3), 2);
    assert.equal(currentStreak(seq('OON'), 3), 2);
  });

  test('upTo 超過長度／省略／負值都不拋例外', () => {
    const q = seq('OO');
    assert.equal(currentStreak(q, 99), 2);
    assert.equal(currentStreak(q), 2);
    assert.equal(currentStreak(q, -5), 0);
    assert.equal(currentStreak([], 3), 0);
    assert.equal(currentStreak(undefined, 3), 0);
  });

  test('提示題計入 live 值', () => {
    assert.equal(currentStreak(seq('OHH'), 3), 3);
  });
});

describe('A27 與 scoreQuiz 的一致性（具名反例，不用隨機 property）', () => {
  // 〔堵〕回傳答對總數恆滿足 `length <= correct`，全對時甚至等於 counted——
  //       隨機 property 只會給出「強證據」的假象
  const FIX = seq('OHXVOOO');

  test('同一 fixture 下 scoreQuiz 的每個欄位', () => {
    const r = scoreQuiz(FIX);
    assert.equal(r.counted, 6);
    assert.equal(r.voided, 1);
    assert.equal(r.correct, 5);
    assert.equal(r.hints, 1);
    assert.equal(r.earned, 4.5);
    assert.equal(r.score, 75);
  });

  test('同一 fixture 下 longestStreak 的確切值', () => {
    // 段落：[O,H] 長 2 → X 切段 → V 跳過 → [O,O,O] 長 3
    assert.deepEqual(longestStreak(FIX), { length: 3, hinted: 0 });
  });

  test('補充：length 不得超過 correct（弱條件，非主要證據）', () => {
    for (const s of ['OHXVOOO', 'OOOOO', 'XXXX', 'OVOVO', 'HHHXHH']) {
      const q = seq(s);
      assert.ok(longestStreak(q).length <= scoreQuiz(q).correct, s);
    }
  });

  test('F9：凡走到結算的回合分母恆為 20，故 length 上界為 20', () => {
    assert.equal(len('O'.repeat(QUIZ_SIZE)), QUIZ_SIZE);
  });
});

// ══ A28／A29 稱號 ═════════════════════════════════════════════════════

/** D24 的表就是唯一真相：這裡把 12 格逐一寫死，不從實作反推 */
const TITLES = {
  L1: ['入門攻克', '記得住外觀', '還在對圖', '先從閃卡開始'],
  L2: ['辨識高手', '看得出門道', '還在比對', '先從閃卡開始'],
  L3: ['火眼金睛', '一眼認藥', '還在背藥名', '先從閃卡開始'],
};
const LEVELS3 = [Level.L1, Level.L2, Level.L3];
/** 各分數帶的代表分數，順序與 TITLES 的欄位一致 */
const BAND_SCORES = [95, 80, 50, 0];

describe('A28 rankTitle 逐格確切字串', () => {
  // 〔堵〕**全部 12 格回傳同一個非空稱號**可以通過任何「非空」斷言；
  //       `>` 與 `>=` 寫反在中間值也看不出來
  test('12 格的確切字串', () => {
    for (const lv of LEVELS3) {
      BAND_SCORES.forEach((s, i) => {
        assert.equal(rankTitle(lv, s), TITLES[lv][i], `${lv} @ ${s}`);
      });
    }
  });

  test('實作匯出的表與規格表一致（RANK_TITLES 即唯一真相）', () => {
    for (const lv of LEVELS3) assert.deepEqual(RANK_TITLES[lv], TITLES[lv], lv);
    assert.deepEqual(RANK_BANDS, [95, 80, 50]);
  });

  test('≥50 的 9 格兩兩相異', () => {
    const upper = LEVELS3.flatMap((lv) => TITLES[lv].slice(0, 3));
    assert.equal(new Set(upper).size, 9, '≥50 的稱號出現重複');
  });

  test('<50 一列三級刻意相同（正面斷言，避免日後被當成漏寫各自改掉）', () => {
    // 這一列不是稱號而是「下一步建議」：最低帶沒有跨級刷分的誘因，
    // 三級本來就該給同一個建議。D24「各級不相交」只約束 ≥50 的 9 格
    const low = LEVELS3.map((lv) => rankTitle(lv, 0));
    assert.deepEqual(low, ['先從閃卡開始', '先從閃卡開始', '先從閃卡開始']);
  });

  test('≥50 的稱號不得跨級出現', () => {
    for (const lv of LEVELS3) {
      const others = LEVELS3.filter((o) => o !== lv).flatMap((o) => TITLES[o].slice(0, 3));
      for (const t of TITLES[lv].slice(0, 3)) {
        assert.ok(!others.includes(t), `${t} 同時出現在多個級別`);
      }
    }
  });

  test('相鄰分數帶的切換點輸出確實改變', () => {
    for (const lv of LEVELS3) {
      for (const b of RANK_BANDS) {
        assert.notEqual(rankTitle(lv, b - 0.1), rankTitle(lv, b), `${lv} @ ${b} 邊界未切換`);
      }
    }
  });

  test('邊界與非法輸入的行為寫死', () => {
    for (const lv of LEVELS3) {
      assert.equal(rankTitle(lv, 100), TITLES[lv][0]);
      assert.equal(rankTitle(lv, 100.1), TITLES[lv][0], '超過 100 照落點處理，不另立失敗');
      assert.equal(rankTitle(lv, 0), TITLES[lv][3]);
      assert.equal(rankTitle(lv, -0.1), TITLES[lv][3]);
      // 非有限分數一律空字串，呼叫端據此隱藏元素
      for (const bad of [NaN, Infinity, -Infinity, '90', null, undefined, {}]) {
        assert.equal(rankTitle(lv, bad), '', `${lv} @ ${String(bad)}`);
      }
    }
    for (const bad of ['L4', '', null, undefined, 'l1', 0]) {
      assert.equal(rankTitle(bad, 90), '', `非法 level ${String(bad)}`);
    }
  });
});

describe('A29 封閉黑名單（法定／認證職稱）', () => {
  /**
   * **完整列出，不以「等」結尾。**
   * 開放清單無法測——「等」後面的東西沒有任何斷言擋得住。
   * 內容為台灣有法定或認證意義的醫事職稱（醫事人員人事條例、
   * 專門職業及技術人員考試各類科），加上會被誤讀為資格的認證字樣。
   */
  const FORBIDDEN = [
    '醫師', '中醫師', '牙醫師', '獸醫師', '專科醫師',
    '藥師', '藥劑師', '藥劑生', '專科藥師', '藥事人員', '調劑師',
    '護理師', '專科護理師', '護士', '助產師', '助產士',
    '物理治療師', '物理治療生', '職能治療師', '職能治療生',
    '醫事檢驗師', '醫事檢驗生', '醫檢師', '醫事放射師', '醫事放射士', '放射師',
    '營養師', '臨床心理師', '諮商心理師', '心理師',
    '呼吸治療師', '語言治療師', '聽力師',
    '牙體技術師', '牙體技術生', '驗光師', '驗光生',
    '執業執照', '證照', '認證', '檢定合格', '國考及格', '考試及格',
  ];

  /** 比對前正規化：大小寫、全半形、標點剝除。少了這步，加個空格或全形就能繞過 */
  const norm = (s) => String(s).normalize('NFKC').toUpperCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');

  test('12 格的全部輸出都不命中黑名單', () => {
    for (const lv of LEVELS3) {
      for (const t of TITLES[lv]) {
        const n = norm(t);
        const hit = FORBIDDEN.filter((f) => n.includes(norm(f)));
        assert.deepEqual(hit, [], `${lv} 的稱號「${t}」含法定職稱：${hit.join('、')}`);
      }
    }
  });

  test('黑名單本身在正規化後仍能命中變體（證明比對有效，不是恆真斷言）', () => {
    // 沒有這條，上面那個測試在 norm 壞掉時會靜默全過
    for (const v of ['藥　師', '藥.師', 'ＡＢ藥師', '藥師！']) {
      assert.ok(norm(v).includes(norm('藥師')), `變體未被正規化攔下：${v}`);
    }
  });

  test('D24 條 3：L1／L2 的 6 格不得含精熟意涵', () => {
    // 第 2 條放棄形式化跨級排序後，這是保住「防刷簡單級拿高階稱號」的較弱但可證偽的約束
    const MASTERY = [
      '精通', '精熟', '熟練', '專精', '專家', '大師', '宗師', '權威', '達人',
      '頂尖', '無敵', '完美', '滿分', '神級', '王者', '冠軍', '第一名', '專業級',
      // 〔2026-08-06 人工覆核裁示補入〕原表的 L1 ≥95 是「牌面熟手」，
      // 黑名單收了「熟練」卻沒收「熟手」，因此**放行了一個該擋的字**——
      // 靠人工覆核才抓到。規格 D24 條 3（v4.3）已寫明裁決：
      // 「熟手」的「熟」與「熟練」同義且落在簡單級最高帶 → 視為精熟意涵，收錄；
      // 「高手」指相對表現位階、不宣稱能力已臻精熟，且 L2 難度已排除刷分路徑 → **不收錄**
      // （收了就與 L2 ≥95「辨識高手」的定案直接衝突）。
      '熟手',
    ];
    for (const lv of [Level.L1, Level.L2]) {
      for (const t of TITLES[lv].slice(0, 3)) {
        const n = norm(t);
        const hit = MASTERY.filter((m) => n.includes(norm(m)));
        assert.deepEqual(hit, [], `${lv} 的稱號「${t}」含精熟意涵：${hit.join('、')}`);
      }
    }
  });

  test('人工法規覆核紀錄存在且涵蓋全部 12 格', () => {
    // A29 要求「另留人工法規覆核紀錄」。稱號用字定案前這份是暫定，
    // 檔案本身就是那個待辦的載體——刪掉它這條會紅
    const p = path.join(ROOT, '.ai-review/rank-title-review.md');
    assert.ok(fs.existsSync(p), '缺少人工法規覆核紀錄 .ai-review/rank-title-review.md');
    const doc = fs.readFileSync(p, 'utf8');
    for (const lv of LEVELS3) {
      for (const t of TITLES[lv]) assert.ok(doc.includes(t), `覆核紀錄未涵蓋「${t}」`);
    }
  });
});

// ══ 靜態原始碼契約（證據強度低於行為測試，理由見檔頭）══════════════════

const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
/**
 * 註解必須先剝掉再解析。
 * 兩個都踩過的坑：規則前面的說明註解會被當成 selector 的一部分；
 * 而「不做 @keyframes」這句註解本身會讓「CSS 內不得出現 @keyframes」恆紅。
 */
const CSS = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'))
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** 同理剝掉 JS 註解——否則講「不得用 behavior: 'smooth'」的註解會讓契約恆紅。
 *  行註解的 `[^:]` 前綴是為了不誤切 `https://` */
const APPJS = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** 取出 @media 區塊的內容（要數大括號——裡面本來就有巢狀規則） */
function mediaBlock(css, query) {
  const at = css.indexOf(`@media (${query})`);
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return { body: css.slice(open + 1, i), end: i + 1, start: at };
  }
  return null;
}

/** 把 `sel { body }` 拆成規則清單 */
const rulesOf = (css) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ sel: m[1].trim(), body: m[2] }));

const propsOf = (body) => [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);

/**
 * selector 命中判定：完全相等，**或以該 selector 為結尾**。
 *
 * 〔TG-6〕後半是本輪補的。原本只比對完全相等，於是
 * `body .rank-title { font-size: 3rem }` 這種較高 specificity 的覆寫整條掃不到——
 * 在 cascade 上它會贏，契約卻宣告全綠。
 * 結尾的前一個字元必須是組合子，否則 `.foo-rank-title` 會被誤判為命中。
 */
const matchesSel = (sel, target) => sel === target
  || (sel.endsWith(target) && /[\s>+~]/.test(sel[sel.length - target.length - 1]));

/**
 * 全檔（含 `@media` 內）收集命中的**所有**規則。
 * 〔TG-2／TG-3〕原本用 `rulesOf(CSS).find(...)` 只驗第一條宣告，
 * 而 `index.html` 已存在 `@media (max-width: 480px)` 且該 block 內本來就在覆寫
 * `font-size`——在那裡多加一條覆寫是這個檔案的既有編輯習慣，會自然踩到這個洞。
 */
const rulesMatching = (...targets) => rulesOf(CSS).filter((r) =>
  r.sel.split(',').map((s) => s.trim().replace(/\s+/g, ' '))
    .some((s) => targets.some((t) => matchesSel(s, t))));

/** 取出所有 `color:` 宣告（排除 border-color／background-color 這類複合屬性） */
const colorsOf = (body) => [...body.matchAll(/(?:^|[;{\s])color\s*:\s*([^;]+)/g)]
  .map((m) => m[1].trim());

/**
 * 取出這批規則所有 `prop` 宣告並換算成 rem。
 *
 * 〔TG-5〕**解析不出來的宣告一律 fail，不得靜默忽略**。
 * 前一版回 `null` 再由呼叫端 `.filter(v !== null)` 濾掉，於是
 * `.rank-title { font-size: 48px }` 直接消失，剩下的既有 rem 宣告讓契約照樣全綠。
 * 把掃描範圍從「第一條」擴大到「全檔」卻沒同步處理「解析失敗怎麼辦」，
 * 等於門開大了但鎖沒換。本專案字級一律用 rem，換單位就該回來改契約。
 */
function remSizes(rules, prop = 'font-size') {
  const out = [];
  for (const r of rules) {
    const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(r.body);
    if (!m) continue;
    const raw = m[1].trim();
    const num = /^([\d.]+)rem$/.exec(raw);
    assert.ok(num, `${r.sel} 的 ${prop} 宣告為「${raw}」——`
      + '本專案字級一律用 rem，無法換算的宣告不得被靜默忽略（TG-5）');
    out.push(Number(num[1]));
  }
  return out;
}

describe('C23b 稱號的視覺層級（靜態契約）', () => {
  test('稱號字級不大於三級判定的字級（全檔，含所有 @media 覆寫）', () => {
    // 〔堵〕F13——樁上沒有 cascade，寫 getComputedStyle 必然假綠。
    //       這裡只驗宣告值，**實際渲染字級與對比另做人工瀏覽器留檔**
    // 〔TG-2〕改掃全檔：只取第一條的話，480px block 內加一條放大覆寫就溜過去了
    // 〔TG-5／TG-6〕非 rem 宣告會在 remSizes() 內直接 fail；
    //               `body .rank-title` 這類覆寫由 matchesSel() 的結尾比對納入
    const rankSizes = remSizes(rulesMatching('.rank-title'));
    const interpSizes = remSizes(rulesMatching('.metric .interp'));
    assert.ok(rankSizes.length, '.rank-title 必須明確宣告 font-size');
    assert.ok(interpSizes.length, '.metric .interp 必須明確宣告 font-size');
    // 保守契約：**任一處**的稱號字級都不得超過**任一處**的三級判定字級。
    // 不模擬 cascade（F13：樁上根本沒有 cascade）。寧可過嚴——
    // 過嚴會逼人回來改規格，過鬆則是威脅模型第 3 條（讓使用者高估自己的能力）
    const maxRank = Math.max(...rankSizes);
    const minInterp = Math.min(...interpSizes);
    assert.ok(maxRank <= minInterp,
      `稱號字級最大 ${maxRank}rem 大於三級判定最小 ${minInterp}rem`);
  });

  test('稱號用 muted 色，不得用 accent／danger 這類強調色（全檔）', () => {
    const rules = rulesMatching('.rank-title');
    const colors = rules.flatMap((r) => colorsOf(r.body));
    assert.ok(colors.length, '.rank-title 必須明確宣告 color');
    for (const c of colors) {
      assert.equal(c, 'var(--text-muted)', `.rank-title 的 color 宣告為 ${c}`);
    }
  });

  test('稱號與級別徽章在同一個容器內（DOM 契約）', () => {
    const m = /<p class="rank hidden" id="resultRank">([\s\S]*?)<\/p>/.exec(HTML);
    assert.ok(m, '缺少 #resultRank');
    assert.match(m[1], /id="rankBadge"/);
    assert.match(m[1], /id="rankTitle"/);
    // DOM 順序：稱號必須在三級判定（resultMetrics 內）之後
    assert.ok(HTML.indexOf('id="resultMetrics"') < HTML.indexOf('id="resultRank"'),
      '稱號的 DOM 順序必須在三級判定之後');
  });
});

describe('C25 reduced-motion 的完整 selector 清單（靜態契約）', () => {
  const block = mediaBlock(CSS, 'prefers-reduced-motion: no-preference');

  test('存在 no-preference 正向表列 block', () => {
    assert.ok(block, 'index.html 必須有 @media (prefers-reduced-motion: no-preference)');
  });

  test('D27 窮舉的三類動態效果全部在 block 內', () => {
    const sels = rulesOf(block.body).map((r) => r.sel);
    for (const must of ['button', '.bar > i', '.opt, .cell', '.streak .n', '.streak.pop .n']) {
      assert.ok(sels.includes(must), `reduced-motion block 缺少 ${must}`);
    }
  });

  test('block 之外不存在任何 transition／animation／@keyframes', () => {
    // 〔堵〕v4.0 只驗揭曉元素，streak pop 與進度條可以在 reduce 模式繼續動；
    //       既有的兩條 transition（button／.bar > i）也必須一併納入——
    //       reduced-motion 是使用者的無障礙偏好，不分「哪一批加的」
    const outside = CSS.slice(0, block.start) + CSS.slice(block.end);
    assert.doesNotMatch(outside, /transition\s*:/, 'block 外仍有 transition 宣告');
    assert.doesNotMatch(outside, /animation\s*:/, 'block 外仍有 animation 宣告');
    assert.doesNotMatch(CSS, /@keyframes/, 'D27 已列 @keyframes 為非目標');
  });

  test('app.js 不得自帶動畫（D27 條 5）', () => {
    // 〔TG-1〕這條原本不存在，三處 window.scrollTo({ behavior: 'smooth' })
    //         因此全部通過上面那條——**已經發生過的假陰性**。
    //         樁的 window.scrollTo 是空函式，行為測試同樣抓不到，只能做靜態契約。
    //         正向表列以 CSS @media 為載體，JS 端動畫繞過整套 reduced-motion 管控
    for (const [re, why] of [
      [/behavior\s*:/, "捲動動畫（改用 window.scrollTo(0, 0)）"],
      [/scrollIntoView\s*\(\s*\{/, 'scrollIntoView 帶選項物件'],
      [/\.animate\s*\(/, 'Web Animations API'],
      [/requestAnimationFrame/, 'requestAnimationFrame 驅動的視覺補間'],
    ]) {
      assert.doesNotMatch(APPJS, re,
        `app.js 出現 ${why}——動畫一律留在 CSS 的 no-preference 正向表列內`);
    }
  });
});

describe('C27 動畫不得造成 document flow 位移（靜態契約）', () => {
  const block = mediaBlock(CSS, 'prefers-reduced-motion: no-preference');

  test('block 內只宣告 transition 與 transform，不動任何佔位屬性', () => {
    // 〔堵〕**雙向**：樁固定回傳相同矩形 → 恆過（假陰性）；
    //       真實 getBoundingClientRect 含 transform → 把 D27 明文允許的 scale
    //       誤判為位移（假陽性）。因此這條驗的是「有沒有動到會影響 flow 的屬性」，
    //       實際 flow 位移另做人工瀏覽器留檔
    for (const r of rulesOf(block.body)) {
      const bad = propsOf(r.body).filter((p) => !['transition', 'transform'].includes(p));
      assert.deepEqual(bad, [], `${r.sel} 宣告了會影響佔位的屬性：${bad.join('、')}`);
    }
  });

  test('transition 的 property 白名單：顏色與 transform；width 僅限 .bar > i', () => {
    const ALLOW = ['background', 'border-color', 'transform'];
    for (const r of rulesOf(block.body)) {
      const m = /transition\s*:\s*([^;]+)/.exec(r.body);
      if (!m) continue;
      const props = m[1].split(',').map((s) => s.trim().split(/\s+/)[0]);
      for (const p of props) {
        if (r.sel === '.bar > i' && p === 'width') continue;   // 既有效果，在固定高度容器內
        assert.ok(ALLOW.includes(p), `${r.sel} 的 transition 動到 ${p}`);
      }
    }
  });

  test('連對數字用 inline-block + transform，不改字級', () => {
    const n = rulesOf(CSS).find((r) => r.sel === '.streak .n');
    assert.match(n.body, /display:\s*inline-block/, 'transform 對 inline 元素無效');
    assert.doesNotMatch(n.body, /font-size/, '改字級會推動同列元素');
  });

  test('狀態 selector 在全檔任何位置都不得動到佔位屬性', () => {
    // 〔TG-3〕上面兩條只迭代 reduced-motion block **內**的規則：
    //         把 `.streak.pop .n { font-size: 2rem }` 寫在 block 外，
    //         C27 不掃（不在 block 內）、C25 也不掃（不是 transition／animation）。
    //         狀態 selector 只該換顏色，佔位屬性一律歸基底規則管
    const STATE = ['.streak.pop .n', '.opt.ok', '.opt.no', '.cell.ok', '.cell.no'];
    const FLOW_PROPS = new Set([
      'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
      'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'font', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'word-spacing',
      'border', 'border-width', 'border-style', 'border-top-width', 'border-right-width',
      'border-bottom-width', 'border-left-width',
      'display', 'position', 'top', 'right', 'bottom', 'left', 'inset',
      'gap', 'flex', 'flex-basis', 'grid-template-columns', 'writing-mode', 'zoom',
    ]);
    const hit = rulesMatching(...STATE);
    assert.ok(hit.length >= 5, `狀態 selector 應全部存在，實得 ${hit.length} 條`);
    for (const r of hit) {
      const bad = propsOf(r.body).filter((p) => FLOW_PROPS.has(p));
      assert.deepEqual(bad, [], `${r.sel} 動到會影響佔位的屬性：${bad.join('、')}`);
    }
  });
});

describe('C26 揭曉不得被樣式延後（靜態部分）', () => {
  test('判定／下一題／正解格標記不得由 opacity:0 或 visibility:hidden 起始', () => {
    for (const r of rulesOf(CSS)) {
      if (!/verdict|btnNext|\.opt\.ok|\.cell\.ok/.test(r.sel)) continue;
      assert.doesNotMatch(r.body, /opacity\s*:\s*0(\D|$)/, `${r.sel} 由 opacity:0 起始`);
      assert.doesNotMatch(r.body, /visibility\s*:\s*hidden/, `${r.sel} 由 visibility:hidden 起始`);
    }
  });
});

describe('新增 DOM 掛點確實存在於 index.html', () => {
  // 樁的 getElementById 會**自動生出**沒宣告過的元素，因此 C 組的 DOM 斷言
  // 在忘記改 index.html 時仍會全綠。這條是那個假綠燈的解藥
  test('批次 A 用到的 id 全部宣告在 index.html', () => {
    for (const id of [
      'qStreak', 'qStreakN', 'resultRank', 'rankBadge', 'rankTitle', 'recordFlash',
      'recordsBox', 'recordsBody', 'recordsNote', 'clearConfirm',
      'btnClearRecords', 'btnClearYes', 'btnClearNo',
    ]) {
      assert.ok(HTML.includes(`id="${id}"`), `index.html 缺少 id="${id}"`);
    }
  });

  test('起始隱藏的區塊在 HTML 上就是 hidden（否則首屏會閃現空區塊）', () => {
    for (const id of ['qStreak', 'resultRank', 'recordFlash', 'recordsBox', 'recordsNote', 'clearConfirm']) {
      assert.match(HTML, new RegExp(`class="[^"]*hidden[^"]*"\\s+id="${id}"`), `${id} 未預設 hidden`);
    }
  });
});
