/**
 * 最小 DOM 樁，供 ui-smoke.test.mjs 實際載入並驅動 app.js。
 *
 * 存在的理由：C7（未選級別不得開始）、C8（L2 不得洩漏外觀特徵）、
 * C9/C10（資源失敗的替換與作廢）、C11（遲到事件）、C13（成績卡印出級別與基線）、
 * §6.1（再測一回須重設級別）這幾條，engine 的純函式測試碰不到——
 * 它們全在 DOM 與事件的接線層。沒有這層，那幾條只能靠開發者目視打勾，
 * 而目視打勾無法防回歸（覆審 3.1-4）。
 *
 * 這不是完整的 DOM 實作，只支援 app.js 實際用到的 API。
 * 刻意不引入 jsdom：本專案零依賴，為了測試加一整棵相依樹不划算。
 *
 * 檔名以 `_` 開頭，避免被 `tests/**\/*.test.mjs` 當成測試檔執行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const attrs = (tag, name) =>
  [...tag.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => m[1]);

/** 圖片載入行為的控制盤，由測試操作 */
export const imgControl = {
  fail: new Set(),      // 這些 src 會觸發 onerror
  pending: new Set(),   // 這些 src 永不 settle（用來測 ready-gate 與逾時）
  loaded: [],           // 依序記錄成功載入的 src
  reset() { this.fail.clear(); this.pending.clear(); this.loaded.length = 0; },
};

/**
 * localStorage 的控制盤（規格 v4 D25 的 E1–E7）。
 *
 * `calls` 記錄的是**每一次 mutation 嘗試**，不只 `setItem`——
 * C22 要堵的正是「破紀錄前偷偷 removeItem 清掉未來 schema」這種
 * 「沒有呼叫 setItem 所以看起來沒動」的實作。
 */
export const storeControl = {
  map: new Map(),
  calls: [],            // {op, key}，含 getItem
  absent: false,        // E1：localStorage 根本不存在
  throwOnAccess: null,  // 存取 property 本身就拋（第三方 cookie 被封鎖的 iframe）
  throwOnGet: null,     // E2
  throwOnSet: null,     // E3
  throwOnRemove: null,  // E7 的移除失敗路徑
  reset() {
    this.map.clear();
    this.calls.length = 0;
    this.absent = false;
    this.throwOnAccess = this.throwOnGet = this.throwOnSet = this.throwOnRemove = null;
  },
  /** 只算會改變內容的操作，供「零 mutation」斷言用 */
  mutations() { return this.calls.filter((c) => c.op !== 'getItem'); },
};

/**
 * 網址與 history 的控制盤（V5 C49）。
 *
 * `replaced` 記錄每一次 `history.replaceState` 的目標網址——
 * C49 要驗「**只**移除 `fx`，其餘 query 與 fragment 精確保留」，
 * 只比對最終 `href` 看不出「整段 query string 被砍掉再重建」這種實作。
 */
export const urlControl = {
  href: 'https://example.test/quiz/',
  replaced: [],
  throwOnReplace: null,
  reset(href = 'https://example.test/quiz/') {
    this.href = href;
    this.replaced.length = 0;
    this.throwOnReplace = null;
  },
};

/**
 * fetch 的控制盤（V5 D47）。預設從磁碟讀真檔；
 * `fail` 內的路徑回非 200，`bad` 內的路徑回壞 JSON，`body` 可整份替換內容。
 */
export const fetchControl = {
  fail: new Set(),
  bad: new Set(),
  body: new Map(),
  urls: [],
  /**
   * `defer` 內的路徑不會自己完成——每次請求會把一個 `{resolve, reject}` 推進 `pending`，
   * 由測試決定誰先誰後（D46 的競態沒有這個就寫不出來，見 codex-review TG-2）。
   */
  defer: new Set(),
  pending: [],
  reset() {
    this.fail.clear(); this.bad.clear(); this.body.clear();
    this.defer.clear(); this.pending.length = 0; this.urls.length = 0;
  },
};

/**
 * **DOM sink 清冊**（C50）。零依賴樁能監控的每一種寫入 DOM 的途徑都要在這裡登記，
 * 否則「零 sink 呼叫」可能只是因為那條路徑根本沒被監控。
 *
 * 每一種都必須有反向 sentinel 證明它真的會觸發——見 `formulary-ui.test.mjs`。
 */
export const sinkLog = {
  calls: [],            // {sink, id, value}
  /**
   * **明列的排除項**（依 codex-review TG-6）。清冊的原意是「不得默默漏列」，
   * 不是「什麼都要監控」——排除的每一項都要說得出為什麼。
   *
   * - `disabled`：布林狀態，不承載字串，注入不了東西
   * - `style.width`：只由 `${百分比}%` 這種算出來的數值字串寫入，不接受使用者輸入
   * - `classList`：只吃程式碼裡的固定字面值
   */
  excluded: Object.freeze({
    disabled: '布林狀態，不承載字串',
    'style.width': '只寫入算出來的百分比，不接受使用者輸入',
    classList: '只吃固定字面值',
  }),
  reset() { this.calls.length = 0; },
  /** 某段文字是否經由**非純文字** sink 進入 DOM */
  taintedBy(needle) {
    return this.calls.filter((c) => c.sink !== 'textContent' && String(c.value).includes(needle));
  },
  ofSink(sink) { return this.calls.filter((c) => c.sink === sink); },
};

const localStorageStub = {
  getItem(k) {
    storeControl.calls.push({ op: 'getItem', key: k });
    if (storeControl.throwOnGet) throw storeControl.throwOnGet;
    return storeControl.map.has(k) ? storeControl.map.get(k) : null;
  },
  setItem(k, v) {
    storeControl.calls.push({ op: 'setItem', key: k });
    if (storeControl.throwOnSet) throw storeControl.throwOnSet;
    storeControl.map.set(k, String(v));
  },
  removeItem(k) {
    storeControl.calls.push({ op: 'removeItem', key: k });
    if (storeControl.throwOnRemove) throw storeControl.throwOnRemove;
    storeControl.map.delete(k);
  },
  clear() {
    storeControl.calls.push({ op: 'clear', key: null });
    storeControl.map.clear();
  },
};

class El {
  constructor(id, tag = 'div') {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this._html = '';
    this._attrs = {};
    this._text = '';
    this._value = '';
    this.className = '';
    this.disabled = false;
    this.style = {};
    this._listeners = {};
    this._children = [];
    this._appended = [];
    const s = new Set();
    this.classList = {
      _s: s,
      toggle: (c, on) => {
        if (on === false) s.delete(c);
        else if (on === true) s.add(c);
        else if (s.has(c)) s.delete(c);
        else s.add(c);
      },
      add: (c) => s.add(c),
      remove: (c) => s.delete(c),
      contains: (c) => s.has(c),
    };
  }

  /**
   * 純文字 sink：C50 允許的唯一一條路徑。
   *
   * **刻意不做 `String()` 轉型**：真實 DOM 會轉，但既有測試以 `assert/strict`
   * 比對數字（`assert.equal(el.textContent, 20)`），轉型會讓那些斷言全部改判。
   * 這一層只負責記錄，不改變既有語意。
   */
  set textContent(v) {
    sinkLog.calls.push({ sink: 'textContent', id: this.id, value: String(v ?? '') });
    this._text = v;
  }

  get textContent() { return this._text; }

  /** property assignment sink（C50 明列的一類，依 codex-review TG-6 補上） */
  set value(v) {
    sinkLog.calls.push({ sink: 'value', id: this.id, value: String(v ?? '') });
    this._value = v;
  }

  get value() { return this._value; }

  set alt(v) {
    sinkLog.calls.push({ sink: 'alt', id: this.id, value: String(v ?? '') });
    this._attrs.alt = v;
  }

  get alt() { return this._attrs.alt ?? ''; }

  set outerHTML(v) {
    sinkLog.calls.push({ sink: 'outerHTML', id: this.id, value: String(v ?? '') });
  }

  insertAdjacentHTML(pos, html) {
    sinkLog.calls.push({ sink: 'insertAdjacentHTML', id: this.id, value: String(html ?? '') });
  }

  set innerHTML(v) {
    sinkLog.calls.push({ sink: 'innerHTML', id: this.id, value: String(v ?? '') });
    this._html = v;
    this._children = [];
    this._appended = [];
    // app.js 只對 .opt / .level / .cell / .qlen 綁事件；.cell 內含一個 <img>
    for (const cls of ['opt', 'level', 'cell', 'qlen']) {
      const tags = [...v.matchAll(new RegExp(`<button class="${cls}"[^>]*>`, 'g'))].map((m) => m[0]);
      tags.forEach((t, i) => {
        const c = new El(`${cls}#${i}`, 'button');
        c._cls = cls;
        c.dataset = {
          k: attrs(t, 'data-k')[0] ?? String(i),
          level: attrs(t, 'data-level')[0],
          len: attrs(t, 'data-len')[0],
        };
        /**
         * **標籤上的屬性要真的解析出來。**
         *
         * `.level` 靠 `resetLevel()` 事後 `setAttribute` 補上，所以早期不解析也看不出問題；
         * `.qlen` 每次都整塊重畫、沒有那道補丁，不解析就會讓
         * 「選擇器顯示什麼」變成測不到的東西——而那正是 M9 要堵的弱化。
         */
        for (const a of ['aria-checked', 'aria-disabled']) {
          const av = attrs(t, a)[0];
          if (av !== undefined) c._attrs[a] = av;
        }
        if (/\sdisabled(?=[\s>])/.test(t)) c.disabled = true;
        if (cls === 'cell') {
          const img = new ImgEl(`${cls}#${i}-img`);
          // alt 取自產生的 HTML，C8 要據此斷言可及性樹沒有洩漏外觀特徵
          const seg = v.split(t)[1] || '';
          img._attrs.alt = (seg.match(/<img alt="([^"]*)"/) || [])[1] || '';
          c._img = img;
        }
        this._children.push(c);
      });
    }
  }

  get innerHTML() { return this._html; }

  addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); }
  querySelectorAll(sel) {
    const c = sel.replace('.', '');
    return this._children.filter((x) => x._cls === c);
  }
  querySelector(sel) {
    if (sel === 'img') return this._img ?? null;
    return this.querySelectorAll(sel)[0] ?? null;
  }
  appendChild(el) { this._appended.push(el); return el; }
  setAttribute(k, v) {
    sinkLog.calls.push({ sink: `setAttribute:${k}`, id: this.id, value: String(v ?? '') });
    this._attrs[k] = v;
  }
  getAttribute(k) { return this._attrs[k]; }
  removeAttribute(k) { delete this._attrs[k]; }
  focus() {}
  click() { (this._listeners.click || []).forEach((f) => f()); }

  /** 這一格對外可見的全部文字（含 appendChild 進來的品名標籤） */
  get visibleText() {
    return [this.textContent, ...this._appended.map((a) => a.textContent)].join(' ');
  }
}

/**
 * 圖片元素。設定 `src` 後以 microtask 非同步 settle，
 * 讓 app.js 的 ready-gate 與遲到事件邏輯走真實的非同步路徑。
 */
class ImgEl extends El {
  constructor(id) { super(id, 'img'); this.naturalWidth = 0; }

  set src(v) {
    sinkLog.calls.push({ sink: 'img.src', id: this.id, value: String(v ?? '') });
    this._attrs.src = v;
    queueMicrotask(() => {
      if (this._attrs.src !== v) return;             // 期間已被換掉
      if (imgControl.pending.has(v)) return;         // 永不 settle
      if (imgControl.fail.has(v)) { this.onerror?.(); return; }
      this.naturalWidth = 100;
      imgControl.loaded.push(v);
      this.onload?.();
    });
  }
  get src() { return this._attrs.src; }
}

/** 安裝全域樁，回傳操作介面。必須在 import app.js **之前**呼叫。 */
export function installDom() {
  const els = new Map();

  // 由 index.html 帶入初始 class。少了這步，一開始就 hidden 的區塊在樁裡
  // 會被當成可見，讓「未選級別不得開始」這類斷言變成永遠通過的假綠燈。
  const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const INITIAL = new Map();
  for (const m of HTML.matchAll(/id="([^"]+)"\s+class="([^"]*)"/g)) INITIAL.set(m[1], m[2].split(/\s+/));
  for (const m of HTML.matchAll(/class="([^"]*)"\s+id="([^"]+)"/g)) INITIAL.set(m[2], m[1].split(/\s+/));

  const get = (id) => {
    if (!els.has(id)) {
      // fImg 與 qImg 同樣要走非同步 settle，否則閃卡的圖片失敗路徑測不到
      const e = (id === 'qImg' || id === 'fImg') ? new ImgEl(id) : new El(id);
      for (const c of INITIAL.get(id) || []) e.classList.add(c);
      els.set(id, e);
    }
    return els.get(id);
  };

  // Canvas 樁：記錄所有 fillText 的內容，用來證明級別與基線**真的被畫進成績卡**，
  // 而不是只出現在頁面 DOM 上（C13 的弱化實作正是後者）。
  const drawn = [];
  // 「成績卡不含任何藥品圖片」（v2 D7）必須驗**有沒有嘗試畫**，
  // 不能只驗「畫的不是跨域圖片」——後者允許畫別的藥品圖片
  const drawnImages = [];
  const canvas = get('cardCanvas');
  canvas.getContext = () => new Proxy({}, {
    get: (_, p) => {
      if (p === 'measureText') return () => ({ width: 60 });
      if (p === 'fillText') return (t) => drawn.push(String(t));
      if (p === 'drawImage' || p === 'createPattern') return () => drawnImages.push(String(p));
      return () => {};
    },
    set: () => true,
  });
  canvas.toBlob = (cb) => cb({ size: 1 });

  // `createElement('img')` 必須是 ImgEl，不能是普通 El——
  // M5 的 L2 發布前預載（D28.1）建的是**未掛進 DOM** 的 img 節點，
  // 若樁回傳不會 settle 的 El，預載的 Promise 永遠不 resolve，
  // L2 的複習卷就再也發布不出來，而測試只會看到逾時
  const downloads = [];
  let created = 0;
  globalThis.document = {
    getElementById: get,
    createElement: (tag) => {
      // 下載用的 <a>：href 是 URL sink，一併登記（C50 的 sink 清冊）
      if (tag === 'a') {
        const rec = { name: null, clicked: 0 };
        downloads.push(rec);
        return {
          click() { rec.clicked++; },
          set href(v) { sinkLog.calls.push({ sink: 'a.href', id: 'download', value: String(v) }); rec.href = v; },
          get href() { return rec.href; },
          set download(v) { sinkLog.calls.push({ sink: 'a.download', id: 'download', value: String(v) }); rec.name = v; },
        };
      }
      if (tag === 'img') return new ImgEl(`created-img#${created++}`);
      return new El(`created-${tag}`, tag);
    },
    fonts: { ready: Promise.resolve() },
  };
  globalThis.window = {
    scrollTo() {},
    get location() { return { href: urlControl.href }; },
    history: {
      replaceState(_s, _t, url) {
        if (urlControl.throwOnReplace) throw urlControl.throwOnReplace;
        urlControl.replaced.push(String(url));
        // 真實瀏覽器會就地改寫網址列；樁也要改，否則第二次 cleanup 的冪等驗不到
        urlControl.href = new URL(String(url), urlControl.href).href;
      },
    },
  };
  // Node 24 的全域 `navigator` 只有 getter，直接指派會 TypeError
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    get: () => ({ clipboard: { writeText: async () => {} } }),
  });
  // 用 getter 而不是直接指派：E1（不存在）與「存取 property 本身就拋」
  // 兩種失效都必須測得到，而那兩種在真實瀏覽器都發生在**還沒呼叫任何方法**之前
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      if (storeControl.throwOnAccess) throw storeControl.throwOnAccess;
      return storeControl.absent ? undefined : localStorageStub;
    },
  });
  const blobs = [];
  globalThis.URL.createObjectURL = (b) => { blobs.push(b); return 'blob:stub'; };
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.fetch = async (u) => {
    fetchControl.urls.push(u);
    const name = String(u).replace('data/', '');
    if (fetchControl.defer.has(name)) {
      return new Promise((resolve, reject) => {
        fetchControl.pending.push({
          name,
          ok: (body) => resolve({ ok: true, status: 200, json: async () => body }),
          fail: (msg = 'network down') => reject(new Error(msg)),
        });
      });
    }
    if (fetchControl.fail.has(name)) return { ok: false, status: 503, json: async () => ({}) };
    if (fetchControl.bad.has(name)) {
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } };
    }
    if (fetchControl.body.has(name)) {
      return { ok: true, status: 200, json: async () => fetchControl.body.get(name) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name), 'utf8')),
    };
  };

  return {
    $: get,
    drawn,
    drawnImages,
    downloads,
    blobs,
    img: imgControl,
    store: storeControl,
    url: urlControl,
    net: fetchControl,
    sinks: sinkLog,
    hidden: (id) => get(id).classList.contains('hidden'),
    cells: () => get('qGrid').querySelectorAll('.cell'),
    /** 讓所有已排定的 microtask 跑完 */
    settle: () => new Promise((r) => setTimeout(r, 0)),
  };
}
