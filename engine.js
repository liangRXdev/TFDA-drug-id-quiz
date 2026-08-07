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
 * L2 單格圖片的載入逾時（規格 D21）。
 *
 * 這條存在的唯一理由是 ready-gate：一旦規定「四格全部載入完才可作答」，
 * 一張永久 pending 的圖就會鎖死整題，而且不會觸發 onerror。
 * L1／L3 沒有 gate，不需要也不加逾時。
 */
export const L2_LOAD_TIMEOUT_MS = 8000;
/**
 * 貪婪挑選的重試次數。挑 k 個「兩兩合法」的元素對順序敏感，
 * 換一個順序常常就成功——重試幾次比實作精確的團搜尋划算得多，
 * 且失敗仍由 QUIZ_ASSEMBLY_FAILED 兜底。
 */
const GREEDY_ATTEMPTS = 8;

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
  const byShape = new Map();
  for (const it of items) {
    if (!byAns.has(it.ans)) byAns.set(it.ans, []);
    byAns.get(it.ans).push(it);
    const sk = shapeKey(it);
    if (!byShape.has(sk)) byShape.set(sk, []);
    byShape.get(sk).push(it);
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
  return { byAns, byShape, union, keys: [...byAns.keys()] };
}

const shapeKey = (it) => it.shape.join('|');

/**
 * D12：L2 判別鍵。**刻意去掉 `score_mark` 與 `size`**——
 * 那兩項在照片上是弱訊號（刻痕淺、尺寸要比對標尺），
 * 兩個答案鍵只差一個 `size` 值就能通過 v2 的 Q5，四張圖擺一起卻無從分辨。
 *
 * L2 誘答刻意選同形同色，因此本鍵相異實際上退化為「刻字必須不同」——
 * L2 的可解性完全押在刻字差異上，這是刻意的（見規格 §0 的 G1 gate）。
 */
export function l2Key(it) {
  return `${shapeKey(it)}#${it.color.join('|')}#${squash(it.mark1 || '')}#${squash(it.mark2 || '')}`;
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
 * L2 候選**紀錄**（不是答案鍵）。
 *
 * 這是 L1 與 L2 的本質差異：L1 顯示藥名，所以該藥名的**每一種外觀**
 * 都必須與正解不相交；L2 顯示的是一張特定照片，所以只有**那筆紀錄**
 * 的外觀需要匹配。用答案鍵層級的聯集來篩 L2 會錯得很離譜。
 *
 * 每個答案鍵只取一筆代表紀錄（H1 要求答案鍵互異）。
 */
function l2Candidates(correct, index, relaxColor) {
  const ck = correct.color.join('|');
  const correctKey = l2Key(correct);
  const seen = new Set();
  const out = [];
  for (const rec of index.byShape.get(shapeKey(correct)) || []) {
    if (rec.ans === correct.ans || seen.has(rec.ans)) continue;
    const sameColor = rec.color.join('|') === ck;
    // 放寬第 1 階只放寬顏色；形狀相同與 L2key 相異永不放寬（規格 §4.3）
    if (!sameColor && !(relaxColor && rec.color.some((c) => correct.color.includes(c)))) continue;
    if (l2Key(rec) === correctKey) continue;
    if (nameCollides(rec.ans, correct.ans)) continue;
    seen.add(rec.ans);
    out.push(rec);
  }
  return out;
}

/**
 * 自候選中貪婪挑出 need 筆兩兩合法者。
 *
 * 「兩兩合法」是 D15 的關鍵：如此一來 L2 任取 3 個必合法，
 * 備援替換不需要重新驗證任何條件。
 */
function pickMutuallyValid(cands, need, level, rng) {
  const c = cands.slice();                     // 不動索引內的陣列（D20）
  shuffle(c, rng);
  const chosen = [];
  const keys = new Set();
  for (const rec of c) {
    if (chosen.length === need) break;
    if (level === Level.L2) {
      const k = l2Key(rec);
      if (keys.has(k)) continue;               // L2key 兩兩相異（D12）
      if (chosen.some((o) => nameCollides(rec.ans, o.ans))) continue;
      keys.add(k);
    } else if (chosen.some((o) => nameCollides(rec.ans, o.ans))) {
      continue;                                // H3
    }
    chosen.push(rec);
  }
  return chosen.length === need ? chosen : null;
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
    if (recs.every((rec) => recordEligible(rec, index, level, need))) out.add(ans);
  }
  return out;
}

/** 單筆紀錄能否組題。不用 RNG——可用性判定與隨機選擇必須分離（覆審 4-6） */
function recordEligible(rec, index, level, need) {
  if (level === Level.L2) {
    // 嚴格階段不足時才看放寬階段（§4.3 的固定放寬順序）
    for (const relax of [false, true]) {
      if (pickMutuallyValid(l2Candidates(rec, index, relax), need, level, () => 0)) return true;
    }
    return false;
  }
  let n = 0;
  for (const candAns of index.keys) {
    if (candidateOk(candAns, rec, index, level)) n++;
    if (n >= need) return true;
  }
  return false;
}

/** L2 該紀錄在**嚴格**階段（同形同色）是否可組題——A9 的回歸基準 */
export function strictlyEligibleL2(rec, index) {
  return !!pickMutuallyValid(
    l2Candidates(rec, index, false), needDistractors(Level.L2), Level.L2, () => 0);
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
  const usable = (rec) => !(exclude.has(rec.ans) && rec.ans !== correct.ans);

  let picked = null;
  if (level === Level.L2) {
    // 固定放寬順序：嚴格（同形同色）→ 顏色相交。形狀與 L2key 永不放寬
    for (const relax of [false, true]) {
      const cands = l2Candidates(correct, index, relax).filter(usable);
      for (let t = 0; t < GREEDY_ATTEMPTS && !picked; t++) {
        picked = pickMutuallyValid(cands, need, level, rng);
      }
      if (picked) break;
    }
  } else {
    const cands = index.keys
      .filter((ans) => candidateOk(ans, correct, index, level))
      .map((ans) => pick(index.byAns.get(ans), rng))
      .filter(usable);
    for (let t = 0; t < GREEDY_ATTEMPTS && !picked; t++) {
      picked = pickMutuallyValid(cands, need, level, rng);
    }
  }

  if (!picked) {
    const err = new Error(`答案鍵 ${correct.ans} 湊不到 ${need} 個兩兩合法的誘答`);
    err.code = 'NO_DISTRACTORS';
    throw err;
  }

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
export function drawLeveledQuiz(items, { level, n = QUIZ_SIZE, rng = Math.random, index, eligible: pre } = {}) {
  const idx = index || buildIndex(items);
  // L2 的 eligibility 掃描約 1.6 秒（每筆紀錄都要試組），呼叫端應快取後傳入，
  // 否則每回合開始都會卡住主執行緒
  const eligible = pre || eligibleKeys(idx, level);

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
      const quiz = corrects.map((c, i) => newQuestion(c, {
        token: i + 1,                                    // 遞補不重用（D18）
        level,
        chance: baseChance,
        ...(level === Level.L3
          ? {}
          : buildChoices(c, idx, { level, rng, excludeAns })),
      }));
      assertQuizInvariants(quiz, level, idx);            // D19 最後一步
      return quiz;
    } catch (e) {
      if (e.code !== 'NO_DISTRACTORS') throw e;          // 含 INVARIANT_VIOLATED：重抽只會掩蓋 bug
      last = e;
    }
  }
  const err = new Error(`整卷組裝連續 ${MAX_QUIZ_ATTEMPTS} 次失敗：${last?.message ?? ''}`);
  err.code = 'QUIZ_ASSEMBLY_FAILED';
  throw err;
}

// ── 整卷不變量與遞補（規格 D19、6.5）─────────────────────────────────

/**
 * 整卷**已出現過**的答案鍵：正解 ∪ 選項 ∪ 備援。
 *
 * 遞補題的正解要避開的是這個集合，不是只有正解集合——見 `drawSpareQuestion`。
 */
export function seenAnsKeys(questions) {
  const out = new Set();
  for (const q of questions) {
    out.add(q.item.ans);
    for (const o of q.options || []) out.add(o.ans);
    for (const s of q.spares || []) out.add(s.ans);
  }
  return out;
}

/**
 * D19 的最後一道防線：對整卷驗證**靜態題卷能驗的那一層**不變量。
 *
 * 測試全綠不等於這道檢查存在。它守的是**執行期才組出來的題卷**——
 * 尤其是遞補後才成形的組合，那是測試無法窮舉的路徑。
 *
 * **驗得到**：H1、H2、H3、I1、I3。
 * **只驗得到弱形式**：H4——靜態快照無法回推「位置是否由 RNG 決定」，
 * 這裡只抓「整卷正解恆在同一格」這個忘記洗牌唯一會產生的樣態（heuristic）。
 * H4 的真正證據是 A13(a)–(d)（controlled RNG、題號獨立性、分布）。
 * **驗不到**：I2 由 I1 蘊含（題幹讀 `q.item`、正解格讀 `options[answerIdx]`，
 * 兩者物件同一即同一紀錄），不另立檢查以免同一件事兩處判定而漂移；
 * I4 與 I5 的「格位 token／目前資產 identity」是跨渲染的事件鏈性質，
 * 靜態 `Question[]` 沒有渲染歷程可驗，守它們的是 C11 與 A18。
 *
 * 回傳違規描述而不直接拋出：呼叫端對「生成時違規」（bug，中止）與
 * 「遞補後違規」（中止本回合並告知使用者）要有不同處置。
 * 每筆以 `[代碼]` 開頭，供呼叫端只顯示代碼——訊息本身含藥名，不可直接給使用者。
 *
 * @param {object} index 選擇題必傳。缺少時**不放行**（I3 無從驗證）
 * @returns {string[]} 空陣列表示通過
 */
export function validateQuizInvariants(questions, { level, index } = {}) {
  const bad = [];
  const lvl = level ?? questions[0]?.level ?? Level.L3;
  const tokens = new Set();
  const corrects = new Set();

  questions.forEach((q, i) => {
    const at = `第 ${i + 1} 題`;
    // I5（可驗的部分）：題目 token 全卷唯一。遞補會使題號位移，token 是唯一穩定的身分
    if (!Number.isInteger(q.token)) bad.push(`[I5] ${at}：缺少題目 token`);
    else if (tokens.has(q.token)) bad.push(`[I5] ${at}：題目 token ${q.token} 重複`);
    tokens.add(q.token);
    // H1（卷層級）：正解答案鍵兩兩相異
    if (corrects.has(q.item.ans)) bad.push(`[H1] ${at}：正解答案鍵 ${q.item.ans} 重複`);
    corrects.add(q.item.ans);
  });

  if (lvl === Level.L3) return bad;                      // 無選項，其餘不變量不適用

  // 沒有索引就驗不了紀錄身分。此時**判為違規**而非略過：
  // 「少傳一個參數就靜默降級成弱檢查」正是這道防線最容易失效的方式
  if (!index?.byAns) return [...bad, '[I3] 缺少 PoolIndex，無法驗證選項的紀錄身分'];
  const known = (r) => index.byAns.get(r.ans)?.includes(r) === true;

  const maxSpares = lvl === Level.L2 ? DISTRACTOR_COUNT - (CHOICE_COUNT - 1) : 0;
  questions.forEach((q, i) => {
    const at = `第 ${i + 1} 題`;
    const opts = q.options || [];
    if (opts.length !== CHOICE_COUNT) {
      bad.push(`[I1] ${at}：選項數 ${opts.length} ≠ ${CHOICE_COUNT}`);
      return;
    }
    if (!Number.isInteger(q.answerIdx) || q.answerIdx < 0 || q.answerIdx >= CHOICE_COUNT) {
      bad.push(`[I1] ${at}：answerIdx ${q.answerIdx} 超出範圍`);
    } else if (opts[q.answerIdx] !== q.item) {
      // I1：必須是 correctItem **本身**。同 ans 的另一筆紀錄會讓題幹與正解格
      // 來自不同照片，畫面上看不出來，但 L2 直接變成不可解
      bad.push(`[I1] ${at}：answerIdx 未指向 correctItem 本身`);
    }

    const spares = q.spares || [];
    // 上限而非等值：替換消耗備援後，同一卷的舊題會少於初始值
    if (spares.length > maxSpares) bad.push(`[D15] ${at}：備援 ${spares.length} 個超過上限 ${maxSpares}`);

    const all = [...opts, ...spares];
    const ids = new Set();
    for (const r of all) {
      // I3：每個選項／備援都必須**是題庫裡的那一筆紀錄本身**。
      // 只驗 id 非空是驗不出東西的——捏造一個唯一 id 就能通過，
      // 而「只換 img 不換紀錄」正是 I3 要防的
      if (!r || !r.id) { bad.push(`[I3] ${at}：選項缺少紀錄身分 id`); continue; }
      if (!known(r)) { bad.push(`[I3] ${at}：選項 ${r.id} 不是題庫中的紀錄`); continue; }
      if (ids.has(r.id)) bad.push(`[I3] ${at}：同題重複紀錄 ${r.id}`);
      ids.add(r.id);
    }
    for (let a = 0; a < all.length; a++) {
      const x = all[a];
      if (!x?.id) continue;
      // H2：誘答與備援不得屬於本卷正解集合（本題正解除外）
      if (x !== q.item && corrects.has(x.ans)) {
        bad.push(`[H2] ${at}：誘答 ${x.ans} 屬於本卷正解集合`);
      }
      for (let b = a + 1; b < all.length; b++) {
        const y = all[b];
        if (!y?.id) continue;
        if (x.ans === y.ans) bad.push(`[H1] ${at}：答案鍵 ${x.ans} 重複`);
        else if (nameCollides(x.ans, y.ans)) bad.push(`[H3] ${at}：${x.ans} 與 ${y.ans} 名稱過近`);
        if (lvl === Level.L2 && l2Key(x) === l2Key(y)) bad.push(`[D12] ${at}：${x.ans} 與 ${y.ans} 的 L2key 碰撞`);
      }
    }
  });

  // H4 的弱形式（heuristic，不等於驗證了 H4）：整卷正解恆在同一格。
  // 忘記洗牌一定會產生這個樣態，而它在畫面上完全看不出來。
  // 門檻取 QUIZ_SIZE：滿卷時偽陽性機率 4^-19 ≈ 3.6e-12，可以當硬條件；
  // 題數更少時機率不夠低（10 題為 3.8e-6），寧可不判。
  if (questions.length >= QUIZ_SIZE) {
    const slots = new Set(questions.map((q) => q.answerIdx));
    if (slots.size === 1) bad.push(`[H4] 整卷正解恆在第 ${[...slots][0]} 格，疑似未洗牌`);
  }
  return bad;
}

/** 生成路徑的硬中止：不變量違規是 bug，重抽只會把它變成偶發 */
function assertQuizInvariants(quiz, level, index) {
  const bad = validateQuizInvariants(quiz, { level, index });
  if (!bad.length) return;
  const err = new Error(`整卷不變量驗證失敗：${bad.join('；')}`);
  err.code = 'INVARIANT_VIOLATED';
  err.violations = bad;
  throw err;
}

/**
 * 遞補一題（規格 6.5）。
 *
 * 遞補的正解必須避開**整卷已出現過的所有答案鍵**——正解、選項、備援都算。
 * 只避開正解集合時，遞補題的正解可以是早先某題的誘答，於是那一題的 H2
 * 被**回溯破壞**（同一個藥名既是甲題的誘答又是乙題的正解），正是 D19 要防的失效。
 *
 * 抽樣在**答案鍵層級均勻**（v2 D5）：按 pool 順序取第一個合格者是決定性的，
 * 會讓題庫前段的答案鍵在遞補時被系統性高估。
 *
 * 精確地說是「候選順序均勻隨機、取第一個能組出誘答者」——嚴格均勻要先算出
 * 「在目前 `excludeAns` 下可組題的鍵集合」，那等於把 1.6 秒的 eligibility 掃描
 * 搬進遞補路徑。實測代價為零：2026-08-03 於 3,913 筆題庫量測，遞補脈絡下的
 * 候選鍵 L1 3,044／L2 2,939 個，**組不出誘答者皆為 0**，兩者退化為同一件事。
 * 題庫改版後若該數字不再是 0，這裡才需要重新評估（見 `verdict-v3.5.md` 1.3）。
 *
 * @param {Set} [eligible] 該級可用答案鍵；省略表示全部可用（L3）
 * @returns {object|null} 無可用候選時回傳 null（呼叫端應中止本回合）
 */
export function drawSpareQuestion({ index, level, eligible, questions, token, rng = Math.random }) {
  const seen = seenAnsKeys(questions);
  const keys = index.keys.filter((ans) => !seen.has(ans) && (!eligible || eligible.has(ans)));
  shuffle(keys, rng);                                    // filter 已複製，未動索引（D20）

  for (const ans of keys) {
    const it = pick(index.byAns.get(ans), rng);          // 該鍵紀錄內也均勻
    if (level === Level.L3) return newQuestion(it, { token, level, chance: CHANCE.NONE });
    // H2 的 excludeAns 是「整卷正解集合」，含這題自己的正解
    const excludeAns = new Set(questions.map((q) => q.item.ans));
    excludeAns.add(ans);
    try {
      return newQuestion(it, {
        token,
        level,
        chance: CHANCE.FOUR,                             // 選擇題遞補仍是四選一
        ...buildChoices(it, index, { level, rng, excludeAns }),
      });
    } catch (e) {
      if (e.code !== 'NO_DISTRACTORS') throw e;          // 組不出就換下一個答案鍵
    }
  }
  return null;
}

// ── M5 錯題再戰（規格 D28）───────────────────────────────────────────

/**
 * 本回合的錯題答案鍵（規格 D28）。順序沿用原卷。
 *
 * **判準是正向白名單 `state === LOCKED`，不是 `state !== VOID`。**
 * 規格 D28 原文寫「`state !== QState.VOID` 且 `correct === false`」，
 * 那是錯的——`newQuestion()` 把 `correct` 預設為 `false`，而 `transition()`
 * 只在 submit／fail 時才寫它，於是**未作答（PENDING）與已提示未答（HINTED）
 * 的題目 `correct` 也都是 `false`**，會被一併收進錯題集合。
 *
 * 今天碰不到，只因為 `finish()` 僅在所有題目都終態時才走得到——
 * 那是脈絡的偶然，不是判準的正確性。呼叫端只要在中途叫它就會出錯，
 * 而畫面上看不出來（使用者會拿到一份混入未作答題的「錯題」卷）。
 * 規格已於 v4.6 同步修正。
 *
 * 作廢題不算錯題（沿用 D23 同一理由）；用提示答錯的題**算**錯題。
 * 由原卷的 H1 保證回傳值兩兩相異——這裡不另外去重，
 * 去重會把「原卷違反 H1」這個 bug 靜默吸收掉。
 */
export function wrongAnsKeys(questions) {
  return (questions ?? [])
    .filter((q) => q.state === QState.LOCKED && q.correct === false)
    .map((q) => q.item.ans);
}

/**
 * 錯題卷組裝（規格 D28 兩階段 + D28.1 原子發布點）。
 *
 * **與 `drawLeveledQuiz` 唯一的差別在階段 1**：整卷正解集合由 `ansKeys`
 * **固定**而非隨機抽出。階段 2、3 完全共用同一條路徑——
 * v3 花了兩輪覆審才把第一套組裝模型弄對，不再開第二套。
 *
 * 分級重建（依 F8：82.1% 的鍵只有 1 筆紀錄）：
 * 三級一律**同答案鍵、重抽紀錄**（`pick` 在該鍵的紀錄內均勻）——
 * 只有 1 筆時 `pick` 必然回傳那一筆，於是「沿用原圖」是自然結果而非特例分支。
 * 選擇題另由 `buildChoices` 重抽誘答並洗牌，正解格位置因此**可變**
 * （D28 已裁示這是可達性，不保證必異於原卷）。
 *
 * @param {string[]} ansKeys 錯題答案鍵，順序即出題順序
 * @throws {Error} code = 'EMPTY_RETRY' | 'KEY_NOT_ELIGIBLE' | 'NO_DISTRACTORS'
 *                      | 'QUIZ_ASSEMBLY_FAILED' | 'INVARIANT_VIOLATED'
 */
export function drawRetryQuiz(items, { level, ansKeys, rng = Math.random, index, eligible: pre } = {}) {
  const keys = ansKeys ?? [];
  if (!keys.length) {
    const err = new Error('錯題集合為空，不建立複習卷');
    err.code = 'EMPTY_RETRY';
    throw err;
  }
  const idx = index || buildIndex(items);
  const eligible = pre || eligibleKeys(idx, level);

  // 指定鍵不在該級的 eligible 內 → 立刻失敗。
  // 不「跳過該題繼續」：靜默剔除會讓使用者以為已複習完全部錯題（D28）
  const bad = keys.filter((k) => !eligible.has(k) || !idx.byAns.has(k));
  if (bad.length) {
    const err = new Error(`答案鍵不在 ${level} 的可用集合內：${bad.join('、')}`);
    err.code = 'KEY_NOT_ELIGIBLE';
    err.keys = bad;
    throw err;
  }

  // 【階段 1】整卷正解集合＝K，固定不抽。這是與 D19 唯一的差別
  const excludeAns = new Set(keys);
  const baseChance = level === Level.L3 ? CHANCE.NONE : CHANCE.FOUR;

  let last;
  for (let attempt = 0; attempt < MAX_QUIZ_ATTEMPTS; attempt++) {
    try {
      // 【階段 2】逐題組裝，excludeAns 恆為整卷正解集合（H2）
      const quiz = keys.map((ans, i) => {
        const it = pick(idx.byAns.get(ans), rng);      // 紀錄重抽；只有 1 筆時即沿用
        return newQuestion(it, {
          token: i + 1,
          level,
          chance: baseChance,
          ...(level === Level.L3 ? {} : buildChoices(it, idx, { level, rng, excludeAns })),
        });
      });
      // 【階段 3】整卷驗證，與正常卷同一個 validator
      assertQuizInvariants(quiz, level, idx);
      return quiz;
    } catch (e) {
      if (e.code !== 'NO_DISTRACTORS') throw e;        // 含 INVARIANT_VIOLATED：重抽只會掩蓋 bug
      last = e;
    }
  }
  const err = new Error(`複習卷組裝連續 ${MAX_QUIZ_ATTEMPTS} 次失敗：${last?.message ?? ''}`);
  err.code = 'QUIZ_ASSEMBLY_FAILED';
  throw err;
}

/**
 * D16：挑一個要排除的誘答格。
 *
 * **絕不回傳 `answerIdx`**，也不回傳已排除的格。
 * 回傳 -1 表示無可排除者（理論上不會發生，呼叫端仍須處理）。
 */
export function pickEliminated(q, rng = Math.random) {
  const cand = [];
  for (let i = 0; i < CHOICE_COUNT; i++) {
    if (i === q.answerIdx || q.eliminated === i) continue;
    cand.push(i);
  }
  if (!cand.length) return -1;
  return cand[Math.floor(rng() * cand.length)];
}

/**
 * D15：消耗一個備援替換指定格，回傳新的題目狀態。
 *
 * 因為 5 個誘答是**兩兩合法**產生的，替換後無須重新驗證任何條件——
 * 這正是那個設計要換來的東西。
 *
 * @returns {object|null} 無法替換時回傳 null（呼叫端應作廢該題）
 */
export function replaceOption(q, slotIdx) {
  if (!Array.isArray(q.spares) || q.spares.length === 0) return null;   // 備援耗盡
  if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= CHOICE_COUNT) return null;
  if (slotIdx === q.answerIdx) return null;      // 正解格不可替換，只能作廢
  if (q.eliminated === slotIdx) return null;     // 已排除的格不參與替換
  const options = q.options.slice();
  options[slotIdx] = q.spares[0];
  return { ...q, options, spares: q.spares.slice(1) };
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

/**
 * 中文品名的顯示用清理。
 *
 * **只壓空白，不改字。** 來源資料有全形空白當 padding
 * （實測 1 筆：`"國嘉"抗血膠囊250毫克` 後面接 16 個全形空白再接一個 `T`），
 * 直接塞進選項會把按鈕撐開一大片空白。
 *
 * 刻意不做「移除劑型詞」之類的改寫——畫面上出現的必須是完整的官方品名，
 * 殘缺品名在臨床情境會自成誤導來源。L1 選項因此可由劑型詞推得答案，
 * 那是已知且接受的取捨（見 app.js 的 LEVELS[L1]）。
 */
export function displayZh(zh) {
  return String(zh ?? '').replace(/[\s　]+/g, ' ').trim();
}

// ── 快速閃卡（不計分）─────────────────────────────────────────────────

export const DECK_SIZE = QUIZ_SIZE;

/**
 * 外觀重複組索引：外觀鍵 → 該外觀底下所有相異答案鍵。
 *
 * **刻意用 `l2Key` 而不是建置管線 Q5 的群組鍵。** 兩者的差別是
 * `score_mark` 與 `size`：Q5 把它們納入鍵，因此「只差刻痕或尺寸」的品項
 * 通得過 Q5 留在題庫裡；`l2Key` 把它們拿掉，因為那兩項在照片上是弱訊號
 * （D12）。閃卡呈現的就是照片，判斷「這張圖是否唯一對應一個藥名」
 * 必須用照片看得出來的特徵，否則會宣稱唯一卻其實不唯一。
 *
 * 2026-08-07 於 3,924 筆題庫實測：124 組外觀鍵對應到多個答案鍵，
 * 涵蓋 311 題（7.9%），組內最多 9 個相異藥名。
 * （2026-08-04 於 3,913 筆時為同一組數字——+11 筆新品項沒有落進任何多品名外觀組。
 * 這幾個數字會隨題庫更新而變，**但判準不會**：改 `l2Key` 才需要回來重寫這段。）
 */
export function buildLookAlikeIndex(items) {
  const byLook = new Map();
  for (const it of items) {
    const k = l2Key(it);
    if (!byLook.has(k)) byLook.set(k, new Set());
    byLook.get(k).add(it.ans);
  }
  const out = new Map();
  for (const [k, set] of byLook) out.set(k, [...set].sort());
  return out;
}

/**
 * 與該筆外觀相同、但品名不同的其他答案鍵。
 *
 * 回傳空陣列代表這張圖在照片可見的特徵上唯一對應一個藥名。
 * 閃卡背面據此決定要不要提醒「這個外觀不只一顆藥」——
 * 少列了等於讓使用者建立錯誤的唯一對應，那是本模式最主要的失效模式。
 */
export function lookAlikesOf(item, lookAlikeIndex) {
  const all = lookAlikeIndex.get(l2Key(item)) || [];
  return all.filter((ans) => ans !== item.ans);
}

/**
 * 一張閃卡。**沒有 state／mark／correct**——閃卡不計分，
 * 借用 `newQuestion` 的形狀會讓它意外流進 `scoreQuiz` 的分母。
 */
export function newCard(item, token) {
  return { item, token, flipped: false };
}

/** 翻面。已翻面即原樣回傳（重複點擊不產生新物件，與狀態機同一紀律）。 */
export function flipCard(card) {
  return card.flipped ? card : { ...card, flipped: true };
}

/**
 * 抽一疊閃卡。答案鍵不重複，沿用 `drawQuiz` 的「答案鍵均勻」抽樣（D5）。
 *
 * 不做難度篩選、不組誘答——閃卡是單向輸出，沒有誘答可言，
 * 因此也沒有 L1/L2 那套可解性條件要滿足。
 *
 * @throws {Error} code = 'INSUFFICIENT_KEYS' 當相異答案鍵不足 n 張
 */
export function drawDeck(items, { n = DECK_SIZE, rng = Math.random, startToken = 1 } = {}) {
  return drawQuiz(items, n, rng).map((item, i) => newCard(item, startToken + i));
}

/**
 * 遞補一張（圖片載入失敗時用）。
 *
 * `exclude` 由呼叫端維護，必須涵蓋**本疊生命週期內出現過的所有答案鍵**，
 * 包含已經被換掉的那幾張。**刻意不從 deck 現況推導**——遞補是覆蓋寫入，
 * 被換掉那張的答案鍵會從 deck 消失，據此推導只避得開「還在架上的」，
 * 下一次失敗就把它抽回來，使用者於是在同一疊裡看到同一顆藥兩次。
 * 圖源整批失敗時更會在少數候選間來回循環，`null` 的終止語意跟著失效。
 *
 * @param {Set<string>} exclude 不得抽中的答案鍵（呼叫端累積，只增不減）
 * @returns {object|null} 無可用候選時回傳 null（呼叫端應結束本疊）
 */
export function drawSpareCard({ index, exclude, token, rng = Math.random }) {
  const keys = index.keys.filter((ans) => !exclude.has(ans));
  if (!keys.length) return null;
  return newCard(pick(index.byAns.get(pick(keys, rng)), rng), token);
}

// ── 連對 streak（規格 v4 D23）─────────────────────────────────────────

/**
 * 哪些題參與 streak：**只有進入 LOCKED 的題**。
 *
 * VOID 跳過（不 +1、不歸零）的理由與 `scoreQuiz` 排除 VOID 相同——
 * 作廢是資源載入失敗，不是使用者的作答；若中斷 streak，等於讓網路狀況決定成績表現。
 * PENDING／HINTED 同樣跳過：那是「還沒作答」，不是「答錯」。
 * 走完的回合裡不存在非終態題，這條只在 live 顯示的中途狀態下會用到。
 */
const inStreak = (q) => !!q && q.state === QState.LOCKED;

/**
 * 全卷最長連對段。
 *
 * @returns {{length: number, hinted: number}}
 *   `hinted` 是**被選中那一段之內**用過提示的題數，不是全卷提示總數——
 *   結算頁寫的是「最長連對 N 題（含 M 題提示）」，M 若取全卷值就與 N 無關了。
 *   同長度的段落有多個時取**最早出現**的那一段（比較用嚴格大於）。
 *
 * 用了提示仍 +1：提示已在分數層扣過（1.0→0.5），在 streak 再罰一次是雙重懲罰，
 * 會誘導使用者不敢用提示而硬猜——那正是本專案最怕的失效模式。
 *
 * **不快取、不增量**。遞補（`voidCurrent` 的 push）會改變陣列組成，
 * 增量值屆時已經算錯而且無從察覺。
 */
export function longestStreak(questions) {
  let best = { length: 0, hinted: 0 };
  let length = 0;
  let hinted = 0;
  for (const q of questions || []) {
    if (!inStreak(q)) continue;
    if (!q.correct) { length = 0; hinted = 0; continue; }
    length++;
    if (q.mark === HINTED_MARK) hinted++;
    if (length > best.length) best = { length, hinted };
  }
  return best;
}

/**
 * `questions[0 .. upTo-1]`（**upTo 為 exclusive**）末端的連對長度，供答題頁 header 用。
 *
 * upTo 省略或非整數時視為整個陣列；超過長度會夾住；負值回 0。
 */
export function currentStreak(questions, upTo) {
  const qs = questions || [];
  const end = Number.isInteger(upTo) ? Math.min(upTo, qs.length) : qs.length;
  let n = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (!inStreak(qs[i])) continue;
    if (!qs[i].correct) break;
    n++;
  }
  return n;
}

// ── 結算稱號（規格 v4 D24）───────────────────────────────────────────

/** 分數帶下界，由高到低。與 `RANK_TITLES` 每列一一對應 */
export const RANK_BANDS = [95, 80, 50];

/**
 * 最低帶三級共用同一句。
 *
 * 這**不是**稱號而是下一步建議：最低帶不存在「刷簡單級拿高階稱號」的誘因，
 * 而三級都該給同一個建議。因此 D24 的「各級不相交」只約束 ≥50 的 9 格，
 * 這一列刻意相同並由 A28 正面斷言，避免日後被當成漏寫而各自改掉。
 */
const RANK_LOW = '先從閃卡開始';

/**
 * 稱號表。**這張表就是唯一真相**——不另建「等級序數」再去證明單調：
 * 序數可以任意指定，與使用者實際看到的字串沒有可證明的關聯，那會是第二份真相。
 * 跨級之間不宣稱任何排序（D26），因此稱號在畫面上永遠與級別徽章同框。
 *
 * 用字已於 **2026-08-06 人工法規覆核定案**，留檔見 `.ai-review/rank-title-review.md`。
 * 要改字必須走同一道覆核——這張表會直接出現在使用者眼前。
 */
export const RANK_TITLES = {
  [Level.L1]: ['入門攻克', '記得住外觀', '還在對圖', RANK_LOW],
  [Level.L2]: ['辨識高手', '看得出門道', '還在比對', RANK_LOW],
  [Level.L3]: ['火眼金睛', '一眼認藥', '還在背藥名', RANK_LOW],
};

/**
 * 查表取稱號。**純查表，不做任何計算。**
 *
 * @returns {string} 非法 level 或非有限分數一律回空字串（呼叫端據此隱藏元素）。
 *   分數超出 [0, 100] 不視為非法——照分數帶落點處理即可，
 *   多一條「範圍檢查」只是替 UI 製造第二種需要處理的失敗。
 */
export function rankTitle(level, score) {
  const row = RANK_TITLES[level];
  if (!row) return '';
  if (typeof score !== 'number' || !Number.isFinite(score)) return '';
  for (let i = 0; i < RANK_BANDS.length; i++) {
    if (score >= RANK_BANDS[i]) return row[i];
  }
  return row[RANK_BANDS.length];
}
