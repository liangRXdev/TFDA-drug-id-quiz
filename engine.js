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
      return {
        ...q,
        state: QState.HINTED,
        mark: HINTED_MARK,
        // 選擇題取提示後變三選一且滿分 0.5，亂猜期望隨之下降（規格 D14）。
        // 自由輸入題沒有猜測基線，維持 0。
        chance: q.options ? CHANCE.THREE : q.chance,
      };

    case 'submit':
      // 首次送出即鎖定，不可重試（允許重試等於允許窮舉）
      return { ...q, state: QState.LOCKED, correct: !!ev.correct };

    case 'fail':
      return { ...q, state: QState.VOID, correct: false, mark: 0 };

    default:
      return q;
  }
}

/**
 * 建立初始題目狀態。
 *
 * `extra` 承載選擇題的附加欄位（規格 §5.2）：token / level / options /
 * answerIdx / spares / chance。L3 不傳即維持 v2 語意。
 */
export function newQuestion(item, extra = {}) {
  return {
    item,
    state: QState.PENDING,
    correct: false,
    mark: FULL_MARK,
    chance: CHANCE.NONE,
    ...extra,
  };
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
  let chanceSum = 0;

  for (const q of questions) {
    if (q.state === QState.VOID) {
      voided++;
      continue;
    }
    counted++;
    // 亂猜基線逐題加總（規格 D14）。此處只做加總，
    // 刻意不讓計分核心知道 level——級別是 UI metadata，不該耦合進來。
    chanceSum += q.chance || 0;
    if (q.mark === HINTED_MARK) hints++;
    if (q.correct) {
      earned += q.mark;
      correct++;
    }
  }
  const score = counted ? (earned / counted) * 100 : 0;
  const chance = counted ? (chanceSum / counted) * 100 : 0;
  return {
    score: Math.round(score * 10) / 10,
    chance: Math.round(chance * 10) / 10,
    earned,
    counted,
    correct,
    voided,
    hints,
  };
}

// ── 難度分級（規格 v3）────────────────────────────────────────────────

export const Level = { L1: 'L1', L2: 'L2', L3: 'L3' };
export const CHOICE_COUNT = 4;
/** L2 需 3 正式 + 2 備援；L1 只要 3（spares 恆空，規格 D15） */
export const DISTRACTOR_COUNT = 5;
export const MAX_QUIZ_ATTEMPTS = 3;

/**
 * 逐題亂猜期望得分（規格 D14）。
 * 基線是逐題加總的結果，不是可以寫死在 UI 的固定值——
 * 三選一且滿分 0.5 的期望是 0.167，不是 0.25。
 */
export const CHANCE = {
  FOUR: FULL_MARK / CHOICE_COUNT,             // 0.25
  THREE: HINTED_MARK / (CHOICE_COUNT - 1),    // ≈0.1667
  NONE: 0,
};

/**
 * D13：同題選項的名稱碰撞。
 * 比較輸入一律為 squash(答案鍵)，不再做其他前處理；
 * 完全相等交由 H1（答案鍵互異）處理，不重複計為前綴碰撞。
 */
export function nameCollides(a, b) {
  const x = squash(a);
  const y = squash(b);
  if (x === y) return false;
  if (editDistance(x, y, 1) <= 1) return true;
  return x.startsWith(y) || y.startsWith(x);
}

const disjoint = (arr, set) => !arr.some((v) => set.has(v));

/** 就地洗牌，呼叫端負責先複製（規格 D20：不得改動共享陣列） */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 建索引。回傳物件與傳入的 items 皆視為不可變（規格 D20）。
 *
 * `union` 存的是**該答案鍵所有紀錄的外觀聯集**，不是任一代表紀錄。
 * L1 誘答要能被「我知道那顆藥長怎樣」排除，就必須該藥名的每一種外觀
 * 都與正解不同——只比對代表紀錄會漏掉同名不同廠的其他外觀。
 */
export function buildIndex(items) {
  const byAns = new Map();
  for (const it of items) {
    if (!byAns.has(it.ans)) byAns.set(it.ans, []);
    byAns.get(it.ans).push(it);
  }
  const union = new Map();
  for (const [ans, recs] of byAns) {
    const shape = new Set();
    const color = new Set();
    for (const r of recs) {
      for (const s of r.shape) shape.add(s);
      for (const c of r.color) color.add(c);
    }
    union.set(ans, { shape, color });
  }
  return { byAns, union, keys: [...byAns.keys()] };
}

/** 該級每題需要幾個誘答（L2 多備 2 個供資源失敗時替換） */
const needDistractors = (level) =>
  level === Level.L2 ? DISTRACTOR_COUNT : CHOICE_COUNT - 1;

/** 單一誘答對正解的條件（不含誘答彼此的兩兩條件） */
function candidateOk(candAns, correct, index, level) {
  if (candAns === correct.ans) return false;
  if (nameCollides(candAns, correct.ans)) return false;
  if (level === Level.L1) {
    const u = index.union.get(candAns);
    return disjoint(correct.shape, u.shape) && disjoint(correct.color, u.color);
  }
  return true;
}

/**
 * 階段 1（規格 D19）：該級的可用答案鍵集合。**純判定，不用 RNG。**
 *
 * D18 的定義：答案鍵可用 ⟺ `drawQuiz` 可能抽到的**每一筆紀錄**都能組題。
 * 不是「至少一筆可用」——後者會讓同一答案鍵有時可出題有時炸掉，
 * 產生難以重現的失敗。
 */
export function eligibleKeys(index, level) {
  if (level === Level.L3) return new Set(index.keys);
  const need = needDistractors(level);
  const out = new Set();
  for (const [ans, recs] of index.byAns) {
    const ok = recs.every((rec) => {
      let n = 0;
      for (const candAns of index.keys) {
        if (candidateOk(candAns, rec, index, level)) n++;
        if (n >= need) return true;
      }
      return false;
    });
    if (ok) out.add(ans);
  }
  return out;
}

/**
 * 階段 2（規格 D19）：為單一正解紀錄組裝選項。
 *
 * 產出的誘答**兩兩皆合法**，因此 L2 任取 3 個必合法——
 * 備援替換不需要重新驗證任何條件（規格 D15）。
 *
 * @param {object} correct    已抽定的紀錄本身（不變量 I1）
 * @param {Set}    excludeAns 整卷正解答案鍵集合（H2）
 * @throws {Error} code = 'NO_DISTRACTORS'
 */
export function buildChoices(correct, index, { level, rng, excludeAns } = {}) {
  const exclude = excludeAns || new Set();
  const need = needDistractors(level);

  const cands = [];
  for (const ans of index.keys) {
    if (exclude.has(ans) && ans !== correct.ans) continue;
    if (candidateOk(ans, correct, index, level)) cands.push(ans);
  }
  shuffle(cands, rng);                       // cands 是新陣列，未動索引

  const chosen = [];
  for (const ans of cands) {
    if (chosen.length === need) break;
    if (chosen.some((o) => nameCollides(ans, o))) continue;   // 誘答彼此（H3）
    chosen.push(ans);
  }
  if (chosen.length < need) {
    const err = new Error(`答案鍵 ${correct.ans} 的合法誘答僅 ${chosen.length} 個，不足 ${need}`);
    err.code = 'NO_DISTRACTORS';
    throw err;
  }

  const picked = chosen.map((a) => pick(index.byAns.get(a), rng));
  const options = [correct, ...picked.slice(0, CHOICE_COUNT - 1)];
  shuffle(options, rng);                     // H4：位置由 RNG 決定
  return {
    options,
    answerIdx: options.indexOf(correct),
    spares: level === Level.L2 ? picked.slice(CHOICE_COUNT - 1) : [],
  };
}

/**
 * 整卷生成（規格 D19 兩階段）。
 *
 * 先定完整正解集合再組選項——逐題組裝會讓後補的正解**回溯破壞**
 * 先前題目的 H2。組裝失敗時整卷重抽，不做局部補抽（局部補抽同樣會破壞 H2，
 * 且會讓誘答池大的答案鍵被高估，違反 v2 D5 的答案鍵均勻）。
 *
 * @throws {Error} code = 'INSUFFICIENT_KEYS' | 'QUIZ_ASSEMBLY_FAILED'
 */
export function drawLeveledQuiz(items, { level, n = QUIZ_SIZE, rng = Math.random, index } = {}) {
  const idx = index || buildIndex(items);
  const eligible = eligibleKeys(idx, level);

  // 選擇題的下限不是 n，而是 n + 每題誘答數。
  // H2 禁止誘答等於本卷其他題的正解——若可用答案鍵恰好等於 n，
  // 全部答案鍵都是正解，合法誘答數為 0，必然組不出任何一題。
  // 這是**必要非充分**條件；剩下的組合失敗由 QUIZ_ASSEMBLY_FAILED 兜底。
  const minKeys = level === Level.L3 ? n : n + needDistractors(level);
  if (eligible.size < minKeys) {
    const err = new Error(
      `${level} 可用答案鍵僅 ${eligible.size} 個，不足 ${minKeys} 個`
      + (level === Level.L3 ? '' : `（${n} 題正解 + 每題 ${needDistractors(level)} 個誘答）`));
    err.code = 'INSUFFICIENT_KEYS';
    err.available = eligible.size;
    err.required = minKeys;
    throw err;
  }
  const pool = items.filter((it) => eligible.has(it.ans));
  const baseChance = level === Level.L3 ? CHANCE.NONE : CHANCE.FOUR;

  let last;
  for (let attempt = 0; attempt < MAX_QUIZ_ATTEMPTS; attempt++) {
    const corrects = drawQuiz(pool, n, rng);            // 答案鍵均勻（v2 D5）
    const excludeAns = new Set(corrects.map((c) => c.ans));
    try {
      return corrects.map((c, i) => newQuestion(c, {
        token: i + 1,                                    // 遞補不重用（D18）
        level,
        chance: baseChance,
        ...(level === Level.L3
          ? {}
          : buildChoices(c, idx, { level, rng, excludeAns })),
      }));
    } catch (e) {
      if (e.code !== 'NO_DISTRACTORS') throw e;
      last = e;
    }
  }
  const err = new Error(`整卷組裝連續 ${MAX_QUIZ_ATTEMPTS} 次失敗：${last?.message ?? ''}`);
  err.code = 'QUIZ_ASSEMBLY_FAILED';
  throw err;
}

/**
 * 選擇題判定。嚴格整數相等，不做任何型別轉換——
 * DOM `dataset` 取出來全是字串，`"1" == 1` 的寬鬆比較會誤判為對。
 */
export function judgeChoice(pickedIdx, answerIdx) {
  if (!Number.isInteger(pickedIdx) || !Number.isInteger(answerIdx)) return false;
  if (pickedIdx < 0 || pickedIdx >= CHOICE_COUNT) return false;
  if (answerIdx < 0 || answerIdx >= CHOICE_COUNT) return false;
  return pickedIdx === answerIdx;
}
