// 整行编辑保存契约（V17.6.10 的「先校验后落笔」两段式）
//
// 守的契约：
//   R-1 身份闸门：打开时冻结的 openRowId / openHeaders 必须在保存时被真正比对，
//       且比对基准取自 DB **活引用**（不是可能陈旧的缓存克隆）。
//   R-2 两类列名一律**拒提交**并说明，不静默还原：
//       ① 空表头 —— updateRow 按列名寻址，无名列写不进去；
//       ② 列名撞上 DB 提交选项 isImportMode / skipNotify / silent ——
//          table-crud-api 的 parseMutationOptions_ACU(options, rowData) 会从
//          **数据对象的键**里读它们，一列叫 silent 且填了 true 会把普通编辑降级成
//          「只改运行时不落盘」，而前端照旧弹「保存成功」。
//   R-3 拒绝分支：不关弹窗、不写缓存、不发通知、不落笔（用户可改完再存）
//   R-4 提交键是**原始表头文本**（不 trim），与改动前的列名解析行为一致；
//       校验才用 trim 后的值
//   R-5 全部未改动 → 不提交（hasChanges 门）
//   R-6 写失败 → 回滚就地写入 + 清缓存 + 提示
//
// 跑的是真实点击处理器源码，不是复制品。
'use strict';

const { section, ok, eq, report } = require('./helpers/harness');
const { readSource, anchorIndex, findBlockEnd, buildScope } = require('./helpers/extract');
const vm = require('vm');

const src = readSource(process.argv[2]);

const anchor = "dialog.find('#dlg-card-save').click(async () => {";
const a = anchorIndex(src, anchor, 'row edit save handler');
const bodyStart = src.indexOf('{', a + anchor.length - 2);
const bodyEnd = findBlockEnd(src, bodyStart);
const body = src.slice(bodyStart + 1, bodyEnd - 1);

function makeEnv(opts) {
  const o = Object.assign({
    tableKey: 'sheet_a', rowIndex: 0, tableName: 'A',
    // openHeaders 就是 content[0] 整行（含 row_id 列）——showCardEditModal 收到的
    // headers 直接来自 content[0]，不是去掉 row_id 后的子集。夹具必须照此，否则
    // 列位移比对会整体错位、所有用例都被闸门拦掉。
    openHeaders: ['row_id', '名称', '备注', '状态'],
    openRowId: 'r1',
    liveContent: [['row_id', '名称', '备注', '状态'], ['r1', '旧名', '旧备注', '旧状态']],
    // 弹窗里每个 textarea 的 [colIdx, 当前值]；colIdx 是行内下标（row_id 占 0 位）
    fields: [],
    saveResult: true,
  }, opts);

  const calls = { save: [], toast: [], close: 0, render: 0 };
  // live = DB 活引用；cache = getTableData() 的返回值（克隆，可能陈旧）。
  // 两者**默认是不同对象**：真实场景里前端缓存是深拷贝，与 DB 活对象必然不同源。
  // 若不区分，「复验读活引用还是读缓存」这条契约在测试里根本无法被观测。
  const live = { sheet_a: { name: 'A', content: o.liveContent.map(r => r.slice()) } };
  const cache = { sheet_a: { name: 'A', content: (o.staleContent || o.liveContent).map(r => r.slice()) } };
  // 假 dialog：find('textarea') 返回带 data('col')/val() 的元素序列
  const textareas = o.fields.map(([col, val]) => ({
    data: (k) => (k === 'col' ? String(col) : undefined),
    val: () => val,
  }));
  const dialog = {
    find: (sel) => (sel === 'textarea' ? { each: (fn) => textareas.forEach((t, i) => fn.call(t)) } : { click: () => {} }),
    remove: () => { calls.close++; },
  };
  // $(this) 会被调用来读 textarea 的 data('col') / val()
  const $ = (sel) => {
    if (typeof sel !== 'string') return sel;              // $(textarea) → 元素自身
    if (sel === 'body') return { append: () => {} };
    return dialog;
  };

  const scope = buildScope(
    [
      'let cachedTableData = null;',
      'let lastRawTableRef = null;',
      'let lastTableSetFingerprint = "";',
      'const cellText = (cell) => (cell === null || cell === undefined ? "" : String(cell));',
      'const readLiveTableData = () => __live;',
      'const getTableData = () => __cache;',
      'const closeDialog = () => { __calls.close++; };',
      'const renderInterface = () => { __calls.render++; };',
      'const saveDataToDatabase = async (d, sr, ctx) => { __calls.save.push(ctx); return __saveResult; };',
      'const tableKey = __tableKey, rowIndex = __rowIndex, tableName = __tableName;',
      'const openHeaders = __openHeaders.slice();',
      'const openRowId = __openRowId;',
      // displayRow 是弹窗构造期的局部量（打开时的数据行），保存时只用于列数上界
      'const displayRow = __displayRow;',
      'const dialog = __dialog, $ = __$;',
      'const window = { toastr: { error: (m) => __calls.toast.push(["error", m]), warning: (m) => __calls.toast.push(["warn", m]) } };',
      'const __handler = async () => {',
      body,
      '};',
    ],
    '__handler'
  );
  const handler = vm.runInNewContext(scope, {
    __live: live, __cache: cache, __calls: calls, __saveResult: o.saveResult,
    __tableKey: o.tableKey, __rowIndex: o.rowIndex, __tableName: o.tableName,
    __openHeaders: o.openHeaders, __openRowId: o.openRowId,
    __displayRow: o.liveContent[1].slice(),
    __dialog: dialog, __$: $,
    console: { ...console, error() {}, warn() {} },
    Array, Object, String, parseInt, isNaN,
  });
  return { handler, calls, cache, live };
}

const rowOf = (env) => env.cache.sheet_a.content[env.handler ? 1 : 1];

(async () => {
  // ── R-5 正常路径 ──
  section('[R-5] 正常编辑：只提交真正改动的列');
  {
    const env = makeEnv({ fields: [[1, '新名'], [2, '旧备注'], [3, '新状态']] });
    await env.handler();
    eq(env.calls.save.length, 1, '恰好提交一次');
    const ctx = env.calls.save[0] || {};
    eq(ctx.type, 'row_edit', '类型为 row_edit');
    eq(ctx.updateObj, { '名称': '新名', '状态': '新状态' }, 'updateObj 只含改动的列，且键为原始表头');
    eq(env.cache.sheet_a.content[1], ['r1', '新名', '旧备注', '新状态'], '就地写入只落在改动的列');
  }
  section('[R-5b] 全部未改动 → 不提交');
  {
    const env = makeEnv({ fields: [[1, '旧名'], [2, '旧备注'], [3, '旧状态']] });
    await env.handler();
    eq(env.calls.save.length, 0, '无改动不提交（避免无谓的 DB 全量回放与通知）');
  }
  section('[R-5c] 空单元格 + 未修改 → 不误判为有改动');
  {
    const env = makeEnv({
      liveContent: [['row_id', '名称', '备注'], ['r1', '旧名', null]],
      fields: [[1, '旧名'], [2, '']],
    });
    await env.handler();
    eq(env.calls.save.length, 0, 'DB 的 null 空格与空串等价 → 不误判（否则会把 "" 写回库）');
  }

  // ── R-2 拒提交 ──
  section('[R-2a] 空表头列 → 拒提交并说明');
  {
    const env = makeEnv({
      openHeaders: ['row_id', '名称', '', '状态'],
      liveContent: [['row_id', '名称', '', '状态'], ['r1', '旧名', '旧值', '旧状态']],
      fields: [[1, '新名'], [2, '新值'], [3, '旧状态']],
    });
    await env.handler();
    eq(env.calls.save.length, 0, '不提交（不出现「其它列提交成功但该列被静默还原」）');
    eq(env.cache.sheet_a.content[1], ['r1', '旧名', '旧值', '旧状态'], '拒绝时零落笔（同行其它列也不写）');
    ok(env.calls.toast.some(([k, m]) => k === 'error' && /没有可用列名/.test(m)), '给出可读原因');
  }
  section('[R-2b] 列名撞 DB 提交选项 → 拒提交并说明');
  {
    for (const name of ['isImportMode', 'skipNotify', 'silent', 'SILENT', ' Silent ']) {
      const env = makeEnv({
        openHeaders: ['row_id', '名称', name, '状态'],
        liveContent: [['row_id', '名称', name, '状态'], ['r1', '旧名', 'false', '旧状态']],
        fields: [[1, '旧名'], [2, 'true'], [3, '旧状态']],
      });
      await env.handler();
      eq(env.calls.save.length, 0, `列名「${name}」→ 拒提交`);
      ok(env.calls.toast.some(([k, m]) => k === 'error' && /提交选项同名/.test(m)), `列名「${name}」→ 说明原因`);
    }
  }
  section('[R-2c] 相似但不同名的列不应被误拒');
  {
    for (const name of ['isImportModes', 'skipNotifyAt', 'silently', 'is_import_mode']) {
      const env = makeEnv({
        openHeaders: ['row_id', '名称', name, '状态'],
        liveContent: [['row_id', '名称', name, '状态'], ['r1', '旧名', '旧值', '旧状态']],
        fields: [[1, '旧名'], [2, '新值'], [3, '旧状态']],
      });
      await env.handler();
      eq(env.calls.save.length, 1, `列名「${name}」→ 正常提交（不得过度拦截）`);
    }
  }

  // ── R-3 拒绝分支副作用 ──
  section('[R-3] 拒绝时不关弹窗 / 不重渲染 / 不发通知');
  {
    const env = makeEnv({
      openHeaders: ['row_id', '名称', '', '状态'],
      liveContent: [['row_id', '名称', '', '状态'], ['r1', '旧名', '旧值', '旧状态']],
      fields: [[1, '新名'], [2, '新值'], [3, '旧状态']],
    });
    await env.handler();
    eq(env.calls.close, 0, '弹窗保持打开（用户可改完再存）');
    eq(env.calls.render, 0, '不重渲染（无变更，无需刷新）');
  }

  // ── R-4 提交键不 trim ──
  section('[R-4] 提交键用原始表头（不 trim），与 DB 列名解析一致');
  {
    const env = makeEnv({
      openHeaders: ['row_id', ' 名称 ', '备注'],
      liveContent: [['row_id', ' 名称 ', '备注'], ['r1', '旧名', '旧备注']],
      fields: [[1, '新名'], [2, '旧备注']],
    });
    await env.handler();
    eq(env.calls.save.length, 1, '带空格的表头仍可提交');
    const keys = Object.keys((env.calls.save[0] || {}).updateObj || {});
    eq(keys, [' 名称 '], '键保留原始空白（若被 trim，DB 按列名寻址会找不到列）');
  }

  // ── R-1 身份闸门 ──
  section('[R-1] 身份闸门：行/列位移 → 拒，基准取自 DB 活引用');
  {
    const F = [[1, '新名'], [2, '旧备注'], [3, '旧状态']];
    // 行已被换（row_id 不符）——改的是 DB 活引用里的数据
    let env = makeEnv({ fields: F });
    env.live.sheet_a.content[1] = ['r9', '别的行', 'x', 'y'];
    await env.handler();
    eq(env.calls.save.length, 0, 'row_id 不符 → 拒');
    ok(env.calls.close > 0, '身份不符时关弹窗（不再让用户对一个已变的目标继续操作）');
    // 列被插入（表头位移）
    env = makeEnv({ fields: F });
    env.live.sheet_a.content[0] = ['row_id', '名称', '新插入列', '备注', '状态'];
    await env.handler();
    eq(env.calls.save.length, 0, '表头位移 → 拒');
    // 一切未变 → 放行
    env = makeEnv({ fields: F });
    await env.handler();
    eq(env.calls.save.length, 1, '身份未变 → 正常放行（闸门不误伤）');
  }
  // ── R-1b 缓存陈旧时闸门仍必须拦得住 ──
  // 这是本文件最关键的一条：DB 原地整表替换（顶层引用与 key 集合都不变）后，
  // 前端缓存克隆可能还是旧的。若闸门拿缓存自证通过，updateRow 会按列名写进
  // **另一行**的同名列，而 DB 返回 true —— 静默写错行且无法撤销。
  section('[R-1b] 缓存克隆陈旧（DB 已原地换表）→ 闸门必须拦');
  {
    const stale = [['row_id', '名称', '备注', '状态'], ['r1', '旧名', '旧备注', '旧状态']];
    const fresh = [['row_id', '名称', '备注', '状态'], ['r9', '别人的行', 'x', 'y']];
    const env = makeEnv({ liveContent: fresh, staleContent: stale, fields: [[1, '新名'], [2, '旧备注'], [3, '旧状态']] });
    // 前置：缓存里确实还是旧行，闸门若读缓存就会通过
    eq(env.cache.sheet_a.content[1][0], 'r1', '前置：缓存克隆里是旧行 r1（读它会误判为通过）');
    eq(env.live.sheet_a.content[1][0], 'r9', '前置：DB 活引用里已是 r9');
    await env.handler();
    eq(env.calls.save.length, 0, '闸门读活引用 → 拦下（不会把改动写到 r9 那一行）');
  }

  // ── R-6 失败回滚 ──
  section('[R-6] 写失败 → 回滚就地写入并提示');
  {
    const env = makeEnv({ saveResult: false, fields: [[1, '新名'], [2, '旧备注'], [3, '旧状态']] });
    await env.handler();
    eq(env.cache.sheet_a.content[1], ['r1', '旧名', '旧备注', '旧状态'], '就地写入已回滚到原值');
    ok(env.calls.toast.some(([k]) => k === 'error'), '提示保存失败');
    ok(env.calls.render > 0, '清缓存后强制重渲染');
  }

  report('row-edit-two-phase');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
