/**
 * V5.2 變異驗證（A62 / M1–M15）。
 *
 * 對每個變異：備份 → 套用弱化 → 跑全套測試 → 還原 → 記錄是否轉紅。
 * **跑全套而不是只跑我猜的那一檔**——「哪個檔會紅」本身就是要驗的東西之一。
 *
 * 用法：node .ai-review/mutate-v52.mjs [M1,M5,...]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const F = (n) => path.join(ROOT, n);

/** 每條變異＝一組 [檔案, 原字串, 弱化字串]。原字串必須唯一命中一次 */
const MUTANTS = {
  M1: ['app.js',
    '  if (state.level && lenOff(state.level, len)) return;',
    '  // [MUTANT M1] 拿掉 selectLen 守門'],
  M2: ['app.js',
    '  const prev = prevLv[len] || {};',
    '  const prev = prevLv[20] || prevLv[10] || {};   // [MUTANT M2] 卷長層塌回單一格'],
  M3: ['app.js',
    '  const bestStreak = validEntry(s.bestStreak, { max: len, int: true });',
    '  const bestStreak = validEntry(s.bestStreak, { max: QUIZ_SIZE, int: true }); // [MUTANT M3]'],
  M4: ['app.js',
    '      if (!QUIZ_LENGTHS.includes(len) || len === QUIZ_SIZE) continue;',
    '      if (!QUIZ_LENGTHS.includes(len) || len === QUIZ_SIZE) return null; // [MUTANT M4]'],
  M5: ['app.js',
    '  const probe = state.fx?.levels[level]?.byLen[len];',
    '  const cap = state.fx?.levels[level]?.cap;\n  const probe = state.fx?.levels[level]?.byLen[cap];\n  if (probe?.quiz) probe.quiz = probe.quiz.slice(0, len); // [MUTANT M5] 截斷別格產物'],
  M6: ['formulary.js',
    '  return crc32(new TextEncoder().encode(`${payload}|${level}|${len}`));',
    '  return crc32(new TextEncoder().encode(`${payload}|${level}`)); // [MUTANT M6] seed 不含卷長'],
  M7: ['app.js',
    "  renderResult({ record: state.mode !== 'retry' && !state.fx });",
    "  renderResult({ record: state.mode !== 'retry' }); // [MUTANT M7] 院內版開始寫紀錄"],
  M8: ['app.js',
    '    const parts = recLengths(recs[lv])\n      .map((len) => `${len} 題 ${recs[lv][len].bestScore.value.toFixed(1)}`);\n    return `${LEVELS[lv].name} ${parts.join(\'／\')}`;',
    '    const best = Math.max(...recLengths(recs[lv]).map((len) => recs[lv][len].bestScore.value));\n    return `${LEVELS[lv].name} ${best.toFixed(1)}`; // [MUTANT M8] 跨卷長取 max'],
  M9: ['app.js',
    '        level, n: len, rng: Math.random,',
    '        level, n: QUIZ_SIZE, rng: Math.random, // [MUTANT M9] 顯示 10 實際抽 20'],
  M10: ['app.js',
    "  try { obj = JSON.parse(raw); } catch { return {}; }                 // E4",
    "  try { obj = JSON.parse(raw); } catch { ls.removeItem(RECORDS_KEY); return {}; } // [MUTANT M10]"],
  M11: ['app.js',
    '  const hasTop = r.bestScore !== undefined || r.bestStreak !== undefined;\n  if (hasTop) {\n    const top = validSlot(r, QUIZ_SIZE);\n    if (!top) return null;\n    out[QUIZ_SIZE] = top;\n  }',
    '  const top = validSlot(r, QUIZ_SIZE);        // [MUTANT M11] 要求頂層必存在\n  if (!top) return null;\n  out[QUIZ_SIZE] = top;'],
  M12: ['app.js',
    '  const probe = state.fx?.levels[level]?.byLen[len];',
    '  const probe = state.fx?.levels[level]?.byLen[state.fx.levels[level].cap]; // [MUTANT M12] 取錯格'],
  M13: ['formulary.js', '__NOOP_M13__', '__NOOP_M13__'],   // 見下方 special
  M14: ['formulary.js',
    '  const available = selectable.some((len) => byLen[len].available);',
    '  const available = selectable.every((len) => byLen[len].available); // [MUTANT M14]'],
  M15: ['app.js',
    '  try { ls.setItem(RECORDS_KEY, JSON.stringify(next)); } catch { return null; }   // E3',
    '  try { ls[RECORDS_KEY] = JSON.stringify(next); } catch { return null; } // [MUTANT M15] 繞過 setItem'],
};

// M13：byLen["20"] 被採信（改 app.js 的忽略條件，讓錯位的 20 覆蓋頂層）
MUTANTS.M13 = ['app.js',
  '      if (!QUIZ_LENGTHS.includes(len) || len === QUIZ_SIZE) continue;',
  '      if (!QUIZ_LENGTHS.includes(len)) continue; // [MUTANT M13] 採信 byLen["20"]'];

const only = (process.argv[2] || '').split(',').filter(Boolean);
const names = only.length ? only : Object.keys(MUTANTS);
const results = [];

/**
 * **原始檔是 CRLF**（`app.js`／`formulary.js` 都是）。錨字串寫在這裡是 LF，
 * 所以多行錨會 0 命中——而 `ANCHOR_FAIL` 看起來很像「變異存活」。
 * 第一次跑就是這樣：13 條單行錨全中，兩條多行錨全掉，而我差點把它讀成
 * 「M8／M11 沒被測試擋住」。**先把錨換成該檔實際使用的行尾再比對。**
 */
const toEol = (s, src) => (src.includes('\r\n') ? s.replace(/\n/g, '\r\n') : s);

for (const name of names) {
  const [file, rawFrom, rawTo] = MUTANTS[name];
  const p = F(file);
  const orig = fs.readFileSync(p, 'utf8');
  const from = toEol(rawFrom, orig);
  const to = toEol(rawTo, orig);
  const hits = orig.split(from).length - 1;
  if (hits !== 1) {
    results.push({ name, status: 'ANCHOR_FAIL', detail: `錨字串命中 ${hits} 次（需恰好 1）` });
    console.log(`${name}: ANCHOR_FAIL (${hits} hits)`);
    continue;
  }
  fs.writeFileSync(p, orig.replace(from, to), 'utf8');
  let status = 'SURVIVED';
  let detail = '';
  try {
    execFileSync('npm', ['test'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', shell: true });
  } catch (e) {
    status = 'KILLED';
    const out = `${e.stdout || ''}`;
    const failed = [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]);
    detail = [...new Set(failed)].slice(0, 4).join(' / ');
  } finally {
    fs.writeFileSync(p, orig, 'utf8');
  }
  results.push({ name, status, detail });
  console.log(`${name}: ${status}  ${detail}`);
}

console.log('\n=== 摘要 ===');
for (const r of results) console.log(`${r.name}\t${r.status}\t${r.detail}`);
const survived = results.filter((r) => r.status !== 'KILLED');
console.log(survived.length ? `\n未轉紅：${survived.map((r) => r.name).join(', ')}` : '\n全部轉紅');
