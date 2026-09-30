// 写身份闸门契约（readRowId / verifyRowIdentity / cellText）
//
// 守的契约：
//   V-1 身份复验必须读 **DB 的活引用**，不能读可能被陈旧化的缓存克隆。
//       原因：exportTableAsJson 返回的是 DB 内部对象的直接引用，DB 的
//       _ensureTablesFromTemplate 会 currentView[key] = sheet 原地整表替换——
//       顶层引用不变、key 集合不变，此时前端手里的缓存克隆可能已是旧的。
//       若闸门拿旧克隆自证通过，DB 却用它自己的新视图解析下标，
//       不可逆写入就落到**另一行**并返回 true（静默覆盖，且不可撤销）。
//       活引用是自更新的：谁持有它都能看到原地替换后的新 sheet。
//   V-2 row_id 不符 → 拒（行被删/位移）
//   V-3 表头文本不符 → 拒（列位移）
//   V-4 老库无 row_id → 退化为只比表头，仍可用
//   V-5 任何异常/脏结构 → 拒（fail-closed），且永不抛
//   V-6 readRowId 的索引基准是 content[rowIndex+1][0]（content[0] 是表头）
//   V-7 cellText 归一 null/undefined → ''，且不吞 0 / false
//
// 跑的是真实源码（index.js 20-72 行的连续区间）。
'use strict';

const { section, ok, eq, report } = require('./helpers/harness');
const { readSource, sliceRange, buildScope } = require('./helpers/extract');
const vm = require('vm');

const src = readSource(process.argv[2]);

const region = sliceRange(src, 'const escapeHtml = (v) =>', 'const TAB_DASHBOARD', 'escapeHtml..cellText');

/**
 * @param live    DB 活引用（readLiveTableData 返回的东西）
 * @param cache   前端缓存克隆（getTableData 返回的东西）——默认与 live 同源
 * @param opts    { getTableDataThrows } 让 getTableData 抛错，用于触发 verifyRowIdentity 的 catch
 *
 * live 与 cache **默认是不同对象**：真实场景里缓存是深拷贝，与 DB 活对象必然不同源。
 * 若不区分，「复验读活引用还是读缓存」这条契约在测试里根本无法被观测。
 */
function makeGate(live, cache, opts = {}) {
  const c = cache === undefined ? live : cache;
  const api = { exportTableAsJson: () => live };
  const scope = buildScope(
    [
      'let cachedTableData = null;',
      region,
      // 真实 getTableData 的对外形状：早退时返回缓存克隆。
      // 注意不要在这里 `let __cache = ...` —— sandbox 注入的 __cache 会被遮蔽成 null。
      'const getTableData = (f) => { if (__throw) throw new Error("getTableData boom"); cachedTableData = __cache; return __cache; };',
    ],
    '({ readRowId, verifyRowIdentity, cellText, setCache: (x) => { __cache = x; } })'
  );
  return vm.runInNewContext(scope, {
    __cache: c,
    __throw: !!opts.getTableDataThrows,
    getCore: () => ({ getDB: () => api }),
    console: { ...console, error() {}, warn() {} },
    JSON, Object, Array, String, Number, isNaN,
  });
}

const tableOf = (content) => ({ mate: { type: 'chatSheets', version: 1 }, sheet_a: { name: 'A', content } });

(async () => {
  // ── V-1 活引用 vs 陈旧克隆（本文件的核心）──
  section('[V-1] 复验必须读 DB 活引用，不能读陈旧缓存克隆');
  {
    const live = tableOf([['row_id', '名称'], ['r1', '原行']]);
    const g = makeGate(live);
    g.setCache({ sheet_a: { name: 'A', content: [['row_id', '名称'], ['r1', '原行']] } }); // 缓存=旧克隆
    // DB 原地把整张表换成另一张（顶层引用不变、key 集合不变）
    live.sheet_a = { name: 'A', content: [['row_id', '名称'], ['r9', '别的行'], ['r5', '第三行']] };
    // 缓存克隆**没有**跟着更新——这正是静默覆盖的必要条件
    const r = g.verifyRowIdentity('sheet_a', 0, 'r1', 1, '名称');
    ok(r.ok === false, '陈旧克隆场景：闸门必须拒绝写入', 'ok=' + r.ok + ' reason=' + r.reason);
    ok(!!r.reason, '拒绝时带可展示的原因（不是静默失败）');
  }

  // ── V-2 row_id 不符 ──
  section('[V-2] 行身份不符 → 拒');
  {
    const live = tableOf([['row_id', '名称'], ['r9', '别的行']]);
    const g = makeGate(live);
    g.setCache({ sheet_a: { name: 'A', content: [['row_id', '名称'], ['r1', '原行']] } });
    ok(g.verifyRowIdentity('sheet_a', 0, 'r1', 1, '名称').ok === false, 'row_id 不符 → 拒');
    // 行数不足
    const live2 = tableOf([['row_id', '名称']]);
    const g2 = makeGate(live2);
    g2.setCache({ sheet_a: { name: 'A', content: [['row_id', '名称'], ['r1', '原行']] } });
    ok(g2.verifyRowIdentity('sheet_a', 5, 'r1', 1, '名称').ok === false, '目标行不存在 → 拒');
  }

  // ── V-3 列位移 ──
  section('[V-3] 列身份不符 → 拒');
  {
    const live = tableOf([['row_id', '新列名'], ['r1', '原行']]);
    const g = makeGate(live);
    g.setCache({ sheet_a: { name: 'A', content: [['row_id', '名称'], ['r1', '原行']] } });
    ok(g.verifyRowIdentity('sheet_a', 0, 'r1', 1, '名称').ok === false, '表头文本不符 → 拒（列位移）');
    // 期望表头为 null/undefined → 跳过列比对（不拦合法写入）
    ok(g.verifyRowIdentity('sheet_a', 0, 'r1', 1, null).ok === true, '未锚定表头 → 不拦（只比 row_id）');
  }

  // ── V-1b 锚点与基准必须不同源 ──
  // 锚点（用户所见，来自缓存）与基准（DB 现状，来自活引用）分工是这条修复的核心。
  // 若两者都读活引用，「渲染之后、点开之前」的行变更就不可见 → 用户改所见、
  // 写进去的是另一行；若两者都读缓存，则同 key 原地替换时基准陈旧 → 静默覆盖。
  // 两种塌缩都要被测出来。
  section('[V-1b] 锚点取自用户所见（缓存），基准取自 DB 现状（活引用）');
  {
    // 场景：用户看到 r1 → 渲染完、点开弹窗前，DB 把它换成了 r9。
    // 缓存仍是用户所见（r1），活引用已是现状（r9）→ 必须拦。
    const stale = { sheet_a: { name: 'A', content: [['row_id', '名称'], ['r1', '原行']] } };
    const live = { sheet_a: { name: 'A', content: [['row_id', '名称'], ['r9', '新行']] } };
    const g = makeGate(live, stale);
    const anchor = g.readRowId('sheet_a', 0);          // 锚点：走缓存（用户所见）
    ok(anchor === 'r1', 'readRowId 取缓存里的 r1（= 用户看见的那一行）', 'got ' + anchor);
    const r = g.verifyRowIdentity('sheet_a', 0, anchor, 1, '名称');
    ok(r.ok === false, '基准走活引用（r9）→ 拦下（防「改所见写另一行」）', 'ok=' + r.ok);

    // 反向：锚点若也读活引用，上面这条就会恒过。用一个对照组证明该测试有区分力。
    const gBad = makeGate(live, live);                 // 假装锚点也来自活引用
    const anchorBad = gBad.readRowId('sheet_a', 0);
    ok(anchorBad === 'r9' && gBad.verifyRowIdentity('sheet_a', 0, anchorBad, 1, '名称').ok === true,
      '对照组：锚点也读活引用时闸门恒过（这正是必须避免的塌缩）');
  }

  // ── V-1c 活引用缺表 / 不可用时的回退 ──
  section('[V-1c] 活引用不可用时的回退（老库兼容）');
  {
    // 活引用里没有该表 → 退回 getTableData(true)
    const cache = { sheet_a: { name: 'A', content: [['row_id', '名称'], ['r1', '原行']] } };
    const g = makeGate({}, cache);                     // 活引用为空对象
    ok(g.verifyRowIdentity('sheet_a', 0, 'r1', 1, '名称').ok === true, '活引用缺该表 → 退回缓存，正常放行');
    ok(g.verifyRowIdentity('sheet_a', 0, 'WRONG', 1, '名称').ok === false, '退回缓存后仍会正确拦截（不是无条件放行）');
    // 活引用整个为 null
    const g2 = makeGate(null, cache);
    ok(g2.verifyRowIdentity('sheet_a', 0, 'r1', 1, '名称').ok === true, '活引用为 null → 退回缓存');
  }

  // ── V-1d verifyRowIdentity 的 catch 必须是 fail-closed ──
  // 回归风险：catch 里若返回 ok:true，任何异常都会变成「放行」——不可逆写入的闸门
  // 一旦 fail-open 就等于没有。
  // 要真的进 catch 必须让**两条路都拿不到数据**：活引用为 null（于是退回 getTableData）
  // 且 getTableData 抛错。只让 getTableData 抛错是不够的——活引用可用时根本不会调它。
  section('[V-1d] 取数抛异常 → catch 必须 fail-closed');
  {
    const g = makeGate(null, null, { getTableDataThrows: true });
    const r = g.verifyRowIdentity('sheet_a', 0, 'r1', 1, '名称');
    ok(r && r.ok === false, '两条路都取不到数据且抛异常 → 闸门拒绝（不是放行）', JSON.stringify(r));
    ok(!!(r && r.reason), '拒绝时带原因', JSON.stringify(r));
    // 反向确认：只要活引用可用就不会抛，也不会误拒
    const g2 = makeGate(tableOf([['row_id', '名称'], ['r1', 'x']]), null, { getTableDataThrows: true });
    ok(g2.verifyRowIdentity('sheet_a', 0, 'r1', 1, '名称').ok === true, '活引用可用时不受 getTableData 抛错影响');
  }

  // ── V-3b 空串表头也必须参与列比对 ──
  // `expectedHeader != null` 与 `expectedHeader` 的差别就在空串：
  // 改成后者会让「原本空表头的列被插入内容后」这一列位移不被拦截。
  section('[V-3b] 空串表头参与比对（!= null 而非真值判断）');
  {
    const live = tableOf([['row_id', '名称'], ['r1', '原行']]);
    const g = makeGate(live);
    g.setCache({ sheet_a: { name: 'A', content: [['row_id', '名称'], ['r1', '原行']] } });
    // 期望表头是空串（打开时该列无表头），现在该列有了表头 → 列位移 → 拒
    ok(g.verifyRowIdentity('sheet_a', 0, 'r1', 1, '').ok === false, '空串表头 → 列变成有值时仍能拦下');
    // 期望表头是 undefined/null → 明确表示「未锚定」→ 放行
    ok(g.verifyRowIdentity('sheet_a', 0, 'r1', 1, null).ok === true, 'null 表头 = 未锚定 → 不拦');
    ok(g.verifyRowIdentity('sheet_a', 0, 'r1', 1, undefined).ok === true, 'undefined 表头 = 未锚定 → 不拦');
  }

  // ── V-4 取不到 row_id 的老库 ──
  // 「老库无 row_id 列」并不等于 readRowId 返回 null：它取的是 content[r+1][0]，
  // 也就是首格。所以只有首格本身是 null/缺失 时才真的退化。
  // 退化后仍必须比表头——否则列位移无人拦。
  section('[V-4] 取不到 row_id → 退化为只比表头，仍可用');
  {
    const live = tableOf([['名称', '备注'], [null, '原行备注']]);
    const g = makeGate(live);
    g.setCache({ sheet_a: { name: 'A', content: [['名称', '备注'], [null, '原行备注']] } });
    ok(g.readRowId('sheet_a', 0) === null, '首格为 null → readRowId 返回 null（触发退化）');
    ok(g.verifyRowIdentity('sheet_a', 0, null, 1, '备注').ok === true, '退化后：表头一致 → 放行（不误伤老库）');
    ok(g.verifyRowIdentity('sheet_a', 0, null, 1, '别的列').ok === false, '退化后：表头不符 → 仍拦得住列位移');
    ok(g.verifyRowIdentity('sheet_a', 0, null, 99, '备注').ok === false, '退化后：列越界（表头为空）→ 拒');
  }

  // ── V-5 fail-closed ──
  section('[V-5] 脏结构 / 异常 → 拒且不抛');
  {
    const dirty = [null, undefined, {}, { sheet_a: null }, { sheet_a: { content: null } }, { sheet_a: { content: 'x' } }, { sheet_a: { content: [['a'], 'notarray'] } }];
    for (const d of dirty) {
      const g = makeGate(d);
      g.setCache(d);
      let res = null, threw = null;
      try { res = g.verifyRowIdentity('sheet_a', 0, 'r1', 1, 'x'); } catch (e) { threw = e; }
      ok(!threw && res && res.ok === false, '脏结构 fail-closed：' + JSON.stringify(d));
    }
    // 导出抛异常
    const g = makeGate(null);
    g.setCache(null);
    let res = null;
    try { res = g.verifyRowIdentity('sheet_a', 0, 'r1', 1, 'x'); } catch (e) { res = { threw: true }; }
    ok(res && res.ok === false, '数据源为 null 时 fail-closed（不抛）');
  }

  // ── V-6 readRowId 索引基准 ──
  section('[V-6] readRowId 索引基准 = content[rowIndex+1][0]');
  {
    const live = tableOf([['row_id', '名称'], ['r0', '零'], ['r1', '一'], ['r2', '二']]);
    const g = makeGate(live);
    g.setCache({ sheet_a: live.sheet_a });
    eq([g.readRowId('sheet_a', 0), g.readRowId('sheet_a', 1), g.readRowId('sheet_a', 2)], ['r0', 'r1', 'r2'], '三个下标各自命中对应 row_id');
    ok(g.readRowId('sheet_a', 99) === null, '越界行 → null（调用方据此放行/降级）');
    ok(g.readRowId('缺失表', 0) === null, '表不存在 → null');
    // row_id 为 null 时也返回 null，不能是字符串 "null"
    const live2 = tableOf([['row_id', '名称'], [null, '空 id']]);
    const g2 = makeGate(live2);
    g2.setCache({ sheet_a: live2.sheet_a });
    ok(g2.readRowId('sheet_a', 0) === null, 'row_id 为 null → 返回 null 而非字面量 "null"');
  }

  // ── V-7 cellText 归一 ──
  section('[V-7] cellText：null/undefined → ""，0/false 不被吞');
  {
    const g = makeGate({});
    eq([g.cellText(null), g.cellText(undefined), g.cellText(''), g.cellText(0), g.cellText(false), g.cellText('x')],
      ['', '', '', '0', 'false', 'x'], 'cellText 归一表');
  }

  report('write-identity');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
