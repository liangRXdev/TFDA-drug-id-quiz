/**
 * 藥品辨識王 — UI 與事件
 *
 * 所有判定、抽題、計分邏輯都在 engine.js（純函式、有測試）。
 * 這裡只負責 DOM、資源載入與失敗處理。
 */
import {
  normalize, squash, judge, makeHint, drawQuiz, QUIZ_SIZE,
  QState, transition, newQuestion, scoreQuiz, HINTED_MARK,
} from './engine.js';

const SCHEMA = 1;
const MAX_VOID = 3;          // 規格 6.5：遞補失敗次數上限
/** pool.json 內的 img 路徑是相對於 data/，不是相對於頁面 */
const DATA_DIR = 'data/';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);

const state = {
  pool: null,
  noFuzzy: new Set(),
  questions: [],
  idx: 0,
  voided: 0,
  used: new Set(),           // 本回合已用過的答案鍵，遞補時避免重複
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

  const m = data.meta;
  $('poolInfo').innerHTML =
    `<b>題庫</b> <span class="num">${m.count.toLocaleString()}</span> 題`
    + `（相異品名 <span class="num">${keys.size.toLocaleString()}</span>）`
    + ` ｜ <b>來源</b> ${m.source}`
    + (m.source_file ? ` ｜ <b>檔案</b> <span class="num">${m.source_file}</span>` : '');
  if (m.source_version) $('srcVer').textContent = `，資料版本 ${m.source_version}`;

  show($('start'));
  $('qTotal').textContent = QUIZ_SIZE;
  $('introN').textContent = QUIZ_SIZE;
  $('btnStart').textContent = `開始 ${QUIZ_SIZE} 題測驗`;
}

// ── 出題 ─────────────────────────────────────────────────────────────

function startQuiz() {
  try {
    const drawn = drawQuiz(state.pool.items, QUIZ_SIZE, Math.random);
    state.questions = drawn.map(newQuestion);
  } catch (e) {
    return fatal(e.code === 'INSUFFICIENT_KEYS'
      ? `題庫可用答案鍵僅 ${e.available} 個，不足 ${QUIZ_SIZE} 題。`
      : `出題失敗：${e.message}`);
  }
  state.idx = 0;
  state.voided = 0;
  state.used = new Set(state.questions.map((q) => q.item.ans));
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

function renderQuestion() {
  const q = state.questions[state.idx];
  const it = q.item;

  $('qIdx').textContent = state.idx + 1;
  $('qBar').style.width = `${(state.idx / QUIZ_SIZE) * 100}%`;
  $('qScore').textContent = scoreQuiz(state.questions.slice(0, state.idx)).earned.toFixed(1);

  // 圖片載入失敗 → 該題作廢並遞補（規格 6.5），絕不計為答錯
  const img = $('qImg');
  img.onerror = () => voidCurrent('圖片載入失敗');
  img.alt = `藥品外觀實拍圖：${it.shape.join('／')}、${it.color.join('／')}`;
  img.src = DATA_DIR + it.img;

  $('qFeatures').innerHTML =
    featureCell('形狀', it.shape.join('／'))
    + featureCell('顏色', it.color.join('／'), it.color.length > 1 ? '多層／膠囊帽身' : '')
    + featureCell('刻痕', it.score_mark.join('／'))
    + featureCell('外觀尺寸', it.size ? `${it.size} mm` : '—')
    + featureCell('標記一', it.mark1)
    + (it.mark2 ? featureCell('標記二', it.mark2) : '');

  const input = $('qInput');
  input.value = '';
  input.disabled = false;
  $('btnSubmit').disabled = false;
  $('btnHint').disabled = false;
  show($('qHint'), false);
  show($('qVerdict'), false);
  show($('btnNext'), false);
  input.focus();
}

/** 資源失敗：作廢並自題庫遞補一題（不計分、不計入分母） */
function voidCurrent(reason) {
  const q = state.questions[state.idx];
  if (q.state === QState.VOID) return;
  state.questions[state.idx] = transition(q, { type: 'fail' });
  state.voided++;

  if (state.voided > MAX_VOID) {
    return fatal(`已有 ${state.voided} 題因資源載入失敗而作廢，中止本回合以免影響成績判讀。<br>原因：${reason}`);
  }
  const spare = state.pool.items.find((i) => !state.used.has(i.ans));
  if (!spare) {
    return fatal('題庫已無可遞補的題目，中止本回合。');
  }
  state.used.add(spare.ans);
  state.questions.push(newQuestion(spare));
  state.idx++;
  if (state.idx < state.questions.length) renderQuestion();
  else finish();
}

// ── 作答 ─────────────────────────────────────────────────────────────

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

  const v = $('qVerdict');
  v.className = `verdict ${r.correct ? 'ok' : 'no'}`;
  v.innerHTML = `
    <div><span class="tag">${r.correct ? '✓ 答對' : '✗ 答錯'}</span>
      ${r.reason === 'fuzzy' ? '（拼字容錯）' : ''}
      　得分 <b>${(r.correct ? locked.mark : 0).toFixed(1)}</b>
      ${locked.mark === HINTED_MARK ? `（用過提示，本題滿分 ${HINTED_MARK.toFixed(1)}）` : ''}</div>
    <div class="official">${escapeHtml(q.item.full)}</div>
    <div class="sub">${escapeHtml(q.item.zh || '')}
      <span class="lic">${escapeHtml(q.item.id)}</span></div>`;
  show(v);

  show($('btnNext'));
  $('btnNext').textContent = state.idx + 1 >= state.questions.length ? '看成績' : '下一題';
  $('btnNext').focus();
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
  show($('quiz'), false);
  show($('result'));

  $('resultSub').textContent =
    `計分 ${r.counted} 題　·　答對 ${r.correct} 題　·　用提示 ${r.hints} 題`
    + (r.voided ? `　·　作廢 ${r.voided} 題（不計入分母）` : '');

  const level = r.score >= 80 ? ['good', '熟練'] : r.score >= 50 ? ['muted', '尚可'] : ['warn', '待加強'];
  $('resultMetrics').innerHTML = `
    <div class="metric key">
      <div class="name">總分</div>
      <div class="val">${r.score.toFixed(1)}</div>
      <div class="interp ${level[0]}">${level[1]}</div>
    </div>
    <div class="metric"><div class="name">答對</div><div class="val">${r.correct} / ${r.counted}</div>
      <div class="interp muted">正確率 ${r.counted ? ((r.correct / r.counted) * 100).toFixed(0) : 0}%</div></div>
    <div class="metric"><div class="name">實得分數</div><div class="val">${r.earned.toFixed(1)}</div>
      <div class="interp muted">滿分 ${r.counted}.0</div></div>
    <div class="metric"><div class="name">使用提示</div><div class="val">${r.hints}</div>
      <div class="interp ${r.hints ? 'muted' : 'good'}">${r.hints ? '該題滿分降為 0.5' : '未使用'}</div></div>`;

  $('reviewBody').innerHTML = state.questions.map((q, i) => {
    if (q.state === QState.VOID) {
      return `<tr><td>${i + 1}</td><td class="ans vd">—</td><td class="vd">資源載入失敗</td><td class="mk vd">作廢</td></tr>`;
    }
    const got = q.correct ? '<span class="ok">答對</span>' : '<span class="no">答錯</span>';
    return `<tr><td>${i + 1}</td><td class="ans">${escapeHtml(q.item.ans)}</td>`
      + `<td>${got}${q.mark === HINTED_MARK ? '（提示）' : ''}</td>`
      + `<td class="mk">${q.correct ? q.mark.toFixed(1) : '0.0'}</td></tr>`;
  }).join('');

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── 成績卡（純 Canvas，不含任何跨域圖片 — 規格 D7）───────────────────

async function downloadCard() {
  const r = scoreQuiz(state.questions);
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

  g.fillStyle = T.text; g.font = sans(700, 26);
  g.fillText('藥品辨識王', 52, 88);
  g.fillStyle = T.muted; g.font = sans(400, 13);
  g.fillText('藥師外觀辨識自我測驗　·　食藥署藥品外觀資料集', 52, 112);

  // 分數。寬度必須在字型仍為 mono 96px 時量測，換字型後再量會得到錯誤值
  const scoreTxt = r.score.toFixed(1);
  g.fillStyle = T.accent; g.font = mono(700, 96);
  g.fillText(scoreTxt, 52, 218);
  const scoreW = g.measureText(scoreTxt).width;
  g.font = sans(400, 15); g.fillStyle = T.muted;
  g.fillText('/ 100', 52 + scoreW + 14, 218);

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
  g.fillText('本工具為教育練習用，非臨床調劑或給藥的辨識依據。', 52, y + 64);

  const blob = await new Promise((ok) => cv.toBlob(ok, 'image/png'));
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `藥品辨識王_${r.score.toFixed(0)}分_${new Date().toISOString().slice(0, 10)}.png`;
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

$('btnStart').addEventListener('click', startQuiz);
$('btnAgain').addEventListener('click', startQuiz);
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
