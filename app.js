/**
 * 藥品辨識王 — UI 與事件
 *
 * 所有判定、抽題、計分邏輯都在 engine.js（純函式、有測試）。
 * 這裡只負責 DOM、資源載入與失敗處理。
 *
 * 三個難度級別共用同一份 pool、同一個狀態機與同一個計分函式（規格 v3 D17）。
 * app.js 只依級別分派「怎麼畫」與「怎麼收作答」。
 */
import {
  normalize, squash, judge, makeHint, QUIZ_SIZE,
  QState, transition, scoreQuiz, HINTED_MARK,
  Level, CHOICE_COUNT, L2_LOAD_TIMEOUT_MS,
  buildIndex, eligibleKeys, drawLeveledQuiz, judgeChoice,
  pickEliminated, replaceOption, drawSpareQuestion, validateQuizInvariants,
  DECK_SIZE, buildLookAlikeIndex, lookAlikesOf, flipCard, drawDeck, drawSpareCard,
  displayZh, longestStreak, currentStreak, rankTitle,
  wrongAnsKeys, drawRetryQuiz,
} from './engine.js';
import {
  tokenize, normalizeLicense, encodeFormulary, decodeFormulary,
  classifyFormulary, buildExcludedIndex, Category, CATEGORY_LABEL,
  prepareFormulary, probeLevel, minUsableK,
} from './formulary.js';

const SCHEMA = 1;
/**
 * 最佳紀錄的 localStorage key。**前綴不可省**——
 * 本站與 pharmacy-portal 的 17 個工具同源，localStorage 是整站共用的。
 */
const RECORDS_KEY = 'tfda-drug-id-quiz:records';
const RECORDS_SCHEMA = 1;
const MAX_VOID = 3;          // 規格 6.5：遞補失敗次數上限
/**
 * 閃卡連續遞補上限。**與測驗的 MAX_VOID 意義不同**——測驗超過就中止回合，
 * 因為作廢會扭曲分母；閃卡不計分，沒有分母可扭曲，超過只代表「圖大概載不動」，
 * 因此是問使用者要不要繼續，而不是替他決定收工（F5）。
 */
const MAX_FLASH_FAIL = 3;
/** pool.json 內的 img 路徑是相對於 data/，不是相對於頁面 */
const DATA_DIR = 'data/';

/**
 * 級別設定。
 *
 * `pass`/`fair` 三級各自不同**不是配色偏好**——L1 的亂猜基線是 25 不是 0，
 * 沿用 L3 的 80/50 會把「幾乎全靠猜」標成「尚可」（規格 §6.3）。
 */
const LEVELS = {
  [Level.L1]: {
    name: '簡單', badge: '簡單級', desc: '看圖，從四個藥名選一個（附中文品名）',
    meta: '亂猜基線 25 ｜ 無提示 ｜ 中文品名可透露劑型', choice: true, hint: false,
    pass: 90, fair: 65,
  },
  [Level.L2]: {
    name: '中級', badge: '中級', desc: '給藥名，從四張圖選一張',
    meta: '亂猜基線 25 ｜ 可刪去一個錯項', choice: true, hint: true, grid: true,
    pass: 85, fair: 55,
  },
  [Level.L3]: {
    name: '困難', badge: '困難級', desc: '看圖，直接輸入英文品名',
    meta: '亂猜基線 0 ｜ 可用提示', choice: false, hint: true,
    pass: 80, fair: 50,
  },
};
const LEVEL_ORDER = [Level.L1, Level.L2, Level.L3];

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);

const state = {
  pool: null,
  noFuzzy: new Set(),
  /**
   * **目前出題的品項集合**。通用版＝全庫；院內版＝命中子集（D36）。
   *
   * 抽題、遞補、複習卷、閃卡一律讀這裡而不是 `state.pool.items`——
   * 少換任何一處，那條路徑就會抽到院內沒有的藥，而畫面上完全看不出來。
   */
  items: [],
  index: null,
  eligible: new Map(),       // level → Set<ans>，整回合重複使用
  level: null,               // 使用者在選擇器上的選取
  quizLevel: null,           // 本回合實際成卷的級別（成績卡以此為準）
  questions: [],
  idx: 0,
  voided: 0,
  nextToken: 1,              // 題目 token，遞補不重用（規格 D18）
  gridLoaded: new Set(),     // L2 已成功載入的格（ready-gate，規格 D21）
  timers: [],                // L2 各格的載入逾時，換題時必須全部清掉
  /**
   * 最近一次讀到的最佳紀錄。**只供渲染，寫入時一律重讀**——
   * 這份快照可能已被另一個分頁的回合超越（D25）。
   * `null` 代表 storage 不可用。
   */
  records: null,

  // ── M5 錯題再戰的 session ownership（規格 D31）────────────────────
  /** `'quiz' | 'retry'`。複習期間為 `'retry'` */
  mode: 'quiz',
  /**
   * 進入複習前的原卷快照。**只存原始欄位**（D31 單一真相來源）——
   * 分數、稱號、三級判定、最長連對、亂猜基線一律由這兩個欄位重算。
   * 多存一份可重算的衍生值，就多一個會與重算結果分歧的來源。
   *
   * 生命週期：發布點通過時建立 → 複習期間唯讀 → 返回或中止時**清為 null**。
   * **下一個正常回合開始時必須為 null**：不清的話，`renderResult()`
   * 讀到殘留快照就會把上一回合的分數印進成績卡，而 C29 只涵蓋得到複習期間。
   */
  origin: null,
  /** 建構中旗標。雙擊時第二次起為 no-op（D31 冪等） */
  retryBuilding: false,

  // 閃卡（獨立於測驗的狀態，不共用 questions／idx——共用會讓
  // 「閃完一疊再去測驗」把閃卡殘留的索引帶進成績頁）
  lookAlike: null,           // 外觀重複索引，第一次進閃卡才建
  deck: [],
  fIdx: 0,
  fFails: 0,                 // 本疊累計遞補次數，使用者按「繼續」後歸零
  fSeen: new Set(),          // 本疊出現過的答案鍵，含已被換掉的（只增不減）
  fReady: false,             // 目前這張的圖已確認載入（ready-gate，同 L2 的 D21）
  fTimer: null,              // 目前這張的載入逾時，換卡時必須清掉
  /**
   * 閃卡 token。**整個頁面生命週期單調遞增，開新疊不重設**——
   * 每疊都從 1 起算的話，上一疊的遲到事件會與新疊的卡撞號，
   * 而 token 正是用來分辨「這個事件屬於哪張卡」的唯一依據。
   *
   * **這條目前沒有行為測試守著**（變異驗證確認：改回每疊重設，測試仍全綠）。
   * 原因是 `fImg` 只有一個 node、handler 每次 render 被覆寫，
   * 帶著舊 token 的 handler 根本不存在，撞號因而觀察不到。
   * 它是為「每張卡建獨立 `<img>` node」那筆改動預留的前置條件——
   * 那筆改動涉及 L1/L3 共用的同一套寫法，屬獨立議題（見 verdict-flashcard.md CR-3）。
   */
  fNextToken: 1,

  // ── V5 院內清單（規格 D34.1／D38／D40–D47）─────────────────────────
  /**
   * `null` ＝ 通用版。院內版時為
   * `{ payload, N, unlistedCount, missing, items, index, levels }`。
   *
   * **`payload` 是唯一權威表示**（D45）：matched subset 由它導出，不另存。
   * 月更後品項消失時 `missing` 會長出來，但 **payload 絕不覆寫成殘餘集合**——
   * 覆寫會讓品項日後重新出現時也回不來（D41／C44）。
   */
  fx: null,
  /** D46：一次只有一個進行中的操作。較舊的非同步結果晚到時必須丟棄 */
  fxOp: 0,
  /** 產連結頁才會抓的 `excluded.json` 索引；`null` ＝ 尚未載入或不可用（D47） */
  excluded: null,
  excludedError: null,
  /** 產連結頁最近一次分析結果，供下載與產連結共用（不重算，避免兩份數字漂移） */
  fxDraft: null,
};

// ── 載入題庫（失敗路徑見規格 C4）──────────────────────────────────────

function fatal(msg) {
  $('fatalMsg').innerHTML = msg;
  show($('fatal'));
  show($('start'), false);
  show($('quiz'), false);
  show($('result'), false);
  show($('flash'), false);
  show($('flashDone'), false);
  show($('formulary'), false);
}

async function loadPool() {
  let res;
  try {
    res = await fetch(DATA_DIR + 'pool.json', { cache: 'no-cache' });
  } catch (e) {
    return fatal(`無法連線讀取題庫（<code>${e.message}</code>）。請確認網路後重新整理。`);
  }
  if (!res.ok) return fatal(`題庫載入失敗：HTTP <code>${res.status}</code>。`);

  let data;
  try {
    data = await res.json();
  } catch {
    return fatal('題庫檔案格式損毀，無法解析。請稍後再試或回報問題。');
  }

  if (data?.meta?.schema !== SCHEMA) {
    return fatal(`題庫格式版本不相容（檔案 <code>${data?.meta?.schema}</code>，程式需要 <code>${SCHEMA}</code>）。請重新整理以取得最新版本。`);
  }
  if (!Array.isArray(data.items) || data.items.length === 0) {
    return fatal('題庫是空的，無法出題。');
  }
  const keys = new Set(data.items.map((i) => i.ans));
  if (keys.size < QUIZ_SIZE) {
    return fatal(`題庫可用答案鍵僅 <code>${keys.size}</code> 個，不足 ${QUIZ_SIZE} 題，無法開始測驗。`);
  }

  state.pool = data;
  state.keyCount = 0;
  state.noFuzzy = new Set(data.meta.no_fuzzy || []);
  state.items = data.items;
  state.index = buildIndex(data.items);

  state.keyCount = keys.size;
  if (data.meta.source_version) $('srcVer').textContent = `，資料版本 ${data.meta.source_version}`;

  // 院內清單必須在畫級別選擇器**之前**決定，否則會先畫出一輪全部可選的按鈕，
  // 使用者可能在那個空檔按下一個其實不可用的級別（D46 的同型問題）
  bootFormulary();

  renderLevelPicker();
  renderRecords();
  show($('start'));
  $('qTotal').textContent = QUIZ_SIZE;
  $('introN').textContent = QUIZ_SIZE;
  $('fTotal').textContent = DECK_SIZE;
}

// ── 最佳紀錄（localStorage，規格 v4 D25）─────────────────────────────

const RE_REC_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_REC_POOL = /^[0-9a-f]{12}$/;
/** 題庫未提供 content_hash 時的佔位值，顯示為「—」。不是任何真實 hash 的前綴 */
const UNKNOWN_POOL = '000000000000';
const REC_LABEL = { bestScore: '最高分', bestStreak: '最長連對' };

/**
 * 取得 localStorage，**取不到一律回 `null` 而不拋**。
 *
 * E1（不存在／被停用）與 E2（存取拋例外）的差別只在原因，行為完全相同。
 * 連屬性存取本身都包在 try 內：第三方 cookie 被封鎖的 iframe 中，
 * 讀 `localStorage` 這個 property 就會丟 SecurityError，還沒呼叫到任何方法。
 * 也刻意不只捕捉具名例外類別——瀏覽器實作丟什麼不是我們能假設的。
 */
function storage() {
  try {
    const ls = globalThis.localStorage;
    if (!ls || typeof ls.getItem !== 'function') return null;
    return ls;
  } catch { return null; }
}

/** 本回合題庫的識別碼：`content_hash` 前 12 碼。只做診斷顯示，不參與比較（D25） */
function poolHash() {
  const h = String(state.pool?.meta?.content_hash || '')
    .replace(/^sha256:/, '').toLowerCase().slice(0, 12);
  return RE_REC_POOL.test(h) ? h : UNKNOWN_POOL;
}

/** 本機日期。**不可用 `toISOString()`**——那是 UTC，台灣凌晨的紀錄會被標成前一天 */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function validEntry(e, { max, int = false }) {
  if (!e || typeof e !== 'object') return null;
  const v = e.value;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (int && !Number.isInteger(v)) return null;
  if (v < 0 || v > max) return null;
  if (typeof e.date !== 'string' || !RE_REC_DATE.test(e.date)) return null;
  if (typeof e.pool !== 'string' || !RE_REC_POOL.test(e.pool)) return null;
  return { value: v, date: e.date, pool: e.pool };
}

/**
 * E6：單一難度的完整性判定。**兩項都合法才採信。**
 *
 * 第一個完成的回合必定同時寫入兩項（無紀錄時任何有限值都算破紀錄），
 * 因此「只有一項」本身就代表資料被動過；部分採信會讓半壞的紀錄留在畫面上。
 * `bestStreak` 的上界是 `QUIZ_SIZE`：凡走到 `finish()` 的回合分母恆為 20（F9）。
 */
function validRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const bestScore = validEntry(r.bestScore, { max: 100 });
  const bestStreak = validEntry(r.bestStreak, { max: QUIZ_SIZE, int: true });
  return bestScore && bestStreak ? { bestScore, bestStreak } : null;
}

/**
 * 讀取紀錄。**任何失效情境都不得執行 storage mutation**——
 * 讀到壞資料就順手清掉，等於把「未來版本寫的資料」在舊版本開啟時靜默刪除（E4／E5）。
 *
 * @returns {object|null} `null` = storage 不可用（E1／E2，整塊隱藏）；
 *   物件 = 可用，內含通過 predicate 的難度（可能是空物件）
 */
function readRecords() {
  const ls = storage();
  if (!ls) return null;
  let raw;
  try { raw = ls.getItem(RECORDS_KEY); } catch { return null; }
  if (raw == null) return {};
  let obj;
  try { obj = JSON.parse(raw); } catch { return {}; }                 // E4
  if (!obj || typeof obj !== 'object' || obj.schema !== RECORDS_SCHEMA) return {};  // E5：不遷移
  const out = {};
  for (const lv of LEVEL_ORDER) {
    const rec = validRecord(obj[lv]);
    if (rec) out[lv] = rec;                                           // E6：只丟該難度
  }
  return out;
}

/**
 * 寫入紀錄。**寫入前重讀最新值再逐項取 max。**
 *
 * 這**不消除競態**——localStorage 沒有跨分頁交易，單一 key 也給不了原子性。
 * 它只把後果從「另一個分頁剛創的紀錄被本頁的舊快照倒退覆蓋」降為
 * 「極短窗口內漏記一次」。刻意不引入 `storage` 事件／`BroadcastChannel`／鎖：
 * 那是為了一個沒有人會遇到的窗口新增一整類跨分頁狀態。
 *
 * 只有**嚴格大於**才更新。相等時連 `date` 都不動——相等就刷新日期，
 * 「最佳紀錄的日期」會變成「最近一次打平的日期」，不是使用者預期的語意。
 *
 * @returns {{records: object, fresh: string[]}|null}
 *   `null` = 無 storage 或寫入失敗（E3）。呼叫端據此**不顯示「新紀錄！」**——
 *   宣稱已保存而實際失敗，使用者要到下次開啟才會發現紀錄不見了。
 */
function writeRecords(level, score, streak) {
  const ls = storage();
  if (!ls) return null;
  // 讀不到就**不寫**（E2）。讀取失敗不代表沒有紀錄——照寫等於用一筆看不見的
  // 舊快照覆蓋掉一筆可能更好的紀錄，而使用者到下次開啟才會發現最佳成績退步了
  const cur = readRecords();
  if (!cur) return null;
  const prev = cur[level] || {};
  const stamp = { date: today(), pool: poolHash() };
  const fresh = [];
  const merged = { ...prev };
  if (!prev.bestScore || score > prev.bestScore.value) {
    merged.bestScore = { value: score, ...stamp };
    fresh.push('bestScore');
  }
  if (!prev.bestStreak || streak > prev.bestStreak.value) {
    merged.bestStreak = { value: streak, ...stamp };
    fresh.push('bestStreak');
  }
  if (!fresh.length) return { records: cur, fresh: [] };   // 沒破紀錄 → 零 storage mutation
  const next = { schema: RECORDS_SCHEMA };
  for (const lv of LEVEL_ORDER) if (cur[lv]) next[lv] = cur[lv];
  next[level] = merged;
  try { ls.setItem(RECORDS_KEY, JSON.stringify(next)); } catch { return null; }   // E3
  return { records: { ...cur, [level]: merged }, fresh };
}

/** E7：只移除**精確的**那一個 key。前綴掃描今日無害，新增 `:settings` 那天就會誤刪 */
function clearRecords() {
  const ls = storage();
  if (!ls) return false;
  try { ls.removeItem(RECORDS_KEY); } catch { return false; }
  return true;
}

const recLine = (k, v, e) => `
  <div class="rec-line"><span class="k">${k}</span><span class="v">${v}</span>
    <span class="d">${escapeHtml(e.date)}</span>
    <span class="p">題庫 ${e.pool === UNKNOWN_POOL ? '—' : escapeHtml(e.pool)}</span></div>`;

/**
 * 起始頁的紀錄區塊。
 *
 * 一筆紀錄都沒有時整塊隱藏：擺一排「—」只是噪音，
 * 而「清除紀錄」在沒有東西可清的時候本來就不該出現。
 */
function renderRecords() {
  const recs = readRecords();
  state.records = recs;
  const levels = recs ? LEVEL_ORDER.filter((lv) => recs[lv]) : [];
  show($('recordsBox'), levels.length > 0);
  // 收合容器與內容同進退。**`#recordsNote` 刻意留在容器外**——
  // 清除成功後 `recordsBox` 會消失，提示若跟著被收走，
  // 按下「確定清除」就變成畫面全部不見、沒有任何回應
  show($('discRecords'), levels.length > 0);
  $('recordsSummary').textContent = levels
    .map((lv) => `${LEVELS[lv].name} ${recs[lv].bestScore.value.toFixed(1)}`).join(' · ');
  show($('clearConfirm'), false);
  show($('recordsNote'), false);
  $('recordsBody').innerHTML = levels.map((lv) => {
    const r = recs[lv];
    return `<div class="rec">
      <div class="rec-lv"><span class="badge">${LEVELS[lv].badge}</span></div>
      ${recLine('最高分', r.bestScore.value.toFixed(1), r.bestScore)}
      ${recLine('最長連對', `${r.bestStreak.value} 題`, r.bestStreak)}
    </div>`;
  }).join('');
}

// ── V5 院內清單：載入與降級（規格 D34.1／D38／D41／D43–D47）──────────

/** D45 的 localStorage key。**前綴不可省**，理由同 `RECORDS_KEY` */
const FORMULARY_KEY = 'tfda-drug-id-quiz:formulary';
const FORMULARY_SCHEMA = 1;
/** D42：上限量的是**完整 URL**，不是 payload */
const MAX_URL_LEN = 1800;
const FX_PARAM = 'fx';
/** 畫面上最多列幾筆未命中；其餘走下載。一份 1500 列的清單全印會灌爆頁面 */
const FX_LIST_CAP = 50;

/**
 * D45：讀取已保存的院內清單。**任何一條不成立都視為未載入，且不得 mutation。**
 *
 * 不「順手修復」也不刪除：讀不到不代表沒有，壞 JSON 更可能是未來版本寫的
 * （沿用 `readRecords()` 的同一條紀律）。
 *
 * **回傳 tri-state 而不是 `null`**（依 codex-review CR-1）：
 * 「這裡沒有清單」與「這裡有東西但我讀不出來」對後續行為的意義完全不同——
 * 前者可以放心寫入，後者一寫就把讀不出來的那份**毀掉**，
 * 而讀不出來最可能的原因正是「未來版本寫的」。
 *
 * @returns {{status:'ok', payload:string}|{status:'absent'}|{status:'error'}}
 */
function readFormulary() {
  const s = storage();
  if (!s) return { status: 'error' };            // 連 storage 都拿不到：不知道有沒有
  let raw;
  try { raw = s.getItem(FORMULARY_KEY); } catch { return { status: 'error' }; }
  if (raw == null) return { status: 'absent' };
  let o;
  try { o = JSON.parse(raw); } catch { return { status: 'error' }; }
  if (!o || o.v !== FORMULARY_SCHEMA || typeof o.payload !== 'string') return { status: 'error' };
  try { decodeFormulary(o.payload); } catch { return { status: 'error' }; }
  return { status: 'ok', payload: o.payload };
}

/** 寫入失敗回 `false`（呼叫端據此中止發布，見 D44.1 第 2 段） */
function writeFormulary(payload) {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(FORMULARY_KEY, JSON.stringify({
      v: FORMULARY_SCHEMA,
      payload,
      savedAt: new Date().toISOString(),
      srcVersion: state.pool?.meta?.source_version ?? null,
    }));
    return true;
  } catch (e) {
    console.warn('[formulary] 寫入失敗', e);
    return false;
  }
}

/**
 * 讀網址上的 `fx`。**「有這個參數但值是空的」與「沒有這個參數」必須分得開**
 * （依 codex-review CR-4）：`?fx=` 是一條壞連結，§5.3 要求它走完整解碼並提示失敗，
 * 而不是靜默當成通用版。
 *
 * @returns {{present: boolean, value: string}}
 */
function fxFromUrl() {
  try {
    const p = new URL(window.location.href).searchParams;
    return { present: p.has(FX_PARAM), value: p.get(FX_PARAM) ?? '' };
  } catch { return { present: false, value: '' }; }
}

/**
 * D44.3：**只移除 `fx` 一個參數**，其餘 query 與 fragment 精確保留。
 *
 * 刻意做字串層的移除而不是 `searchParams.toString()` 回寫——後者會把其他參數
 * 重新編碼（`%20` → `+` 之類），那不叫「精確保留」。
 *
 * 這是**成功提交後的冪等 cleanup，不納入交易**（D44.1 第 3 段）：
 * 失敗時保留 `fx`，但**不得回滾已載入的清單**。重整會以同一 payload 再跑一次。
 */
function cleanupFxParam() {
  try {
    const u = new URL(window.location.href);
    const raw = u.search.slice(1);
    if (!raw) return true;
    const segs = raw.split('&');
    // **比對解碼後的名稱**（依 codex-review CR-3）：`searchParams.get()` 會把 `%66x`
    // 解成 `fx` 而讀得到它，raw 字串比對卻刪不掉——那會留下「已消費卻還在網址上」的狀態。
    // 同時**不過濾空 segment**：`?a=1&&b=2` 的那個空段也是「其餘 query」的一部分，
    // 順手正規化掉就不叫「精確保留」了。
    const kept = segs.filter((kv) => {
      let k = kv.split('=')[0];
      try { k = decodeURIComponent(k); } catch { /* 壞的百分號序列：照原樣比 */ }
      return k !== FX_PARAM;
    });
    if (kept.length === segs.length) return true;                    // 沒有 fx：冪等
    window.history.replaceState(null, '', u.pathname + (kept.length ? `?${kept.join('&')}` : '') + u.hash);
    return true;
  } catch (e) {
    console.warn('[formulary] URL cleanup 失敗，fx 保留（清單不回滾）', e);
    return false;
  }
}

/**
 * 子集化 ＋ 三級 probe。**產連結端與載入端走同一支**——
 * 兩邊各寫一次的話，教學藥師看到「L2 可用」而新人載入後 L2 是灰的，
 * 而兩邊的數字都「對」（各自算各自的）。
 */
function evaluateFormulary(payload, ids) {
  const prep = prepareFormulary(state.pool.items, ids);
  const levels = {};
  for (const lv of LEVEL_ORDER) {
    levels[lv] = probeLevel({ payload, level: lv, items: prep.items, index: prep.index });
  }
  return { prep, levels };
}

/**
 * D44.1 的三段語意。**驗證階段全部成功前不發布任何一項。**
 *
 * 回傳 `{ok:true}` 或 `{ok:false, code, msg}`；失敗時記憶體與兩個 localStorage key
 * **位元組完全不變**。這裡刻意不做「先發布再回滾」——那三個介面沒有共同 transaction，
 * 回滾本身也可能失敗（規格明列這是平台提供不了的保證）。
 */
function activateFormulary(payload, { persist }) {
  const op = ++state.fxOp;                                    // D46
  const superseded = () => op !== state.fxOp;

  // ── 1. 驗證階段（此段不得改動任何狀態）
  let decoded;
  try {
    decoded = decodeFormulary(payload);
  } catch (e) {
    return { ok: false, code: e.code || 'DECODE_FAILED',
      msg: '院內清單連結的內容損毀或格式不符，未載入。原本的設定沒有被更動。' };
  }
  const { prep, levels } = evaluateFormulary(payload, decoded.ids);
  if (!prep.N) {
    return { ok: false, code: 'NO_MATCH',
      msg: '這份清單裡沒有任何品項出現在目前的外觀資料集，無法用它出題。' };
  }
  if (superseded()) return { ok: false, code: 'SUPERSEDED', msg: '' };

  // ── 2. 提交階段：先寫 storage（拋錯視為失敗），再做單一不會拋錯的記憶體切換
  if (persist && !writeFormulary(payload)) {
    return { ok: false, code: 'STORAGE_FAILED',
      msg: '無法在這個瀏覽器保存院內清單（儲存空間不可用或已滿），未載入。' };
  }
  state.fx = {
    payload,
    N: prep.N,
    unlistedCount: decoded.unlistedCount,
    missing: prep.missing,
    items: prep.items,
    index: prep.index,
    levels,
  };
  state.items = prep.items;
  state.index = prep.index;
  state.eligible = new Map();       // 索引換了，舊的可用鍵快取全部作廢
  state.lookAlike = null;           // 閃卡的外觀索引同理（閃卡也只用院內品項）
  return { ok: true };
}

/**
 * 啟動時決定通用版／院內版。
 *
 * 順序是**先還原已保存的清單，再處理網址上的 `fx`**：這樣一條損毀的連結
 * 不會把已經在用的清單弄掉（C42 要的正是這個——錯誤後仍能從原清單組出一卷）。
 */
function bootFormulary() {
  const saved = readFormulary();
  if (saved.status === 'ok') activateFormulary(saved.payload, { persist: false });

  const fx = fxFromUrl();
  let bootError = '';
  if (fx.present) {
    /**
     * **讀失敗時不得寫入**（CLAUDE.md 的既有紀律，codex-review CR-1）。
     *
     * 讀不出來最可能的原因是「未來版本寫的」，覆寫等於把它靜默毀掉。
     * 此時仍讓這條連結在**本頁生效**（使用者的操作要有回應），但
     * **既不保存、也不清掉網址上的 `fx`**——cleanup 本來就只是「成功提交後」的動作
     * （D44.1 第 3 段），不保存卻把 fx 清掉，重整後連這一份也沒了。
     */
    const persist = saved.status !== 'error';
    const r = activateFormulary(fx.value, { persist });
    if (r.ok) {
      if (persist) cleanupFxParam();     // cleanup 失敗也不回滾（D44.1 第 3 段）
      else bootError = '本機已有一份無法讀取的院內清單，為避免覆寫它，這次只在本頁生效、'
        + '不會保存。請保留這條網址。';
    } else if (r.code !== 'SUPERSEDED') {
      bootError = r.msg;                 // 失敗時 fx 保留在網址上，使用者可以重整重試
    }
  }
  // 錯誤訊息交給 `renderFormularyState` 一起輸出——分兩處寫的話，
  // 後跑的那個會把先寫的訊息蓋掉，而畫面上看起來就是「靜默失敗」
  renderFormularyState(bootError);
}

/**
 * 退出院內版，切回全題庫。
 *
 * **規格沒有定義過這條路**（D40–D47 只講怎麼進來，沒講怎麼出去）——
 * 那是規格缺口，不是刻意設計：`fx` 一旦載入就寫進 localStorage，
 * 之後每次開站都會還原，使用者除了開 DevTools 刪 key 之外沒有出口。
 *
 * 移除只 `removeItem` **那一個精確 key**：不 `clear()`、不前綴掃描（既有紀律）。
 * **移除失敗時不得宣稱成功**——清單其實還在，下次開啟又會冒出來（沿用 `clearRecords()`）。
 *
 * @returns {boolean} 是否真的移除了
 */
function exitFormulary() {
  const ls = storage();
  if (!ls) return false;
  try { ls.removeItem(FORMULARY_KEY); } catch { return false; }

  state.fxOp++;                       // D46：讓任何進行中的載入作廢
  state.fx = null;
  state.items = state.pool.items;
  state.index = buildIndex(state.pool.items);
  state.eligible = new Map();         // 索引換回全庫，可用鍵快取全部作廢
  state.lookAlike = null;
  return true;
}

/** 三級全部禁用（D41：此時要提示重新產生連結） */
const fxAllDisabled = () => !!state.fx && LEVEL_ORDER.every((lv) => !state.fx.levels[lv].available);

/**
 * D34.1 的全額揭露句。**措辭必須與 D37.1 一致**——
 * 「不在外觀資料集中」的那些多半是針劑、外用、眼藥，不是使用者打錯字號。
 */
function fxUnlistedSentence() {
  const m = state.fx?.unlistedCount ?? 0;
  if (!m) return '';
  return `｜另有 ${m} 筆院內品項${CATEGORY_LABEL[Category.UNLISTED]}`;
}

/**
 * 起始頁的題庫規模說明。
 *
 * **院內版不得宣稱「題庫 3,941 題」**（C51 人工留檔 S-3）：那一卷只從命中的 N 個
 * 院內品項出，而這行字就印在「命中 N 品項」正下方——兩個矛盾的數字面對面。
 * 這與成績卡的 S-1 是同一個判準：使用者拿數字做判斷，數字就不能是別人的。
 * 全庫規模仍然顯示，但**明確標成「比對母體」**而不是出題母體。
 */
function renderPoolInfo() {
  const m = state.pool?.meta;
  if (!m) return;
  const src = ` ｜ <b>來源</b> ${m.source}`
    + (m.source_file ? ` ｜ <b>檔案</b> <span class="num">${m.source_file}</span>` : '');
  // 收合狀態下的一行答案：「我現在用哪個題庫」不該要展開才看得到。
  // 院內版**不在這裡重印 N**——正上方的 `#startFxNote` 已經印了，
  // 同一個數字出現兩次會讓人開始比對兩者是不是同一件事
  $('poolSummary').textContent = state.fx
    ? '院內清單' : `全題庫 ${m.count.toLocaleString()} 題`;
  $('poolInfo').innerHTML = state.fx
    ? `<b>出題範圍</b> 院內清單 <span class="num">${state.fx.N.toLocaleString()}</span> 品項`
      + `（自全題庫 <span class="num">${m.count.toLocaleString()}</span> 題中命中）${src}`
    : `<b>題庫</b> <span class="num">${m.count.toLocaleString()}</span> 題`
      + `（相異品名 <span class="num">${(state.keyCount ?? 0).toLocaleString()}</span>）${src}`;
}

/** 起始頁的院內版狀態。通用版時整塊隱藏（但啟動錯誤仍要說出來） */
function renderFormularyState(bootError = '') {
  const on = !!state.fx;
  renderPoolInfo();
  show($('startFxNote'), on);
  // 出口與狀態同進同出。**它在收合區內，因此必須自己切**——
  // 以前它是 `#startFxNote` 的子節點，藏 note 就順便藏了按鈕
  show($('fxExitRow'), on);
  if (!on) show($('fxExitConfirm'), false);       // 切回之後確認框不該留在畫面上

  const warn = bootError ? [bootError] : [];
  if (on) {
    $('sFxN').textContent = String(state.fx.N);
    $('sFxUnlisted').textContent = fxUnlistedSentence();
    // D41：品項消失是**降級不是阻斷**，而且要說出精確數字
    if (state.fx.missing.length) {
      warn.push(`清單中 ${state.fx.missing.length} 個品項已不在最新資料中，本次以 ${state.fx.N} 品項出題。`);
    }
    if (fxAllDisabled()) {
      warn.push('目前這份清單三個級別都組不出題卷，請教學藥師重新產生連結。');
    }
  }
  $('startFxWarn').textContent = warn.join(' ');
  show($('startFxWarn'), warn.length > 0);
}

const FX_COVERAGE = {
  quiz: { note: 'qFxNote', n: 'qFxN', k: 'qFxK', u: 'qFxUnlisted' },
  result: { note: 'resultFxNote', n: 'rFxN', k: 'rFxK', u: 'rFxUnlisted' },
};

/**
 * 答題頁／結算頁的涵蓋數字（C43）。
 *
 * **N 與 K 分別寫入，不得互相冒充**：N 是命中品項數（換級別不變），
 * K 是該級可出題的答案鍵數（換級別會變，L2 通常比 N 少三成）。
 */
function renderFxCoverage(where, level) {
  const el = FX_COVERAGE[where];
  const on = !!state.fx;
  show($(el.note), on);
  if (!on) return;
  $(el.n).textContent = String(state.fx.N);
  $(el.k).textContent = String(state.fx.levels[level]?.K ?? 0);
  $(el.u).textContent = fxUnlistedSentence();
}

// ── V5 產連結頁（教學藥師端，規格 §5.2／D42／D43／D47）────────────────

/** 類別在畫面與下載檔中的固定順序。命中類不進下載檔（那是「有出題」的那些） */
const FX_CATS = [
  { code: Category.NON_SOLID_ORAL, key: 'nonSolidOral' },
  { code: Category.LOW_QUALITY, key: 'lowQuality' },
  { code: Category.UNLISTED, key: 'unlisted' },
];

/**
 * D47：`excluded.json` 只在**打開產連結頁時**才抓。
 *
 * 它取不到、或與 `pool.json` 不成對時，**只有產連結功能停用**——
 * 通用版與院內版出題完全不受影響（硬性要求：新增的檔案不得拖垮既有功能）。
 */
async function loadExcluded() {
  if (state.excluded || state.excludedError) return;
  const op = ++state.fxOp;
  let data;
  try {
    const res = await fetch(DATA_DIR + 'excluded.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    // **失敗路徑也要過 current-op gate**（依 codex-review CR-2）：
    // 原本只有成功路徑檢查 op，於是「先開頁→返回→再開頁」時，
    // 第一次那個**晚到的失敗**會蓋掉第二次的成功結果，產連結被誤停用到重整為止。
    // D46 說的是「只有當前 operation 可以 commit」——失敗也是一種 commit。
    if (op !== state.fxOp) return;
    state.excludedError = `無法讀取排除清單（${e.message}），因此無法分類未命中的品項。`;
    return;
  }
  if (op !== state.fxOp) return;                     // D46：有更新的操作接手了
  try {
    state.excluded = buildExcludedIndex(state.pool, data);
  } catch (e) {
    // 兩檔不成對（例如只更新了其中一份）→ 一律不產連結，不做半套分類
    state.excludedError = `排除清單與題庫不成對或格式不符（${e.code ?? 'INVALID'}），`
      + '無法分類未命中的品項。請重新整理，若持續發生請回報。';
  }
}

function openFormularyPage() {
  show($('start'), false);
  show($('formulary'));
  show($('fxResult'), false);
  show($('fxError'), false);
  loadExcluded().then(() => {
    if (state.excludedError) {
      $('fxError').textContent = state.excludedError;
      show($('fxError'));
      $('btnFxAnalyze').disabled = true;
    }
  });
}

function closeFormularyPage() {
  show($('formulary'), false);
  show($('start'));
  window.scrollTo(0, 0);
}

/** 讀取分欄設定。未指定分隔符時走「每行一個」路徑（D35.1） */
function fxTokenizeOpts() {
  const delimiter = $('fxDelim').value || undefined;
  const opts = { hasHeader: !!$('fxHeader').checked };
  if (delimiter !== undefined) {
    opts.delimiter = delimiter;
    opts.column = Number($('fxColumn').value) || 0;
  }
  return opts;
}

const fxError = (msg) => {
  $('fxError').textContent = msg;
  show($('fxError'));
  show($('fxResult'), false);
  // **連結要明確收掉**，不能只靠隱藏外層容器（依 codex-review TG-8）：
  // 上一輪產出的連結留在畫面上，教學藥師會以為它還對應現在這份清單
  show($('fxLinkBox'), false);
  state.fxDraft = null;
};

/** 分析清單並（在條件全滿足時）產出連結。**每一種不產出的情形都要說明原因** */
function analyzeFormulary() {
  if (state.excludedError) return fxError(state.excludedError);
  if (!state.excluded) return fxError('排除清單尚未載入完成，請稍候再試。');

  let tokens;
  try {
    tokens = tokenize($('fxInput').value, fxTokenizeOpts());
  } catch (e) {
    return fxError(`無法解析貼上的內容：${e.message}`);
  }

  const poolIds = new Set(state.pool.items.map((it) => it.id));
  let cls;
  try {
    cls = classifyFormulary(tokens, { poolIds, excludedStages: state.excluded });
  } catch (e) {
    return fxError(`分類失敗：${e.message}`);
  }

  show($('fxError'), false);
  state.fxDraft = cls;
  renderFxBreakdown(cls);

  if (!cls.matched.length) {
    show($('fxLinkBox'), false);
    $('fxLevels').innerHTML = '';
    return fxErrorKeepResult('這份清單沒有任何品項出現在外觀資料集中，無法出題，因此不產生連結。');
  }

  // payload 帶「來源已知」的 id ＋ 第三類筆數（D34.1／D34.2a）
  let payload;
  try {
    payload = encodeFormulary(cls.payloadIds, cls.unlistedCount);
  } catch (e) {
    show($('fxLinkBox'), false);
    return fxErrorKeepResult(e.code === 'UNLISTED_OUT_OF_RANGE' || e.code === 'COUNT_OUT_OF_RANGE'
      ? '清單筆數超出連結格式上限，請縮減清單或分批。'
      : `無法編碼這份清單：${e.message}`);
  }

  const { levels } = evaluateFormulary(payload, cls.matched);
  renderFxLevels(levels);
  if (LEVEL_ORDER.every((lv) => !levels[lv].available)) {
    show($('fxLinkBox'), false);
    return fxErrorKeepResult('這份清單三個級別都組不出完整題卷，因此不產生連結。請增加品項後再試。');
  }

  const url = fxUrlFor(payload);
  if (url.length > MAX_URL_LEN) {
    show($('fxLinkBox'), false);
    // **三個數字不是同一個**（依 codex-review CR-5）：使用者貼的是 `distinct` 筆相異字號，
    // 真正撐大網址的是進 payload 的 `payloadIds`（命中 ∪ excluded 內的），
    // 而 `matched` 只是其中可出題的那些。教學藥師是靠這行決定要縮減多少——
    // 拿 matched 冒充清單總數，他會刪錯東西。
    return fxErrorKeepResult(`清單 ${cls.distinct} 筆相異字號，其中 ${cls.payloadIds.length} 筆進入連結，`
      + `產生的網址 ${url.length} 字元，超出可分享連結上限 ${MAX_URL_LEN} 字元。請縮減清單或分批。`);
  }
  $('fxLink').value = url;
  show($('fxLinkBox'));
  show($('fxCopied'), false);
}

/** 有分析結果、但不產連結的情形：數字照樣揭露，只是說明為什麼沒有連結 */
function fxErrorKeepResult(msg) {
  $('fxError').textContent = msg;
  show($('fxError'));
}

/** 分享連結的基底：目前頁面去掉 query 與 fragment，只掛 `fx` */
function fxUrlFor(payload) {
  const u = new URL(window.location.href);
  return `${u.origin}${u.pathname}?${FX_PARAM}=${payload}`;
}

function renderFxBreakdown(cls) {
  show($('fxResult'));
  $('fxSummary').innerHTML =
    `<b>命中</b> <span class="num">${cls.matched.length}</span> 品項`
    + ` ｜ <b>未命中</b> <span class="num">${cls.distinct - cls.matched.length}</span>`
    + ` ｜ <b>相異字號</b> <span class="num">${cls.distinct}</span>`
    + (cls.blank ? ` ｜ <b>空白列</b> <span class="num">${cls.blank}</span>（未計入任何類別）` : '');

  // 全額揭露：**直接給各項數字**，不只列原因名稱（D37 的 v5.4 教訓）
  $('fxBreakdown').innerHTML = [
    { label: CATEGORY_LABEL[Category.MATCHED], n: cls.matched.length },
    ...FX_CATS.map((c) => ({ label: CATEGORY_LABEL[c.code], n: cls[c.key].length })),
  ].map((r) => `<div class="fx-row"><span class="k">${escapeHtml(r.label)}</span>`
    + `<span class="v">${r.n}</span></div>`).join('');

  /**
   * 明細印的是**內部代碼**，畫面上必須有對照（C51 人工留檔 S-5）。
   * 原本只有下載檔的檔頭有對照表，畫面上的 `NON_SOLID_ORAL` 要使用者自己猜。
   * 措辭從 `CATEGORY_LABEL` 導出（取括號前的短名），不在這裡另寫一份。
   */
  $('fxListLegend').textContent = '代碼對照：'
    + FX_CATS.map((c) => `${c.code}＝${CATEGORY_LABEL[c.code].split('（')[0]}`).join(' ｜ ');
  show($('fxListLegend'));

  // 未命中明細**只經 textContent**（D43）：這裡的字串來自使用者貼上的原始輸入，
  // 未知前綴的 token 會原樣保留（C50 的惡意字串正是走這條路徑）
  const lines = [];
  for (const c of FX_CATS) for (const id of cls[c.key]) lines.push(`${c.code}\t${id}`);
  $('fxUnlistedList').textContent = lines.length
    ? lines.slice(0, FX_LIST_CAP).join('\n')
      + (lines.length > FX_LIST_CAP ? `\n…共 ${lines.length} 筆，完整清單請下載` : '')
    : '（沒有未命中的品項）';
  show($('fxUnlistedList'), true);
  $('btnFxDownload').disabled = lines.length === 0;
}

function renderFxLevels(levels) {
  $('fxLevels').innerHTML = LEVEL_ORDER.map((lv) => {
    const p = levels[lv];
    const detail = p.available
      ? `可出 <span class="v">${p.quizLen}</span> 題（可出題藥名 <span class="v">${p.K}</span> 個）`
      : `不可用：${escapeHtml(p.code === 'K_BELOW_MIN'
        ? `可出題藥名 ${p.K} 個，至少要 ${minUsableK(lv)} 個`
        : p.reason ?? '組不出完整題卷')}`;
    return `<div class="fx-lv${p.available ? '' : ' off'}"><b>${LEVELS[lv].badge}</b> ｜ ${detail}</div>`;
  }).join('');
}

/** D43：下載內容是純文字，經 Blob 而不經任何 DOM sink */
function downloadUnmatched() {
  const cls = state.fxDraft;
  if (!cls) return;
  const head = [
    '# 藥品辨識王 — 院內清單未命中明細',
    `# 產生時間 ${new Date().toISOString()}`,
    `# 題庫版本 ${state.pool?.meta?.source_version ?? '未知'}`,
    `# 命中（可出題）${cls.matched.length} 筆，未列於本檔`,
    '# 以下每行為「類別代碼<TAB>藥證字號」',
    ...FX_CATS.map((c) => `#   ${c.code} = ${CATEGORY_LABEL[c.code]}`),
  ];
  const body = [];
  for (const c of FX_CATS) for (const id of cls[c.key]) body.push(`${c.code}\t${id}`);
  const blob = new Blob([[...head, ...body].join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `院內清單-未命中-${(state.pool?.meta?.source_version ?? 'unknown')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── 難度選擇（規格 §6.1）─────────────────────────────────────────────

/**
 * 該級在目前模式下可否出題（D38）。
 *
 * 通用版恆可用（全庫的可用性由 C4 的載入檢查與 `startQuiz` 的失敗路徑處理）；
 * 院內版一律以 **probe 的實際組卷結果**為準，**不看 `eligibleKeys().size`**。
 */
const levelOff = (id) => (state.fx ? !state.fx.levels[id].available : false);

/** 禁用原因的使用者可讀說明。不含藥名（引擎的訊息帶藥名，不可直接顯示） */
function levelOffReason(id) {
  const p = state.fx?.levels[id];
  if (!p || p.available) return '';
  if (p.code === 'K_BELOW_MIN') {
    return `這份清單在此級只有 ${p.K} 個可出題藥名，至少要 ${minUsableK(id)} 個`;
  }
  return `這份清單在此級組不出完整題卷（${p.reason ?? '原因不明'}）`;
}

function renderLevelPicker() {
  $('levelPick').innerHTML = LEVEL_ORDER.map((id) => {
    const L = LEVELS[id];
    const off = levelOff(id);
    // 禁用時**不用 hidden**（C45／M5 的 M-6 判準）：藏起來會讓人以為工具壞了。
    // `disabled` 與 `aria-disabled` 都給——前者擋滑鼠、後者讓輔助技術讀得到狀態
    return `<button class="level" role="radio" aria-checked="false" data-level="${id}"${
      off ? ' disabled aria-disabled="true"' : ''}>
      <span class="lv-name">${L.name}</span>
      <span class="lv-desc">${L.desc}</span>
      <span class="lv-meta">${L.meta}</span>${
      state.fx ? `<span class="lv-meta">院內可出題 ${state.fx.levels[id].K} 個藥名</span>` : ''}${
      off ? `<span class="lv-off">暫不可用：${escapeHtml(levelOffReason(id))}</span>` : ''}
    </button>`;
  }).join('');
  $('levelPick').querySelectorAll('.level').forEach((el) => {
    el.addEventListener('click', () => selectLevel(el.dataset.level));
  });
  resetLevel();
}

/**
 * 每次回到開始畫面都重設為未選取（規格 §6.1）。
 * 沿用上一回合的級別會讓成績卡印出非預期的級別。
 */
function resetLevel() {
  state.level = null;
  $('levelPick').querySelectorAll('.level').forEach((el) => {
    el.setAttribute('aria-checked', 'false');
    // 禁用狀態**不因重設而解除**：它是清單撐不撐得起這一級的性質，
    // 與「這一回合選了誰」無關（C45）
    el.disabled = levelOff(el.dataset.level);
  });
  show($('levelWarn'), false);
  $('btnStart').disabled = true;
  $('btnStart').textContent = '請先選擇難度';
}

/**
 * C45：禁用的級別必須是**程式化 no-op**——
 * `disabled` 只擋得住滑鼠，鍵盤、輔助技術與程式呼叫都繞得過去。
 * 這裡是真正的守門：不改 level、不寫 storage、不啟動任何預載。
 */
function selectLevel(id) {
  if (!LEVELS[id]) return;
  if (levelOff(id)) {
    $('levelWarn').textContent = `${LEVELS[id].badge}目前不可用：${levelOffReason(id)}。`;
    show($('levelWarn'));
    return;
  }
  state.level = id;
  $('levelPick').querySelectorAll('.level').forEach((el) => {
    el.setAttribute('aria-checked', String(el.dataset.level === id));
  });
  show($('levelWarn'), false);
  $('btnStart').disabled = false;
  // 院內版可能是短卷（D39）：按鈕上寫 20 題卻只出 11 題，是宣稱與交付不符
  const n = state.fx ? state.fx.levels[id].quizLen : QUIZ_SIZE;
  $('btnStart').textContent = `開始 ${n} 題測驗（${LEVELS[id].name}）`;
}

/**
 * 不變量違規只給使用者看代碼，細節送主控台。
 *
 * 違規訊息含答案鍵——把它印在中止畫面等於揭露尚未作答題目的藥名。
 * 回合雖已終止不影響計分，但沒有理由送分（覆審 v3.5 1.4）。
 */
function violationCodes(violations = []) {
  console.error('[quiz] 題卷不變量違規：', violations);
  const codes = violations.map((v) => /^\[([A-Z]\d+)\]/.exec(v)?.[1]).filter(Boolean);
  return [...new Set(codes)].join('、') || '未知';
}

/** 該級可用答案鍵集合，整個 session 只算一次 */
function eligibleFor(level) {
  if (!state.eligible.has(level)) {
    state.eligible.set(level, eligibleKeys(state.index, level));
  }
  return state.eligible.get(level);
}

// ── 出題 ─────────────────────────────────────────────────────────────

function startQuiz() {
  // 未選級別時不得建立題卷——按鈕 disabled 只是外觀，這裡才是真正的守門
  if (!state.level) {
    $('levelWarn').textContent = '請先選擇一個難度再開始。';
    show($('levelWarn'));
    return;
  }
  const level = state.level;
  // D31 生命週期：新的一輪正常回合開始前，retry 的殘留一律清乾淨。
  //
  // **這一行目前沒有測試守著**（變異驗證確認：拿掉它，25 條全綠）。
  // 原因是現況到不了「origin 非 null 且走到 startQuiz」——`exitRetry()` 與
  // `backToStart()` 都已經清過，而複習結算頁不提供「再測一回」。
  // 留著是縱深防禦：D31 的生命週期表把「下一個正常回合開始時 origin 必為 null」
  // 列為硬性條件，靠三處各自清乾淨來成立，少任何一處都會讓
  // 「下一回合的成績卡印上一回合的分數」這條路徑重新打開。
  clearRetryState();

  // C45 的第二道：入口被程式化呼叫時也不得出題
  if (levelOff(level)) {
    $('levelWarn').textContent = `${LEVELS[level].badge}目前不可用：${levelOffReason(level)}。`;
    show($('levelWarn'));
    return;
  }

  /**
   * D38.3：**probe 成功時產生的那一卷就是這一卷**，按下開始不得重抽。
   *
   * 重抽會讓 D38 的判定作廢——「檢查時可用、按下去失敗」正是那條規定要防的。
   * 只用一次：用掉之後同一 session 的下一回合正常隨機抽（否則每回合都同一份題目）。
   */
  const probe = state.fx?.levels[level];
  if (probe?.quiz) {
    state.questions = probe.quiz;
    probe.quiz = null;
  } else {
    const n = state.fx ? probe.quizLen : QUIZ_SIZE;
    try {
      state.questions = drawLeveledQuiz(state.items, {
        level, n, rng: Math.random,
        index: state.index, eligible: eligibleFor(level),
      });
    } catch (e) {
      /**
       * **院內版的重抽失敗是可預期的隨機結果，不是致命錯誤。**
       *
       * 第一回合有 D38.3 的 probe 產物護著，第二回合起走的是 `Math.random`——
       * 而 `drawLeveledQuiz` 是有限重試（3 次）的隨機貪婪組卷。
       * 實測一份 30 品項的清單（probe 判定 L1 可用、K=29）：**200 次重抽失敗 105 次**。
       *
       * 走 `fatal()` 會把起始頁與答題頁全部藏起來，只剩「無法開始測驗」，
       * 使用者非重新整理不可——對一個「再按一次很可能就成功」的情況，那是災難性的處置。
       * 退回起始頁說明原因即可，`state.level` 還在，再按一次就重抽。
       */
      if (state.fx && (e.code === 'QUIZ_ASSEMBLY_FAILED' || e.code === 'INSUFFICIENT_KEYS')) {
        $('levelWarn').textContent = `這一級這次沒能組出題卷（院內清單品項偏少時會發生）。`
          + '請再按一次開始，或改選其他級別。';
        show($('levelWarn'));
        return;
      }
      if (e.code === 'INSUFFICIENT_KEYS') {
        return fatal(`${LEVELS[level].badge}可用答案鍵僅 ${e.available} 個，`
          + `不足 ${e.required ?? n} 個，無法出 ${n} 題。`);
      }
      if (e.code === 'INVARIANT_VIOLATED') {
        // 生成路徑違規是程式 bug，不是題庫問題——不要建議使用者改選難度
        return fatal('題卷未通過不變量驗證，已中止以免出到不可解或會洩題的題目。'
          + `<br>違規項目：${escapeHtml(violationCodes(e.violations))}`
          + '<br>詳細診斷已輸出至瀏覽器主控台，請連同該內容回報。');
      }
      if (e.code === 'QUIZ_ASSEMBLY_FAILED') {
        return fatal('無法組出符合條件的題卷（誘答條件過嚴或題庫多樣性不足），已中止。'
          + '<br>請改選其他難度，或回報此問題。');
      }
      return fatal(`出題失敗：${e.message}`);
    }
  }

  state.quizLevel = level;
  state.idx = 0;
  state.voided = 0;
  state.nextToken = state.questions.length + 1;
  renderFxCoverage('quiz', level);          // C43：答題頁的 N 與 K
  show($('start'), false);
  show($('result'), false);
  show($('quiz'));
  renderQuestion();
}

const featureCell = (name, val, interp) => `
  <div class="metric">
    <div class="name">${name}</div>
    <div class="val">${val || '—'}</div>
    ${interp ? `<div class="interp muted">${interp}</div>` : ''}
  </div>`;

const OPT_KEYS = ['A', 'B', 'C', 'D'];

/**
 * 答題頁 header 的連對顯示（規格 v4 D32）。
 *
 * 一律由 `currentStreak` 現算，不維護增量計數——遞補會改變陣列組成（D23 同一理由）。
 * `upTo` 是 exclusive：作答鎖定後要傳 `state.idx + 1` 才會把當題算進去。
 *
 * `pop` 只加一個 class，放大交給 CSS 的 transform transition。
 * 收尾靠下一題的 render 移除 class，**不用任何 timer**——
 * 用 `setTimeout` 收尾的動畫會多一條與資訊呈現無關的排程（D27 條 2 的精神）。
 */
function refreshStreak(upTo, pop = false) {
  // 〔D29〕複習模式不顯示 live streak。D32 把更新時點掛在 lockAndReveal()，
  // 而 retry 走的就是同一條——不在這裡擋，它會照跑。
  // 錯題卷是刻意挑的難題子集，連對數與正常卷不可比（同 D26 三級分數不可比的理由），
  // 顯示它等於給出一個會被當成能力訊號的數字
  if (state.mode === 'retry') {
    show($('qStreak'), false);
    $('qStreak').classList.remove('pop');
    return;
  }
  const n = currentStreak(state.questions, upTo);
  $('qStreakN').textContent = n;
  show($('qStreak'), n >= 1);            // 0 沒有「連對」可言，顯示「連對 0」只是噪音
  $('qStreak').classList.toggle('pop', !!pop && n >= 1);
}

function renderQuestion() {
  const q = state.questions[state.idx];
  const cfg = LEVELS[q.level ?? Level.L3];

  clearTimers();
  // 分母是本卷題數而非 QUIZ_SIZE：複習卷通常只有數題，寫死 20 會讓
  // 使用者看到「第 3 / 20 題」然後在第 3 題就結束（D33）
  const total = state.questions.length;
  $('qIdx').textContent = state.idx + 1;
  $('qTotal').textContent = total;
  $('qBar').style.width = `${(state.idx / total) * 100}%`;
  $('qScore').textContent = scoreQuiz(state.questions.slice(0, state.idx)).earned.toFixed(1);
  refreshStreak(state.idx);
  show($('qRetryTag'), state.mode === 'retry');

  show($('qHint'), false);
  show($('qVerdict'), false);
  show($('btnNext'), false);
  show($('choiceActions'), false);

  if (cfg.grid) renderGrid(q);
  else {
    renderPhoto(q);
    if (cfg.choice) renderChoices(q);
    else renderInput(cfg);
  }
}

/** L1／L3：單張大圖 + 外觀特徵格 */
function renderPhoto(q) {
  const it = q.item;
  show($('qPrompt'), false);
  show($('qGrid'), false);
  show($('qGridNote'), false);
  show($('qImgWrap'));
  show($('qFeatures'));

  // 圖片載入失敗 → 該題作廢並遞補（規格 6.5），絕不計為答錯。
  // onerror 必須綁定「哪一題、哪個 src」：換題後舊圖片的延遲錯誤會作廢無辜的新題（覆審 C5）。
  // 題號會因遞補而位移，因此比對的是不可變的 token（規格 D18）。
  const img = $('qImg');
  const myToken = q.token;
  const expected = DATA_DIR + it.img;
  img.onerror = () => {
    const cur = state.questions[state.idx];
    if (!cur || cur.token !== myToken || img.getAttribute('src') !== expected) return; // 過期事件
    voidCurrent('圖片載入失敗');
  };
  img.alt = `藥品外觀實拍圖：${it.shape.join('／')}、${it.color.join('／')}`;
  img.src = expected;

  $('qFeatures').innerHTML =
    featureCell('形狀', it.shape.join('／'))
    + featureCell('顏色', it.color.join('／'), it.color.length > 1 ? '多層／膠囊帽身' : '')
    + featureCell('刻痕', it.score_mark.join('／'))
    + featureCell('外觀尺寸', it.size ? `${it.size} mm` : '—')
    + featureCell('標記一', it.mark1)
    + (it.mark2 ? featureCell('標記二', it.mark2) : '');
}

/**
 * L1 選項：英文品名 + 完整官方中文品名。
 *
 * 中文品名幾乎都含劑型詞，而 L1 的誘答刻意選 shape／color 不相交的藥
 * （engine.js `candidateOk`），兩者一對，**實測 22.4% 的題目可只靠
 * 「膠囊／錠」命中正解**。這是使用者知情後接受的取捨：L1 是入門級，
 * 中文品名對臨床使用者有實際意義，而竄改官方品名的代價更高。
 * 難度標示已在 LEVELS[L1] 標明，不讓分數被誤讀。
 */
function renderChoices(q) {
  show($('inputMode'), false);
  show($('qOptions'));
  $('qOptions').innerHTML = q.options.map((o, k) =>
    `<button class="opt" data-k="${k}">
       <span class="key">${OPT_KEYS[k]}</span>
       <span class="txt">
         <span class="en">${escapeHtml(o.ans)}</span>
         <span class="zh">${escapeHtml(displayZh(o.zh))}</span>
       </span>
     </button>`).join('');
  $('qOptions').querySelectorAll('.opt').forEach((el) => {
    el.addEventListener('click', () => submitChoice(Number(el.dataset.k)));
  });
}

function renderInput(cfg) {
  show($('qOptions'), false);
  show($('inputMode'));
  const input = $('qInput');
  input.value = '';
  input.disabled = false;
  $('btnSubmit').disabled = false;
  show($('btnHint'), cfg.hint);
  $('btnHint').disabled = false;
  input.focus();
}

// ── L2：四張圖擇一 ───────────────────────────────────────────────────

const gridCells = () => $('qGrid').querySelectorAll('.cell');
const clearTimers = () => { state.timers.forEach(clearTimeout); state.timers = []; };

/**
 * L2 題目版面。**不顯示任何外觀特徵**——形狀／顏色／刻痕／標記
 * 只要出現任何一項（含 alt 與 aria），使用者不看圖就能對答案，該級歸零（規格 §6.2）。
 */
function renderGrid(q) {
  show($('qImgWrap'), false);
  show($('qFeatures'), false);
  show($('qOptions'), false);
  show($('inputMode'), false);
  show($('qPrompt'));
  show($('qGrid'));
  show($('qGridNote'));
  show($('choiceActions'));

  $('qPrompt').innerHTML =
    `<div class="name">${escapeHtml(q.item.full)}</div>`
    + (q.item.zh ? `<div class="zh">${escapeHtml(q.item.zh)}</div>` : '')
    + '<div class="ask">這個藥是哪一張？</div>';

  // alt 只能是中性描述——現行 L1/L3 的 alt 寫著「圓形／白」，
  // 直接沿用會把答案寫進可及性樹裡送分
  $('qGrid').innerHTML = q.options.map((_, k) =>
    `<button class="cell" data-k="${k}" disabled>
       <span class="key">${OPT_KEYS[k]}</span>
       <img alt="選項 ${OPT_KEYS[k]} 藥品外觀">
     </button>`).join('');
  gridCells().forEach((el) => {
    el.addEventListener('click', () => submitChoice(Number(el.dataset.k)));
  });

  state.gridLoaded = new Set();
  for (let k = 0; k < CHOICE_COUNT; k++) loadCell(k);
  updateGate();
}

/**
 * 載入單一格。
 *
 * 生效條件是三段身分全等：**題目 token、格位 k、該格目前的資產 id**（規格 I5）。
 * 只比對題號會被遞補的位移騙過；只比對格位會被「同格換過備援」的舊請求騙過——
 * 那是真實瀏覽器最常見的路徑（同一個 <img> 改 src 後舊請求才回報）。
 */
function loadCell(k) {
  const q = state.questions[state.idx];
  const cell = gridCells()[k];
  if (!cell) return;
  const img = cell.querySelector('img');
  const item = q.options[k];
  const token = q.token;
  const assetId = item.id;
  const src = DATA_DIR + item.img;

  let settled = false;
  const stale = () => {
    const cur = state.questions[state.idx];
    return !cur || cur.token !== token || cur.options[k]?.id !== assetId
      || img.getAttribute('src') !== src;
  };
  const settle = (ok) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (stale()) return;                       // 遲到事件，一律忽略
    if (ok) {
      state.gridLoaded.add(k);
      updateGate();
    } else {
      failCell(token, k, assetId);
    }
  };

  // 沒有逾時，一張永久 pending 的圖會鎖死整題（ready-gate 的直接後果，規格 D21）
  const timer = setTimeout(() => settle(false), L2_LOAD_TIMEOUT_MS);
  state.timers.push(timer);

  img.onload = () => settle((img.naturalWidth ?? 1) > 0);   // 零尺寸視同失敗
  img.onerror = () => settle(false);
  img.setAttribute('src', src);
  img.src = src;
}

/** 資源失敗：正解格作廢，誘答格換備援（規格 D15） */
function failCell(token, k, assetId) {
  const q = state.questions[state.idx];
  if (!q || q.token !== token || q.options[k]?.id !== assetId) return;
  // 題目已鎖定後的資源事件一律忽略，不得回溯改變結果（規格 D21）
  if (q.state === QState.LOCKED || q.state === QState.VOID) return;
  if (k === q.answerIdx) return voidCurrent('正解圖片載入失敗');

  const replaced = replaceOption(q, k);
  if (!replaced) return voidCurrent('誘答圖片載入失敗且備援已耗盡');

  state.questions[state.idx] = replaced;
  state.gridLoaded.delete(k);
  updateGate();
  loadCell(k);                                  // 只重載該格，格位不變
}

/** ready-gate：四格全部載入完成前不得作答、不得取提示（規格 D21） */
function updateGate() {
  const q = state.questions[state.idx];
  if (!q || !LEVELS[q.level]?.grid) return;
  const ready = state.gridLoaded.size === CHOICE_COUNT;
  const open = ready && (q.state === QState.PENDING || q.state === QState.HINTED);

  gridCells().forEach((el, k) => {
    el.disabled = !open || q.eliminated === k;
  });
  $('btnHintChoice').disabled = !ready || q.state !== QState.PENDING;
  $('qGridNote').textContent = ready
    ? '看不清楚刻字時可用兩指縮放。'
    : `圖片載入中…（${state.gridLoaded.size}/${CHOICE_COUNT}）`;
}

/** L2 提示：刪去一個誘答（規格 D16） */
function hintChoice() {
  const q = state.questions[state.idx];
  if (q.state !== QState.PENDING) return;                 // 已提示或已鎖定即忽略
  if (state.gridLoaded.size !== CHOICE_COUNT) return;     // 未 ready 不可取提示

  const elim = pickEliminated(q, Math.random);
  if (elim < 0) return;
  state.questions[state.idx] = { ...transition(q, { type: 'hint' }), eliminated: elim };

  const cells = gridCells();
  cells[elim].classList.add('gone');
  $('qHint').innerHTML =
    `已刪去選項 ${OPT_KEYS[elim]}`
    + '<div class="meta">本題滿分降為 0.5，亂猜基線同步降為 16.7</div>';
  show($('qHint'));
  updateGate();
}

/** 資源失敗：作廢並自題庫遞補一題（不計分、不計入分母） */
function voidCurrent(reason) {
  // ── 複習模式：整次複習終止，回到原成績（D28）──
  // **嚴禁**走下面的遞補路徑：drawSpareQuestion 抽的是「未使用且 eligible」的
  // **任意**鍵（F15），複習卷用它必然混入原本沒答錯的藥，而畫面上完全看不出來。
  // 使用者會以為自己複習完了全部錯題。這是 M5 專屬的第一順位風險。
  if (state.mode === 'retry') {
    const origin = state.origin;
    // 先清乾淨再走失敗路徑（覆審 M-9）。直接 fatal 會讓狀態停在
    // `mode='retry'` 而 `origin=null`——那是**永久卡住**的組合：
    // 之後每一次 voidCurrent 都會再 fatal 一次，且 startRetry 的冪等守衛
    // 看到 mode='retry' 就永遠 no-op，使用者只能重整頁面
    if (!origin) {
      clearRetryState();
      return fatal('複習狀態已遺失，無法回到原成績。');
    }
    state.questions = origin.questions;
    state.quizLevel = origin.quizLevel;
    state.idx = state.questions.length;
    clearRetryState();
    renderResult({ record: false });
    retryFailed(`複習途中圖片載入失敗（${reason}）`);
    return;
  }

  const q = state.questions[state.idx];
  const next = transition(q, { type: 'fail' });

  // 必須確認真的進入 VOID 才能往下走（覆審 C5）。
  // LOCKED 是終態，transition 會原樣回傳——若此時仍 voided++ 並遞補一題，
  // 原題會照常計分、考卷卻多一題，分母變成 21。
  if (next.state !== QState.VOID) return;

  clearTimers();
  state.questions[state.idx] = next;
  state.voided++;
  refreshStreak(state.idx + 1);            // 作廢跳過，因此顯示值必然與作廢前相同

  if (state.voided > MAX_VOID) {
    return fatal(`已有 ${state.voided} 題因資源載入失敗而作廢，中止本回合以免影響成績判讀。<br>原因：${reason}`);
  }
  const level = q.level ?? Level.L3;
  const spare = drawSpareQuestion({
    index: state.index,
    level,
    eligible: LEVELS[level].choice ? eligibleFor(level) : null,
    questions: state.questions,
    token: state.nextToken++,
    rng: Math.random,
  });
  if (!spare) {
    return fatal('題庫已無可遞補的題目，中止本回合。');
  }

  // 遞補是唯一在執行期改變整卷組成的路徑，因此也是唯一需要事後複驗的地方（D19）。
  state.questions.push(spare);
  const bad = validateQuizInvariants(state.questions, {
    level: state.quizLevel, index: state.index,
  });
  if (bad.length) {
    state.questions.pop();
    return fatal('遞補題破壞了題卷不變量，中止本回合以免影響成績判讀。'
      + `<br>違規項目：${escapeHtml(violationCodes(bad))}`
      + '<br>詳細診斷已輸出至瀏覽器主控台，請連同該內容回報。');
  }
  state.idx++;
  if (state.idx < state.questions.length) renderQuestion();
  else finish();
}

// ── 作答 ─────────────────────────────────────────────────────────────

/** 送出後統一的鎖定處理：停用輸入、顯示判定、切到下一題按鈕 */
function lockAndReveal(locked, correct, extraNote = '') {
  const q = locked;
  const v = $('qVerdict');
  v.className = `verdict ${correct ? 'ok' : 'no'}`;
  v.innerHTML = `
    <div><span class="tag">${correct ? '✓ 答對' : '✗ 答錯'}</span>
      ${extraNote}
      　得分 <b>${(correct ? q.mark : 0).toFixed(1)}</b>
      ${q.mark === HINTED_MARK ? `（用過提示，本題滿分 ${HINTED_MARK.toFixed(1)}）` : ''}</div>
    <div class="official">${escapeHtml(q.item.full)}</div>
    <div class="sub">${escapeHtml(q.item.zh || '')}
      <span class="lic">${escapeHtml(q.item.id)}</span></div>`;
  show(v);

  // 連對在同一 tick 更新。VOID 的「顯示值不變」由 currentStreak 的跳過語意自動成立
  refreshStreak(state.idx + 1, correct);

  show($('btnNext'));
  // 明確寫上 disabled=false：D27 條 2 要求揭曉後**同一 tick 即可操作**，
  // 「看得到但按不下去」與延後呈現是同一種失效
  $('btnNext').disabled = false;
  $('btnNext').textContent = state.idx + 1 >= state.questions.length ? '看成績' : '下一題';
  $('btnNext').focus();
}

/** L1/L2：點選作答 */
function submitChoice(k) {
  const q = state.questions[state.idx];
  if (q.state === QState.LOCKED || q.state === QState.VOID) return;
  if (q.eliminated === k) return;                       // 已排除的格不接受作答
  const grid = !!LEVELS[q.level]?.grid;
  if (grid && state.gridLoaded.size !== CHOICE_COUNT) return;   // 未 ready 不接受作答

  const correct = judgeChoice(k, q.answerIdx);
  // picked 是作答狀態而非狀態機事件，在 transition 之外組合進去（規格 §5.2）
  state.questions[state.idx] = { ...transition(q, { type: 'submit', correct }), picked: k };
  const locked = state.questions[state.idx];

  const cells = grid ? gridCells() : $('qOptions').querySelectorAll('.opt');
  cells.forEach((el, i) => {
    const kk = Number(el.dataset.k ?? i);
    el.disabled = true;
    if (kk === q.answerIdx) el.classList.add('ok');
    else if (kk === k) el.classList.add('no');
    else if (!grid) el.classList.add('dim');
    // L2 鎖定後把品名補到每一格——「名字 ↔ 長相」的補完正是該級的學習點
    if (grid) {
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = q.options[kk].ans;
      el.appendChild(nm);
    }
  });
  $('btnHintChoice').disabled = true;

  lockAndReveal(locked, correct);
}

/** L3：輸入作答 */
function submit() {
  const q = state.questions[state.idx];
  if (q.state === QState.LOCKED || q.state === QState.VOID) return;

  const raw = $('qInput').value;
  const r = judge(raw, q.item.ans, { noFuzzy: state.noFuzzy.has(squash(q.item.ans)) });
  if (r.reason === 'empty') {
    $('qInput').focus();
    return;                       // 空輸入不改變狀態，不算答錯（規格 6.1）
  }

  state.questions[state.idx] = transition(q, { type: 'submit', correct: r.correct });
  const locked = state.questions[state.idx];

  $('qInput').disabled = true;
  $('btnSubmit').disabled = true;
  $('btnHint').disabled = true;

  lockAndReveal(locked, r.correct, r.reason === 'fuzzy' ? '（拼字容錯）' : '');
}

function hint() {
  const q = state.questions[state.idx];
  if (q.state !== QState.PENDING) return;
  state.questions[state.idx] = transition(q, { type: 'hint' });

  const h = makeHint(q.item.ans);
  $('qHint').innerHTML =
    `${h.masked}<div class="meta">共 ${h.chars} 字元${h.words > 1 ? `，${h.words} 個字` : ''}　·　本題滿分已降為 0.5</div>`;
  show($('qHint'));
  $('btnHint').disabled = true;
  $('qInput').focus();
}

function next() {
  clearTimers();
  state.idx++;
  if (state.idx >= state.questions.length) finish();
  else renderQuestion();
}

// ── 快速閃卡（不計分，F1–F6）─────────────────────────────────────────

/** 外觀重複索引建一次就好（3,913 筆掃描，別每疊重算） */
function lookAlikeIndex() {
  if (!state.lookAlike) state.lookAlike = buildLookAlikeIndex(state.items);
  return state.lookAlike;
}

function startFlash() {
  try {
    state.deck = drawDeck(state.items, {
      n: DECK_SIZE, rng: Math.random, startToken: state.fNextToken,
    });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_KEYS') {
      return fatal(`題庫相異品名僅 ${e.available} 個，不足 ${DECK_SIZE} 張，無法組成一疊閃卡。`);
    }
    return fatal(`閃卡抽取失敗：${e.message}`);
  }
  state.fIdx = 0;
  state.fFails = 0;
  state.fNextToken += state.deck.length;
  state.fSeen = new Set(state.deck.map((c) => c.item.ans));

  show($('start'), false);
  show($('result'), false);
  show($('quiz'), false);
  show($('flashDone'), false);
  show($('flash'));
  renderCard();
}

const clearFlashTimer = () => { clearTimeout(state.fTimer); state.fTimer = null; };

/** 背面（含 DOM 內容）歸零。翻面前、換卡時、進警示前都必須走這裡 */
function clearBack() {
  $('fBack').innerHTML = '';
  show($('fBack'), false);
}

function renderCard() {
  const card = state.deck[state.fIdx];
  const it = card.item;

  clearFlashTimer();
  $('fIdx').textContent = state.fIdx + 1;
  $('fBar').style.width = `${(state.fIdx / DECK_SIZE) * 100}%`;

  // 背面在翻面前必須是真的空的。留著上一張的內容再用 hidden 蓋住，
  // 等於把答案放在 DOM 裡讓讀屏與檢視原始碼看得到（F3）
  clearBack();
  show($('btnFlip'));
  show($('btnFlashNext'), false);
  show($('fWarnBox'), false);

  // ready-gate：圖片確認載入成功前不得翻面（沿用 L2 的 D21）。
  // 沒有這道閘，使用者會在空白或上一張的 bitmap 上翻出新卡的藥名——
  // 「圖片與藥名錯位」正是本工具最怕的失效模式。
  $('btnFlip').disabled = true;
  state.fReady = false;

  // 生效條件與測驗同一套：token + src 兩段身分比對，擋掉舊圖的遲到事件
  // （規格 D18／覆審 C5）
  const img = $('fImg');
  const myToken = card.token;
  const expected = DATA_DIR + it.img;

  let settled = false;
  const stale = () => {
    const cur = state.deck[state.fIdx];
    return !cur || cur.token !== myToken || img.getAttribute('src') !== expected;
  };
  const settle = (ok, reason) => {
    if (settled) return;
    settled = true;
    clearFlashTimer();
    if (stale()) return;                      // 遲到事件，一律忽略
    if (ok) {
      state.fReady = true;
      $('btnFlip').disabled = false;
      $('btnFlip').focus();
    } else {
      replaceCard(reason);
    }
  };

  // ready-gate 的直接後果：一張永久 pending 的圖會讓翻面永遠停用，
  // 使用者卡死在這一張。逾時門檻沿用 L2 的同一個值（D21）
  state.fTimer = setTimeout(() => settle(false, '圖片載入逾時'), L2_LOAD_TIMEOUT_MS);
  img.onload = () => settle((img.naturalWidth ?? 1) > 0, '圖片尺寸為零');
  img.onerror = () => settle(false, '圖片載入失敗');
  img.alt = `藥品外觀實拍圖：${it.shape.join('／')}、${it.color.join('／')}`;
  img.setAttribute('src', expected);
  img.src = expected;

  $('fFeatures').innerHTML =
    featureCell('形狀', it.shape.join('／'))
    + featureCell('顏色', it.color.join('／'), it.color.length > 1 ? '多層／膠囊帽身' : '')
    + featureCell('刻痕', it.score_mark.join('／'))
    + featureCell('外觀尺寸', it.size ? `${it.size} mm` : '—')
    + featureCell('標記一', it.mark1)
    + (it.mark2 ? featureCell('標記二', it.mark2) : '');
}

/**
 * 翻面。狀態走 `flipCard` 而不是只改 DOM——重複點擊必須是同一張卡，
 * 否則「已翻面」這件事只存在畫面上，遞補路徑無從得知。
 */
function flip() {
  const card = state.deck[state.fIdx];
  if (!card || card.flipped) return;
  // 按鈕的 disabled 只是外觀，這裡才是 ready-gate 真正的守門（同 startQuiz 的紀律）
  if (!state.fReady) return;
  state.deck[state.fIdx] = flipCard(card);

  const it = card.item;
  const alts = lookAlikesOf(it, lookAlikeIndex());

  // 相似品項清單是本模式最重要的一段。少列了，使用者會建立
  // 「這個外觀＝這顆藥」的錯誤唯一對應，那正是閃卡最主要的失效模式（F3）
  const altBlock = alts.length ? `
    <div class="look-alike">
      <div class="lead">⚠ 這個外觀不只一種藥（另有 ${alts.length} 種品名）</div>
      <ul>${alts.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>
      <div class="note">以照片可見的特徵（形狀／顏色／標記）判斷時，這些品項無法區分。
        實務辨識請以包裝標籤與院內品項資料為準。</div>
    </div>` : '';

  $('fBack').innerHTML = `
    <div class="ans">${escapeHtml(it.ans)}</div>
    <div class="full">${escapeHtml(it.full)}</div>
    ${it.zh ? `<div class="zh">${escapeHtml(it.zh)}</div>` : ''}
    <div class="lic">${escapeHtml(it.id)}</div>
    ${altBlock}`;
  show($('fBack'));

  show($('btnFlip'), false);
  const last = state.fIdx + 1 >= state.deck.length;
  $('btnFlashNext').textContent = last ? '看完了' : '下一張';
  show($('btnFlashNext'));
  $('btnFlashNext').focus();
}

function nextCard() {
  state.fIdx++;
  if (state.fIdx >= state.deck.length) finishFlash();
  else renderCard();
}

/**
 * 圖片載不出來就換一張，不留空卡（F4）。
 *
 * 本疊**累計**失敗達 `MAX_FLASH_FAIL` 就停下來問使用者——刻意不採「連續失敗」，
 * 零星散落的失敗同樣代表圖源有問題，只是不會連號出現。沒有這道閘，
 * 離線或圖床掛掉時會把整疊安靜換完，使用者只看到卡片一直跳。
 */
function replaceCard(reason) {
  clearFlashTimer();
  const token = state.fNextToken++;
  // 排除集合是本疊的歷史，不是 deck 現況——理由見 engine.js 的 drawSpareCard
  const spare = drawSpareCard({ index: state.index, exclude: state.fSeen, token, rng: Math.random });
  if (!spare) {
    // 目前這張換不掉、也顯示不出來，因此不算看過
    return finishFlash('題庫已無可替換的品項，本疊提前結束。', state.fIdx);
  }
  state.fSeen.add(spare.item.ans);
  state.deck[state.fIdx] = spare;
  state.fFails++;

  if (state.fFails >= MAX_FLASH_FAIL) {
    state.fReady = false;
    $('fImg').removeAttribute('src');          // 停在警示畫面時不要繼續打圖床
    // 使用者可能已經翻開上一張。警示不經過 renderCard，這裡不清就會留著
    // 上一張的藥名，而 state 已經指向遞補卡——DOM 與狀態不同步（CR-4）
    clearBack();
    $('fWarnMsg').textContent =
      `已有 ${state.fFails} 張圖片載入失敗（最近一次：${reason}）。`
      + '可能是網路不穩或圖檔缺漏。要繼續看這疊嗎？';
    show($('fWarnBox'));
    show($('btnFlip'), false);
    show($('btnFlashNext'), false);
    $('btnFlashResume').focus();
    return;
  }
  renderCard();
}

/** 使用者選擇繼續：計數歸零，否則下一張失敗就會立刻再跳一次警示 */
function resumeFlash() {
  state.fFails = 0;
  show($('fWarnBox'), false);
  renderCard();
}

/**
 * 完成頁。
 *
 * @param {string} note 提前結束的說明
 * @param {number} shown 使用者**實際看到**的張數，預設整疊。
 *   不可一律用 `deck.length`——遞補是覆蓋寫入，張數恆為 20，
 *   提前結束時會把根本沒顯示出來的卡算成「看過」（CR-5）。
 */
function finishFlash(note = '', shown = state.deck.length) {
  clearFlashTimer();                 // 離開後才 fire 的逾時會誤觸遞補
  state.fReady = false;
  const seen = state.deck.slice(0, shown);
  const flipped = seen.filter((c) => c.flipped).length;
  const withAlts = seen.filter((c) => lookAlikesOf(c.item, lookAlikeIndex()).length).length;

  show($('flash'), false);
  show($('flashDone'));
  $('flashDoneSub').textContent =
    (note ? `${note}　` : '')
    + `看過 ${shown} / ${DECK_SIZE} 張，翻開 ${flipped} 張`
    + (withAlts ? `　·　其中 ${withAlts} 張的外觀另有相似品項` : '')
    + '　·　閃卡不計分，成績請走測驗模式。';
  window.scrollTo(0, 0);        // 動畫一律走 CSS 正向表列，JS 不得自帶（規格 D27 條 5）
}

function quitFlash() {
  $('fImg').removeAttribute('src');
  finishFlash('', state.fIdx + 1);          // 目前這張已經呈現過，算看過
}

// ── 成績 ─────────────────────────────────────────────────────────────

/**
 * 一個回合真的完成。**只有這裡會寫紀錄**——
 * 紀錄是「完成一個回合」的副作用，不是「顯示結算頁」的副作用。
 * 返回原成績時重走 `renderResult()` 但不寫，否則每次返回都會重跑一次寫入判定。
 */
function finish() {
  // D40：**院內版完全不寫任何最佳紀錄**，只顯示當回合分數。
  // 不同醫院的清單共用同一 key、換清單前後基準不同、月更縮水後基準又變——
  // 三個問題疊起來讓那個數字沒有任何可比較的意義。
  renderResult({ record: state.mode !== 'retry' && !state.fx });
}

/**
 * 結算頁渲染。**正常回合、複習回合、返回原成績三者走的是同一條路徑**（D31）——
 * 另寫一條「返回專用」的衍生路徑等於開第二套結算模型，
 * 而兩套模型一定會漂移（漂移的後果是成績卡印的數字與畫面上不一樣）。
 *
 * 複習模式的差異全部集中在 `retry` 分支，由 D29 的正負面契約定義。
 */
function renderResult({ record }) {
  const retry = state.mode === 'retry';
  const r = scoreQuiz(state.questions);
  const streak = longestStreak(state.questions);
  const cfg = LEVELS[state.quizLevel ?? Level.L3];
  show($('quiz'), false);
  show($('result'));

  renderFxCoverage('result', state.quizLevel ?? Level.L3);   // C43：結算頁也要有

  // ── D29：複習卷的分母不是 20、題目不是隨機抽樣，任何跨回合可比較的數字都不適用
  $('resultTitle').textContent = retry ? '錯題複習結果' : '測驗結果';
  show($('retryNote'), retry);
  show($('resultMetrics'), !retry);      // 分數／基線／最長連對全在這裡面
  show($('resultActions'), !retry);      // 含成績卡下載與「錯題再戰」
  show($('retryActions'), retry);
  if (retry) {
    show($('resultRank'), false);        // 稱號：D24 的表以 (level, score) 為輸入
    show($('recordFlash'), false);
    show($('retryFail'), false);
    $('resultBadge').textContent = cfg.badge;
    // M 是**題數不是分數**：HINTED_MARK 讓提示後答對計 0.5，
    // 沿用加權值會印出「5 題答對 3.5 題」這種讀不通的句子（D29）
    const done = state.questions.filter((q) => q.state === QState.LOCKED).length;
    const got = state.questions.filter((q) => q.state === QState.LOCKED && q.correct === true).length;
    $('resultSub').textContent = `本次 ${done} 題答對 ${got} 題`;
    renderReview(cfg.choice, { retry: true });
    window.scrollTo(0, 0);               // 動畫一律走 CSS 正向表列（D27 條 5）
    return;
  }

  $('resultBadge').textContent = cfg.badge;
  $('resultSub').textContent =
    `計分 ${r.counted} 題　·　答對 ${r.correct} 題　·　用提示 ${r.hints} 題`
    + (r.voided ? `　·　作廢 ${r.voided} 題（不計入分母）` : '');

  const level3 = r.score >= cfg.pass ? ['good', '熟練']
    : r.score >= cfg.fair ? ['muted', '尚可'] : ['warn', '待加強'];

  // 亂猜基線逐題加總（規格 D14）。不做 (score-25)/75 之類的校正換算——
  // 那會產生一個看似可跨級比較、統計假設卻不成立的數字。
  const net = Math.round((r.score - r.chance) * 10) / 10;
  $('resultMetrics').innerHTML = `
    <div class="metric key">
      <div class="name">總分</div>
      <div class="val">${r.score.toFixed(1)}</div>
      <div class="interp ${level3[0]}">${level3[1]}（${cfg.badge}標準）</div>
    </div>
    <div class="metric"><div class="name">亂猜基線</div><div class="val">${r.chance.toFixed(1)}</div>
      <div class="interp ${net > 0 ? 'good' : 'warn'}">淨 ${net >= 0 ? '+' : ''}${net.toFixed(1)}</div></div>
    <div class="metric"><div class="name">答對</div><div class="val">${r.correct} / ${r.counted}</div>
      <div class="interp muted">正確率 ${r.counted ? ((r.correct / r.counted) * 100).toFixed(0) : 0}%</div></div>
    <div class="metric"><div class="name">實得分數</div><div class="val">${r.earned.toFixed(1)}</div>
      <div class="interp muted">滿分 ${r.counted}.0</div></div>
    <div class="metric"><div class="name">使用提示</div><div class="val">${r.hints}</div>
      <div class="interp ${r.hints ? 'muted' : 'good'}">${r.hints ? '該題滿分降為 0.5' : '未使用'}</div></div>
    <div class="metric"><div class="name">最長連對</div><div class="val">${streak.length} 題</div>
      ${streak.hinted ? `<div class="interp muted">含 ${streak.hinted} 題提示</div>` : ''}</div>`;

  // 稱號。由**實際的** quizLevel 與 score 查表，並與級別徽章同框（D24）
  const title = rankTitle(state.quizLevel, r.score);
  $('rankBadge').textContent = cfg.badge;
  $('rankTitle').textContent = title;
  show($('resultRank'), !!title);

  renderReview(cfg.choice, { retry: false });

  // 「錯題再戰」控制項：**錯題數 > 0 時才存在**（D33）。
  // 用 hidden class 而非 disabled——零錯題時控制項不該可及，
  // disabled 仍在 DOM 裡，程式化 click 照樣觸發得到
  const wrong = wrongAnsKeys(state.questions);
  $('btnRetryN').textContent = wrong.length;
  show($('btnRetry'), wrong.length > 0);
  show($('retryFail'), false);

  // 紀錄寫入放在**全部渲染之後**，並整段包在 try 內：
  // 持久化是附加功能，它的任何失敗都不得讓使用者拿不到分數與逐題檢討（§5.2）
  let fresh = [];
  if (record) {
    try {
      fresh = writeRecords(state.quizLevel, r.score, streak.length)?.fresh ?? [];
    } catch (e) {
      console.warn('[records] 寫入失敗', e);
    }
  }
  // 「新紀錄！」只在持久化確認完成後顯示——宣稱已保存而實際失敗，
  // 使用者要到下次開啟才會發現紀錄不見了（E3）
  $('recordFlash').textContent = fresh.length
    ? `新紀錄！${fresh.map((k) => REC_LABEL[k]).join('、')}`
    : '';
  show($('recordFlash'), fresh.length > 0);

  window.scrollTo(0, 0);        // 同上（D27 條 5）
}

/**
 * 逐題檢討。複習模式**不印每題得分**——D29 的負面契約是「不顯示分數」，
 * 逐題得分就是分數，只是換一個位置。
 */
function renderReview(isChoice, { retry }) {
  const scoreCol = !retry;
  // 欄位結構與 v3 完全相同，複習模式只是**少一欄得分**。
  // 非選擇題的「你的作答」欄放的就是答對／答錯（v3 既有行為，不在這輪改）
  $('reviewHead').innerHTML = (isChoice
    ? '<th>#</th><th>正解</th><th>你選的</th><th>結果</th>'
    : '<th>#</th><th>正解</th><th>你的作答</th>')
    + (scoreCol ? '<th>得分</th>' : '');

  const cols = (isChoice ? 4 : 3) + (scoreCol ? 1 : 0);
  $('reviewBody').innerHTML = state.questions.map((q, i) => {
    if (q.state === QState.VOID) {
      // 複習卷不會有作廢題（D28：圖片失敗整卷終止，不遞補），這條是防禦性的
      // 欄數：#、正解、跨欄說明、（得分）。跨欄寬度隨得分欄的有無而變
      return `<tr><td>${i + 1}</td><td class="ans vd">—</td>`
        + `<td class="vd" colspan="${scoreCol ? cols - 3 : cols - 2}">`
        + `資源載入失敗${scoreCol ? '' : '（作廢）'}</td>`
        + (scoreCol ? '<td class="mk vd">作廢</td>' : '') + '</tr>';
    }
    const got = q.correct ? '<span class="ok">答對</span>' : '<span class="no">答錯</span>';
    const picked = isChoice
      ? `<td class="ans">${escapeHtml(q.options?.[q.picked]?.ans ?? '—')}</td>`
      : '';
    return `<tr><td>${i + 1}</td><td class="ans">${escapeHtml(q.item.ans)}</td>${picked}`
      + `<td>${got}${q.mark === HINTED_MARK ? '（提示）' : ''}</td>`
      + (scoreCol ? `<td class="mk">${q.correct ? q.mark.toFixed(1) : '0.0'}</td>` : '')
      + '</tr>';
  }).join('');
}

// ── M5 錯題再戰（規格 D28／D28.1／D29／D31／D33）─────────────────────

/** 把 retry 的暫態清乾淨。三種失敗與返回共用同一條，避免各自漏掉一項 */
function clearRetryState() {
  clearTimers();
  state.mode = 'quiz';
  state.origin = null;
  state.retryBuilding = false;
}

/**
 * 建構失敗時的非破壞性提示（D28.1）。
 *
 * 規格原本寫「DOM 完全不變」——那是自相矛盾的：使用者按了按鈕卻什麼都沒發生，
 * 與「功能靜默不存在」無法區分，而那是本專案第二順位風險。
 * 約束因此精確化為「**原成績內容**不變」：這裡只寫一個獨立的提示元素，
 * 不觸碰分數、稱號、三級判定、逐題檢討與任何按鈕的可用性。
 */
function retryFailed(msg) {
  $('retryFail').textContent = `這次沒能組出複習卷：${msg}　原成績不受影響，可以再試一次。`;
  show($('retryFail'));
}

/**
 * L2 的資源前置條件：把候選卷**每一格**的圖片先載完（規格 D28.1、覆審 M-1）。
 *
 * 沒有這一步，L2 的複習卷會是「先發布再回滾」——切進答題頁之後才發現某張圖
 * 載不動，於是 `voidCurrent()` 把整次複習終止並退回原成績。使用者看到的是
 * 「按下去、畫面跳走、又跳回來」，而 D28.1 加上這條前置條件的目的正是消掉回滾。
 *
 * 節點刻意不掛進 DOM：這裡只要把資源送進瀏覽器快取並確認它可解碼，
 * 真正的 `<img>` 稍後由 `renderGrid()` 建立（同一個 src 直接命中快取）。
 * **這不取代 ready-gate**——快取仍可能在期間被逐出，`loadCell()` 的逾時與
 * `failCell()` 因此保留。
 *
 * @returns {Promise<boolean>} 全部成功才是 true；任何一張失敗或逾時即 false
 */
function preloadGridImages(quiz) {
  const srcs = [...new Set(quiz.flatMap((q) => q.options.map((o) => DATA_DIR + o.img)))];
  const one = (src) => new Promise((resolve) => {
    const img = document.createElement('img');
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // 逾時與 loadCell 同一個常數。永久 pending 的圖沒有逾時就會讓
    // 「錯題再戰」按下去之後永遠沒有反應——比失敗提示更難理解
    const timer = setTimeout(() => settle(false), L2_LOAD_TIMEOUT_MS);
    img.onload = () => settle((img.naturalWidth ?? 1) > 0);   // 零尺寸視同失敗
    img.onerror = () => settle(false);
    img.src = src;
  });
  return Promise.all(srcs.map(one)).then((oks) => oks.every(Boolean));
}

/**
 * **D28.1 的發布點本身**。呼叫到這裡代表三個前置條件都已成立：
 * 候選卷完整建構、`validateQuizInvariants()` 回空、該級的資源前置條件成立。
 *
 * 抽成獨立函式不只是整理：L2 的發布發生在 Promise 回呼裡，
 * 兩條入口共用同一段發布程式碼才能保證「L2 少做了一步」不會悄悄發生。
 */
function publishRetry(quiz) {
  state.origin = {
    // **只存原始欄位**（D31 單一真相來源）。分數、稱號、基線、最長連對
    // 一律由這兩個欄位重算——多存一份可重算的值就多一個會分歧的來源
    questions: state.questions,
    quizLevel: state.quizLevel,
  };
  state.mode = 'retry';
  state.retryBuilding = false;
  state.questions = quiz;
  state.idx = 0;
  state.voided = 0;
  state.nextToken = quiz.length + 1;
  show($('result'), false);
  show($('quiz'));
  renderQuestion();
}

/**
 * 進入錯題再戰。
 *
 * **D28.1 原子發布點**：候選卷完整建構、通過整卷驗證、**且該級的資源前置條件
 * 成立**之前，`state.mode`、`state.origin` 與畫面一律不動。因此發布前的任何
 * 失敗都是「還沒開始」而不是「回滾」——不需要第二套回滾狀態流程。
 */
function startRetry() {
  // D31 冪等：建構中或已在複習中，第二次起一律 no-op。
  // 雙擊是真實情境，而覆寫 origin 會讓返回時拿到複習卷的成績。
  // L2 的建構含非同步預載，`retryBuilding` 因此要撐過整個等待期間
  if (state.retryBuilding || state.mode === 'retry' || state.origin) return;

  const ansKeys = wrongAnsKeys(state.questions);
  if (!ansKeys.length) return;           // 零錯題：控制項本來就不存在，這是防禦性的

  const level = state.quizLevel ?? Level.L3;
  state.retryBuilding = true;
  let quiz;
  try {
    quiz = drawRetryQuiz(state.items, {
      level,
      ansKeys,
      rng: Math.random,
      index: state.index,
      eligible: LEVELS[level].choice ? eligibleFor(level) : null,
    });
  } catch (e) {
    state.retryBuilding = false;
    // 一律不發布。不得「把該題剔除後繼續」——靜默剔除會讓使用者
    // 以為自己已複習完全部錯題（D28）
    if (e.code === 'INVARIANT_VIOLATED') {
      console.warn('[retry] 不變量違規', e.violations);
      return retryFailed(`題卷未通過不變量驗證（${escapeHtml(violationCodes(e.violations))}）`);
    }
    if (e.code === 'KEY_NOT_ELIGIBLE') return retryFailed('部分錯題在這個難度已無法出題');
    if (e.code === 'QUIZ_ASSEMBLY_FAILED' || e.code === 'NO_DISTRACTORS') {
      return retryFailed('這些藥名湊不出足夠的誘答');
    }
    return retryFailed(e.message);
  }

  // L2：ready-gate 是這一級的資源前置條件，必須在發布前就成立（D28.1）
  if (LEVELS[level].grid) {
    preloadGridImages(quiz).then((ok) => {
      // 等待期間使用者可能已按「再測一回」或返回起始頁——那兩條都會
      // `clearRetryState()`。此時發布等於把畫面搶回複習卷
      if (!state.retryBuilding) return;
      if (!ok) {
        state.retryBuilding = false;
        return retryFailed('複習卷的藥品圖片載入失敗');
      }
      publishRetry(quiz);
    });
    return;
  }
  publishRetry(quiz);
}

/**
 * 返回原成績（D31）。
 *
 * 由 `state.origin` **重新衍生**，走的是與正常回合完全相同的 `renderResult()`；
 * 不回填任何先前保存的 DOM 字串——那樣表面會過，底層原卷卻已被覆寫。
 * 返回完成後 `origin` 清為 `null`：不清的話，下一個正常回合的結算會讀到殘留快照。
 */
function exitRetry() {
  if (state.mode !== 'retry') return;    // 不在複習中：控制項本來就隱藏，這是防禦性的
  // `mode='retry'` 卻沒有 origin 是不該存在的組合。**不能只是 no-op**——
  // no-op 會讓它永久停在那裡，返回鍵從此按不動（覆審 M-9）。
  // 清乾淨再明說失敗，使用者至少能重新開始
  if (!state.origin) {
    clearRetryState();
    return fatal('複習狀態已遺失，無法回到原成績。');
  }
  const origin = state.origin;
  state.questions = origin.questions;
  state.quizLevel = origin.quizLevel;
  state.idx = state.questions.length;
  clearRetryState();                     // 先回到 quiz 模式，renderResult 才走正常分支
  renderResult({ record: false });       // 紀錄是「完成回合」的副作用，不是「顯示」的
}

// ── 成績卡（純 Canvas，不含任何跨域圖片 — 規格 D7）───────────────────

async function downloadCard() {
  // D29：複習卷不出成績卡。按鈕在複習結算頁本來就隱藏，這是防禦性的第二道——
  // 成績卡是唯一會外流的產物，不得帶著不可比的數字出去
  if (state.mode === 'retry') {
    throw new Error('錯題複習不提供成績卡（分母不是 20，數字不可比）');
  }
  const r = scoreQuiz(state.questions);
  const cfg = LEVELS[state.quizLevel ?? Level.L3];
  const W = 720, H = 900, S = 2;             // 2× 供高解析螢幕
  const cv = $('cardCanvas');
  cv.width = W * S; cv.height = H * S;
  const g = cv.getContext('2d');
  g.scale(S, S);

  try { await document.fonts.ready; } catch { /* 字型未就緒仍可繪製 */ }

  const T = {
    bg: '#F5F0E8', card: '#FFFFFF', accent: '#3D7A8A',
    text: '#2C2C2C', muted: '#6B7280', border: '#E0D9CE',
    ok: '#27AE60', no: '#C0392B',
  };
  const sans = (w, s) => `${w} ${s}px "Noto Sans TC", sans-serif`;
  const mono = (w, s) => `${w} ${s}px "JetBrains Mono", monospace`;

  g.fillStyle = T.bg; g.fillRect(0, 0, W, H);
  g.fillStyle = T.card; g.strokeStyle = T.border; g.lineWidth = 1;
  roundRect(g, 24, 24, W - 48, H - 48, 10); g.fill(); g.stroke();

  g.fillStyle = T.accent; g.fillRect(24, 24, W - 48, 6);

  const title = '藥品辨識王';
  g.fillStyle = T.text; g.font = sans(700, 26);
  g.fillText(title, 52, 88);
  const titleW = g.measureText(title).width;   // 必須在標題字型下量測

  // 級別徽章。成績卡是離開頁面後唯一的上下文，漏印級別會讓分數被誤讀（規格 D14）
  const badge = cfg.badge;
  g.font = sans(700, 13);
  const bx = 52 + titleW + 14;
  const bw = g.measureText(badge).width + 20;
  g.fillStyle = T.accent;
  roundRect(g, bx, 68, bw, 24, 12); g.fill();
  g.fillStyle = '#fff';
  g.fillText(badge, bx + 10, 85);

  g.fillStyle = T.muted; g.font = sans(400, 13);
  g.fillText(`${cfg.desc}　·　食藥署藥品外觀資料集`, 52, 112);

  // 分數。寬度必須在字型仍為 mono 96px 時量測，換字型後再量會得到錯誤值
  const scoreTxt = r.score.toFixed(1);
  g.fillStyle = T.accent; g.font = mono(700, 96);
  g.fillText(scoreTxt, 52, 218);
  const scoreW = g.measureText(scoreTxt).width;
  g.font = sans(400, 15); g.fillStyle = T.muted;
  g.fillText('/ 100', 52 + scoreW + 14, 200);
  g.font = sans(400, 13);
  g.fillText(`亂猜基線 ${r.chance.toFixed(1)}　·　淨 ${r.score - r.chance >= 0 ? '+' : ''}${(r.score - r.chance).toFixed(1)}`,
    52 + scoreW + 14, 220);

  // 指標列
  const stats = [
    ['計分題數', `${r.counted}`],
    ['答對', `${r.correct}`],
    ['使用提示', `${r.hints}`],
    ['作廢', `${r.voided}`],
  ];
  let x = 52;
  for (const [k, v] of stats) {
    g.fillStyle = '#FAF7F2'; g.strokeStyle = T.border;
    roundRect(g, x, 246, 148, 66, 6); g.fill(); g.stroke();
    g.fillStyle = T.muted; g.font = sans(400, 11.5); g.fillText(k, x + 12, 268);
    g.fillStyle = T.text; g.font = mono(700, 22); g.fillText(v, x + 12, 298);
    x += 156;
  }

  // 逐題
  g.fillStyle = T.text; g.font = sans(500, 14);
  g.fillText('逐題結果', 52, 352);
  let y = 376;
  g.font = mono(400, 11.5);
  state.questions.forEach((q, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const px = 52 + col * 318, py = y + row * 25;
    const voided = q.state === QState.VOID;
    g.fillStyle = voided ? T.muted : q.correct ? T.ok : T.no;
    g.fillText(voided ? '—' : q.correct ? '✓' : '✗', px, py);
    g.fillStyle = T.text;
    const name = voided ? '（作廢）' : q.item.ans;
    g.fillText(clip(g, name, 232), px + 18, py);
    g.fillStyle = T.muted;
    g.fillText(voided ? '' : (q.correct ? q.mark.toFixed(1) : '0.0'), px + 262, py);
  });

  y += Math.ceil(state.questions.length / 2) * 25 + 22;
  g.strokeStyle = T.border; g.beginPath(); g.moveTo(52, y); g.lineTo(W - 52, y); g.stroke();

  g.fillStyle = T.muted; g.font = sans(400, 11);
  const stamp = new Date().toLocaleString('zh-TW', { hour12: false });
  g.fillText(`測驗時間 ${stamp}`, 52, y + 24);
  const ver = state.pool?.meta?.source_version;
  /**
   * **院內版的母體不是全庫。**
   *
   * 成績卡是新人會截圖給帶教藥師看的東西，印「題庫 3,941 題」等於宣稱這一卷抽自全庫，
   * 而它其實只抽自院內清單的 N 個品項——分數的意義完全不同。
   * 這與 D34.1「全額揭露」是同一條理由：使用者拿數字做判斷，數字就不能是別人的。
   */
  const scope = state.fx
    ? `院內清單 ${state.fx.N.toLocaleString()} 品項`
    : `題庫 ${state.pool.meta.count.toLocaleString()} 題`;
  g.fillText(`${scope}${ver ? `　·　資料版本 ${ver}` : ''}`, 52, y + 42);
  g.fillStyle = T.no; g.font = sans(400, 10.5);
  g.fillText('本工具為教育練習用，非臨床調劑或給藥的辨識依據。分數不可跨難度比較。', 52, y + 64);

  const blob = await new Promise((ok) => cv.toBlob(ok, 'image/png'));
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `藥品辨識王_${cfg.badge}_${r.score.toFixed(0)}分_${new Date().toISOString().slice(0, 10)}.png`;
  a.click();
  URL.revokeObjectURL(url);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function clip(g, s, max) {
  if (g.measureText(s).width <= max) return s;
  let t = s;
  while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── 綁定 ─────────────────────────────────────────────────────────────

function backToStart() {
  clearRetryState();            // D31：離開結算頁就不該再有 retry 殘留
  show($('formulary'), false);
  show($('result'), false);
  show($('quiz'), false);
  show($('flash'), false);
  show($('flashDone'), false);
  show($('start'));
  resetLevel();                 // 每回合都必須重新選級別（規格 §6.1）
  renderRecords();              // 剛結束的回合可能剛破紀錄，回起始頁要看得到
  window.scrollTo(0, 0);        // 同上（D27 條 5）
}

$('btnStart').addEventListener('click', startQuiz);
$('btnAgain').addEventListener('click', backToStart);
$('btnSubmit').addEventListener('click', submit);
$('btnHint').addEventListener('click', hint);
$('btnHintChoice').addEventListener('click', hintChoice);
$('btnNext').addEventListener('click', next);
$('btnRetry').addEventListener('click', startRetry);
$('btnBackToOrigin').addEventListener('click', exitRetry);
$('btnDownload').addEventListener('click', () => {
  downloadCard().catch((e) => {
    $('resultSub').innerHTML += ` <span style="color:var(--danger)">（成績卡產生失敗：${escapeHtml(e.message)}）</span>`;
  });
});
$('qInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submit(); }
});

// 閃卡。btnFlash 不看 state.level——閃卡沒有難度可言（F1）
$('btnFlash').addEventListener('click', startFlash);
$('btnFlip').addEventListener('click', flip);
$('btnFlashNext').addEventListener('click', nextCard);
$('btnFlashQuit').addEventListener('click', quitFlash);
$('btnFlashResume').addEventListener('click', resumeFlash);
$('btnFlashStop').addEventListener('click', () => {
  $('fImg').removeAttribute('src');
  finishFlash('已結束這疊。', state.fIdx + 1);
});
$('btnToQuiz').addEventListener('click', backToStart);
$('btnFlashAgain').addEventListener('click', startFlash);

// V5 產連結頁
$('btnFormulary').addEventListener('click', openFormularyPage);
$('btnFxBack').addEventListener('click', closeFormularyPage);
$('btnFxAnalyze').addEventListener('click', analyzeFormulary);
$('btnFxDownload').addEventListener('click', downloadUnmatched);
$('btnFxCopy').addEventListener('click', () => {
  // 複製失敗不得宣稱成功——使用者會以為連結在剪貼簿裡而貼出空白
  const done = () => { show($('fxCopied')); };
  try {
    const p = navigator.clipboard?.writeText($('fxLink').value);
    if (p?.then) p.then(done, () => { $('fxCopied').textContent = '複製失敗，請手動選取'; show($('fxCopied')); });
    else done();
  } catch {
    $('fxCopied').textContent = '複製失敗，請手動選取';
    show($('fxCopied'));
  }
});

// 切回全題庫。二次確認同「清除紀錄」的作法
$('btnFxExit').addEventListener('click', () => show($('fxExitConfirm')));
$('btnFxExitNo').addEventListener('click', () => show($('fxExitConfirm'), false));
$('btnFxExitYes').addEventListener('click', () => {
  const ok = exitFormulary();
  if (!ok) {
    // 移除失敗時**不得切回**：記憶體切了但 storage 還在，重整又是院內版，
    // 而畫面已經說「已切回」——那比不給出口更糟
    $('startFxWarn').textContent = '無法從這個瀏覽器移除院內清單（儲存空間不可用），仍在院內版。';
    show($('startFxWarn'));
    show($('fxExitConfirm'), false);
    return;
  }
  renderFormularyState();
  renderLevelPicker();          // 禁用狀態要跟著解除
  renderRecords();              // 通用版才有最佳紀錄可看
});

// 清除紀錄：二次確認走頁內元素而不是 window.confirm——
// 瀏覽器 modal 會阻斷整個頁面，而且取消路徑無從自動驗證（E7 要求取消時零 mutation）
$('btnClearRecords').addEventListener('click', () => show($('clearConfirm')));
$('btnClearNo').addEventListener('click', () => show($('clearConfirm'), false));
$('btnClearYes').addEventListener('click', () => {
  const ok = clearRecords();
  renderRecords();              // 內含隱藏確認框與提示；順序在下方設定文字之前
  // 移除失敗時不得顯示「已清除」：紀錄其實還在，下次開啟又會冒出來
  $('recordsNote').textContent = ok ? '已清除最佳紀錄。' : '清除失敗，紀錄仍在。';
  show($('recordsNote'));
});

loadPool();
