// 保存管线契约：saveDataToDatabaseImpl（降级语义）+ saveDataToDatabase（串行包装层）
//
// 这两个是**不同**的 owner，不是同一契约的两次调用：
//   Impl    —— 写不写、写到哪、失败怎么报
//   Wrapper —— 并发编辑如何排队
//
// 守的契约：
//   S-1 有精确写 API 且被拒 → 返回 false，**绝不**降级全量 import
//       （import 是全量 data_replace，绕过表锁/填表互斥；陈旧克隆会整库回退并重建引擎）
//   S-2 DB 完全没有精确 API（旧库）→ import 兜底是合法通道
//   S-3 精确 API 缺失（本次操作类型对不上）→ 不得把 undefined 当成功
//   S-4 精确 API 抛异常 → 如实失败，不吞
//   S-5 写入参数契约：tableName / rowIndex+1（1-based）/ colIndex / updateObj
//   S-6 数据缺少 sheet_* 顶层键 → 拒绝保存（不自造随机 sheetKey 破坏 DB 身份契约）
//   S-7 并发保存被串行化：maxActive === 1，顺序稳定，且不因 isSaving 误报失败
//   S-8 队列中前一个失败不吞掉后一个
//
// 只读闸门不在这里测（由 read-only-gates 拥有，避免两个 owner 守同一契约）。
'use strict';

const { section, ok, eq, report } = require('./helpers/harness');
const { readSource, sliceConstFn, buildScope } = require('./helpers/extract');
const vm = require('vm');

const src = readSource(process.argv[2]);

function fnExpr(needle, label) {
  const decl = sliceConstFn(src, needle, label);
  return decl.replace(new RegExp('^const\\s+' + label + '\\s*=\\s*'), '').replace(/;\s*$/, '');
}

function makeImpl(api, { allowed = true } = {}) {
  const btn = { html() { return { prop() { return this; }, removeClass() {}, addClass() {} }; }, prop() { return this; } };
  const calls = { import: 0, save: 0, snapshot: 0, render: 0 };
  const ctx = {
    isSaving: false, cachedTableData: null, lastRawTableRef: null, lastTableSetFingerprint: '',
    currentDiffMap: new Map(), api,
    getCore: () => ({ getDB: () => api, $: () => btn }),
    UpdateController: { runSilently: (fn) => fn() },
    saveSnapshot() { calls.snapshot++; }, renderInterface() { calls.render++; },
    isTableEditAllowed: () => allowed,
    notifyEditBlocked() {},
    getConfig: () => ({ allowTableEdit: allowed }),
    console: { ...console, error() {}, warn() {} },
    window: { toastr: { error() {}, success() {}, warning() {}, info() {} } },
    Object, Array, JSON, String, Math, Boolean, Promise, Date, parseInt, isNaN,
  };
  return { fn: vm.runInNewContext('"use strict";(' + fnExpr('const saveDataToDatabaseImpl = async (', 'saveDataToDatabaseImpl') + ')', ctx), calls };
}

const data = () => ({ mate: { type: 'chatSheets', version: 1 }, sheet_demo: { name: 'Demo', content: [['row_id', 'name'], ['1', 'A']] } });

(async () => {
  // ── S-1 精确写被拒 → 不降级 ──
  section('[S-1] 精确写被拒 → 返回 false，绝不降级全量 import');
  {
    let imports = 0;
    const api = { updateCell: async () => false, importTableAsJson: async () => { imports++; return true; } };
    const { fn } = makeImpl(api);
    const r = await fn(data(), true, { type: 'cell_edit', tableName: 'Demo', rowIndex: 0, colIndex: 1, newValue: 'B' });
    ok(r === false, '返回 false（如实报错）');
    ok(imports === 0, '全量 import 一次都没被调用（否则整库回退）', 'imports=' + imports);
  }
  // ── S-2 老库无精确 API → 兜底合法 ──
  section('[S-2] DB 无精确写 API（旧库）→ import 兜底是合法通道');
  {
    let imports = 0;
    const api = { importTableAsJson: async () => { imports++; return true; } };
    const { fn } = makeImpl(api);
    const r = await fn(data(), true, { type: 'cell_edit', tableName: 'Demo', rowIndex: 0, colIndex: 1, newValue: 'B' });
    ok(r === true && imports === 1, '兜底成功并返回 true', 'r=' + r + ' imports=' + imports);
  }
  // ── S-3 精确 API 缺失不得当成功 ──
  section('[S-3] 本次操作没有对应的精确 API → 不得把 undefined 当成功');
  {
    let imports = 0;
    // 只有 updateCell，但本次是 row_edit：updateRow 缺失
    const api = { updateCell: async () => true, importTableAsJson: async () => { imports++; return true; } };
    const { fn } = makeImpl(api);
    const r = await fn(data(), true, { type: 'row_edit', tableName: 'Demo', rowIndex: 0, updateObj: { name: 'B' } });
    ok(r === false, '缺精确 API 且库有精确能力 → fail closed', 'r=' + r);
    ok(imports === 0, '不降级全量（部分 API 存在时不许兜底）', 'imports=' + imports);
  }
  // ── S-4 精确 API 抛异常 ──
  section('[S-4] 精确 API 抛异常 → 如实失败');
  {
    let imports = 0;
    const api = { updateCell: async () => { throw new Error('db boom'); }, importTableAsJson: async () => { imports++; return true; } };
    const { fn } = makeImpl(api);
    const r = await fn(data(), true, { type: 'cell_edit', tableName: 'Demo', rowIndex: 0, colIndex: 1, newValue: 'B' });
    ok(r === false && imports === 0, '返回 false 且不降级', 'r=' + r + ' imports=' + imports);
  }

  // ── S-5 写入参数契约 ──
  section('[S-5] 写入参数：行下标 1-based、列下标原样、updateObj 按列名');
  {
    const seen = [];
    const api = {
      updateCell: async (...a) => { seen.push(['updateCell', a]); return true; },
      updateRow: async (...a) => { seen.push(['updateRow', a]); return true; },
      deleteRow: async (...a) => { seen.push(['deleteRow', a]); return true; },
    };
    const { fn } = makeImpl(api);
    await fn(data(), true, { type: 'cell_edit', tableName: 'Demo', rowIndex: 7, colIndex: 3, newValue: 'B' });
    await fn(data(), true, { type: 'row_edit', tableName: 'Demo', rowIndex: 7, updateObj: { name: 'B' } });
    await fn(data(), true, { type: 'row_delete', tableName: 'Demo', rowIndex: 7 });
    eq(seen[0], ['updateCell', ['Demo', 8, 3, 'B']], 'updateCell：行下标 +1（content[0] 是表头，故数据行是 1-based）');
    eq(seen[1], ['updateRow', ['Demo', 8, { name: 'B' }]], 'updateRow：行下标 +1，updateObj 按列名寻址');
    eq(seen[2], ['deleteRow', ['Demo', 8]], 'deleteRow：行下标 +1');
  }

  // ── S-6 存储护栏 ──
  section('[S-6] 缺少 sheet_* 顶层键 → 拒绝保存（不自造随机 sheetKey）');
  {
    const api = { updateCell: async () => true, importTableAsJson: async () => true };
    const { fn } = makeImpl(api);
    const r = await fn({ mate: { type: 'chatSheets' } }, true,
      { type: 'cell_edit', tableName: 'X', rowIndex: 0, colIndex: 0, newValue: 'v' });
    ok(r === false, '无 sheet_* 键 → 拒绝（否则与 DB 稳定 sheetKey 身份契约冲突）');
  }
  section('[S-6b] 自动补齐 mate 字段（DB 9.0 契约要求）');
  {
    const api = { updateCell: async () => true, importTableAsJson: async () => true };
    const { fn } = makeImpl(api);
    const d = { sheet_demo: { name: 'Demo', content: [['row_id'], ['1']] } };
    const r = await fn(d, true, { type: 'cell_edit', tableName: 'Demo', rowIndex: 0, colIndex: 0, newValue: 'v' });
    ok(r === true, '缺 mate 时补齐后仍可保存');
    ok(d.mate && d.mate.type === 'chatSheets', 'mate 已按 DB 契约补上', JSON.stringify(d.mate));
  }

  // ── S-7/S-8 串行化 ──
  section('[S-7] 并发保存被串行化（不因 isSaving 误报失败）');
  {
    let active = 0, maxActive = 0;
    const order = [];
    const ctx = {
      saveQueue: Promise.resolve(),
      saveDataToDatabaseImpl: async (tableData, skipRender, ctx2) => {
        active++; maxActive = Math.max(maxActive, active);
        order.push('start:' + tableData.id);
        await new Promise(r => setTimeout(r, tableData.id === 1 ? 20 : 1));
        order.push('end:' + tableData.id);
        active--;
        return tableData.fail ? false : true;
      },
      Promise, Object, Array, console,
    };
    const save = vm.runInNewContext('"use strict";(' + fnExpr('const saveDataToDatabase = (', 'saveDataToDatabase') + ')', ctx);
    const results = await Promise.all([
      save({ id: 1 }, true, { type: 'cell_edit' }),
      save({ id: 2 }, true, { type: 'cell_edit' }),
      save({ id: 3 }, true, { type: 'cell_edit' }),
    ]);
    ok(maxActive === 1, '任一时刻只有一个保存在进行（maxActive=' + maxActive + '）');
    eq(order, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3'], '按提交顺序串行执行');
    eq(results, [true, true, true], '三次编辑都成功（未出现 isSaving 误报失败）');
  }
  section('[S-8] 队列中前一个失败不吞掉后一个');
  {
    const order = [];
    const ctx = {
      saveQueue: Promise.resolve(),
      saveDataToDatabaseImpl: async (d) => { order.push(d.id); await new Promise(r => setTimeout(r, 1)); return !d.fail; },
      Promise, Object, Array, console,
    };
    const save = vm.runInNewContext('"use strict";(' + fnExpr('const saveDataToDatabase = (', 'saveDataToDatabase') + ')', ctx);
    const results = await Promise.all([
      save({ id: 1, fail: true }, true, {}),
      save({ id: 2 }, true, {}),
      save({ id: 3 }, true, {}),
    ]);
    eq(results, [false, true, true], '失败只影响自己（后两个仍成功）');
    eq(order, [1, 2, 3], '失败不阻断后续入队');
  }

  report('save-pipeline');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
