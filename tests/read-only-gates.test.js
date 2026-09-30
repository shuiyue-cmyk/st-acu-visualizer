// 只读模式（allowTableEdit 默认关闭）契约
//
// 守的契约：
//   E-1 默认关闭；闸门严格取 === true（未配置/旧配置一律只读）
//   E-2 旧用户 localStorage 无该键时，配置合并会补上 false
//   E-3 **每条写库路径都真的写不进去**（不只是 UI 隐藏）：
//       ① saveDataToDatabaseImpl（覆盖 updateCell/updateRow/row_delete/全量 import 兜底）
//       ② insertRow 直连 API   ③ 批量 deleteRow 直连 API
//       用 Proxy 间谍断言「一个写库方法都没被碰到」，而不是断言某个字符串存在。
//   E-4 只读时 UI 不产生写入口（单元格不弹编辑菜单、多选按钮隐藏）
//   E-5 但**查看**交互必须完好：分页 / 仪表盘快速查看 / 标签切换 / 视图切换。
//       回归背景：曾用函数级提前 return 把这三条绑定一起跳过，导致默认（只读）态下
//       超过每页行数的表只能看到第 1 页。
//   E-6 闸门只拦前端手改：不得加到通知注册 / 填表回调 / 追平上
'use strict';

const { section, ok, eq, report } = require('./helpers/harness');
const { readSource, sliceConstFn, anchorIndex, anchorIndexBefore, findBlockEnd, buildScope } = require('./helpers/extract');
const vm = require('vm');

const src = readSource(process.argv[2]);
const lines = src.split('\n');
const idxOf = (re, from = 0) => { for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i; return -1; };

// ── 1/2 配置与默认值（读源码即可：这是配置契约，不是行为）──
section('[E-1] 默认关闭且闸门严格取 true');
ok(/allowTableEdit:\s*false/.test(src), 'DEFAULT_CONFIG.allowTableEdit = false（默认只读）');
ok(!/allowTableEdit:\s*true/.test(src), '未误设为默认开启');
ok(/const isTableEditAllowed = \(\) => getConfig\(\)\.allowTableEdit === true;/.test(src), '闸门严格取 true（未配置/旧配置一律只读）');
ok(/return \{ \.\.\.DEFAULT_CONFIG, \.\.\.saved \}/.test(src), '旧配置合并默认值 false（老用户升级即只读）');

section('[E-2] 定义先于使用（无 TDZ）');
{
  const defHelper = idxOf(/const isTableEditAllowed =/);
  const defNotify = idxOf(/const notifyEditBlocked =/);
  const defLive = idxOf(/const readLiveTableData =/);
  const defImpl = idxOf(/const saveDataToDatabaseImpl =/);
  // 逐名比较：定义 vs **该名字自己的**首次使用。
  // 两个坑：① 必须排除注释行（本文件的说明注释里就写着这些函数名）；
  //        ② 不能把三个名字里最早的使用点拿去和其中一个的定义比（那是三个名字的并集）。
  const firstUseOf = (name) => lines.findIndex(l => !/^\s*(\/\/|\*)/.test(l)
    && l.includes(name + '(') && !l.includes('const ' + name));
  const useHelper = firstUseOf('isTableEditAllowed');
  const useNotify = firstUseOf('notifyEditBlocked');
  const useLive = firstUseOf('readLiveTableData');
  ok(defHelper >= 0 && defHelper < useHelper, `isTableEditAllowed 定义(${defHelper + 1}) 先于首次使用(${useHelper + 1})`);
  ok(defNotify >= 0 && defNotify < useNotify, `notifyEditBlocked 定义(${defNotify + 1}) 先于首次使用(${useNotify + 1})`);
  ok(defLive >= 0 && defLive < useLive, `readLiveTableData 定义(${defLive + 1}) 先于首次使用(${useLive + 1})`);
  ok(defLive < defImpl, 'readLiveTableData 定义早于 saveDataToDatabaseImpl');
}

// ── 3 只读时一条写库路径都碰不到（真跑 + Proxy 间谍）──
section('[E-3] 只读时任何写库 API 都不会被调用（Proxy 间谍）');
function makeImpl(allowed) {
  const decl = sliceConstFn(src, 'const saveDataToDatabaseImpl = async (', 'saveDataToDatabaseImpl');
  const expr = decl.replace(/^const\s+saveDataToDatabaseImpl\s*=\s*/, '').replace(/;\s*$/, '');
  const touched = [];
  const spyApi = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); return async () => true; } });
  const btn = { html() { return { prop() { return this; }, removeClass() {}, addClass() {}, text() {} }; }, prop() { return this; } };
  const ctx = {
    isSaving: false, cachedTableData: null, lastRawTableRef: null, lastTableSetFingerprint: '',
    currentDiffMap: new Map(), api: spyApi,
    getCore: () => ({ getDB: () => spyApi, $: () => btn }),
    UpdateController: { runSilently: (fn) => fn() },
    saveSnapshot() {}, renderInterface() {},
    isTableEditAllowed: () => allowed,
    notifyEditBlocked() {},
    getConfig: () => ({ allowTableEdit: allowed }),
    console: { ...console, error() {}, warn() {} },
    window: { toastr: { error() {}, success() {}, warning() {}, info() {} } },
    Object, Array, JSON, String, Math, Boolean,
  };
  return { fn: vm.runInNewContext('"use strict";(' + expr + ')', ctx), touched };
}

(async () => {
  {
    const { fn, touched } = makeImpl(false);
    const r = await fn({ mate: {}, sheet_x: { name: 'X', content: [['row_id'], ['1']] } }, false,
      { type: 'cell_edit', tableName: 'X', rowIndex: 0, colIndex: 1, newValue: 'v' });
    ok(r === false, 'saveDataToDatabaseImpl 只读时返回 false');
    ok(touched.length === 0, 'saveDataToDatabaseImpl 只读时一个写库方法都没碰到', touched.join(','));
  }
  {
    const { fn, touched } = makeImpl(false);
    const r = await fn({ mate: {}, sheet_x: { name: 'X', content: [['row_id'], ['1']] } }, false,
      { type: 'row_delete', tableName: 'X', rowIndex: 0 });
    ok(r === false && touched.length === 0, 'row_delete 只读时同样被拦（在任何 API 之前）');
  }
  {
    const { fn, touched } = makeImpl(true);
    // skipRender=true：与 cell_edit/row_edit 的真实调用一致，也避开与本次契约无关的
    // toastr/高亮清理分支（那属于渲染层，由 cell-edit-guard 覆盖）。
    const r = await fn({ mate: {}, sheet_x: { name: 'X', content: [['row_id', 'a'], ['1', 'b']] } }, true,
      { type: 'cell_edit', tableName: 'X', rowIndex: 0, colIndex: 1, newValue: 'v' });
    ok(r === true && touched.length > 0, '放行时确实走到了写库 API（闸门不是无条件拒绝）',
      'result=' + r + ' touched=' + touched.join(','));
  }

  // insertRow 直连路径（不经 impl）
  section('[E-3b] insertRow 直连路径的闸门（真跑该处理器）');
  {
    const decl = sliceConstFn(src, "menu.find('#act-insert').click(async () => {", 'act-insert handler');
    const a = anchorIndex(src, "menu.find('#act-insert').click(async () => {");
    const bodyStart = src.indexOf('{', a + 10);
    const bodyEnd = findBlockEnd(src, bodyStart);
    const body = src.slice(bodyStart + 1, bodyEnd - 1);
    for (const allowed of [false, true]) {
      const touched = [];
      const spyApi = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); return async () => true; } });
      const menu = { find: () => ({ click: () => {} }) };
      const closeAll = () => {};
      const scope = buildScope([
        'let isMultiSelectMode = false;',
        'const tableKey = __tableKey, rowIdx = 0, tableName = __tableName;',
        'const closeAll = __closeAll;',
        'const isTableEditAllowed = () => __allowed;',
        'const notifyEditBlocked = () => { __calls.notified++; };',
        'const getTableData = () => __cache;',
        'const getCore = () => ({ getDB: () => __api, $: () => __menu });',
        'const showCellMenu = () => { __calls.menu++; };',
        'const __api = __spyApi;',
        'const __menu = __menuObj;',
        'const renderInterface = () => { __calls.render++; };',
        'const selectedRows = new Map();',
        'const window = { toastr: { error() {}, success() {}, warning() {}, info() {} } };',
        'const __run = async () => {', body, '};',
      ], '__run');
      const calls = { notified: 0, menu: 0, render: 0 };
      const run = vm.runInNewContext(scope, {
        __allowed: allowed, __closeAll: closeAll, __calls: calls, __spyApi: spyApi,
        __tableKey: 'sheet_x', __tableName: 'X',
        __menuObj: menu, __cache: { sheet_x: { name: 'X', content: [['row_id', 'a'], ['1', 'b']] } },
        console: { ...console, error() {}, warn() {} },
        Object, Array, JSON, String, Math, Number, parseInt, isNaN, Promise, Set, Map,
      });
      await run();
      if (!allowed) {
        ok(touched.length === 0, '只读：insertRow 未碰到任何写库 API', touched.join(','));
        ok(calls.notified === 1, '只读：给出了「当前为只读模式」的提示（不是静默失败）');
      } else {
        ok(touched.length > 0, '放行：insertRow 走到写库 API（闸门不是无条件拒绝）', touched.join(','));
      }
    }
  }

  // 批量 deleteRow 直连路径
  section('[E-3c] 批量 deleteRow 直连路径的闸门（真跑该分支）');
  {
    // 该 if 在文件里出现多次（handleUpdate / 按钮态 / 批量删），
    // 必须锚定到 deleteRow 调用之前的那一处，否则会抽错分支。
    const anchor = 'if (pendingDeletes.size > 0) {';
    const delCall = src.indexOf('await api.deleteRow(t, r + 1)');
    const a = anchorIndexBefore(src, anchor, delCall, 'batch delete branch');
    ok(a >= 0 && a < delCall, '锚点定位于批量删分支（不是文件里首个同名 if）');
    const bodyStart = src.indexOf('{', a + anchor.length - 2);
    const bodyEnd = findBlockEnd(src, bodyStart);
    const body = src.slice(bodyStart + 1, bodyEnd - 1);
    for (const allowed of [false, true]) {
      // 区分「读到属性」与「真正调用」：只读闸门关心的是**有没有发出写请求**。
      // 存在性检查（if (!api.deleteRow)）也会读属性，不能算成写。
      const readProps = [];
      const invoked = [];
      const spyApi = new Proxy({ __onCall: null }, {
        get: (t, k) => {
          if (k === '__onCall') return t.__onCall;
          readProps.push(String(k));
          return async (...args) => {
            invoked.push([String(k), args]);
            if (typeof t.__onCall === 'function') t.__onCall();
            return true;
          };
        },
        set: (t, k, v) => { t[k] = v; return true; },
      });
      const calls = { notified: 0, render: 0 };
      const scope = buildScope([
        'let pendingDeletes = new Set();',
        'let pendingDeleteRowIds = new Map();',
        'let isMultiSelectMode = true;',
        'let selectedRows = new Map();',
        'let bulkOpActive = false;',
        'let cachedTableData = null, lastRawTableRef = null, lastTableSetFingerprint = "";',
        'const notifyEditBlocked = () => { __calls.notified++; };',
        'const isTableEditAllowed = () => __allowed;',
        'const getCore = () => ({ getDB: () => __api });',
        // 复验快照：row_id 与勾选时一致 → 放行模式下两行都应真正提交删除
        'const readLiveTableData = () => ({ X: { content: [["row_id", "a"], ["r1", "x"], ["r2", "y"]] } });',
        'const getTableData = () => ({});',
        'const processJsonData = (d) => ({ X: { rows: d.X.content.slice(1) } });',
        'const renderInterface = () => { __calls.render++; };',
        'const updateDynamicActionButton = () => {};',
        'const saveSnapshot = () => {};',
        'const window = { toastr: { error() {}, success() {}, warning() {}, info() {} } };',
        'const __run = async () => {',
        'pendingDeletes = new Set(["X-row-0", "X-row-1"]);',
        'pendingDeleteRowIds = new Map([["X-row-0", "r1"], ["X-row-1", "r2"]]);',
        body,
        '};',
        // 供外部在 deleteRow 被调用的那一刻观察 bulkOpActive：
        // 「批量删循环进行中挂起 handleUpdate」是防 data_replace 冲突的关键，
        // 但它是个纯状态位，从外面看不到 → 必须提供观察点，否则这条等于没测。
        'const __observe = () => ({ bulkOpActive, isMultiSelectMode, pending: pendingDeletes.size });',
      ], '({ run: __run, observe: __observe })');
      const mod = vm.runInNewContext(scope, {
        __allowed: allowed, __calls: calls, __api: spyApi,
        console: { ...console, error() {}, warn() {}, log() {} },
        Object, Array, JSON, String, Math, Number, parseInt, isNaN, Promise, Set, Map, RegExp,
      });
      const run = mod.run;
      const duringDelete = [];
      spyApi.__onCall = () => { try { duringDelete.push(mod.observe()); } catch (_) {} };
      await run();
      if (!allowed) {
        ok(invoked.length === 0, '只读：批量删一个写库方法都没被调用', invoked.map(x => x[0]).join(','));
        ok(calls.notified === 1, '只读：给出提示');
      } else {
        ok(invoked.length === 2, '放行：两行都提交了删除', 'invoked=' + JSON.stringify(invoked));
        // 倒序删除：先删后出现的行，避免下标位移
        eq(invoked.map(x => x[1][1]).sort((a, b) => a - b), [1, 2], '传入的行号（1-based）正确');
        // 批量删循环进行中必须挂起 handleUpdate：循环中每次 deleteRow 都触发 DB 通知，
        // 通知到达时 await 尚未落定，getTableData(true) 会拉到中间态，
        // 该中间态一旦被写路径回灌就是 data_replace 冲突源（DB 作者指出的高危模式）。
        ok(duringDelete.length === 2, '观察点被取到两次（与删除次数一致）', JSON.stringify(duringDelete));
        ok(duringDelete.every(o => o.bulkOpActive === true),
          '删除进行中 bulkOpActive === true（通知被有意挂起）', JSON.stringify(duringDelete));
        ok(mod.observe().bulkOpActive === false, '循环结束后 bulkOpActive 已复位（finally 生效）');
      }
    }
  }

  // ── 4 UI 写入口 ──
  section('[E-4] 只读时 UI 不产生写入口');
  ok(/\$\('\.acu-cell'\)\.off\('click'\)\.on\('click', function\(e\) \{ e\.stopPropagation\(\); notifyEditBlocked\(\); \}\);/.test(src),
    '只读模式单元格点击不弹编辑菜单');
  ok(/isTableEditAllowed\(\) \? `[\s\S]{0,200}acu-btn-multiselect/.test(src), '只读模式隐藏多选按钮');

  // ── 5 查看交互必须完好 ──
  section('[E-5] 只读（默认态）下查看交互完好');
  {
    const bindIdx = idxOf(/const bindDynamicContentEvents = \(\) => \{/);
    const bindEnd = lines.findIndex((l, i) => i > bindIdx && /^\s{8}\};\s*$/.test(l));
    const body = lines.slice(bindIdx, bindEnd);
    const text = body.join('\n');
    const funcLevelReturn = body.some(l => /^\s{12}return;\s*$/.test(l));
    ok(!funcLevelReturn, 'bindDynamicContentEvents 内无函数级提前 return（不会跳过只读交互绑定）');
    const cellIdx = body.findIndex(l => /if \(isTableEditAllowed\(\)\)/.test(l));
    const checks = [
      ['分页按钮', /\.acu-page-btn'\)\.off\('click'\)/],
      ['仪表盘快速查看', /\.acu-dash-interactive'\)\.off\('click'\)/],
      ['仪表盘标签切换', /\.acu-tab-btn'\)\.off\('click'\)/],
    ];
    for (const [label, re] of checks) {
      const i = body.findIndex(l => re.test(l));
      ok(i >= 0, `${label}绑定存在`);
      ok(cellIdx >= 0 && i > cellIdx, `${label}绑定在 .acu-cell 条件分支之后（只读时同样执行）`);
    }
    const elseIdx = body.findIndex(l => /^\s{12}\} else \{/.test(l));
    const elseBlock = elseIdx >= 0 ? body.slice(elseIdx, elseIdx + 3).join('\n') : '';
    ok(elseIdx >= 0 && !/showCellMenu/.test(elseBlock), '只读分支内不绑定 showCellMenu');
    ok(/showCellMenu/.test(body[cellIdx].concat(body[cellIdx + 1] || '')), '编辑分支仍绑定 showCellMenu');
  }

  // ── 6 闸门只拦前端手改，不拦 DB 自身能力 ──
  // 不用「isTableEditAllowed 后 200 字符内不得出现 X」这种 proximity 窗口：
  // 它会被源码注释本身误伤（本文件的说明注释就写着这些函数名），属于
  // 「因无关原因而通过/失败的负向对照」。改为真跑通知注册块：
  // 只读态下 DB 的更新/填表通知仍必须注册得上（前端不吞掉数据库自身的写入信号）。
  section('[E-6] 只读态下数据库通知仍注册得上（闸门不拦 DB 自身能力）');
  {
    const regAnchor = 'if (api.registerTableUpdateCallback) {';
    const a = anchorIndex(src, regAnchor, 'notify registration block');
    const bodyStart = src.indexOf('{', a + regAnchor.length - 2);
    const bodyEnd = findBlockEnd(src, bodyStart);
    const body = src.slice(bodyStart + 1, bodyEnd - 1);
    for (const allowed of [false, true]) {
      const registered = { update: [], fill: [] };
      const api = {
        registerTableUpdateCallback: (cb) => registered.update.push(cb),
        registerTableFillStartCallback: (cb) => registered.fill.push(cb),
      };
      const calls = { render: 0 };
      const scope = buildScope([
        'const isTableEditAllowed = () => __allowed;',
        'const notifyEditBlocked = () => { __calls.blocked++; };',
        'const getCore = () => ({ getDB: () => __api });',
        'const renderInterface = () => { __calls.render++; };',
        'const clearSearchCache = () => {};',
        'const saveSnapshot = () => {};',
        'const setPolling = () => {};',
        'const startFillPoll = () => {};',
        'const stopFillPoll = () => {};',
        'const window = { toastr: { error() {}, success() {}, warning() {}, info() {} } };',
        'const __run = () => {',
        'const api = __api;',
        'const UpdateController = { handleUpdate: () => {} };',
        body,
        '};',
      ], '__run');
      const run = vm.runInNewContext(scope, {
        __allowed: allowed, __api: api, __calls: calls,
        console: { ...console, error() {}, warn() {}, log() {} },
        Object, Array, JSON, String, Math, Number, parseInt, isNaN, Promise, Set, Map, RegExp, setTimeout, clearTimeout,
      });
      run();
      ok(registered.update.length === 1, `只读=${allowed}：更新通知回调仍注册成功（DB 写入信号不被前端吞掉）`);
    }
  }

  report('read-only-gates');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
