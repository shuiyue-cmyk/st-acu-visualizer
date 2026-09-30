// 数据管道契约：processJsonData（视图 → 表名→行 映射）与 lightFingerprint（轮询变更检测）
//
// 这两个函数此前**从未进入任何 vm**（read-only-gates 用的是桩）。
// 「抽真码」只解决"不测副本"，不解决"覆盖面"——凡是被桩掉的依赖，
// 套件证明的是桩。所以这里把它们纳入真实执行。
//
// 守的契约：
//   P-1 processJsonData 以**表名**（sheet.name）为键，不是 sheetId
//       ——批量删的复验快照按表名索引，用 sheetId 会永远取不到而全量误拒
//   P-2 P-1 的反证：把键换成 sheetId 必须被测出来
//   P-3 rows 是 content.slice(1)（跳过表头行），headers 是 content[0]
//   P-4 **不改传入对象**。这一点现在比以前更要紧：批量删把 DB 活引用喂进来，
//       一旦 processJsonData 改写它就是直写 DB 运行时内存
//   P-5 脏数据不抛：缺 content / 非数组 / 无 name 的 sheet 一律跳过
//   P-6 lightFingerprint：数据没动 → 指纹相同（轮询不刷新，无谓重绘）
//   P-7 lightFingerprint：行数/表头/采样行任一变化 → 指纹变化（轮询能发现）
//   P-8 lightFingerprint：null 单元格与空串同形（已知限制，只影响刷新时机）
'use strict';

const { section, ok, eq, report } = require('./helpers/harness');
const { readSource, sliceConstFn, buildScope } = require('./helpers/extract');
const vm = require('vm');

const src = readSource(process.argv[2]);

/**
 * 把真实函数装进 vm，并让它直接吃**同一个**对象实例。
 * 不能 JSON 序列化后再传：那样对象身份丢失，调用前的 mutate 全部失效，
 * 「共享行数组」这类断言也测不到（这是本文件第一版的真实错误）。
 */
function load(needle, label) {
  const decl = sliceConstFn(src, needle, label);
  const expr = decl.replace(new RegExp('^const\\s+' + label + '\\s*=\\s*'), '').replace(/;\s*$/, '');
  const scope = buildScope([decl], label);
  const call = (input) => vm.runInNewContext(scope, {
    __in: input,
    console: { ...console, error() {}, warn() {} },
    JSON, Object, Array, String, Number, Math, Set, Map, isNaN, parseInt,
  })(input);
  return call;
}
const processJsonData = load('const processJsonData = (json) => {', 'processJsonData');
const lightFingerprint = load('const lightFingerprint = (data) => {', 'lightFingerprint');

const view = (sheets) => Object.assign({ mate: { type: 'chatSheets', version: 1 } }, sheets);
const sh = (name, content) => ({ name, content });

(async () => {
  // ── P-1/P-2 键必须是表名 ──
  section('[P-1] processJsonData 以表名为键（不是 sheetId）');
  {
    const t = processJsonData(view({
      sheet_abc123: sh('主角信息表', [['row_id', '名称'], ['r1', '甲']]),
      sheet_xyz789: sh('背包物品表', [['row_id', '名称']]),
    }));
    eq(Object.keys(t).sort(), ['主角信息表', '背包物品表'], '键是 sheet.name');
    eq(t['主角信息表'].key, 'sheet_abc123', 'key 字段仍保存 sheetId（供其它用途）');
    ok(t['sheet_abc123'] === undefined, '不会误用 sheetId 当键');
  }

  // ── P-3 表头与数据行 ──
  section('[P-3] headers=content[0]，rows=content.slice(1)');
  {
    const t = processJsonData(view({ sheet_a: sh('A', [['row_id', '名称', '备注'], ['r1', '甲', 'x'], ['r2', '乙', 'y']]) }));
    eq(t['A'].headers, ['row_id', '名称', '备注'], 'headers 是表头行');
    eq(t['A'].rows, [['r1', '甲', 'x'], ['r2', '乙', 'y']], 'rows 跳过表头行');
  }
  section('[P-3b] 只有表头没有数据行');
  {
    const t = processJsonData(view({ sheet_a: sh('A', [['row_id', '名称']]) }));
    eq(t['A'].rows, [], '无数据行 → rows 为空数组（不是 undefined）');
    const t2 = processJsonData(view({ sheet_a: sh('A', []) }));
    eq(t2['A'].headers, [], 'content 为空数组 → headers 为空');
    eq(t2['A'].rows, [], 'content 为空数组 → rows 为空');
  }

  // ── P-4 不改传入对象（现在传的是 DB 活引用）──
  section('[P-4] 不改传入对象（批量删会把 DB 活引用喂进来）');
  {
    const live = view({ sheet_a: sh('A', [['row_id', '名称'], ['r1', '甲']]) });
    const before = JSON.stringify(live);
    const t = processJsonData(live);
    eq(JSON.stringify(live), before, '调用后活引用内容逐字未变');
    // 返回值与活引用共享行数组是**已知取舍**（只读用途）；这里把「共享」钉出来，
    // 将来若有人往 verifyTables 上写，必须先看到这条断言失败并重新设计。
    ok(t['A'].rows[0] === live.sheet_a.content[1], '已知取舍：rows 与活引用共享行数组（只读，绝不可写）');
  }

  // ── P-5 脏数据 ──
  section('[P-5] 脏数据不抛且被跳过');
  {
    for (const bad of [null, undefined, 0, 'str', [], { sheet_a: null }, { sheet_a: {} },
      { sheet_a: { name: 'A' } }, { sheet_a: { name: 'A', content: 'x' } },
      { sheet_a: { name: 'A', content: [null, 'notarray'] } }, { sheet_x: { content: [['a']] } }]) {
      let threw = null, r = null;
      try { r = processJsonData(bad); } catch (e) { threw = e; }
      ok(!threw && r && typeof r === 'object', '脏输入不抛：' + JSON.stringify(bad), threw ? threw.message : '');
    }
    const t = processJsonData(view({ sheet_noname: { content: [['a']] }, sheet_ok: sh('OK', [['a'], ['1']]) }));
    eq(Object.keys(t), ['OK'], '无 name 的 sheet 被跳过');
  }

  // ── P-6/P-7 轮询指纹 ──
  section('[P-6] lightFingerprint：未变则指纹不变（轮询不刷新）');
  {
    const d = view({ sheet_a: sh('A', [['row_id', '名称'], ['r1', '甲']]) });
    const f1 = lightFingerprint(d);
    ok(typeof f1 === 'string' && f1.length > 0, '返回非空字符串');
    eq(lightFingerprint(d), f1, '同一份数据重复调用结果相同（确定性）');
    eq(lightFingerprint(view({ sheet_a: sh('A', [['row_id', '名称'], ['r1', '甲']]) })), f1,
      '内容相同的另一份对象指纹也相同（不依赖引用）');
  }
  section('[P-7] lightFingerprint：真实变化能被检出');
  {
    const mk = () => view({ sheet_a: sh('A', [['row_id', '名称'], ['r1', '甲'], ['r2', '乙']]) });
    const base = lightFingerprint(mk());
    // 每个用例一份全新数据：mutate 必须作用在**本次传入的那个对象**上
    const changes = [
      ['表头变化（新增列）', (d) => { d.sheet_a.content[0].push('新列'); }],
      ['行数变化（新增行）', (d) => { d.sheet_a.content.push(['r3', '丙']); }],
      ['首行值变化', (d) => { d.sheet_a.content[1][1] = '改'; }],
      ['末行值变化', (d) => { d.sheet_a.content[2][1] = '改'; }],
      ['新增表', (d) => { d.sheet_b = sh('B', [['row_id', 'x'], ['1', 'y']]); }],
      ['删表', (d) => { delete d.sheet_a; }],
    ];
    for (const [label, mutate] of changes) {
      const dd = mk();
      const before = lightFingerprint(dd);   // 建立本例基线
      mutate(dd);
      ok(lightFingerprint(dd) !== before, label + ' → 指纹变化（轮询能发现）');
    }
  }
  section('[P-8] lightFingerprint：已知限制（null 与空串同形）');
  {
    const a = view({ sheet_a: sh('A', [['row_id', '名称'], ['r1', null]]) });
    const b = view({ sheet_a: sh('A', [['row_id', '名称'], ['r1', '']]) });
    eq(lightFingerprint(a), lightFingerprint(b), 'null 格与空串格指纹相同（只影响刷新时机，不影响寻址）');
    const c = view({ sheet_a: sh('A', [['row_id', '名称'], ['r1', 'null']]) });
    ok(lightFingerprint(c) !== lightFingerprint(a), '但字面量 "null" 与真正的 null 可区分');
  }
  section('[P-8b] lightFingerprint 脏输入不抛');
  {
    for (const bad of [null, undefined, 0, 'str', {}, { sheet_a: null }, { sheet_a: { content: null } }, { sheet_a: { content: [] } }]) {
      let threw = null;
      try { lightFingerprint(bad); } catch (e) { threw = e; }
      ok(!threw, '脏输入不抛：' + JSON.stringify(bad), threw ? threw.message : '');
    }
  }

  report('data-plumbing');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
