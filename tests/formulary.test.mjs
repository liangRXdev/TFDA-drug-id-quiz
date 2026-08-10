/**
 * V5 批次 1 — 藥證字號正規化與連結編碼（規格 plan-v5-formulary.md v5.8 的 A36–A40、A45）
 *
 *   node --test
 *
 * 這一檔只驗**純函式**。凡涉及 UI、localStorage、出題、管線者一律不在此。
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
import {
  PREFIX_TABLE, FORMAT_VERSION, PREFIX_TABLE_VERSION,
  normalizeLicense, tokenize, encodeFormulary, decodeFormulary, crc32,
  FormularyError,
} from '../formulary.js';
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
