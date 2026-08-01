#!/usr/bin/env node
/**
 * G1 — L2 照片可辨識 gate 的樣本產生器（規格 plan-v3-levels.md §0）
 *
 * 這不是產品程式碼，是一次性的規格 gate 工具。刻意放在 .ai-review/ 而非 tools/，
 * 因為 tools/ 是發布管線，本次變更不得觸及（D17）。
 *
 * 產出單一自足 HTML（圖片以 data: URI 內嵌），可直接在手機開啟，
 * 不需 server、不依賴 GH Pages、不會被發布到正式站。
 *
 * 固定 seed → 樣本可重現，gate 結果可被重驗。
 *
 *   node .ai-review/g1-sample.mjs [seed]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { squash, editDistance, makeRng } from '../engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');

const SEED = Number(process.argv[2] ?? 20260801);
const N_PER_STRATUM = 10;
const MIN_SHORT_IMPRINT = 10;   // 刻字 ≤3 字元者至少 10 組（最難的一類）
const SHORT_IMPRINT_LEN = 3;

// ── 規格條件 ──────────────────────────────────────────────────────────

const sq = (v) => String(v ?? '').replace(/\s+/g, '').toUpperCase();
const setKey = (a) => a.join('|');

/** D12：L2 判別鍵。刻意去掉 size 與 score_mark 這兩個照片上的弱訊號 */
const l2key = (it) =>
  `${setKey(it.shape)}#${setKey(it.color)}#${sq(it.mark1)}#${sq(it.mark2)}`;

/** §4.3 嚴格條件：同形同色 */
const appearanceKey = (it) => `${setKey(it.shape)}#${setKey(it.color)}`;

/**
 * D13：名稱碰撞。比較輸入一律為 squash(ans)，完全相等由 H1 處理不再算前綴碰撞。
 */
function collides(a, b) {
  const x = squash(a), y = squash(b);
  if (x === y) return false;                       // 相等交給 H1
  if (editDistance(x, y, 1) <= 1) return true;     // 編輯距離 ≤1
  return x.startsWith(y) || y.startsWith(x);       // 前綴包含
}

// ── 載入題庫 ──────────────────────────────────────────────────────────

const pool = JSON.parse(fs.readFileSync(path.join(DATA, 'pool.json'), 'utf8'));
const items = pool.items;

const byAppearance = new Map();
for (const it of items) {
  const k = appearanceKey(it);
  if (!byAppearance.has(k)) byAppearance.set(k, []);
  byAppearance.get(k).push(it);
}
const byAns = new Map();
for (const it of items) {
  if (!byAns.has(it.ans)) byAns.set(it.ans, []);
  byAns.get(it.ans).push(it);
}

// ── 分層 ──────────────────────────────────────────────────────────────

function stratum(it) {
  const s = setKey(it.shape), c = setKey(it.color);
  if (s === '圓形' && c === '白') return 'A';                 // 常見
  if ((s === '膠囊' || s === '橢圓形') && it.color.length === 1) return 'B'; // 次常見
  return 'C';                                                 // 稀有
}

// ── 組題（§4.3 嚴格條件 + H1/H3 + L2key 兩兩相異）─────────────────────

function buildQuestion(correct, rng) {
  const pool0 = (byAppearance.get(appearanceKey(correct)) || [])
    .filter((o) => o.ans !== correct.ans);

  // 每個誘答答案鍵只取一筆紀錄，避免同鍵多筆佔滿候選
  const seen = new Set();
  const cands = [];
  for (const o of pool0) {
    if (seen.has(o.ans)) continue;
    seen.add(o.ans);
    cands.push(o);
  }
  // 洗牌在複本上進行（D20）
  const c = cands.slice();
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]];
  }

  const chosen = [];
  const keys = new Set([l2key(correct)]);
  for (const cand of c) {
    if (chosen.length === 3) break;
    if (keys.has(l2key(cand))) continue;                       // L2key 兩兩相異
    if (collides(cand.ans, correct.ans)) continue;             // D13 對正解
    if (chosen.some((x) => collides(cand.ans, x.ans))) continue; // D13 誘答彼此
    chosen.push(cand);
    keys.add(l2key(cand));
  }
  if (chosen.length < 3) return null;

  // H4：正解位置由 RNG 決定
  const options = [correct, ...chosen];
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return { correct, options, answerIdx: options.indexOf(correct) };
}

// ── 抽樣 ──────────────────────────────────────────────────────────────

const rng = makeRng(SEED);

// 每個答案鍵取一筆代表紀錄
const reps = [...byAns.values()].map((recs) => recs[Math.floor(rng() * recs.length)]);
const buckets = { A: [], B: [], C: [] };
for (const it of reps) buckets[stratum(it)].push(it);

function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

const isShort = (it) => sq(it.mark1).length <= SHORT_IMPRINT_LEN;

/**
 * 每層取固定配比：短刻字 4 題 + 一般刻字 6 題。
 *
 * 短刻字是最難的一類，但**不能讓它佔滿樣本**——那會系統性低估通過率，
 * 使 gate 量到的不是「L2 是否可解」而是「最壞情況是否可解」。
 * 4×3 = 12 ≥ MIN_SHORT_IMPRINT，同時保留多數為代表性題目。
 */
const SHORT_PER_STRATUM = 4;

function take(src, n, s, got) {
  for (const it of src) {
    if (got.length >= n) break;
    const q = buildQuestion(it, rng);
    if (!q) continue;                       // 湊不到 3 個合法誘答，跳過
    got.push(Object.assign(q, { stratum: s }));
  }
  return got;
}

const picked = [];
for (const s of ['A', 'B', 'C']) {
  const short = shuffle(buckets[s].filter(isShort));
  const long = shuffle(buckets[s].filter((it) => !isShort(it)));

  const gotShort = take(short, SHORT_PER_STRATUM, s, []);
  const gotLong = take(long, N_PER_STRATUM - gotShort.length, s, []);
  let got = [...gotShort, ...gotLong];
  // 任一類不足時由另一類補滿，維持每層 10 題
  if (got.length < N_PER_STRATUM) {
    const used = new Set(got.map((q) => q.correct.id));
    got = take([...short, ...long].filter((it) => !used.has(it.id)), N_PER_STRATUM, s, got);
  }
  if (got.length < N_PER_STRATUM) {
    console.error(`[警告] 分層 ${s} 只湊到 ${got.length}/${N_PER_STRATUM} 題`);
  }
  picked.push(...shuffle(got.slice(0, N_PER_STRATUM)));
}

const shortCount = picked.filter((q) => isShort(q.correct)).length;
console.log(`抽出 ${picked.length} 題（A ${picked.filter((q) => q.stratum === 'A').length}`
  + ` / B ${picked.filter((q) => q.stratum === 'B').length}`
  + ` / C ${picked.filter((q) => q.stratum === 'C').length}）`);
console.log(`刻字 ≤${SHORT_IMPRINT_LEN} 字元：${shortCount} 題（要求 ≥${MIN_SHORT_IMPRINT}）`);
if (shortCount < MIN_SHORT_IMPRINT) console.error('[警告] 短刻字題數未達標');

// ── 內嵌圖片 ──────────────────────────────────────────────────────────

const cache = new Map();
function dataUri(img) {
  if (!cache.has(img)) {
    const buf = fs.readFileSync(path.join(DATA, img));
    cache.set(img, `data:image/webp;base64,${buf.toString('base64')}`);
  }
  return cache.get(img);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const payload = picked.map((q, i) => ({
  n: i + 1,
  stratum: q.stratum,
  full: q.correct.full,
  zh: q.correct.zh,
  answerIdx: q.answerIdx,
  short: isShort(q.correct),
  options: q.options.map((o) => ({ ans: o.ans, full: o.full, mark: o.mark1, src: dataUri(o.img) })),
}));

// ── 輸出 ──────────────────────────────────────────────────────────────

const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>G1 — L2 照片可辨識 gate</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#F5F0E8;color:#2C2C2C;font:15px/1.5 "Noto Sans TC",system-ui,sans-serif;
  display:flex;justify-content:center;padding:0 0 3rem}
#app{width:100%;max-width:360px;padding:12px}
header{position:sticky;top:0;background:#F5F0E8;padding:10px 0;border-bottom:1px solid #E0D9CE;z-index:2}
h1{font-size:.95rem;font-weight:700}
.sub{font-size:.72rem;color:#6B7280;margin-top:2px}
.bar{height:4px;background:#E0D9CE;border-radius:2px;margin-top:8px;overflow:hidden}
.bar i{display:block;height:100%;background:#3D7A8A;width:0;transition:width .2s}
.tally{display:flex;gap:10px;font-size:.72rem;color:#6B7280;margin-top:6px}
.tally b{color:#2C2C2C;font-variant-numeric:tabular-nums}
.card{background:#fff;border:1px solid #E0D9CE;border-radius:10px;padding:14px;margin-top:14px}
.tag{display:inline-block;font-size:.62rem;color:#6B7280;border:1px solid #E0D9CE;
  border-radius:99px;padding:1px 7px;margin-bottom:8px}
.name{font-size:1.02rem;font-weight:700;letter-spacing:.02em;word-break:break-word}
.zh{font-size:.8rem;color:#6B7280;margin-top:3px}
.ask{font-size:.75rem;color:#3D7A8A;margin:10px 0 8px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.cell{position:relative;border:2px solid #E0D9CE;border-radius:8px;overflow:hidden;
  background:#FAF7F2;cursor:pointer;padding:0;aspect-ratio:1/1}
/* 候選補救條件：單欄全寬、直式比例，像素量約 4.5× */
body.wide .grid{grid-template-columns:1fr}
body.wide .cell{aspect-ratio:3/4}
.cond{display:flex;gap:6px;margin-top:8px}
.cond button{flex:1;padding:6px 4px;font-size:.66rem;border:1px solid #E0D9CE;
  background:#fff;color:#6B7280;border-radius:6px;cursor:pointer;line-height:1.3}
.cond button.on{background:#3D7A8A;border-color:#3D7A8A;color:#fff;font-weight:700}
.cell img{width:100%;height:100%;object-fit:contain;display:block}
.cell .num{position:absolute;top:4px;left:4px;background:rgba(255,255,255,.9);
  border-radius:4px;font-size:.65rem;padding:0 5px;color:#6B7280}
.cell.ok{border-color:#27AE60}
.cell.no{border-color:#C0392B}
.cell .mk{position:absolute;top:4px;right:4px;font-size:.9rem;font-weight:700}
.cell.ok .mk{color:#27AE60}
.cell.no .mk{color:#C0392B}
.reveal{margin-top:10px;font-size:.72rem;display:none}
.reveal.on{display:block}
.reveal div{padding:3px 0;border-top:1px dashed #E0D9CE;word-break:break-word}
.reveal .hit{color:#27AE60;font-weight:700}
.verdict{margin-top:10px;font-size:.8rem;font-weight:700}
.verdict.ok{color:#27AE60}
.verdict.no{color:#C0392B}
button.next{margin-top:12px;width:100%;padding:11px;border:0;border-radius:8px;
  background:#3D7A8A;color:#fff;font-size:.85rem;font-weight:700;cursor:pointer;display:none}
button.next.on{display:block}
#done{display:none;background:#fff;border:1px solid #E0D9CE;border-radius:10px;
  padding:20px;margin-top:14px;text-align:center}
#done.on{display:block}
#done .rate{font-size:2.6rem;font-weight:700;font-variant-numeric:tabular-nums;margin:6px 0}
#done .gate{font-size:.85rem;font-weight:700;margin-top:10px;padding:10px;border-radius:8px}
#done .gate.pass{background:#EAF7EF;color:#1E7E45}
#done .gate.adjust{background:#FDF3E3;color:#9A6318}
#done .gate.fail{background:#FBEAE8;color:#A5342A}
#done .bd{font-size:.72rem;color:#6B7280;margin-top:12px;text-align:left;line-height:1.7}
.note{font-size:.68rem;color:#6B7280;margin-top:16px;line-height:1.6}
</style>
</head>
<body>
<div id="app">
<header>
  <h1>G1 — L2 照片可辨識 gate</h1>
  <div class="sub">規格 <code>plan-v3-levels.md</code> §0 ｜ seed ${SEED} ｜ 通過門檻 <b>80%（24/30）</b></div>
  <div class="cond">
    <button id="cA" class="on">條件 1（規格）<br>2×2 · 約 160px</button>
    <button id="cB">條件 2（候選補救）<br>單欄 · 約 340px</button>
  </div>
  <div class="bar"><i id="bar"></i></div>
  <div class="tally">
    <span>第 <b id="cur">1</b>/<b>${payload.length}</b> 題</span>
    <span>答對 <b id="hit">0</b></span>
    <span>目前正確率 <b id="pct">—</b></span>
  </div>
</header>
<div id="stage"></div>
<div id="done"></div>
<p class="note">
  這是規格 gate，不是產品畫面。呈現條件固定為 <b>375px 寬、2×2、單格約 160px</b>，
  與 §6.2 的 L2 版面一致。<b>可以兩指縮放</b>——正式站沒有停用縮放（D22），
  臨床上也本來就會把藥錠拿近看，湊近看不算作弊。<br><br>
  判斷依據只有四張照片。答錯不是你的問題，是題目不可解；這正是要量的東西。
</p>
</div>
<script>
const Q = ${JSON.stringify(payload)};
const STRATA = { A: '常見形色（圓形／白）', B: '次常見（膠囊／橢圓形）', C: '稀有形色' };
let i = 0, hit = 0, locked = false, cond = 'A';
const $ = (id) => document.getElementById(id);

/**
 * 切換呈現條件會重置計分。
 * 兩個條件的通過率必須分開記錄——混在一起量到的不是任何一個規格。
 */
function setCond(c) {
  if (c === cond) return;
  if (i > 0 && !confirm('切換呈現條件會從第 1 題重新開始（兩個條件的通過率必須分開記錄）。要切換嗎？')) return;
  cond = c;
  document.body.classList.toggle('wide', c === 'B');
  $('cA').className = c === 'A' ? 'on' : '';
  $('cB').className = c === 'B' ? 'on' : '';
  i = 0; hit = 0;
  $('hit').textContent = '0';
  $('pct').textContent = '—';
  $('done').className = '';
  render();
}
$('cA').addEventListener('click', () => setCond('A'));
$('cB').addEventListener('click', () => setCond('B'));

function render() {
  const q = Q[i];
  locked = false;
  $('cur').textContent = q.n;
  $('bar').style.width = ((i / Q.length) * 100) + '%';
  $('stage').innerHTML =
    '<div class="card">'
    + '<span class="tag">' + STRATA[q.stratum] + (q.short ? ' ｜ 短刻字' : '') + '</span>'
    + '<div class="name">' + q.full.replace(/[&<>]/g, '') + '</div>'
    + (q.zh ? '<div class="zh">' + q.zh.replace(/[&<>]/g, '') + '</div>' : '')
    + '<div class="ask">哪一張是這個藥？</div>'
    + '<div class="grid">'
    + q.options.map((o, k) =>
        '<button class="cell" data-k="' + k + '">'
        + '<span class="num">' + (k + 1) + '</span>'
        + '<img src="' + o.src + '" alt="選項 ' + (k + 1) + '">'
        + '</button>').join('')
    + '</div>'
    + '<div class="reveal" id="rv"></div>'
    + '<div class="verdict" id="vd"></div>'
    + '<button class="next" id="nx"></button>'
    + '</div>';

  document.querySelectorAll('.cell').forEach((el) => {
    el.addEventListener('click', () => pick(Number(el.dataset.k)));
  });
  $('nx').addEventListener('click', next);
  window.scrollTo({ top: 0 });
}

function pick(k) {
  if (locked) return;
  locked = true;
  const q = Q[i];
  const correct = k === q.answerIdx;
  if (correct) hit++;

  document.querySelectorAll('.cell').forEach((el) => {
    const kk = Number(el.dataset.k);
    if (kk === q.answerIdx) { el.classList.add('ok'); el.insertAdjacentHTML('beforeend', '<span class="mk">✓</span>'); }
    else if (kk === k) { el.classList.add('no'); el.insertAdjacentHTML('beforeend', '<span class="mk">✗</span>'); }
  });

  $('rv').className = 'reveal on';
  $('rv').innerHTML = q.options.map((o, kk) =>
    '<div class="' + (kk === q.answerIdx ? 'hit' : '') + '">'
    + (kk + 1) + '. ' + o.ans.replace(/[&<>]/g, '')
    + '　<span style="color:#6B7280">刻字 ' + (o.mark || '—').replace(/[&<>]/g, '') + '</span></div>').join('');

  $('vd').className = 'verdict ' + (correct ? 'ok' : 'no');
  $('vd').textContent = correct ? '✓ 判對' : '✗ 判錯 — 這題在此呈現條件下不可解';

  $('hit').textContent = hit;
  $('pct').textContent = Math.round((hit / (i + 1)) * 100) + '%';
  $('nx').className = 'next on';
  $('nx').textContent = i + 1 >= Q.length ? '看結果' : '下一題';
}

function next() {
  i++;
  if (i >= Q.length) return finish();
  render();
}

function finish() {
  $('stage').innerHTML = '';
  $('bar').style.width = '100%';
  const rate = (hit / Q.length) * 100;
  const g = rate >= 80 ? ['pass', 'G1 通過 → D12 定案，L2 可動工']
    : rate >= 60 ? ['adjust', 'G1 未達門檻 → D12 需調整（單格加大或預設放大）']
    : ['fail', 'G1 明確失敗 → L2 誘答原則須改，重跑 /codex-checkplan'];
  const byS = {};
  Q.forEach((q, k) => { (byS[q.stratum] = byS[q.stratum] || []).push(k); });
  const lines = ['A', 'B', 'C'].map((s) => {
    const ks = byS[s] || [];
    return STRATA[s] + '：' + ks.length + ' 題';
  }).join('<br>');
  const cname = cond === 'A' ? '條件 1（規格：2×2 · 約 160px）' : '條件 2（候選補救：單欄 · 約 340px）';
  $('done').className = 'on';
  $('done').innerHTML =
    '<div style="font-size:.8rem;color:#6B7280">' + cname + '<br>最終正確率</div>'
    + '<div class="rate">' + rate.toFixed(1) + '%</div>'
    + '<div style="font-size:.8rem;color:#6B7280">' + hit + ' / ' + Q.length + '　門檻 80%（24/30）</div>'
    + '<div class="gate ' + g[0] + '">' + g[1] + '</div>'
    + '<div class="bd"><b>分層組成</b><br>' + lines
    + '<br><br><b>只有條件 1 是規格所寫的 D12。</b>條件 2 若通過而條件 1 未通過，'
    + '代表 D12 的版面須改（§6.2），不是誘答原則須改。<br><br>'
    + '把兩個條件的數字與判定填回 <code>.ai-review/plan-v3-levels.md</code> §0 作為 gate 紀錄。</div>';
  window.scrollTo({ top: 0 });
}

render();
</script>
</body>
</html>`;

const out = path.join(HERE, 'g1-sample.html');
fs.writeFileSync(out, html, 'utf8');
const mb = (Buffer.byteLength(html) / 1048576).toFixed(2);
console.log(`\n輸出：${out}（${mb} MB，含 ${cache.size} 張內嵌圖片）`);
