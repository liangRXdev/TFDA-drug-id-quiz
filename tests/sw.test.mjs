/**
 * Service Worker 快取界線
 *
 *   node --test
 *
 * 本工具**可安裝但不宣稱離線可用**，全部理由壓在一條界線上：
 * 題庫（`data/pool.json`）與藥品圖片（`data/img/**`）永遠不進快取。
 * 破了這條，pool 更新後就會出現「新答案鍵配舊圖片」——
 * 顯示 A 藥的照片、標成 B 藥的名字，正是本工具最怕的失效模式。
 *
 * 這裡不做靜態字串比對，而是真的把 `sw.js` 載進受控的假 SW 全域、
 * 驅動它的 fetch handler：只驗「原始碼裡有那行 return」的測試，
 * 擋不住有人在別處先呼叫了 respondWith。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './_ui-harness.mjs';

const ORIGIN = 'https://example.test';

/** 把 sw.js 載進假的 SW 全域，回傳事件 listener 與快取內容 */
function loadSw() {
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const listeners = {};
  const store = new Map();

  const cache = {
    addAll: async (urls) => urls.forEach((u) => store.set(u, `body:${u}`)),
    put: async (req, res) => store.set(typeof req === 'string' ? req : req.url, res),
    match: async (req) => store.get(typeof req === 'string' ? req : req.url),
  };
  const caches = {
    open: async () => cache,
    keys: async () => ['tfda-drug-id-quiz-v1'],
    delete: async () => true,
    match: async (req) => cache.match(req),
  };
  const self = {
    addEventListener: (k, fn) => { listeners[k] = fn; },
    location: { origin: ORIGIN },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };

  const fetched = [];
  const fetchStub = async (req) => {
    fetched.push(typeof req === 'string' ? req : req.url);
    return { ok: true, clone: () => ({ ok: true, cached: true }), url: req.url ?? req };
  };

  // sw.js 是 classic script，不能 import；在受控 scope 執行
  new Function('self', 'caches', 'fetch', 'URL', 'Error', src)(
    self, caches, fetchStub, URL, Error,
  );
  return { listeners, store, fetched, caches };
}

/** 驅動 fetch handler，回報 respondWith 是否被呼叫 */
async function handleFetch(listeners, url, { mode = 'no-cors', method = 'GET' } = {}) {
  let responded = false;
  let result;
  const event = {
    request: { url, method, mode },
    respondWith: (p) => { responded = true; result = p; },
    waitUntil: () => {},
  };
  listeners.fetch(event);
  if (responded) { try { result = await result; } catch (e) { result = e; } }
  return { responded, result };
}

describe('SW 快取界線：題庫與圖片永不進快取', () => {
  test('install 只快取 app shell，清單不含任何 data/ 路徑', async () => {
    const { listeners, store } = loadSw();
    let done;
    listeners.install({ waitUntil: (p) => { done = p; } });
    await done;

    const cached = [...store.keys()];
    assert.ok(cached.length > 0, 'shell 應該有被快取');
    const leaked = cached.filter((u) => u.includes('data/') || u.endsWith('.webp') || u.includes('pool.json'));
    assert.deepEqual(leaked, [], `題庫／圖片不得出現在 shell 快取清單：${leaked}`);
    // shell 必要項目
    for (const must of ['index.html', 'app.js', 'engine.js']) {
      assert.ok(cached.includes(must), `shell 少了 ${must}`);
    }
  });

  test('pool.json 的請求完全不被攔截', async () => {
    // 〔堵〕改成「快取但網路優先」也算破線——pool 是唯一的答案來源，
    //       任何情況下都必須拿到當下的版本，不能有回快取的路徑
    const { listeners } = loadSw();
    const { responded } = await handleFetch(listeners, `${ORIGIN}/data/pool.json`);
    assert.equal(responded, false, 'SW 不得對 pool.json 呼叫 respondWith');
  });

  test('藥品圖片的請求完全不被攔截', async () => {
    const { listeners } = loadSw();
    const { responded } = await handleFetch(listeners, `${ORIGIN}/data/img/9628e7c4ecd079c2.webp`);
    assert.equal(responded, false, 'SW 不得對藥品圖片呼叫 respondWith');
  });

  test('shell 資源走網路優先，成功時才寫回快取', async () => {
    const { listeners, fetched } = loadSw();
    const { responded } = await handleFetch(listeners, `${ORIGIN}/app.js`);
    assert.equal(responded, true, 'shell 應由 SW 接手');
    assert.ok(fetched.includes(`${ORIGIN}/app.js`), '網路優先：應先打網路');
  });

  test('跨域請求（Google Fonts）不攔截', async () => {
    const { listeners } = loadSw();
    const { responded } = await handleFetch(listeners, 'https://fonts.gstatic.com/s/a.woff2');
    assert.equal(responded, false);
  });

  test('非 GET 請求不攔截', async () => {
    const { listeners } = loadSw();
    const { responded } = await handleFetch(listeners, `${ORIGIN}/app.js`, { method: 'POST' });
    assert.equal(responded, false);
  });
});

describe('C31 每批交付無條件升 CACHE 版本', () => {
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

  test('CACHE 版本字串已升到本批的值', () => {
    // 〔堵〕只改既有 shell 檔而不新增資源時，條件式斷言會直接跳過升版檢查。
    //       這裡把版本釘死：改 shell 就必須同時改 sw.js 與這一行，
    //       「這批沒新增資源所以不用升」的判斷不留給下一個人
    const m = /const CACHE = '([^']+)'/.exec(src);
    assert.ok(m, 'sw.js 必須有 const CACHE');
    assert.equal(m[1], 'tfda-drug-id-quiz-v3', '本批（批次 A 覆審修正）必須升到 v3');
  });

  test('shell 清單的每個資源都真的存在', async () => {
    // 由實際的 install 事件驅動，不比對原始碼字串
    const { listeners, store } = loadSw();
    let done;
    listeners.install({ waitUntil: (p) => { done = p; } });
    await done;
    for (const u of store.keys()) {
      if (u === './') continue;
      assert.ok(fs.existsSync(path.join(ROOT, u)), `shell 清單引用了不存在的檔案：${u}`);
    }
  });
});

describe('PWA 資產完整性', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));

  test('manifest 具備可安裝所需的 192／512 圖示且檔案存在', () => {
    const sizes = manifest.icons.map((i) => i.sizes);
    assert.ok(sizes.includes('192x192'), '缺 192x192，Chrome 不會提示安裝');
    assert.ok(sizes.includes('512x512'), '缺 512x512');
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), '缺 maskable 圖示');
    for (const icon of manifest.icons) {
      assert.ok(fs.existsSync(path.join(ROOT, icon.src)), `圖示檔不存在：${icon.src}`);
    }
  });

  test('manifest 不得宣稱離線可用', () => {
    // 〔堵〕描述寫「可離線使用」，但題庫從不快取——那是對使用者的假承諾
    assert.doesNotMatch(manifest.description, /離線|offline/i);
    assert.match(manifest.description, /需連網/);
  });

  test('index.html 有註冊 SW 且引用的圖示都存在', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /serviceWorker.*register\(['"]sw\.js['"]\)/s);
    for (const m of html.matchAll(/(?:href|src)="(icons?\/[^"]+|icon\.svg)"/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, m[1])), `index.html 引用了不存在的圖示：${m[1]}`);
    }
  });
});
