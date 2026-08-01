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
  QState, transition, newQuestion, scoreQuiz, HINTED_MARK,
  Level, CHANCE, buildIndex, eligibleKeys, buildChoices, drawLeveledQuiz, judgeChoice,
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
    name: '簡單', desc: '看圖，從四個藥名選一個',
    meta: '亂猜基線 25 ｜ 無提示', choice: true, hint: false,
    pass: 90, fair: 65,
  },
  [Level.L3]: {
    name: '困難', desc: '看圖，直接輸入英文品名',
    meta: '亂猜基線 0 ｜ 可用提示', choice: false, hint: true,
    pass: 80, fair: 50,
  },
};
const LEVEL_ORDER = [Level.L1, Level.L3];

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
  used: new Set(),           // 本回合已用過的答案鍵，遞補時避免重複
  nextToken: 1,              // 題目 token，遞補不重用（規格 D18）
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
      level, n: QUIZ_SIZE, rng: Math.random, index: state.index,
    });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_KEYS') {
      return fatal(`${LEVELS[level].name}級可用答案鍵僅 ${e.available} 個，`
        + `不足 ${e.required ?? QUIZ_SIZE} 個，無法出 ${QUIZ_SIZE} 題。`);
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
  state.used = new Set(state.questions.map((q) => q.item.ans));
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
  const it = q.item;
  const cfg = LEVELS[q.level ?? Level.L3];

  $('qIdx').textContent = state.idx + 1;
  $('qBar').style.width = `${(state.idx / QUIZ_SIZE) * 100}%`;
  $('qScore').textContent = scoreQuiz(state.questions.slice(0, state.idx)).earned.toFixed(1);

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

  show($('qHint'), false);
  show($('qVerdict'), false);
  show($('btnNext'), false);

  if (cfg.choice) renderChoices(q);
  else renderInput(cfg);
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

/** 資源失敗：作廢並自題庫遞補一題（不計分、不計入分母） */
function voidCurrent(reason) {
  const q = state.questions[state.idx];
  const next = transition(q, { type: 'fail' });

  // 必須確認真的進入 VOID 才能往下走（覆審 C5）。
  // LOCKED 是終態，transition 會原樣回傳——若此時仍 voided++ 並遞補一題，
  // 原題會照常計分、考卷卻多一題，分母變成 21。
  if (next.state !== QState.VOID) return;

  state.questions[state.idx] = next;
  state.voided++;

  if (state.voided > MAX_VOID) {
    return fatal(`已有 ${state.voided} 題因資源載入失敗而作廢，中止本回合以免影響成績判讀。<br>原因：${reason}`);
  }
  const spare = drawSpare(q.level ?? Level.L3);
  if (!spare) {
    return fatal('題庫已無可遞補的題目，中止本回合。');
  }
  state.used.add(spare.item.ans);
  state.questions.push(spare);
  state.idx++;
  if (state.idx < state.questions.length) renderQuestion();
  else finish();
}

/**
 * 遞補一題。選擇題的遞補必須連同選項一起重建，
 * 且 H2 要對「目前的正解集合」成立——直接沿用舊選項會讓遞補題洩題。
 */
function drawSpare(level) {
  const cfg = LEVELS[level];
  const eligible = cfg.choice ? eligibleFor(level) : null;
  for (const it of state.pool.items) {
    if (state.used.has(it.ans)) continue;
    if (eligible && !eligible.has(it.ans)) continue;
    const token = state.nextToken++;
    if (!cfg.choice) return newQuestion(it, { token, level, chance: 0 });
    try {
      const excludeAns = new Set(state.used);
      excludeAns.add(it.ans);
      return newQuestion(it, {
        token, level, chance: CHANCE.FOUR,
        ...buildChoices(it, state.index, { level, rng: Math.random, excludeAns }),
      });
    } catch (e) {
      if (e.code !== 'NO_DISTRACTORS') throw e;   // 組不出就換下一筆
    }
  }
  return null;
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

  const correct = judgeChoice(k, q.answerIdx);
  // picked 是作答狀態而非狀態機事件，在 transition 之外組合進去（規格 §5.2）
  state.questions[state.idx] = { ...transition(q, { type: 'submit', correct }), picked: k };
  const locked = state.questions[state.idx];

  $('qOptions').querySelectorAll('.opt').forEach((el) => {
    const kk = Number(el.dataset.k);
    el.disabled = true;
    if (kk === q.answerIdx) el.classList.add('ok');
    else if (kk === k) el.classList.add('no');
    else el.classList.add('dim');
  });

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

  $('resultBadge').textContent = `${cfg.name}級`;
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
      <div class="interp ${level3[0]}">${level3[1]}（${cfg.name}級標準）</div>
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
  const badge = `${cfg.name}級`;
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
  a.download = `藥品辨識王_${cfg.name}級_${r.score.toFixed(0)}分_${new Date().toISOString().slice(0, 10)}.png`;
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
