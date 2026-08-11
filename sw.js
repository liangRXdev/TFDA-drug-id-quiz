/* 藥品辨識王 Service Worker
 *
 * **只快取 app shell，題庫與藥品圖片一律直通網路。**
 *
 * 這條界線是本檔存在的全部理由，改動前先讀完：
 *
 * 1. `data/pool.json` 與 `data/img/**` 進了快取，就會出現
 *    「新 pool 配舊圖片」——pool 更新後答案鍵換了、SW 卻回舊圖，
 *    使用者看到的是 A 藥的照片配 B 藥的名字。那是本工具最怕的失效模式
 *    （見 CLAUDE.md「判定紀律」）。
 * 2. 全部圖片約 50MB，預載與「首屏 <3MB」直接衝突。
 *
 * 因此本工具**可安裝、但不宣稱離線可用**：離線時開得起來，
 * 但題庫載不到，app.js 會走既有的 C4 失敗路徑顯示「無法連線讀取題庫」。
 * 那是誠實的降級——不是壞掉。
 *
 * shell 用 network-first：題庫格式與程式碼是綁在一起的（pool.json 的
 * `meta.schema` 對應 app.js 的 `SCHEMA` 常數），快取回舊 app.js 配新 pool
 * 會直接撞 schema 檢查而中止。網路可用時一律拿新的，快取只作為離線兜底。
 */
/**
 * **每一批交付都必須升版**，不設條件——
 * 批次一定會動到 index.html／app.js／engine.js，三者都在 shell 清單內。
 * `tests/sw.test.mjs` 的 C31 把這個字串釘死，改版時必須一併改，
 * 「這批沒新增資源所以不用升」的判斷不留給下一個人。
 */
const CACHE = 'tfda-drug-id-quiz-v5';
const SHELL = [
  './',
  'index.html',
  'app.js',
  'engine.js',
  'formulary.js',
  'manifest.webmanifest',
  'icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // 字型等外部資源不攔截

  // 題庫與藥品圖片：完全不攔截，交給瀏覽器直接連網。
  // 不是「快取但優先網路」——是連 respondWith 都不呼叫，
  // 確保這些請求的行為與沒有 SW 時完全一致
  if (url.pathname.includes('/data/')) return;

  event.respondWith(networkFirst(req));
});

/** 網路優先，失敗才回快取。離線時 shell 開得起來，但題庫仍會失敗 */
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    // 導覽請求離線且未快取時，至少回入口頁（scope 內的深連結）
    if (req.mode === 'navigate') {
      const shell = await cache.match('index.html');
      if (shell) return shell;
    }
    throw new Error('offline and not cached');
  }
}
