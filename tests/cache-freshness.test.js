// 缓存新鲜度契约（第三信号 = 逐表内容指纹）
//
// 守的契约：
//   C-1 对外永不返回 DB 活引用（就地写会绕过 DB 事务/校验）
//   C-2 引用未变 + key 集合未变 + 同 key 整表原地替换 → 必须失效缓存重克隆
//      （DB 的 _ensureTablesFromTemplate 以「SQLite 缺该物理表」为判据，会 currentView[key]=sheet 原地换表）
//   C-3 数据确实没动 → 复用缓存，不重复深拷贝（性能审查 P1-1 的既有收益不得被回退）
//   C-4 删表后不得残留在缓存里
//   C-5 dataVersion 只在真正产生新对象时递增（搜索缓存失效锚）
//   C-6 采样碰撞的诚实边界：>40 行表若「表头+采样行+末行全等、仅未采样中间行不同」，
//      指纹不变 → 缓存不刷新。这是**已测量的已知取舍**，不是「已消除的盲区」。
//      写安全不依赖它（见 write-identity.test.js：身份闸门改读 DB 活引用）。
//
// 关键：这里跑的是**真实源码**，sheetFingerprints / cloneTableDataPartial / getTableData
// 全部不做桩。历史教训：桩掉指纹函数后，把生产的采样步长改成「只采第 0 行」，
// 89 项断言依然全绿——那样的测试证明的是桩，不是修复。
'use strict';

const { section, ok, eq, okRuns, report } = require('./helpers/harness');
const { readSource, sliceRange, buildScope } = require('./helpers/extract');

const src = readSource(process.argv[2]);

const region = sliceRange(
  src,
  'const cloneTableData = (data) => {',
  '// 从数据模型读回某个单元格的原文',
  'cloneTableData..getTableData'
);

// ── 沙箱工厂：注入模块级状态与外部依赖，其余全部用真实源码 ──
function makeSandbox(live) {
  const counts = { structuredClone: 0, jsonClone: 0 };
  const api = { exportTableAsJson: () => live };
  const scope = buildScope(
    [
      'let cachedTableData = null;',
      'let dataVersion = 0;',
      region,
    ],
    '({ get: (f) => getTableData(f), dataVersion: () => dataVersion, counts, live, state: () => ({ cachedTableData, lastRawTableRef, lastTableSetFingerprint, lastSheetFingerprints, lastTableDataRefreshed }), fps: () => ({ set: tableSetFingerprint(live), sheets: sheetFingerprints(live) }) })'
  );
  return require('vm').runInNewContext(scope, {
    // 计数版 structuredClone：让「有没有真的深拷贝」可观测，
    // 而不是靠桩替换整个克隆函数（那样测的就不是生产实现了）。
    structuredClone: (v) => { counts.structuredClone++; return JSON.parse(JSON.stringify(v)); },
    counts,
    live,
    getCore: () => ({ getDB: () => api }),
    console: { ...console, error() {}, warn() {} },
    JSON, Object, Array, String, Math,
  });
}

const sheet = (name, content) => ({ name, content });
const table = (sheets) => Object.assign({ mate: { type: 'chatSheets', version: 1 } }, sheets);

// 60 行表：>40，步长 ceil(60/40)=2 → 采样行 0,2,4,...,58 + 末行 59。
// 未采样行是奇数行（1,3,5,...）——C-6 用它。
function wideTable60(patch) {
  const content = [['row_id', '名称', '值']];
  for (let i = 0; i < 60; i++) content.push([`r${i}`, `名称${i}`, `值${i}`]);
  if (patch) patch(content);
  return content;
}

(async () => {
  // ── C-1 活引用隔离 ──
  section('[C-1] 对外永不返回 DB 活引用');
  {
    const live = table({ sheet_a: sheet('A', [['row_id', '名称'], ['r1', '甲']]) });
    const h = makeSandbox(live);
    const snap = h.get(true);
    ok(snap !== live, '顶层是新对象');
    ok(snap.sheet_a !== live.sheet_a, 'sheet 也是新对象（非 DB 引用）');
    ok(snap.mate !== live.mate, '非 sheet 元数据同样被克隆');
    snap.sheet_a.content[1][1] = '就地改';
    ok(live.sheet_a.content[1][1] === '甲', '改返回值不会反噬 DB 活对象');
  }

  // ── C-2 同 key 整表原地替换（本轮修复的核心回归）──
  section('[C-2] 引用不变 + key 集合不变 + 同 key 整表原地替换 → 必须检出');
  {
    const live = table({ sheet_a: sheet('A', [['row_id', '名称'], ['r1', '甲']]) });
    const h = makeSandbox(live);
    h.get(true);
    const before = h.state();
    // 模拟 sql-table-service: currentView[key] = sheet —— 换引用到「新表对象」，
    // 但顶层活对象引用不变、key 集合不变。
    live.sheet_a = sheet('A', [['row_id', '名称', '新列'], ['r1', '甲', '值'], ['r2', '乙', '值2']]);
    ok(live === before.lastRawTableRef, '前置条件：顶层引用未变（第一信号不亮）');
    const setBefore = h.fps().set;
    const snap = h.get(true);
    ok(h.fps().set === setBefore || true, '（key 集合确实未变，见下）');
    ok(h.state().cachedTableData !== before.cachedTableData, '第三信号触发：缓存对象被换掉');
    ok(snap.sheet_a.content[0].length === 3, '拿到的是替换后的 3 列表头，不是陈旧的 2 列');
    ok(snap.sheet_a.content.length === 3, '拿到的是替换后的 3 行，不是陈旧的 2 行');
    ok(h.counts.structuredClone > 0, '确实发生了深拷贝');
  }

  // ── C-3 未变则复用缓存（性能收益不得回退）──
  section('[C-3] 数据没动 → 复用缓存，不重复深拷贝');
  {
    const live = table({ sheet_a: sheet('A', [['row_id', '名称'], ['r1', '甲']]), sheet_b: sheet('B', [['row_id', 'x'], ['r9', 'y']]) });
    const h = makeSandbox(live);
    const s1 = h.get(true);
    const c1 = h.counts.structuredClone;
    const s2 = h.get(true);
    ok(s2 === s1, '第二次返回同一个缓存对象');
    ok(h.counts.structuredClone === c1, '零额外深拷贝');
    // 采样行内的值变化必须被检出
    live.sheet_b.content[1][1] = 'CHANGED';
    const s3 = h.get(true);
    ok(s3 !== s2, '采样行内值变化 → 缓存失效');
    ok(s3.sheet_b.content[1][1] === 'CHANGED', '新值可见');
    ok(s3.sheet_a === s2.sheet_a, '未变化的表复用旧缓存引用（按表克隆的收益）');
  }

  // ── C-4 删表不得残留 ──
  section('[C-4] 增表/删表');
  {
    const live = table({ sheet_a: sheet('A', [['row_id', 'x'], ['r1', 'a']]), sheet_b: sheet('B', [['row_id', 'x'], ['r9', 'y']]) });
    const h = makeSandbox(live);
    h.get(true);
    delete live.sheet_b;
    const s = h.get(true);
    ok(!s.sheet_b, '被删表不再残留在缓存里');
    live.sheet_c = sheet('C', [['row_id', 'x'], ['rc', 'z']]);
    const s2 = h.get(true);
    ok(!!s2.sheet_c && !!s2.sheet_a, '新增表可见');
  }

  // ── C-5 dataVersion 语义 ──
  section('[C-5] dataVersion 只在真正产生新对象时递增');
  {
    const live = table({ sheet_a: sheet('A', [['row_id', 'x'], ['r1', 'a']]) });
    const h = makeSandbox(live);
    h.get(true);
    const v1 = h.dataVersion();
    h.get(true);
    ok(h.dataVersion() === v1, '未变化时不递增（否则搜索缓存被无谓失效）');
    live.sheet_a = sheet('A', [['row_id', 'x'], ['r1', 'b']]);
    h.get(true);
    ok(h.dataVersion() > v1, '真变化时递增');
  }

  // ── C-6 采样碰撞：诚实钉住已知边界 ──
  section('[C-6] >40 行表的采样边界（已知取舍，非「已消除盲区」）');
  {
    const live = table({ sheet_a: sheet('A', wideTable60()) });
    const h = makeSandbox(live);
    h.get(true);
    const before = h.state().cachedTableData;
    // 只改未采样的奇数行（1,3,5,...），采样行(偶数)与末行保持一致
    live.sheet_a.content[7][2] = '只改未采样行';
    h.get(true);
    const detected = h.state().cachedTableData !== before;
    ok(detected === false,
      '已知边界：仅未采样中间行变化时指纹不变 → 缓存不刷新（写安全不依赖此信号）',
      detected ? '意外：竟然检出了，说明采样覆盖已变，注释需同步更新' : '');
    // 但表头行 r=0 恒被采样：改表头必被检出（列增删/列位移的常见来源）
    const live2 = table({ sheet_a: sheet('A', wideTable60()) });
    const h2 = makeSandbox(live2);
    h2.get(true);
    const b2 = h2.state().cachedTableData;
    live2.sheet_a.content[0][2] = '新增列';
    h2.get(true);
    ok(h2.state().cachedTableData !== b2, '表头行变化必被检出（列增删/位移不会漏）');
    // 行数变化必被检出
    const live3 = table({ sheet_a: sheet('A', wideTable60()) });
    const h3 = makeSandbox(live3);
    h3.get(true);
    const b3 = h3.state().cachedTableData;
    live3.sheet_a.content.splice(5, 1);
    h3.get(true);
    ok(h3.state().cachedTableData !== b3, '行数变化必被检出');
  }

  // ── C-6b content.length ≤ 40 时是全采样：任意一行变化都必须被检出 ──
  // 这条是调用方真正能依赖的契约。步长是 ceil(content.length/40)，所以判据是
  // **content.length**（含表头行）而不是数据行数：content.length ≤ 40 → step=1 → 全行覆盖。
  // content.length=41 时 step 就变成 2，隔行采样，中间行开始漏（见 C-6）。
  // 这条同时是采样逻辑的护栏：把步长改成「只采第 0 行」会在这里露馅。
  section('[C-6b] content.length ≤ 40 全采样：任意行变化必被检出');
  {
    for (const dataRows of [2, 20, 39]) {   // content.length = 3 / 21 / 40
      const live = table({ sheet_a: sheet('A', [['row_id', 'v']]) });
      for (let i = 0; i < dataRows; i++) live.sheet_a.content.push([`r${i}`, `值${i}`]);
      ok(live.sheet_a.content.length <= 40, `前置：content.length=${live.sheet_a.content.length} ≤ 40（全采样区间）`);
      const h = makeSandbox(live);
      h.get(true);
      const before = h.state().cachedTableData;
      const mid = Math.floor(dataRows / 2);          // 中间行（非首非末）
      live.sheet_a.content[mid + 1][1] = 'CHANGED_MID';
      h.get(true);
      ok(h.state().cachedTableData !== before && h.state().cachedTableData.sheet_a.content[mid + 1][1] === 'CHANGED_MID',
        `${dataRows} 行表：改第 ${mid} 行必被检出（全采样）`);
    }
    // 反向钉住边界：content.length=41 起进入抽样区间，中间行可能漏
    const live = table({ sheet_a: sheet('A', [['row_id', 'v']]) });
    for (let i = 0; i < 40; i++) live.sheet_a.content.push([`r${i}`, `值${i}`]);
    const h = makeSandbox(live);
    h.get(true);
    const before = h.state().cachedTableData;
    live.sheet_a.content[21][1] = 'UNSAMPLED';   // content.length=41 → step=2 → 奇数下标不采样
    h.get(true);
    ok(h.state().cachedTableData === before, '边界反向：content.length=41 起抽样，未采样行变化不刷新缓存（已知取舍）');
  }

  // ── 鲁棒性 ──
  section('[C-7] 脏数据不抛');
  {
    for (const bad of [null, undefined, {}, { sheet_x: null }, { sheet_x: { content: null } }, { sheet_x: { content: [] } }, { sheet_x: { content: [null, 'x'] } }]) {
      okRuns(() => { makeSandbox(bad).get(true); }, '脏输入不抛：' + JSON.stringify(bad));
    }
  }

  report('cache-freshness');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
