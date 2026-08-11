/**
 * V5 批次 1／3 — 藥證字號正規化、連結編碼、四分類與級別可用性
 * （規格 plan-v5-formulary.md v5.9 的 A36–A45）
 *
 *   node --test
 *
 * 這一檔只驗**純函式**。凡涉及 UI、localStorage、管線者一律不在此
 * （批次 3 的出題判定本身是純函式，故在此）。
 *
 * **golden vectors 是外部 oracle**：G1–G5 的位元組與 payload 抄自
 * `.ai-review/golden-vectors-v1.md`，該檔在 codec 實作**之前**由人工推導產出
 * （LEB128 手算＋獨立實作交叉驗證，CRC 與 base64url 以 Python 標準庫為 oracle）。
 * **實作跑出不同結果時錯的是實作，不得回頭改 golden。**
 *
 * 每條測試上方標註它要堵死的弱化實作。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PREFIX_TABLE, FORMAT_VERSION, PREFIX_TABLE_VERSION,
  normalizeLicense, tokenize, encodeFormulary, decodeFormulary, crc32,
  FormularyError,
  Category, CATEGORY_LABEL, classifyFormulary, buildExcludedIndex, validatePair,
  MIN_QUIZ_LEN, distractorNeed, minUsableK, quizLenFor, formularySeed,
  prepareFormulary, probeLevel, probeFormulary, splitMissing,
} from '../formulary.js';
import {
  Level, QUIZ_SIZE, buildIndex, eligibleKeys, nameCollides, makeRng, validateQuizInvariants,
  buildChoices,
} from '../engine.js';
import { COLLISION_GROUPS, PREFIX_SAMPLES } from './_license-fixtures.mjs';

/** 抄自 .ai-review/golden-vectors-v1.md，**不得由 encodeFormulary 產生後回填** */
const GOLDEN = [
  { name: 'G1', payload: 'AQEAAQAAAAEBmJjSAQ', unlisted: 0,
    ids: ['衛署藥製字第000001號'] },
  { name: 'G2', payload: 'AQEAAwAFAAJ7veYDAgGl0QErHDki', unlisted: 5,
    ids: ['衛署藥製字第000123號', '衛署藥製字第062392號', '衛部藥輸字第026789號'] },
  { name: 'G3', payload: 'AQEAAAAqnEWSYA', unlisted: 42, ids: [] },
  { name: 'G4', payload: 'AQEAAgAAEAE_EQEqRrKPSg', unlisted: 0,
    ids: ['衛署藥輸字第R00063號', '衛部藥製字第R00042號'] },
  { name: 'G5', payload: 'AQEAAgAAAAG_hD0QAZ-NBg458qQ', unlisted: 0,
    ids: ['衛署藥製字第999999號', '衛署藥輸字第R99999號'] },
  // R-1：G1–G5 只釘住 index 0/2/16/17，11–15 完全靠 round-trip
  { name: 'G6', payload: 'AQEABQAACwGtAgwBxIYBDQG9PQ4BFg8B6geNyIn9', unlisted: 0,
    ids: ['衛署菌疫輸字第000301號', '衛部成製字第017220號', '衛署成製字第007869號',
          '衛部罕菌疫輸字第000022號', '衛部成輸字第001002號'] },
  // R-6：A39 的 permutation 需涵蓋最小號碼 1；G2/G4/G5 都不含 1，G1 是單元素
  { name: 'G7', payload: 'AQEAAgAAAAIBeibjey8', unlisted: 0,
    ids: ['衛署藥製字第000001號', '衛署藥製字第000123號'] },
];

const bytesOf = (s) => [...s].map((c) => c.charCodeAt(0));
const throwsCode = (fn, code) => assert.throws(fn, (e) =>
  e instanceof FormularyError && e.code === code, `預期拋 ${code}`);

// ════════════════════════════════════════════════════════════════════
describe('A36 整串比對：18 種前綴與全部 93 組撞號', () => {
  test('前綴表本身是 18 種，且 index 順序即 wire contract', () => {
    // 〔堵〕重排既有 index 會讓舊連結靜默解成不同藥證——與被否決的 bitmap 同型風險
    assert.equal(PREFIX_TABLE.length, 18);
    assert.equal(PREFIX_TABLE[0].prefix, '衛署藥製字第');
    assert.equal(PREFIX_TABLE[16].prefix, '衛署藥輸字第R');
    assert.equal(PREFIX_TABLE[17].prefix, '衛部藥製字第R');
    assert.equal(PREFIX_TABLE[0].numWidth, 6);
    assert.equal(PREFIX_TABLE[16].numWidth, 5);
  });

  test('18 種前綴各自的真實 id 都能正規化成自己', () => {
    assert.equal(PREFIX_SAMPLES.length, 18);
    PREFIX_SAMPLES.forEach((id, i) => {
      assert.equal(normalizeLicense(id), id, `index ${i} 的樣本正規化後應不變`);
      assert.ok(id.startsWith(PREFIX_TABLE[i].prefix),
        `index ${i} 的樣本應以 ${PREFIX_TABLE[i].prefix} 開頭`);
    });
  });

  test('wire index 由獨立 payload 釘死，不靠 round-trip', () => {
    // 〔堵〕**這條原本是 round-trip**：encoder 與 decoder 做對稱對調時恆等成立，
    //       59/59 全綠（2026-08-10 已實跑確認）。後果是已分享的舊連結靜默解成
    //       不同的藥，而 wire format 是不可變契約，發布後改不了。
    //       改為解**手推的硬編碼 payload**——對稱錯誤再也抵銷不掉。
    const PINNED = [
      ['AQEAAQAAAAEBmJjSAQ', 0, ['衛署藥製字第000001號']],
      ['AQEAAwAFAAJ7veYDAgGl0QErHDki', 2, ['衛部藥輸字第026789號']],
      ['AQEABQAACwGtAgwBxIYBDQG9PQ4BFg8B6geNyIn9', 11, ['衛署菌疫輸字第000301號']],
      ['AQEABQAACwGtAgwBxIYBDQG9PQ4BFg8B6geNyIn9', 12, ['衛部成製字第017220號']],
      ['AQEABQAACwGtAgwBxIYBDQG9PQ4BFg8B6geNyIn9', 13, ['衛署成製字第007869號']],
      ['AQEABQAACwGtAgwBxIYBDQG9PQ4BFg8B6geNyIn9', 14, ['衛部罕菌疫輸字第000022號']],
      ['AQEABQAACwGtAgwBxIYBDQG9PQ4BFg8B6geNyIn9', 15, ['衛部成輸字第001002號']],
      ['AQEAAgAAEAE_EQEqRrKPSg', 16, ['衛署藥輸字第R00063號']],
      ['AQEAAgAAEAE_EQEqRrKPSg', 17, ['衛部藥製字第R00042號']],
    ];
    for (const [payload, idx, expected] of PINNED) {
      const { ids } = decodeFormulary(payload);
      for (const e of expected) {
        assert.ok(ids.includes(e), `payload 應解出 ${e}（index ${idx}）`);
        assert.ok(e.startsWith(PREFIX_TABLE[idx].prefix),
          `${e} 應對應 PREFIX_TABLE[${idx}]`);
      }
    }
  });

  test('全部 93 組撞號：組內任兩者正規化後不得相等，且各自非 null', () => {
    // 〔堵〕只 hardcode 5 組明列反例——其餘 88 組仍可錯配，
    //       而錯配直接造成「A 藥的照片配 B 藥的名字」，是本專案最怕的失效模式
    assert.equal(COLLISION_GROUPS.length, 93);
    for (const group of COLLISION_GROUPS) {
      const norms = group.map(normalizeLicense);
      // R-2：逐筆驗「命中自己」。只驗「非 null 且組內相異」時，
      //      把號碼整批換成另一個號碼的 normalizer 仍會因前綴不同而通過
      norms.forEach((n, i) => assert.equal(n, group[i],
        `${group[i]} 應正規化成自己，實得 ${n}`));
      assert.equal(new Set(norms).size, group.length,
        `撞號組 ${group.join(' / ')} 正規化後彼此應相異`);
    }
  });

  test('同一前綴、不同號碼也不得碰撞', () => {
    // 〔堵〕撞號組全是「跨前綴」，因此前綴保留但號碼被改的實作仍可通過。
    //       這條補的是同前綴內的號碼精確性
    const pairs = [
      ['衛署藥製字第000123號', '衛署藥製字第001230號'],
      ['衛署藥製字第000001號', '衛署藥製字第000010號'],
      ['衛署藥輸字第R00063號', '衛署藥輸字第R00630號'],
    ];
    for (const [a, b] of pairs) {
      assert.equal(normalizeLicense(a), a);
      assert.equal(normalizeLicense(b), b);
      assert.notEqual(normalizeLicense(a), normalizeLicense(b));
    }
  });

  test('忽略前綴只比號碼的實作會被抓到', () => {
    // 這兩筆是完全不同的藥；若正規化只留號碼，兩者會相等
    const a = normalizeLicense('衛署藥製字第020174號');
    const b = normalizeLicense('衛署藥輸字第020174號');
    assert.notEqual(a, b);
    assert.equal(a, '衛署藥製字第020174號');
    assert.equal(b, '衛署藥輸字第020174號');
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A37 正規化：逐類容忍＋每類反例＋冪等＋不碰撞', () => {
  const TOLERATED = [
    ['全形數字', '衛署藥製字第０２０１７４號'],
    ['前後空白', '  衛署藥製字第020174號  '],
    ['內部空白', '衛署藥製字第 020174 號'],
    ['全形空白', '衛署藥製字第　020174　號'],
    ['小寫字母', '衛署藥輸字第r00063號'],
    ['缺前導零', '衛署藥製字第20174號'],
    ['缺「號」', '衛署藥製字第020174'],
    ['缺「第」', '衛署藥製字020174號'],
  ];
  for (const [name, input] of TOLERATED) {
    test(`容忍：${name}`, () => {
      const expect = name === '小寫字母' ? '衛署藥輸字第R00063號' : '衛署藥製字第020174號';
      assert.equal(normalizeLicense(input), expect);
    });
  }

  const REJECTED = [
    ['缺前綴（純數字）', '020174'],
    ['前綴錯字', '衛署藥制字第020174號'],
    ['未知前綴', '衛福部新式字第020174號'],
    ['號碼為 0', '衛署藥製字第000000號'],
    ['位數超過 numWidth', '衛署藥製字第1234567號'],
    ['R 型位數超限', '衛署藥輸字第R123456號'],
    ['空字串', ''],
    ['非字串', 42],
    ['號碼段非數字', '衛署藥製字第ABCDEF號'],
  ];
  for (const [name, input] of REJECTED) {
    test(`不容忍：${name}`, () => {
      // 〔堵〕把正規化寫成「抽出數字就好」——所有單類容忍案例都會過，
      //       但純數字與前綴錯字會被猜成某一顆藥
      assert.equal(normalizeLicense(input), null);
    });
  }

  test('組合輸入：同時全形＋空白＋缺「第」＋缺前導零', () => {
    assert.equal(normalizeLicense('  衛署藥製字 ２０１７４ 號 '), '衛署藥製字第020174號');
  });

  test('冪等：N(N(x)) === N(x)', () => {
    // 〔堵〕正規化若不冪等，storage 與 URL 的同一份清單會產生不同 canonical 集合
    const inputs = [...TOLERATED.map(([, i]) => i), ...PREFIX_SAMPLES];
    for (const raw of inputs) {
      const once = normalizeLicense(raw);
      assert.notEqual(once, null, `${raw} 不應失敗`);
      assert.equal(normalizeLicense(once), once, `${raw} 的正規化應冪等`);
    }
  });

  test('任兩個不同的合法 id 正規化後不得相等', () => {
    const norms = PREFIX_SAMPLES.map(normalizeLicense);
    assert.equal(new Set(norms).size, PREFIX_SAMPLES.length);
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A38 golden vectors（外部 oracle，非 round-trip）', () => {
  test('CRC variant 是 CRC-32/ISO-HDLC', () => {
    // D34.2 指定的標準檢查向量。只寫「CRC-32」不足以跨實作一致
    assert.equal(crc32(bytesOf('123456789')), 0xCBF43926);
  });

  for (const g of GOLDEN) {
    test(`${g.name} encode 產出的 payload 位元組完全相同`, () => {
      // 〔堵〕encode 與 decode 共用同一份錯誤的 prefix 表仍可完美 round-trip——
      //       **round-trip 測試本身證明不了正確性**，錯誤要到跨版本解碼才爆
      assert.equal(encodeFormulary(g.ids, g.unlisted), g.payload);
    });
    test(`${g.name} decode 還原出正確的 canonical id 與 unlistedCount`, () => {
      const { ids, unlistedCount } = decodeFormulary(g.payload);
      assert.deepEqual([...ids].sort(), [...g.ids].sort());
      assert.equal(unlistedCount, g.unlisted);
    });
  }

  test('G1 的補零規則：號碼 1 必須還原成 000001 而非 1', () => {
    // 〔堵〕整數化是有損的，遺失的正是前導零。join key 是字串完全相等，
    //       不補回則每一筆都變未命中，而 encoder 與 round-trip 測試完全正常
    const { ids } = decodeFormulary('AQEAAQAAAAEBmJjSAQ');
    assert.deepEqual(ids, ['衛署藥製字第000001號']);
  });

  test('G3 證明 unlistedCount 沒有被忽略', () => {
    // 〔堵〕codec 可以完全不讀 unlistedCount（v5.3 才加的欄位）而其他 golden 仍全綠
    const { ids, unlistedCount } = decodeFormulary('AQEAAAAqnEWSYA');
    assert.deepEqual(ids, []);
    assert.equal(unlistedCount, 42);
  });

  test('版本欄位釘死在 v1', () => {
    assert.equal(FORMAT_VERSION, 0x01);
    assert.equal(PREFIX_TABLE_VERSION, 0x01);
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A39 canonical 唯一性：同一集合只有唯一合法編碼', () => {
  test('輸入順序不影響輸出位元組', () => {
    // 〔堵〕非 canonical encoding 會讓同一份清單產生不同連結，無法判斷兩條是否等價
    for (const g of GOLDEN) {
      if (g.ids.length < 2) continue;
      const orders = [
        [...g.ids],
        [...g.ids].reverse(),
        [...g.ids].sort((a, b) => (a < b ? 1 : -1)),
      ];
      for (const o of orders) assert.equal(encodeFormulary(o, g.unlisted), g.payload);
    }
  });

  test('重複輸入會被去重，且不改變輸出', () => {
    const g = GOLDEN[1];
    assert.equal(encodeFormulary([...g.ids, ...g.ids], g.unlisted), g.payload);
  });

  test('邊界號碼：最小合法值 1 與各 index 的上限', () => {
    // A39 的合法邊界是 1，不是 0——D34.3 第 2 條明定絕對號碼 ≥1（號碼 0 見 A40）
    assert.equal(encodeFormulary(['衛署藥製字第000001號'], 0), GOLDEN[0].payload);
    assert.equal(encodeFormulary(GOLDEN[4].ids, 0), GOLDEN[4].payload);
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A40 解碼 fail-closed', () => {
  const b64d = (s) => {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const out = [];
    for (let i = 0; i < s.length; i += 4) {
      const n = Math.min(4, s.length - i);
      const v = [0, 1, 2, 3].map((k) => (k < n ? A.indexOf(s[i + k]) : 0));
      const bits = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
      if (n >= 2) out.push((bits >> 16) & 0xFF);
      if (n >= 3) out.push((bits >> 8) & 0xFF);
      if (n >= 4) out.push(bits & 0xFF);
    }
    return out;
  };
  const b64e = (b) => {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let o = '';
    for (let i = 0; i < b.length; i += 3) {
      const n = b.length - i;
      const x = b[i], y = n > 1 ? b[i + 1] : 0, z = n > 2 ? b[i + 2] : 0;
      o += A[x >> 2] + A[((x & 3) << 4) | (y >> 4)];
      if (n > 1) o += A[((y & 15) << 2) | (z >> 6)];
      if (n > 2) o += A[z & 63];
    }
    return o;
  };
  const withCrc = (pre) => {
    const c = crc32(pre);
    return b64e([...pre, (c >>> 24) & 0xFF, (c >>> 16) & 0xFF, (c >>> 8) & 0xFF, c & 0xFF]);
  };

  test('(a) 完整性：逐 byte 翻轉、保留原 CRC，全部必須拋錯', () => {
    // 〔堵〕v5.2 曾允許「分段抽樣」，那個逃生口讓實作只需擋住三個 byte。
    //       此處逐 byte 且斷言三區段的 mutation 數皆非零
    let header = 0, groups = 0, checksum = 0;
    for (const g of GOLDEN) {
      const buf = b64d(g.payload);
      for (let i = 0; i < buf.length; i++) {
        const m = [...buf];
        m[i] ^= 0x01;
        assert.throws(() => decodeFormulary(b64e(m)),
          (e) => e instanceof FormularyError, `第 ${i} byte 翻轉後應拋錯`);
        if (i < 6) header++;
        else if (i < buf.length - 4) groups++;
        else checksum++;
      }
    }
    assert.ok(header > 0 && groups > 0 && checksum > 0,
      `三個區段都要被涵蓋（header ${header} / groups ${groups} / checksum ${checksum}）`);
  });

  test('(b) canonical grammar：每個違規 fixture 都重算正確 CRC', () => {
    // 〔堵〕若所有語法違規 fixture 都保留舊 CRC，只實作 CRC 檢查、
    //       完全不實作 grammar 的 decoder 也會全部拋錯而全綠
    const cases = [
      ['非最短 varint', [1, 1, 0, 1, 0, 0, 0x80, 0x00, 0x01, 0x01], 'NON_CANONICAL_VARINT'],
      ['count 與實際不符', [1, 1, 0, 5, 0, 0, 0x00, 0x01, 0x01], 'TRUNCATED'],
      ['prefixIndex 不遞增', [1, 1, 0, 2, 0, 0, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01], 'PREFIX_NOT_ASCENDING'],
      ['prefixIndex 越界', [1, 1, 0, 1, 0, 0, 0x12, 0x01, 0x01], 'PREFIX_OUT_OF_RANGE'],
      ['groupCount 為 0', [1, 1, 0, 1, 0, 0, 0x00, 0x00], 'EMPTY_GROUP'],
      ['絕對號碼為 0', [1, 1, 0, 1, 0, 0, 0x00, 0x01, 0x00], 'BAD_DELTA'],
      ['delta 為 0（重複 id）', [1, 1, 0, 2, 0, 0, 0x00, 0x02, 0x01, 0x00], 'BAD_DELTA'],
      ['號碼超過 numWidth', [1, 1, 0, 1, 0, 0, 0x00, 0x01, 0x80, 0x89, 0x7A], 'NUMBER_TOO_LARGE'],
      ['trailing bytes', [1, 1, 0, 1, 0, 0, 0x00, 0x01, 0x01, 0xFF], 'TRAILING_BYTES'],
      ['未知 formatVersion', [9, 1, 0, 1, 0, 0, 0x00, 0x01, 0x01], 'UNKNOWN_FORMAT_VERSION'],
      ['未知 prefixTableVer', [1, 9, 0, 1, 0, 0, 0x00, 0x01, 0x01], 'UNKNOWN_PREFIX_TABLE_VERSION'],
      // R-3：A40 明列但原本完全沒有 fixture。實跑拿掉這兩個檢查 → 仍全綠
      ['varint 超過 5 bytes',
       [1, 1, 0, 1, 0, 0, 0x00, 0x01, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01], 'VARINT_TOO_LONG'],
      ['varint overflow（第 5 byte 超出 32 bits）',
       [1, 1, 0, 1, 0, 0, 0x00, 0x01, 0x80, 0x80, 0x80, 0x80, 0x10], 'VARINT_OVERFLOW'],
    ];
    for (const [name, pre, code] of cases) {
      throwsCode(() => decodeFormulary(withCrc(pre)), code, name);
    }
  });

  test('非 base64url 字元與尾端未用 bits（餘 2 與餘 3 都要）', () => {
    throwsCode(() => decodeFormulary('AQEAAQAAAAEBmJjSA+'), 'BAD_BASE64');
    // 餘 2 字元：G1 尾字元 'Q' 帶 4 個未用 bits，改成帶非零尾 bits 的字元即非 canonical
    throwsCode(() => decodeFormulary('AQEAAQAAAAEBmJjSAR'), 'NON_CANONICAL_BASE64');
    // R-4 餘 3 字元：G7 長度 19（%4===3），尾字元 '8'(60) 低 2 bits 為 0；
    //     換成 '9'(61) 低 2 bits 為 01 → 非 canonical。原本完全沒測這一路
    throwsCode(() => decodeFormulary('AQEAAgAAAAIBeibjey9'), 'NON_CANONICAL_BASE64');
  });

  test('R-4：payload 長度 % 4 === 1 不合法', () => {
    // 〔堵〕拿掉這條長度檢查後，合法 payload 後追加一個**不產生 byte** 的字元
    //       仍會被接受——同一 body 就有了多個字串表示，破壞 canonical 唯一性
    throwsCode(() => decodeFormulary(GOLDEN[1].payload + 'A'), 'BAD_BASE64_LENGTH');
  });

  test('截斷與過短', () => {
    // 長度仍 ≥10 bytes 的截斷會先撞 CRC；更短的先撞長度檢查。兩條路都要 fail-closed
    throwsCode(() => decodeFormulary(GOLDEN[1].payload.slice(0, 24)), 'CRC_MISMATCH');
    throwsCode(() => decodeFormulary('AQEAAQAAAAEB'), 'TOO_SHORT');
    throwsCode(() => decodeFormulary('AQEA'), 'TOO_SHORT');
    throwsCode(() => decodeFormulary(''), 'BAD_PAYLOAD');
  });

  test('錯誤時回傳值完全不存在（不得回傳部分結果）', () => {
    // 〔堵〕解碼寫成「盡力而為、回傳解得出來的前 N 筆」——
    //       新人會拿到一份殘缺的院內清單而完全不自知
    let ret = 'SENTINEL';
    try { ret = decodeFormulary(withCrc([1, 1, 0, 3, 0, 0, 0x00, 0x02, 0x01, 0x01])); }
    catch { /* 預期 */ }
    assert.equal(ret, 'SENTINEL');
  });

  test('uint16 邊界：unlistedCount 超界一律拒絕，不得截斷', () => {
    throwsCode(() => encodeFormulary([], 65536), 'UNLISTED_OUT_OF_RANGE');
    throwsCode(() => encodeFormulary([], -1), 'UNLISTED_OUT_OF_RANGE');
  });

  test('R-5：count 超界一律拒絕，不得靜默截成低 16 bits', () => {
    // 〔堵〕原本的測試**名稱**宣稱驗了 count，實際只驗 unlistedCount。
    //       實跑刪掉 count 檢查 → 仍全綠。測試名稱過度宣稱比沒有名稱更誤導
    const many = Array.from({ length: 65536 },
      (_, i) => `衛署藥製字第${String(i + 1).padStart(6, '0')}號`);
    throwsCode(() => encodeFormulary(many, 0), 'COUNT_OUT_OF_RANGE');
    // 恰好 65535 筆是合法的——邊界要兩側都釘
    assert.doesNotThrow(() => encodeFormulary(many.slice(0, 65535), 0));
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A45 三種退化輸入（明列）', () => {
  test('(1) 完全空字串', () => {
    throwsCode(() => tokenize(''), 'EMPTY_INPUT');
  });

  test('(2) 只有空白與分隔符', () => {
    // R-7：規格 A45 明寫「只有空白**與分隔符**」，原本只測了空白與 Tab
    throwsCode(() => tokenize('  \n\t\n   \r\n  '), 'EMPTY_INPUT');
    // Tab 本身是空白，整行只有 Tab 會被 trim 成空行而略過（與上一行同一條路徑）
    throwsCode(() => tokenize('\t\t\n\t'), 'EMPTY_INPUT');
    // 非空白的分隔符：整行只有分隔符 → 多欄且每欄皆空 → 正規化後為 null
    // （歸 UNLISTED），**不會誤配到任何一顆藥**
    for (const d of [',', ';', '，']) {
      const toks = tokenize(`${d}${d}`, { delimiter: d, column: 1 });
      assert.deepEqual(toks, [''], `只有 ${JSON.stringify(d)} 時第 1 欄應為空字串`);
      assert.equal(normalizeLicense(toks[0]), null);
    }
  });

  test('(3) 同一合法 id 重複 20 次 → 去重後恰為 1 筆', () => {
    // 〔堵〕只驗「不拋例外」——回四個空集合也會通過
    const id = '衛署藥製字第020174號';
    const toks = tokenize(Array(20).fill(id).join('\n'));
    assert.equal(toks.length, 20, 'tokenize 保留原始順序與筆數，不負責去重');
    const canon = new Set(toks.map(normalizeLicense));
    assert.deepEqual([...canon], [id]);
    assert.equal(decodeFormulary(encodeFormulary(canon, 0)).ids.length, 1);
  });

  test('空集合可編碼（D34.3 第 7 條：count = 0 合法）', () => {
    const p = encodeFormulary([], 0);
    const { ids, unlistedCount } = decodeFormulary(p);
    assert.deepEqual(ids, []);
    assert.equal(unlistedCount, 0);
  });
});

// ════════════════════════════════════════════════════════════════════
describe('D35.1／D35.1a tokenization 契約', () => {
  test('每行一個 token，剝 BOM、略過空行、剝引號', () => {
    const toks = tokenize('﻿衛署藥製字第020174號\n\n  "衛署藥輸字第020174號"  \n');
    assert.deepEqual(toks, ['衛署藥製字第020174號', '衛署藥輸字第020174號']);
  });

  test('三種換行都認', () => {
    assert.equal(tokenize('a\r\nb\nc\rd').length, 4);
  });

  test('含分隔符但未指定欄位 → 整份拒絕，不得猜測', () => {
    // 〔堵〕猜錯欄位會靜默產出一份錯誤的清單，而使用者無從得知少了哪些
    throwsCode(() => tokenize('代碼,品名\nA,B'), 'COLUMN_NOT_SPECIFIED');
  });

  test('指定 delimiter 與 1-based column', () => {
    const t = tokenize('代碼,品名\n衛署藥製字第020174號,某藥\n衛署藥輸字第020174號,另一藥',
      { delimiter: ',', column: 1, hasHeader: true });
    assert.deepEqual(t, ['衛署藥製字第020174號', '衛署藥輸字第020174號']);
  });

  test('引號內的分隔符不算分欄', () => {
    const t = tokenize('"A,B",衛署藥製字第020174號', { delimiter: ',', column: 2 });
    assert.deepEqual(t, ['衛署藥製字第020174號']);
  });

  test('R-8：頂層 delimiter 偵測必須 quote-aware', () => {
    // 〔堵〕原本用 includes() 直接搜原始字串，`"A,B"` 這種**單一欄位**會被誤判成多欄
    //       而整份拒絕——D35.1a 明定引號內的 delimiter 不算分欄。
    //       嚴重度低（明顯拒絕而非靜默錯配），但違反已寫下的輸入契約
    assert.deepEqual(tokenize('"A,B"'), ['A,B']);
    assert.deepEqual(tokenize('"衛署藥製字第020174號"'), ['衛署藥製字第020174號']);
    // 真的有頂層 delimiter 時仍須拒絕
    throwsCode(() => tokenize('a,b'), 'COLUMN_NOT_SPECIFIED');
    throwsCode(() => tokenize('"A,B",c'), 'COLUMN_NOT_SPECIFIED');
  });

  test('各列欄數不一致 → 整份拒絕並指出列號', () => {
    assert.throws(() => tokenize('a,b\nc,d,e', { delimiter: ',', column: 1 }),
      (e) => e.code === 'RAGGED_ROWS' && /第 2 列/.test(e.message));
  });

  test('引號未閉合 → 整份拒絕', () => {
    throwsCode(() => tokenize('"未閉合,b', { delimiter: ',', column: 1 }), 'UNCLOSED_QUOTE');
  });

  test('欄序超出範圍 → 拒絕', () => {
    throwsCode(() => tokenize('a,b\nc,d', { delimiter: ',', column: 5 }), 'COLUMN_OUT_OF_RANGE');
  });
});

// ════════════════════════════════════════════════════════════════════
// V5 批次 3 — 四分類（D37）／級別可用性（D38）／出題封閉性（D36）
// ════════════════════════════════════════════════════════════════════

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
const POOL = readJson(path.join(ROOT, 'data/pool.json'));
const EXCLUDED = readJson(path.join(ROOT, 'data/excluded.json'));
const needData = () => assert.ok(POOL && EXCLUDED,
  'data/pool.json 與 data/excluded.json 都必須存在，請先執行 npm run build:pool');

/** 合成 canonical id（index 0 前綴，6 位號碼）。1-based，號碼 0 非法 */
const synthId = (n) => `衛署藥製字第${String(n).padStart(6, '0')}號`;

/**
 * 合成答案鍵：等長 3 字母 ＋ 一個檢查字元 ⇒ 任兩個 Hamming 距離 ≥2。
 *
 * 為什麼不用 `DRUG1`／`DRUG2`：那兩個編輯距離為 1，`nameCollides` 會判碰撞，
 * 於是 fixture 的 K 會**悄悄少掉**，A42 的邊界就對不上真正要驗的那個數字。
 * 等長也順便排除 `startsWith` 那條前綴碰撞。
 */
function codeName(i) {
  const A = (n) => String.fromCharCode(65 + n);
  const hi = Math.floor(i / 26), lo = i % 26;
  return A(hi) + A(lo) + A((hi + lo) % 26);
}

/** fixture 自檢：答案鍵兩兩不得碰撞，否則 K 會與宣稱的不符 */
function assertNoNameCollision(items) {
  const names = [...new Set(items.map((it) => it.ans))];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      assert.ok(!nameCollides(names[i], names[j]),
        `fixture 產生了碰撞的答案鍵：${names[i]} / ${names[j]}`);
    }
  }
}

/** L1／L3 用：外觀兩兩不相交 ⇒ 全部答案鍵可用 ⇒ K === count */
function mkDisjointItems(count, { idFrom = 1, nameFrom = 0 } = {}) {
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push({
      id: synthId(idFrom + i),
      ans: codeName(nameFrom + i),
      shape: [`S${nameFrom + i}`],
      color: [`C${nameFrom + i}`],
      score_mark: ['無'], size: '8', mark1: `M${nameFrom + i}`, mark2: null,
      img: `img/${nameFrom + i}.webp`,
    });
  }
  assertNoNameCollision(items);
  return items;
}

/** L2 用：同形同色、刻字互異 ⇒ 每筆都湊得到 5 個嚴格候選 ⇒ K === count（count ≥ 6） */
function mkL2Items(count, { idFrom = 1, nameFrom = 0 } = {}) {
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push({
      id: synthId(idFrom + i),
      ans: codeName(nameFrom + i),
      shape: ['圓形'], color: ['白'],
      score_mark: ['無'], size: '8', mark1: `MK${nameFrom + i}`, mark2: null,
      img: `img/${nameFrom + i}.webp`,
    });
  }
  assertNoNameCollision(items);
  return items;
}

const mkItems = (level, count, opts) =>
  (level === Level.L2 ? mkL2Items(count, opts) : mkDisjointItems(count, opts));

/** 題卷的穩定 identity：逐題的正解／選項／備援 id 序列 */
const quizIdentity = (quiz) => quiz.map((q) => [
  q.item.id,
  (q.options || []).map((o) => o.id).join(','),
  (q.spares || []).map((s) => s.id).join(','),
].join('|'));

/** 整卷用到的全部紀錄 id（正解 ∪ 選項 ∪ 備援） */
function allQuizIds(quiz) {
  const out = new Set();
  for (const q of quiz) {
    out.add(q.item.id);
    for (const o of q.options || []) out.add(o.id);
    for (const s of q.spares || []) out.add(s.id);
  }
  return out;
}

const payloadOf = (items) => encodeFormulary(items.map((it) => it.id), 0);

/**
 * pool-only sentinel：**只存在於全庫、不在院內子集**的品項。
 *
 * 它們的外觀（圓形／白）與 `mkDisjointItems` 的任何一筆都不相交、刻字互異，
 * 因此對 L1 與 L2 **都是合法的誘答候選**——這正是「誤用全庫 index」時它們會被抽中的原因。
 * id 以「內」開頭（U+5167 < U+885B），在 canonical 排序中恆在子集之前。
 *
 * **這裡不宣稱「排序靠前所以一定先被選到」**（原註解這樣寫是錯的）：
 * `engine.js` 的 `pickMutuallyValid()` 進來第一件事就是 `shuffle(c, rng)`，候選順序會被洗掉。
 * sentinel 的守備力來自「它們**根本不該進入索引**」，而陷阱有沒有裝上由下方的
 * **正向對照**測試證明（誤用全庫 index 時必定選中），不是靠註解宣稱。
 */
function mkSentinels(n = 8) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `內衛成製字第${String(i + 1).padStart(6, '0')}號`,
      ans: codeName(200 + i),
      shape: ['圓形'], color: ['白'],
      score_mark: ['無'], size: '8', mark1: `ZZ${i}`, mark2: null,
      img: `img/sentinel${i}.webp`,
    });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════
describe('A41 出題品項封閉於子集（防 vacuous pass）', () => {
  // 〔堵〕(a) 空卷讓逐題斷言 vacuous pass；(b) 隨機抽樣剛好沒抽到洩漏品項；
  //       (c) 只驗正解不驗誘答
  test('三級：pool-only sentinel 在全庫但不得進入任何一卷', () => {
    const subset = mkDisjointItems(30, { idFrom: 100, nameFrom: 0 });
    const l2subset = mkL2Items(30, { idFrom: 100, nameFrom: 0 });

    const sentinels = mkSentinels();

    for (const [level, base] of [[Level.L1, subset], [Level.L2, l2subset], [Level.L3, subset]]) {
      const full = [...sentinels, ...base];              // sentinel 排在最前面
      const matchedIds = new Set(base.map((it) => it.id));
      const r = probeFormulary({
        payload: payloadOf(base), poolItems: full, matchedIds, levels: [level],
      }).levels[level];

      // 先證明卷是真的組出來的——空卷的聯集是空集合，自然是子集
      assert.equal(r.available, true, `${level} 應可用`);
      assert.equal(r.quiz.length, QUIZ_SIZE, `${level} 卷長應為 20`);
      // 不讀實作自己回報的 violations（那是受測程式產生的期望值）——
      // 以測試自己重建的子集 index 獨立驗一次
      assert.deepEqual(validateQuizInvariants(r.quiz, { level, index: buildIndex(base) }), []);

      const used = allQuizIds(r.quiz);
      assert.ok(used.size > 0);
      for (const id of used) {
        assert.ok(matchedIds.has(id), `${level} 出現子集外的品項：${id}`);
      }
      for (const s of sentinels) {
        assert.ok(!used.has(s.id), `${level} 洩漏了全庫品項 ${s.id}`);
      }
      // 逐題也要驗（不是只看聯集）：正解、全部選項、全部備援
      for (const q of r.quiz) {
        assert.ok(matchedIds.has(q.item.id));
        for (const o of q.options || []) assert.ok(matchedIds.has(o.id));
        for (const sp of q.spares || []) assert.ok(matchedIds.has(sp.id));
      }
    }
  });

  test('正向對照：陷阱確實有裝上——誤用全庫 index 時 sentinel 必被選中', () => {
    // 依 codex-review 發現 4 新增。上一條測「sentinel 沒出現」，但**沒有任何斷言
    // 證明它出得來**——若 sentinel 因外觀或名稱條件而永遠不可能成為候選，
    // 那條就只是在驗一件恆真的事（M5 的 M-16 同型：判準漏了自己不知道）。
    //
    // 這裡以**受控 RNG** 直接呼叫 `buildChoices()` 並餵**全庫 index**（＝錯誤實作），
    // 且把整個子集放進 excludeAns（H2 在滿卷時就是這個樣子）——此時唯一的合法候選
    // 就是 sentinel。選得到，證明陷阱是活的；選不到，代表上一條測試在驗空氣。
    const sentinels = mkSentinels();
    const sentinelIds = new Set(sentinels.map((s) => s.id));

    // L2 的候選必須同形同色，因此 L2 的 base 要用 mkL2Items（圓形／白），
    // 與 sentinel 同形同色而刻字互異——這才是 L2 真正的誘答條件
    for (const [level, base] of [
      [Level.L1, mkDisjointItems(30, { idFrom: 100 })],
      [Level.L2, mkL2Items(30, { idFrom: 100 })],
    ]) {
      const fullIndex = buildIndex([...sentinels, ...base]);
      const choice = buildChoices(base[0], fullIndex, {
        level,
        rng: makeRng(7),
        excludeAns: new Set(base.map((b) => b.ans)),
      });
      const picked = [...choice.options, ...choice.spares].filter((o) => o !== base[0]);
      assert.ok(picked.length > 0);
      for (const p of picked) {
        assert.ok(sentinelIds.has(p.id),
          `${level} 的誘答 ${p.id} 不是 sentinel——這個對照沒有把候選逼到只剩 sentinel`);
      }
    }
  });

  test('子集索引本身不得含全庫品項（結構層的同一道防線）', () => {
    const base = mkDisjointItems(30, { idFrom: 100 });
    const sentinel = { ...mkDisjointItems(1, { idFrom: 1, nameFrom: 300 })[0], id: '內衛成製字第000001號' };
    const prep = prepareFormulary([sentinel, ...base], new Set(base.map((it) => it.id)));
    assert.equal(prep.N, 30);
    assert.ok(!prep.items.some((it) => it.id === sentinel.id));
    assert.ok(!prep.index.keys.includes(sentinel.ans));
    assert.deepEqual(prep.missing, []);
  });

  test('真實題庫的隨機子集：三級都組得出卷且封閉', () => {
    needData();
    // 決定性子集：以固定 seed 從真實 pool 抽 300 筆
    const rng = makeRng(20260811);
    const ids = POOL.items.map((it) => it.id);
    for (let i = 0; i < 300; i++) {
      const j = i + Math.floor(rng() * (ids.length - i));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const matchedIds = new Set(ids.slice(0, 300));
    const r = probeFormulary({
      payload: encodeFormulary(matchedIds, 0), poolItems: POOL.items, matchedIds,
    });
    assert.equal(r.N, 300);
    for (const level of [Level.L1, Level.L2, Level.L3]) {
      const lr = r.levels[level];
      assert.equal(lr.available, true, `${level} 在 300 品項子集應可用（K=${lr.K}）`);
      assert.equal(lr.quiz.length, QUIZ_SIZE);
      for (const id of allQuizIds(lr.quiz)) {
        assert.ok(matchedIds.has(id), `${level} 洩漏了子集外的 ${id}`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A42 可用性判定：級別特定邊界＋真的組得出卷＋可重現', () => {
  // 〔堵〕(a) availability 只依 .size 回標籤，不證明能出卷；
  //       (b) 三個級別共用同一組 K 邊界（v5.2 的錯誤，會掩蓋 L1／L2 的誘答需求）；
  //       (c) 只用單一 seed，敵意子集恰好在該 seed 失敗就通過
  const BOUNDS = {
    [Level.L1]: [[12, null], [13, 10], [22, 19], [23, 20]],
    [Level.L2]: [[14, null], [15, 10], [24, 19], [25, 20]],
    [Level.L3]: [[9, null], [10, 10], [19, 19], [20, 20]],
  };

  test('D38.1 的算術本身：三級的 need／最小 K／卷長公式各不相同', () => {
    assert.deepEqual([Level.L1, Level.L2, Level.L3].map(distractorNeed), [3, 5, 0]);
    assert.deepEqual([Level.L1, Level.L2, Level.L3].map(minUsableK), [13, 15, 10]);
    assert.equal(MIN_QUIZ_LEN, 10);
    // 卷長是 min(20, K − need)，不是 K
    assert.equal(quizLenFor(Level.L1, 23), 20);
    assert.equal(quizLenFor(Level.L1, 22), 19);
    assert.equal(quizLenFor(Level.L2, 25), 20);
    assert.equal(quizLenFor(Level.L2, 24), 19);
    assert.equal(quizLenFor(Level.L3, 20), 20);
  });

  for (const [level, rows] of Object.entries(BOUNDS)) {
    for (const [K, expectLen] of rows) {
      test(`${level} K=${K} → ${expectLen === null ? '禁用' : `卷長 ${expectLen}`}`, () => {
        const items = mkItems(level, K);
        const index = buildIndex(items);
        // fixture 自檢：宣稱的 K 必須真的是該級的可出題鍵數
        assert.equal(eligibleKeys(index, level).size, K, `fixture 的 K 不是 ${K}`);

        const r = probeLevel({ payload: payloadOf(items), level, items, index });
        assert.equal(r.K, K);
        if (expectLen === null) {
          assert.equal(r.available, false);
          assert.equal(r.code, 'K_BELOW_MIN');
          assert.equal(r.quiz, null);
          return;
        }
        // 標記為可用者**都必須實際組卷成功並通過 invariants**
        assert.equal(r.available, true, `應可用但被判 ${r.code}：${r.reason}`);
        assert.equal(r.quizLen, expectLen);
        assert.equal(r.quiz.length, expectLen);
        // 不讀實作自己回報的 violations（那是受測程式產生的期望值）——
        // 以測試自己重建的子集 index 獨立驗一次
        assert.deepEqual(validateQuizInvariants(r.quiz, { level, index: buildIndex(items) }), []);
        const ids = new Set(items.map((it) => it.id));
        for (const id of allQuizIds(r.quiz)) assert.ok(ids.has(id));
      });
    }
  }

  test('敵意子集：K 過門檻但整卷組不出來 → 判不可用（≥5 個 seed 都一樣）', () => {
    // A1–A10 同形同色（彼此不能當誘答）；B1–B3 外觀與 A 不相交但**三者名稱互相碰撞**。
    // 逐鍵判定（recordEligible 不看整卷脈絡）會說 13 個鍵全部可用：
    // A 各有 B1/B2/B3 三個外觀不相交的候選，B 各有 10 個 A。
    // 但整卷 excludeAns 恆為全卷正解集合（H2），10 題怎麼抽都湊不到 3 個兩兩合法的誘答。
    const A = [];
    for (let i = 0; i < 10; i++) {
      A.push({ id: synthId(1 + i), ans: codeName(i), shape: ['S0'], color: ['C0'],
        score_mark: ['無'], size: '8', mark1: `A${i}`, mark2: null, img: `a${i}.webp` });
    }
    const B = ['XXA', 'XXB', 'XXC'].map((ans, i) => ({
      id: synthId(101 + i), ans, shape: ['S1'], color: ['C1'],
      score_mark: ['無'], size: '8', mark1: `B${i}`, mark2: null, img: `b${i}.webp` }));
    for (const b of B) for (const b2 of B) if (b !== b2) {
      assert.ok(nameCollides(b.ans, b2.ans), 'B 組必須彼此名稱碰撞，否則這個 fixture 不敵意');
    }
    const items = [...A, ...B];
    const index = buildIndex(items);

    // 前置門檻**過得了**——這正是「只看 .size 就發可用標籤」會誤判的地方
    assert.equal(eligibleKeys(index, Level.L1).size, 13);
    assert.equal(minUsableK(Level.L1), 13);
    assert.equal(quizLenFor(Level.L1, 13), 10);

    for (const payload of ['seedA', 'seedB', 'seedC', 'seedD', 'seedE', payloadOf(items)]) {
      const r = probeLevel({ payload, level: Level.L1, items, index });
      assert.equal(r.available, false, `payload=${payload} 竟判為可用`);
      assert.equal(r.code, 'QUIZ_ASSEMBLY_FAILED');
      assert.equal(r.quiz, null);
      assert.equal(r.quizLen, 10, '仍要如實回報它嘗試的目標卷長');
    }
  });

  /**
   * 三級**各一個確定可組卷**的 fixture（依 codex-review 發現 3 新增）。
   *
   * 原本可重現性只驗 L1。**已實跑確認**：把 `probeLevel` 改成「只有 L2 用
   * `Math.random`」，105 條測試全綠——因為 ≥5 次比對與 `Math.random` 隔離都只跑 L1，
   * 子集排序那條的 L2 fixture 恆為不可用所以不比第一卷，A41／A43 的 L2 各只跑一次。
   * D38.3 是「檢查時可用、按下去失敗」的唯一防線，只守 L1 等於守三分之一。
   */
  const REPRO = () => [
    [Level.L1, mkDisjointItems(30)],
    [Level.L2, mkL2Items(30)],
    [Level.L3, mkDisjointItems(30)],
  ];

  for (const [level] of REPRO()) {
    test(`D38.3 可重現（${level}）：同 payload ＋同子集 → 同判定、同第一卷（≥5 次）`, () => {
      const items = REPRO().find(([lv]) => lv === level)[1];
      const payload = payloadOf(items);
      const first = probeLevel({ payload, level, items });
      assert.equal(first.available, true, `${level} fixture 必須可組卷，否則這條在驗空氣`);
      for (let i = 0; i < 5; i++) {
        const r = probeLevel({ payload, level, items });
        assert.equal(r.available, first.available);
        assert.equal(r.K, first.K);
        assert.equal(r.quizLen, first.quizLen);
        assert.deepEqual(quizIdentity(r.quiz), quizIdentity(first.quiz),
          '同一 payload 必須得到相同的第一卷，否則會「檢查時可用、按下去失敗」');
      }
    });

    test(`D38.3 seed 與 Math.random 無關（${level}）`, () => {
      const items = REPRO().find(([lv]) => lv === level)[1];
      const payload = payloadOf(items);
      const before = Math.random;
      try {
        Math.random = () => 0.5;
        const a = probeLevel({ payload, level, items });
        Math.random = () => 0.9;
        const b = probeLevel({ payload, level, items });
        Math.random = () => { throw new Error('probe 不得呼叫 Math.random'); };
        const c = probeLevel({ payload, level, items });
        assert.equal(a.available, true);
        assert.deepEqual(quizIdentity(b.quiz), quizIdentity(a.quiz));
        assert.deepEqual(quizIdentity(c.quiz), quizIdentity(a.quiz));
      } finally { Math.random = before; }
    });
  }

  test('D38.3 三級的 seed 互不相同（否則三級抽出同一組題）', () => {
    const payload = payloadOf(mkDisjointItems(30));
    const seeds = [Level.L1, Level.L2, Level.L3].map((lv) => formularySeed(payload, lv));
    assert.equal(new Set(seeds).size, 3);
  });

  test('D38.3 子集排序：輸入順序不得影響判定與第一卷', () => {
    // 〔堵〕忘了「餵入 buildIndex 前依 canonical id 昇冪排序」——
    //       同一份清單在不同 pool 版本（列序不同）下會抽出不同的卷
    const items = mkDisjointItems(30);
    const payload = payloadOf(items);
    const shuffled = [...items].reverse();
    const wanted = new Set(items.map((i) => i.id));
    const a = probeFormulary({ payload, poolItems: items, matchedIds: wanted });
    const b = probeFormulary({ payload, poolItems: shuffled, matchedIds: wanted });
    assert.deepEqual(b.items.map((i) => i.id), a.items.map((i) => i.id));
    // 這份 fixture 外觀兩兩不相交，L2 抽不到同形同色的誘答 ⇒ L2 本來就不可用。
    // 那也是「判定必須一致」的一部分，不可只比對可用的那兩級
    assert.equal(a.levels[Level.L2].available, false);
    for (const lv of [Level.L1, Level.L2, Level.L3]) {
      assert.equal(b.levels[lv].available, a.levels[lv].available, `${lv} 的判定隨輸入順序改變`);
      assert.equal(b.levels[lv].code, a.levels[lv].code);
      assert.equal(b.levels[lv].K, a.levels[lv].K);
      if (a.levels[lv].available) {
        assert.deepEqual(quizIdentity(b.levels[lv].quiz), quizIdentity(a.levels[lv].quiz));
      }
    }
  });

  test('未知錯誤必須重拋，不得降格成「該級不可用」', () => {
    // 依 codex-review 發現 2 新增。原本 `catch (e)` 全攔：一個 TypeError 會被貼上
    // 「組卷失敗」的標籤，使用者只看到級別按鈕變灰——真 bug 以靜默失效呈現。
    // 這裡用「index 是好的、items 的外觀欄位被抽掉」逼出 TypeError：
    // eligible 由好的 index 算出，poisoned 紀錄的 ans 仍在其中，於是必被抽為正解，
    // 而 L1 的 candidateOk 會去讀 correct.shape
    const good = mkDisjointItems(30);
    const index = buildIndex(good);
    const poisoned = good.map((it) => ({ ...it, shape: undefined }));
    assert.throws(
      () => probeLevel({ payload: payloadOf(good), level: Level.L1, items: poisoned, index }),
      TypeError,
      '未知錯誤被吞掉了——它應該以真面目炸出來');
  });

  test('可降級的失敗回固定文字，不含藥名也不含 undefined', () => {
    const items = mkDisjointItems(9);          // K=9 < 13 → K_BELOW_MIN
    const r = probeLevel({ payload: payloadOf(items), level: Level.L1, items });
    assert.equal(r.available, false);
    assert.ok(r.reason && !/undefined/.test(r.reason), `reason 不得含 undefined：${r.reason}`);
    // 敵意子集走的是另一條（QUIZ_ASSEMBLY_FAILED），同樣不得出現 undefined
    const A = Array.from({ length: 10 }, (_, i) => ({
      id: synthId(1 + i), ans: codeName(i), shape: ['S0'], color: ['C0'],
      score_mark: ['無'], size: '8', mark1: `A${i}`, mark2: null, img: `a${i}.webp` }));
    const B = ['XXA', 'XXB', 'XXC'].map((ans, i) => ({
      id: synthId(101 + i), ans, shape: ['S1'], color: ['C1'],
      score_mark: ['無'], size: '8', mark1: `B${i}`, mark2: null, img: `b${i}.webp` }));
    const h = probeLevel({ payload: 'x', level: Level.L1, items: [...A, ...B] });
    assert.equal(h.code, 'QUIZ_ASSEMBLY_FAILED');
    assert.ok(!/undefined/.test(h.reason), `reason 不得含 undefined：${h.reason}`);
    for (const it of [...A, ...B]) assert.ok(!h.reason.includes(it.ans), 'reason 不得含藥名');
  });

  test('三級全禁用時 anyAvailable 為 false；D41 的 missing 不吞掉', () => {
    const items = mkDisjointItems(9);
    const gone = [...items.map((i) => i.id), synthId(9999)];
    const r = probeFormulary({ payload: payloadOf(items), poolItems: items, matchedIds: new Set(gone) });
    assert.equal(r.anyAvailable, false);
    assert.deepEqual(r.missing, [synthId(9999)]);
    assert.equal(r.N, 9);
  });

  /**
   * v5.11：`missing` 拆成兩種後果完全不同的情形。
   * 這支是純函式，UI 那一層（C44.1）驗的是「哪一種用橘字講」。
   */
  describe('splitMissing', () => {
    const stages = new Map([[synthId(1), 'Q1'], [synthId(2), 'Q3']]);

    test('分不出來時回 null——呼叫端必須自己決定講什麼', () => {
      // 〔堵〕回 `{excluded: [], absent: [...]}` 當預設值：
      //       那等於在還不知道的時候斷言「全部都消失了」，正是要修的那個假警報
      assert.equal(splitMissing([synthId(1)], null), null);
      assert.equal(splitMissing([synthId(1)], undefined), null);
    });

    test('在 excluded 內的歸 excluded，其餘歸 absent', () => {
      const r = splitMissing([synthId(1), synthId(2), synthId(3)], stages);
      assert.deepEqual(r.excluded, [synthId(1), synthId(2)]);
      assert.deepEqual(r.absent, [synthId(3)]);
    });

    test('兩邊互斥且加總不遺漏', () => {
      const miss = [synthId(1), synthId(3), synthId(4), synthId(2)];
      const r = splitMissing(miss, stages);
      assert.equal(r.excluded.length + r.absent.length, miss.length);
      for (const id of r.excluded) assert.ok(!r.absent.includes(id));
    });

    test('空的 missing 兩邊都是空陣列，不是 null', () => {
      assert.deepEqual(splitMissing([], stages), { excluded: [], absent: [] });
    });
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A43 短卷的完整封閉性（級別特定）', () => {
  // 〔堵〕沿用 v5.2 的「正解集合恰等於 K」——對 L1／L2 數學上不可能，
  //       實作只能靠違反 H2 或跨子集誘答通過
  const CASES = [
    { level: Level.L1, K: 14, len: 11, proper: true },
    { level: Level.L2, K: 15, len: 10, proper: true },
    { level: Level.L3, K: 14, len: 14, proper: false },
  ];

  for (const { level, K, len, proper } of CASES) {
    test(`${level} K=${K} → 卷長 ${len}，正解集合${proper ? '為真子集' : '恰等於全部鍵'}`, () => {
      const items = mkItems(level, K);
      const index = buildIndex(items);
      assert.equal(eligibleKeys(index, level).size, K);

      const r = probeLevel({ payload: payloadOf(items), level, items, index });
      assert.equal(r.available, true, `應可用但被判 ${r.code}`);
      assert.equal(r.quiz.length, len);
      // 不讀實作自己回報的 violations（那是受測程式產生的期望值）——
      // 以測試自己重建的子集 index 獨立驗一次
      assert.deepEqual(validateQuizInvariants(r.quiz, { level, index: buildIndex(items) }), []);

      const keys = new Set(items.map((it) => it.ans));
      const corrects = new Set(r.quiz.map((q) => q.item.ans));
      assert.equal(corrects.size, len);
      for (const k of corrects) assert.ok(keys.has(k));
      if (proper) {
        assert.ok(corrects.size < keys.size, '正解集合必須是真子集（誘答要從卷外取）');
        assert.equal(keys.size - corrects.size, distractorNeed(level),
          '留給誘答的鍵數必須恰為該級的 need');
      } else {
        assert.deepEqual([...corrects].sort(), [...keys].sort());
      }

      const ids = new Set(items.map((it) => it.id));
      for (const q of r.quiz) {
        for (const o of q.options || []) assert.ok(ids.has(o.id), `選項 ${o.id} 不在子集`);
        for (const s of q.spares || []) assert.ok(ids.has(s.id), `備援 ${s.id} 不在子集`);
      }
    });
  }

  test('L2 K=14 只能是禁用（A42／A43 曾互相矛盾，見 R3-6）', () => {
    const items = mkL2Items(14);
    const r = probeLevel({ payload: payloadOf(items), level: Level.L2, items });
    assert.equal(r.available, false);
    assert.equal(r.code, 'K_BELOW_MIN');
  });
});

// ════════════════════════════════════════════════════════════════════
describe('A44 四分類逐 stage 精確 membership', () => {
  // 〔堵〕把所有 unmatched 錯分到同一類，總和與互斥仍然成立——
  //       封閉性斷言證明不了分類正確。且 v5.0 完全沒測 Q3
  const ID = {
    pool1: synthId(11), pool2: synthId(12),
    q1: synthId(21), q2: synthId(22), q3: synthId(23), q4: synthId(24), q5: synthId(25),
    ghost: synthId(31),                       // 格式合法、兩份檔案都沒有
  };
  const refs = () => ({
    poolIds: new Set([ID.pool1, ID.pool2]),
    excludedStages: new Map([
      [ID.q1, 'Q1'], [ID.q2, 'Q2'], [ID.q3, 'Q3'], [ID.q4, 'Q4'], [ID.q5, 'Q5'],
    ]),
  });

  test('逐筆精確歸屬：matched／Q1／Q2／Q3／Q4／Q5／來源不存在', () => {
    const junk = '衛署藥XX字第000001號';     // 未知前綴 → 正規化不出東西
    const r = classifyFormulary(
      [ID.pool1, ID.pool2, ID.q1, ID.q2, ID.q3, ID.q4, ID.q5, ID.ghost, junk], refs());

    assert.deepEqual(r.matched, [ID.pool1, ID.pool2]);
    assert.deepEqual(r.nonSolidOral, [ID.q1]);
    assert.deepEqual(r.lowQuality, [ID.q2, ID.q3, ID.q4, ID.q5]);
    assert.deepEqual([...r.unlisted].sort(), [ID.ghost, junk].sort());
    assert.deepEqual(r.byStage, {
      Q1: [ID.q1], Q2: [ID.q2], Q3: [ID.q3], Q4: [ID.q4], Q5: [ID.q5],
    });
    // 第二類必須涵蓋 Q3（品名過短），不得只有「無圖或無刻字」
    assert.ok(r.lowQuality.includes(ID.q3));
    assert.ok(CATEGORY_LABEL[Category.LOW_QUALITY].includes('品名過短'));
  });

  test('總和封閉與兩兩互斥', () => {
    const all = [ID.pool1, ID.pool2, ID.q1, ID.q2, ID.q3, ID.q4, ID.q5, ID.ghost];
    const r = classifyFormulary(all, refs());
    const groups = [r.matched, r.nonSolidOral, r.lowQuality, r.unlisted];
    assert.equal(groups.reduce((n, g) => n + g.length, 0), r.distinct);
    assert.equal(r.distinct, all.length);
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        for (const v of groups[i]) assert.ok(!groups[j].includes(v), `${v} 同時屬於兩類`);
      }
    }
    // D34.1：payload 只帶「來源已知」的 id
    assert.deepEqual(r.payloadIds, [...r.matched, ...r.nonSolidOral, ...r.lowQuality].sort());
    assert.ok(!r.payloadIds.includes(ID.ghost));
    assert.equal(r.unlistedCount, 1);
  });

  test('重複 id：去重時點在正規化之後（全形／空白／缺第缺號都算同一筆）', () => {
    const variants = [
      '衛署藥製字第000021號', '衛署藥製字第００００２１號', ' 衛署藥製字第 000021 號 ',
      '衛署藥製字第21號', '衛署藥製字000021', '衛署藥製字第000021號',
    ];
    const r = classifyFormulary(variants, refs());
    assert.equal(r.distinct, 1);
    assert.deepEqual(r.nonSolidOral, [ID.q1]);
    assert.equal(r.matched.length + r.lowQuality.length + r.unlisted.length, 0);
  });

  test('第三類的去重與 UNLISTED 計數用同一套折疊（D34.2a）', () => {
    // 〔堵〕正規化失敗的 token 若改用另一套（或不做）折疊，
    //       同一個未知前綴的全形／半形寫法會被算成 2 筆
    const r = classifyFormulary(
      ['衛署藥XX字第000001號', '衛署藥ＸＸ字第０００００１號', ' 衛署藥XX字第000001號 '], refs());
    assert.equal(r.unlistedCount, 1);
    assert.equal(r.distinct, 1);
  });

  test('空／空白 token 不計入任何一類，但也不靜默丟掉', () => {
    const r = classifyFormulary(['', '   ', '　', ID.pool1], refs());
    assert.equal(r.blank, 3);
    assert.equal(r.distinct, 1);
    assert.deepEqual(r.matched, [ID.pool1]);
  });

  test('stage 由 excluded.json 決定，分類層不得改寫（precedence 由 B10 守）', () => {
    // 同一筆 id 換一個 stage，分類必須跟著換——若實作自己推導 stage，這條會紅
    const alt = new Map([[ID.q1, 'Q4']]);
    const r = classifyFormulary([ID.q1], { poolIds: new Set(), excludedStages: alt });
    assert.deepEqual(r.byStage.Q4, [ID.q1]);
    assert.deepEqual(r.nonSolidOral, []);
    assert.deepEqual(r.lowQuality, [ID.q1]);
  });

  test('缺 excludedStages 直接拋 —— 少了它 Q1–Q5 會全被誤標成「不在資料集中」', () => {
    throwsCode(() => classifyFormulary([ID.q1], { poolIds: new Set() }), 'BAD_EXCLUDED_INDEX');
    throwsCode(() => classifyFormulary([ID.q1], { excludedStages: new Map() }), 'BAD_POOL_IDS');
  });

  test('stage 值域外 → 拋錯，不得默默歸成某一類', () => {
    throwsCode(() => classifyFormulary([ID.q1],
      { poolIds: new Set(), excludedStages: new Map([[ID.q1, 'Q9']]) }), 'BAD_STAGE');
  });

  test('D37.1 顯示名稱：不得暗示使用者打錯，且內外代碼分離', () => {
    for (const label of Object.values(CATEGORY_LABEL)) {
      assert.ok(!label.includes('查無此證'), '「查無此證」不得出現在使用者可見之處');
      assert.ok(!label.includes('請核對'));
    }
    // S-2：命中類的標籤是 **N** 的標籤，不得承諾出題能力——K 由級別決定，
    // L2 的 K 常比 N 少三成。規格名詞表：任何 UI 文字不得用 N 代替 K
    assert.ok(!CATEGORY_LABEL[Category.MATCHED].includes('可出題'),
      '命中類的標籤不得寫「可出題」，那是 K 的語意');
    const u = CATEGORY_LABEL[Category.UNLISTED];
    assert.ok(u.includes('不在外觀資料集中'));
    assert.ok(u.includes('針劑') && u.includes('外用') && u.includes('眼藥'));
    assert.ok(u.includes('已下市') && u.includes('誤植'), '做不到的區分必須誠實涵蓋全部可能');
    assert.equal(Category.UNLISTED, 'UNLISTED');
  });

  test('真實兩份資料：逐 stage 筆數必須等於 pool.meta.stages 的首次淘汰差值', () => {
    needData();
    // 期望值取自**管線自己的另一個輸出**（`meta.stages` 的存活數差值），
    // 不是由 excluded.json 自己數出來的——規格引用管線行為時一律取管線的輸出
    const order = ['來源', ...Object.keys(POOL.meta.stages).filter((k) => /^Q[1-5] /.test(k))];
    const expect = {};
    for (let i = 1; i < order.length; i++) {
      expect[order[i].slice(0, 2)] = POOL.meta.stages[order[i - 1]] - POOL.meta.stages[order[i]];
    }
    assert.deepEqual(expect, { Q1: 572, Q2: 1, Q3: 8, Q4: 1603, Q5: 170 },
      'D37 表格的筆數與 pool.meta.stages 對不上');

    const stages = buildExcludedIndex(POOL, EXCLUDED);
    const poolIds = new Set(POOL.items.map((it) => it.id));
    const r = classifyFormulary(EXCLUDED.items.map((it) => it.id), { poolIds, excludedStages: stages });

    assert.equal(r.matched.length, 0);
    assert.equal(r.unlistedCount, 0);
    assert.equal(r.distinct, EXCLUDED.items.length);
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']) {
      assert.equal(r.byStage[q].length, expect[q], `${q} 筆數不符`);
    }
    assert.equal(r.nonSolidOral.length, expect.Q1);
    assert.equal(r.lowQuality.length, expect.Q2 + expect.Q3 + expect.Q4 + expect.Q5);
    assert.equal(r.nonSolidOral.length + r.lowQuality.length, EXCLUDED.meta.count);
  });

  test('真實兩份資料：pool 的 id 全部歸 matched，一筆都不得落入其他類', () => {
    needData();
    const stages = buildExcludedIndex(POOL, EXCLUDED);
    const poolIds = new Set(POOL.items.map((it) => it.id));
    const r = classifyFormulary(POOL.items.map((it) => it.id), { poolIds, excludedStages: stages });
    assert.equal(r.matched.length, POOL.items.length);
    assert.equal(r.nonSolidOral.length + r.lowQuality.length + r.unlisted.length, 0);
  });

  test('D49：excluded.json 單筆損毀即整份不可用（不做逐筆容錯）', () => {
    needData();
    const broken = { meta: { ...EXCLUDED.meta }, items: [...EXCLUDED.items] };
    broken.items[7] = { id: broken.items[7].id, stage: 'Q7' };
    assert.throws(() => buildExcludedIndex(POOL, broken), (e) =>
      e instanceof FormularyError && e.code === 'EXCLUDED_UNUSABLE' && e.errors.length >= 1);
    // hash 不成對也是整份不可用（D47：產連結停用，出題不受影響）
    const mismatched = { meta: { ...EXCLUDED.meta, content_hash: 'sha256:0' }, items: EXCLUDED.items };
    throwsCode(() => buildExcludedIndex(POOL, mismatched), 'EXCLUDED_UNUSABLE');
  });

  test('D49：join key 必須是 canonical——兩側都驗（codex-review 發現 1／自查 S-1）', () => {
    // 〔堵〕只驗「非空字串」。實跑重現過：`衛署藥製字第21號` 進 excluded 後
    //       `validatePair()` 回空陣列，而使用者打對的 `衛署藥製字第000021號`
    //       被分到第三類，畫面對一顆確實在資料集裡的藥說「不在外觀資料集中」
    const hash = 'sha256:abc';
    const okPool = { meta: { content_hash: hash }, items: [{ id: synthId(11) }] };
    const mkEx = (id) => ({ meta: { schema: 1, content_hash: hash, count: 1 }, items: [{ id, stage: 'Q1' }] });

    const BAD_IDS = [
      ['缺前導零', '衛署藥製字第21號'],
      ['前後空白', ' 衛署藥製字第000021號 '],
      ['全形數字', '衛署藥製字第０００００２１號'],
      ['缺「號」', '衛署藥製字第000021'],
    ];
    for (const [name, id] of BAD_IDS) {
      const errs = validatePair(okPool, mkEx(id), null);
      assert.ok(errs.some((e) => e.includes('canonical')),
        `${name}（${id}）應被判為非 canonical，實得：${JSON.stringify(errs)}`);
      throwsCode(() => buildExcludedIndex(okPool, mkEx(id)), 'EXCLUDED_UNUSABLE');
    }
    // 正面案例：canonical 的 id 不得誤擋
    assert.deepEqual(validatePair(okPool, mkEx(synthId(21)), null), []);

    // **pool 側同樣要驗**（Codex 只提了 excluded 側）：pool 的 id 直接取自來源欄位，
    // 非 canonical 的 pool id 更糟——那顆藥可以出題，卻永遠進不了任何一份院內清單
    const badPool = { meta: { content_hash: hash }, items: [{ id: '衛署藥製字第11號' }] };
    const poolErrs = validatePair(badPool, mkEx(synthId(21)), null);
    assert.ok(poolErrs.some((e) => e.includes('pool.json') && e.includes('canonical')),
      `pool 側的非 canonical id 應被擋下，實得：${JSON.stringify(poolErrs)}`);
  });

  test('真實兩份資料的 id 全部是 canonical（今天成立，但沒有守衛就會漂）', () => {
    needData();
    assert.deepEqual(validatePair(POOL, EXCLUDED, null), []);
    for (const it of POOL.items) assert.equal(normalizeLicense(it.id), it.id);
    for (const it of EXCLUDED.items) assert.equal(normalizeLicense(it.id), it.id);
  });
});
