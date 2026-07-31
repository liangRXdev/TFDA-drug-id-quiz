/**
 * 藥品辨識王 — 純函式引擎
 *
 * 無 DOM 依賴，可直接被 node --test 與瀏覽器 <script type="module"> 載入。
 * 建置期管線（tools/build-pool.mjs）與執行期前端共用**同一份** normalize，
 * 避免兩套實作漂移（規格 D3）。
 */

// ── 正規化 ────────────────────────────────────────────────────────────

/**
 * 完整劑型字詞：以 \b 為界，出現在任何位置都剝除。
 * 這些是多字母單字，誤傷品名的機率低。
 */
const FORM_WORDS =
  '(?:FILM|SUGAR|ENTERIC|COATED|TABLETS?|CAPSULES?|CAPS?|TABS?|' +
  'PROLONGED|SUSTAINED|EXTENDED|CONTROLLED|DELAYED|RELEASE|SOFT|HARD|GELATIN|' +
  'CHEWABLE|DISPERSIBLE|EFFERVESCENT|ORAL|VAGINAL|SUBLINGUAL|BUCCAL|MICRO|' +
  'MICROENCAPSULATED|ENCAPSULATED|LOZENGES?|PELLETS?|DRAGEES?|PILLS?|' +
  'SUSPENSION|SOLUTION|SYRUPS?|POWDERS?|GRANULES?|INJECTIONS?|LIQUIDS?)';

/**
 * 劑型縮寫：**僅在整個空白分隔 token 完全相符時**剝除。
 *
 * 不可用 \b 比對——實測 `O.G.S.C. TABLETS "JOHNSON"` 的品名本身含 `S.C.`，
 * 用 \b 會把品牌字剝成 `O G`。這類縮寫太短，只能整 token 比對。
 * 亦不收無點形式（FC/SC/EC…），那些極可能是真品名。
 */
const FORM_ABBR = new Set([
  'F.C.', 'F.C', 'S.C.', 'S.C', 'E.C.', 'E.C',
  'S.R.', 'S.R', 'C.R.', 'C.R', 'X.R.', 'X.R', 'O.D.', 'O.D',
]);

const QUOTES = '“”„‟＂"\'`‘’';
const RE_QUOTED = new RegExp(`[${QUOTES}][^${QUOTES}]{1,25}[${QUOTES}]`, 'g');
const RE_PAREN = /[（(][^)）]*[)）]/g;
const RE_STRENGTH = /\d+(?:[.,]\d+)?\s*(?:MG|MCG|UG|G|ML|L|%|IU|U|PPM|W\/V|V\/V)\b/g;
const RE_RATIO = /\d+(?:\.\d+)?\s*\/\s*\d*(?:\.\d+)?\s*(?:MG|ML|G)?\b/g;
const RE_FORM = new RegExp(`\\b${FORM_WORDS}\\b`, 'g');
const RE_NON_ALNUM = /[^A-Z0-9一-鿿]+/g;
const RE_BARE_NUM = /\b\d+(?:\.\d+)?\b/g;

/**
 * 英文品名 → 答案鍵。
 * 對原始資料與使用者輸入使用同一條管線，是判定一致性的前提。
 */
export function normalize(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.normalize('NFKC').toUpperCase();
  t = t.replace(RE_QUOTED, ' ');
  t = t.replace(RE_PAREN, ' ');
  t = t.replace(RE_STRENGTH, ' ');
  t = t.replace(RE_RATIO, ' ');
  // 劑型縮寫先於一般剝除處理：整 token 相符才剔除
  t = t
    .split(/\s+/)
    .filter((tok) => tok && !FORM_ABBR.has(tok.replace(/[,;]+$/, '')))
    .join(' ');
  t = t.replace(RE_FORM, ' ');
  t = t.replace(RE_NON_ALNUM, ' ');
  t = t.replace(RE_BARE_NUM, ' ');
  return t.split(/\s+/).filter(Boolean).join(' ');
}

/** 去除全部空白。所有長度判斷一律以此為準（規格 6.1）。 */
export function squash(s) {
  return (s || '').replace(/\s+/g, '');
}

// ── 比對 ──────────────────────────────────────────────────────────────

/** 容錯門檻：答案鍵去空白長度 ≥ 此值才啟用編輯距離 1 的容錯 */
export const FUZZY_MIN_LEN = 6;

/**
 * 編輯距離，超過 max 即提早放棄（回傳 max + 1）。
 * 只關心 ≤1，不需要完整矩陣。
 */
export function editDistance(a, b, max = 1) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * 判定作答。
 *
 * @param {string} input      使用者原始輸入
 * @param {string} answerKey  題目答案鍵（已正規化）
 * @param {{noFuzzy?: boolean}} [opts] noFuzzy 為 true 時停用容錯（規格 6.2 碰撞處理）
 * @returns {{correct: boolean, reason: string}}
 *          reason: empty | exact | squashed | fuzzy | wrong
 */
export function judge(input, answerKey, opts = {}) {
  const norm = normalize(input);
  if (!norm) return { correct: false, reason: 'empty' };

  if (norm === answerKey) return { correct: true, reason: 'exact' };

  const a = squash(norm);
  const b = squash(answerKey);
  if (a === b) return { correct: true, reason: 'squashed' };

  if (!opts.noFuzzy && b.length >= FUZZY_MIN_LEN && editDistance(a, b, 1) <= 1) {
    return { correct: true, reason: 'fuzzy' };
  }
  return { correct: false, reason: 'wrong' };
}

// ── 提示 ──────────────────────────────────────────────────────────────

/**
 * 首字母 + 底線，並標示原始詞數（規格 6.3）。
 * 字數以去空白答案鍵為準，與容錯門檻共用同一長度定義。
 */
export function makeHint(answerKey) {
  const flat = squash(answerKey);
  const words = answerKey.split(/\s+/).filter(Boolean).length;
  const masked = flat
    ? [flat[0], ...Array(flat.length - 1).fill('_')].join(' ')
    : '';
  return { masked, chars: flat.length, words };
}

// ── 抽題 ──────────────────────────────────────────────────────────────

export const QUIZ_SIZE = 20;

/** 可重現的 PRNG（mulberry32）。固定 seed 讓抽題測試不會偶發紅燈。 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * 依「答案鍵均勻」抽題（規格 D5）。
 *
 * 先從相異答案鍵均勻抽 n 個，每個答案鍵再從其紀錄中均勻抽 1 筆外觀。
 * 不採紀錄均勻抽樣——那會讓 IBUPROFEN（20 筆）出現機率是單一品項的 20 倍。
 *
 * @throws {Error} code = 'INSUFFICIENT_KEYS' 當相異答案鍵不足 n 個
 */
export function drawQuiz(items, n = QUIZ_SIZE, rng = Math.random) {
  const byKey = new Map();
  for (const it of items) {
    if (!byKey.has(it.ans)) byKey.set(it.ans, []);
    byKey.get(it.ans).push(it);
  }
  const keys = [...byKey.keys()];
  if (keys.length < n) {
    const err = new Error(`可用答案鍵僅 ${keys.length} 個，不足 ${n} 題`);
    err.code = 'INSUFFICIENT_KEYS';
    err.available = keys.length;
    throw err;
  }
  // partial Fisher–Yates：只洗出前 n 個
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (keys.length - i));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return keys.slice(0, n).map((k) => pick(byKey.get(k), rng));
}

// ── 題目狀態機（規格 6.4）─────────────────────────────────────────────

export const QState = {
  PENDING: 'pending',   // 未作答
  HINTED: 'hinted',     // 已提示
  LOCKED: 'locked',     // 已鎖定（對／錯）
  VOID: 'void',         // 作廢（資源失敗，不計分不計入分母）
};

export const FULL_MARK = 1.0;
export const HINTED_MARK = 0.5;

/**
 * 狀態轉移。非法轉移一律**忽略**並回傳原狀態，
 * 這是「重複點擊送出不重複計分」的實作依據（規格 6.4）。
 *
 * @param {{state: string, correct?: boolean, mark: number}} q
 * @param {{type: 'submit'|'hint'|'fail', correct?: boolean}} ev
 */
export function transition(q, ev) {
  const cur = q.state;
  if (cur === QState.LOCKED || cur === QState.VOID) return q; // 終態

  switch (ev.type) {
    case 'hint':
      // 已鎖定後不可取提示；此處 cur 必為 PENDING 或 HINTED
      if (cur === QState.HINTED) return q; // 重複點提示不重複扣分
      return { ...q, state: QState.HINTED, mark: HINTED_MARK };

    case 'submit':
      // 首次送出即鎖定，不可重試（允許重試等於允許窮舉）
      return { ...q, state: QState.LOCKED, correct: !!ev.correct };

    case 'fail':
      return { ...q, state: QState.VOID, correct: false, mark: 0 };

    default:
      return q;
  }
}

/** 建立初始題目狀態 */
export function newQuestion(item) {
  return { item, state: QState.PENDING, correct: false, mark: FULL_MARK };
}

// ── 計分（規格 6.6）───────────────────────────────────────────────────

/**
 * 總分 = Σ 得分 / 實際計分題數 × 100。分母排除作廢題。
 * 全部作廢時回傳 score 0 且 counted 0，不做除以零。
 */
export function scoreQuiz(questions) {
  let earned = 0;
  let counted = 0;
  let voided = 0;
  let hints = 0;
  let correct = 0;

  for (const q of questions) {
    if (q.state === QState.VOID) {
      voided++;
      continue;
    }
    counted++;
    if (q.mark === HINTED_MARK) hints++;
    if (q.correct) {
      earned += q.mark;
      correct++;
    }
  }
  const score = counted ? (earned / counted) * 100 : 0;
  return {
    score: Math.round(score * 10) / 10,
    earned,
    counted,
    correct,
    voided,
    hints,
  };
}
