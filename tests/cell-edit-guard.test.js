// 单元格编辑保存回调契约（V17.6.10 的「值未变则不写」判据 + 身份闸门 + 回滚）
//
// 守的契约：
//   G-1 值未变 → **不写库、不发通知、不动 DOM**。
//       为什么重要：DB 的 updateCell 成功后会发通知，通知经 handleUpdate 清空用户已勾选的
//       待删/选中状态；且 DB 写侧不归一化，NULL 空单元格会被改写成 ''。
//   G-2 值变了 → 恰好写一次，参数正确（tableName / rowIndex / colIndex / newValue）
//   G-3 等值按 cellText 归一比较：null ≡ ''、0 ≡ '0'、false ≡ 'false'，
//       但 0 ≢ ''、0 ≢ false（不得把不同的值判成相同）
//   G-4 读不到模型旧值时**照写**（不得把「读不到」当成「未变」而吞掉合法写入）
//   G-5 身份闸门在等值判据之前：陈旧时先报陈旧，不静默写入
//   G-6 写失败 → 回滚就地写入 + 清缓存 + 提示；写成功 → 推进快照
//
// 跑的是真实回调源码（showEditDialog 的第一个 async 回调），不是复制品。
'use strict';

const { section, ok, eq, report } = require('./helpers/harness');
const { readSource, anchorIndex, findBlockEnd, buildScope } = require('./helpers/extract');
const vm = require('vm');

const src = readSource(process.argv[2]);

// 从 `showEditDialog(content, async (newVal) => {` 的箭头函数体开始配平。
const anchor = 'showEditDialog(content, async (newVal) => {';
const a = anchorIndex(src, anchor, 'cell edit save callback');
const bodyStart = src.indexOf('{', a + 'showEditDialog(content, async (newVal)'.length);
const bodyEnd = findBlockEnd(src, bodyStart);
const body = src.slice(bodyStart + 1, bodyEnd - 1);

// ── 沙箱 ──
function makeEnv(opts) {
  const o = Object.assign({
    tableKey: 'sheet_a', rowIdx: 0, colIdx: 1, tableName: 'A',
    modelRow: ['r1', '旧值'],
    liveContent: [['row_id', '名称', '备注'], ['r1', '旧值', 'x']],
    identOk: true, identReason: '', saveResult: true, tableDataThrows: false,
    identityRowId: 'r1', identityHeader: '名称',
  }, opts);

  const calls = { save: [], text: [], highlight: 0, render: 0, toast: [], patch: [], nulls: 0 };
  let cache = { sheet_a: { name: 'A', content: [o.liveContent[0].slice(), o.liveContent[1].slice()] } };
  // getTableData 返回缓存克隆；rowIdx+1 才是数据行（content[0] 是表头）
  const getTableData = (force) => {
    if (o.tableDataThrows) throw new Error('getTableData boom');
    return cache;
  };
  const $cell = {
    hasClass: () => false,
    find: () => $cell,
    text: (v) => { if (v !== undefined) calls.text.push(v); return $cell; },
    addClass: () => { calls.highlight++; return $cell; },
  };
  const $ = () => $cell;
  const scope = buildScope(
    [
      // 弹窗打开时冻结的身份锚点（本回调只读，不再重算——重算即失去锚定意义）
      'const identityRowId = __identityRowId;',
      'let identityHeader = __identityHeader;',
      'const content = __content;',
      'let cachedTableData = null;',
      'let lastRawTableRef = null;',
      'let lastTableSetFingerprint = "";',
      'const cellText = (cell) => (cell === null || cell === undefined ? "" : String(cell));',
      'const getTableData = __getTableData;',
      'const verifyRowIdentity = () => ({ ok: __identOk, reason: __identReason });',
      'const renderInterface = () => { __calls.render++; };',
      'const patchSnapshotCell = (...a) => { __calls.patch.push(a); };',
      'const saveDataToDatabase = async (d, sr, ctx) => { __calls.save.push(ctx); return __saveResult; };',
      'const tableKey = __tableKey, rowIdx = __rowIdx, colIdx = __colIdx, tableName = __tableName;',
      'const $cell = __$cell, $ = __$;',
      'const cell = __$cell;',
      'const window = { toastr: { warning: (m) => __calls.toast.push(["warn", m]), error: (m) => __calls.toast.push(["error", m]) } };',
      'const __cb = async (newVal) => {',
      body,
      '};',
    ],
    '__cb'
  );
  const cb = vm.runInNewContext(scope, {
    __getTableData: getTableData, __identOk: o.identOk, __identReason: o.identReason,
    __saveResult: o.saveResult, __calls: calls, __$cell: $cell, __$: $,
    __tableKey: o.tableKey, __rowIdx: o.rowIdx, __colIdx: o.colIdx, __tableName: o.tableName,
    __identityRowId: o.identityRowId, __identityHeader: o.identityHeader,
    __content: o.liveContent,
    console: { ...console, error() {}, warn() {} },
    Array, Object, String, parseInt, isNaN,
  });
  return { cb, calls, cache };
}

(async () => {
  // ── G-1/G-2 值变与不变 ──
  section('[G-1] 值未变 → 不写库 / 不动 DOM / 不发通知');
  {
    const { cb, calls } = makeEnv({});
    await cb('旧值');
    eq(calls.save.length, 0, 'saveDataToDatabase 未被调用（不触发 DB 全量回放与通知）');
    eq(calls.text.length, 0, 'DOM 未被乐观改写');
    eq(calls.highlight, 0, '未打高亮样式');
    eq(calls.toast.length, 0, '未弹提示（不是错误路径）');
  }
  section('[G-2] 值变了 → 恰好写一次，参数正确');
  {
    const { cb, calls } = makeEnv({});
    await cb('新值');
    eq(calls.save.length, 1, '恰好调用一次保存');
    const ctx = calls.save[0] || {};
    eq([ctx.type, ctx.tableName, ctx.rowIndex, ctx.colIndex, ctx.newValue],
      ['cell_edit', 'A', 0, 1, '新值'], '保存上下文参数正确');
    eq(calls.text, ['新值'], 'DOM 已乐观更新为新值');
    eq(calls.highlight, 1, '打了变更高亮');
  }

  // ── G-3 等值按 cellText 归一 ──
  section('[G-3] 等值比较走 cellText 归一');
  {
    const cases = [
      { model: ['r1', null], input: '', name: 'null 模型格 ≡ 空串 → 不写' },
      { model: ['r1', undefined], input: '', name: 'undefined ≡ 空串 → 不写' },
      { model: ['r1', 0], input: '0', name: '0 ≡ "0" → 不写' },
      { model: ['r1', false], input: 'false', name: 'false ≡ "false" → 不写' },
      { model: ['r1', '0'], input: 0, name: '"0" ≡ 0 → 不写' },
      { model: ['r1', 0], input: '', name: '0 ≢ 空串 → 写' },
      { model: ['r1', 0], input: false, name: '0 ≢ false → 写' },
      { model: ['r1', false], input: '', name: 'false ≢ 空串 → 写' },
      { model: ['r1', 'x'], input: ' x', name: '纯空白差异不算未变 → 写' },
    ];
    for (const c of cases) {
      const env = makeEnv({ liveContent: [['row_id', '名称'], c.model] });
      await env.cb(c.input);
      const expectWrite = c.name.includes('→ 写');
      eq(env.calls.save.length, expectWrite ? 1 : 0, c.name);
    }
  }

  // ── G-4 读不到旧值时判据不得短路（fail-open）──
  // 这里刻意只断言「判据没把流程短路掉」（DOM 乐观写已发生 = 已越过判据），
  // 而不是断言下游保存一定成功：脏行会让下游写入自身抛错，那是另一件事，
  // 且渲染路径的 Array.isArray(row) 守卫使这类行在 UI 上不可达。
  section('[G-4] 读不到模型旧值 → 判据不短路（不误吞合法写入）');
  {
    // 4a 模型行不是数组
    let env = makeEnv({ liveContent: [['row_id', '名称'], ['r1', '旧值']] });
    env.cache.sheet_a.content[1] = '脏数据';
    await env.cb('新值').catch(() => {});
    eq(env.calls.text, ['新值'], '行非数组 → 判据未短路（已越过等值判据）');
    // 4b 列越界：该行只有 row_id 一格，colIdx=1 越界
    env = makeEnv({ liveContent: [['row_id', '名称'], ['r1']] });
    await env.cb('新值');
    eq(env.calls.save.length, 1, '列越界 → 照常写库（合法写入不被吞）');
    // 4c 取模型抛异常
    env = makeEnv({ tableDataThrows: true });
    await env.cb('新值').catch(() => {});
    eq(env.calls.text, ['新值'], '读取抛异常 → 判据 fail-open，未短路');
    // 4d 关键区分用例：读不到旧值**且用户输入为空**。
    // 若把「读不到」误当成「读到空值」，合法的「清空此格」写入会被静默吞掉。
    env = makeEnv({ liveContent: [['row_id', '名称'], ['r1']] });
    await env.cb('');
    eq(env.calls.save.length, 1, '读不到旧值 + 输入为空 → 仍写入（清空是合法写入，不被吞）');
  }

  // ── G-5 身份闸门优先 ──
  section('[G-5] 身份闸门早于等值判据：陈旧时先报陈旧');
  {
    const { cb, calls } = makeEnv({ identOk: false, identReason: '目标行已变化' });
    await cb('旧值');   // 故意传一个「值未变」的输入
    eq(calls.save.length, 0, '闸门拒绝 → 不写');
    eq(calls.text.length, 0, '闸门拒绝 → 不动 DOM');
    ok(calls.toast.some(([k, m]) => k === 'warn' && /目标行已变化/.test(m)), '闸门拒绝 → 出可读提示');
  }

  // ── G-6 成功/失败分支 ──
  section('[G-6] 写成功推进快照；写失败回滚并清缓存');
  {
    let env = makeEnv({ saveResult: true });
    await env.cb('新值');
    eq(env.calls.patch.length, 1, '成功 → patchSnapshotCell 推进快照基线');
    ok(!env.calls.toast.some(([k]) => k === 'error'), '成功 → 不报错');

    env = makeEnv({ saveResult: false });
    await env.cb('新值');
    eq(env.calls.patch.length, 0, '失败 → 不推进快照');
    ok(env.calls.toast.some(([k]) => k === 'error'), '失败 → 报错');
    ok(env.calls.render > 0, '失败 → 强制重渲染');
    eq(env.cache.sheet_a.content[1][1], '旧值', '失败 → 缓存里的乐观写入已回滚');
  }

  report('cell-edit-guard');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
