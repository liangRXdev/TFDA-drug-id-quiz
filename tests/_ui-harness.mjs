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

class El {
  constructor(id, tag = 'div') {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this._html = '';
    this._attrs = {};
    this.textContent = '';
    this.value = '';
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

  set innerHTML(v) {
    this._html = v;
    this._children = [];
    this._appended = [];
    // app.js 只對 .opt / .level / .cell 綁事件；.cell 內含一個 <img>
    for (const cls of ['opt', 'level', 'cell']) {
      const tags = [...v.matchAll(new RegExp(`<button class="${cls}"[^>]*>`, 'g'))].map((m) => m[0]);
      tags.forEach((t, i) => {
        const c = new El(`${cls}#${i}`, 'button');
        c._cls = cls;
        c.dataset = { k: attrs(t, 'data-k')[0] ?? String(i), level: attrs(t, 'data-level')[0] };
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
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
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
      const e = id === 'qImg' ? new ImgEl(id) : new El(id);
      for (const c of INITIAL.get(id) || []) e.classList.add(c);
      els.set(id, e);
    }
    return els.get(id);
  };

  // Canvas 樁：記錄所有 fillText 的內容，用來證明級別與基線**真的被畫進成績卡**，
  // 而不是只出現在頁面 DOM 上（C13 的弱化實作正是後者）。
  const drawn = [];
  const canvas = get('cardCanvas');
  canvas.getContext = () => new Proxy({}, {
    get: (_, p) => {
      if (p === 'measureText') return () => ({ width: 60 });
      if (p === 'fillText') return (t) => drawn.push(String(t));
      return () => {};
    },
    set: () => true,
  });
  canvas.toBlob = (cb) => cb({ size: 1 });

  globalThis.document = {
    getElementById: get,
    createElement: (tag) => (tag === 'a'
      ? { click() {}, set href(v) {}, set download(v) {} }
      : new El(`created-${tag}`, tag)),
    fonts: { ready: Promise.resolve() },
  };
  globalThis.window = { scrollTo() {} };
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.fetch = async (u) => ({
    ok: true,
    status: 200,
    json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', u.replace('data/', '')), 'utf8')),
  });

  return {
    $: get,
    drawn,
    img: imgControl,
    hidden: (id) => get(id).classList.contains('hidden'),
    cells: () => get('qGrid').querySelectorAll('.cell'),
    /** 讓所有已排定的 microtask 跑完 */
    settle: () => new Promise((r) => setTimeout(r, 0)),
  };
}
