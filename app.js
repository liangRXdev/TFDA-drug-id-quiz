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
} from './engine.js';

const SCHEMA = 1;
const MAX_VOID = 3;          // 規格 6.5：遞補失敗次數上限
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
    name: '簡單', badge: '簡單級', desc: '看圖，從四個藥名選一個',
    meta: '亂猜基線 25 ｜ 無提示', choice: true, hint: false,
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
};

// ── 載入題庫（失敗路徑見規格 C4）──────────────────────────────────────

function fatal(msg) {
  $('fatalMsg').innerHTML = msg;
  show($('fatal'));
  show($('start'), false);
  show($('quiz'), false);
  show($('result'), false);
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
  state.noFuzzy = new Set(data.meta.no_fuzzy || []);
  state.index = buildIndex(data.items);

  const m = data.meta;
  $('poolInfo').innerHTML =
    `<b>題庫</b> <span class="num">${m.count.toLocaleString()}</span> 題`
    + `（相異品名 <span class="num">${keys.size.toLocaleString()}</span>）`
    + ` ｜ <b>來源</b> ${m.source}`
    + (m.source_file ? ` ｜ <b>檔案</b> <span class="num">${m.source_file}</span>` : '');
  if (m.source_version) $('srcVer').textContent = `，資料版本 ${m.source_version}`;

  renderLevelPicker();
  show($('start'));
  $('qTotal').textContent = QUIZ_SIZE;
  $('introN').textContent = QUIZ_SIZE;
}

// ── 難度選擇（規格 §6.1）─────────────────────────────────────────────

function renderLevelPicker() {
  $('levelPick').innerHTML = LEVEL_ORDER.map((id) => {
    const L = LEVELS[id];
    return `<button class="level" role="radio" aria-checked="false" data-level="${id}">
      <span class="lv-name">${L.name}</span>
      <span class="lv-desc">${L.desc}</span>
      <span class="lv-meta">${L.meta}</span>
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
    el.disabled = false;
  });
  show($('levelWarn'), false);
  $('btnStart').disabled = true;
  $('btnStart').textContent = '請先選擇難度';
}

function selectLevel(id) {
  if (!LEVELS[id]) return;
  state.level = id;
  $('levelPick').querySelectorAll('.level').forEach((el) => {
    el.setAttribute('aria-checked', String(el.dataset.level === id));
  });
  show($('levelWarn'), false);
  $('btnStart').disabled = false;
  $('btnStart').textContent = `開始 ${QUIZ_SIZE} 題測驗（${LEVELS[id].name}）`;
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

  try {
    state.questions = drawLeveledQuiz(state.pool.items, {
      level, n: QUIZ_SIZE, rng: Math.random,
      index: state.index, eligible: eligibleFor(level),
    });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_KEYS') {
      return fatal(`${LEVELS[level].badge}可用答案鍵僅 ${e.available} 個，`
        + `不足 ${e.required ?? QUIZ_SIZE} 個，無法出 ${QUIZ_SIZE} 題。`);
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

  state.quizLevel = level;
  state.idx = 0;
  state.voided = 0;
  state.nextToken = state.questions.length + 1;
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

function renderQuestion() {
  const q = state.questions[state.idx];
  const cfg = LEVELS[q.level ?? Level.L3];

  clearTimers();
  $('qIdx').textContent = state.idx + 1;
  $('qBar').style.width = `${(state.idx / QUIZ_SIZE) * 100}%`;
  $('qScore').textContent = scoreQuiz(state.questions.slice(0, state.idx)).earned.toFixed(1);

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

function renderChoices(q) {
  show($('inputMode'), false);
  show($('qOptions'));
  $('qOptions').innerHTML = q.options.map((o, k) =>
    `<button class="opt" data-k="${k}">
       <span class="key">${OPT_KEYS[k]}</span>
       <span>${escapeHtml(o.ans)}</span>
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
  const q = state.questions[state.idx];
  const next = transition(q, { type: 'fail' });

  // 必須確認真的進入 VOID 才能往下走（覆審 C5）。
  // LOCKED 是終態，transition 會原樣回傳——若此時仍 voided++ 並遞補一題，
  // 原題會照常計分、考卷卻多一題，分母變成 21。
  if (next.state !== QState.VOID) return;

  clearTimers();
  state.questions[state.idx] = next;
  state.voided++;

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

  show($('btnNext'));
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

// ── 成績 ─────────────────────────────────────────────────────────────

function finish() {
  const r = scoreQuiz(state.questions);
  const cfg = LEVELS[state.quizLevel ?? Level.L3];
  show($('quiz'), false);
  show($('result'));

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
      <div class="interp ${r.hints ? 'muted' : 'good'}">${r.hints ? '該題滿分降為 0.5' : '未使用'}</div></div>`;

  const isChoice = cfg.choice;
  $('reviewHead').innerHTML = isChoice
    ? '<th>#</th><th>正解</th><th>你選的</th><th>結果</th><th>得分</th>'
    : '<th>#</th><th>正解</th><th>你的作答</th><th>得分</th>';

  $('reviewBody').innerHTML = state.questions.map((q, i) => {
    const cols = isChoice ? 5 : 4;
    if (q.state === QState.VOID) {
      return `<tr><td>${i + 1}</td><td class="ans vd">—</td>`
        + `<td class="vd" colspan="${cols - 3}">資源載入失敗</td><td class="mk vd">作廢</td></tr>`;
    }
    const got = q.correct ? '<span class="ok">答對</span>' : '<span class="no">答錯</span>';
    const picked = isChoice
      ? `<td class="ans">${escapeHtml(q.options?.[q.picked]?.ans ?? '—')}</td>`
      : '';
    return `<tr><td>${i + 1}</td><td class="ans">${escapeHtml(q.item.ans)}</td>${picked}`
      + `<td>${got}${q.mark === HINTED_MARK ? '（提示）' : ''}</td>`
      + `<td class="mk">${q.correct ? q.mark.toFixed(1) : '0.0'}</td></tr>`;
  }).join('');

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── 成績卡（純 Canvas，不含任何跨域圖片 — 規格 D7）───────────────────

async function downloadCard() {
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
  g.fillText(`題庫 ${state.pool.meta.count.toLocaleString()} 題${ver ? `　·　資料版本 ${ver}` : ''}`, 52, y + 42);
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
  show($('result'), false);
  show($('quiz'), false);
  show($('start'));
  resetLevel();                 // 每回合都必須重新選級別（規格 §6.1）
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('btnStart').addEventListener('click', startQuiz);
$('btnAgain').addEventListener('click', backToStart);
$('btnSubmit').addEventListener('click', submit);
$('btnHint').addEventListener('click', hint);
$('btnHintChoice').addEventListener('click', hintChoice);
$('btnNext').addEventListener('click', next);
$('btnDownload').addEventListener('click', () => {
  downloadCard().catch((e) => {
    $('resultSub').innerHTML += ` <span style="color:var(--danger)">（成績卡產生失敗：${escapeHtml(e.message)}）</span>`;
  });
});
$('qInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submit(); }
});

loadPool();
