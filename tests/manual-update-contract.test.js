// 手动填表（legacy 回退路径）的调用契约
//
// 只在这条路径被触发时运行：apiV2.open 缺失或抛错（老库、或 V2 打不开）。
// 守的契约：
//   M-1 必须显式传 { confirm: true }
//       ST 库 1.0.0（龙血玄黄·数据库）给 manualUpdate 加了可选参
//       `options?: { confirm?: boolean }`，无参调用会被转成 skipConfirm:true →
//       **跳过那道高风险确认框**（框内明说会先删除所选表的 checkpoint 与增量，
//       唯一基线被删则历史数据不可恢复）。DB 侧注释写明「外部 API 调用由调用方
//       负责确认」，所以前端必须自己把那一步补回来。
//   M-2 传了对象在旧库上无害（旧 manualUpdate() 不读实参）
//   M-3 前置探测（清理失效的表选择）仍然发生，且失败不阻断主流程
//
// 跑的是真实调用点源码。
'use strict';

const { section, ok, eq, report } = require('./helpers/harness');
const { readSource, anchorIndex, buildScope } = require('./helpers/extract');
const vm = require('vm');

const src = readSource(process.argv[2]);

// 定位「await api.manualUpdate(...)」这一次真实调用
const callRe = /await api\.manualUpdate\(([^)]*)\)/g;
const sites = [];
let m;
while ((m = callRe.exec(src)) !== null) sites.push({ index: m.index, args: m[1].trim(), line: src.slice(0, m.index).split('\n').length });

section('[M-0] 前端只有一处 manualUpdate 调用点');
ok(sites.length === 1, 'manualUpdate 调用点恰好一处（漏一处就是漏一处确认）', '实际 ' + sites.length + ' 处');
ok(sites[0] && sites[0].args.includes('confirm'), '显式传了 confirm', '实参为: ' + (sites[0] ? sites[0].args : '(无)'));
ok(sites[0] && /confirm\s*:\s*true/.test(sites[0].args), 'confirm 的值是 true（不是 falsy）',
  '实参=' + JSON.stringify(sites[0] && sites[0].args));

// 真跑该次调用，验证参数确实传到了 DB
(async () => {
section('[M-1] 参数确实传到 DB（真跑调用表达式）');
{
  const calls = [];
  const api = { manualUpdate: async (...args) => { calls.push(args); return true; } };
  const expr = sites[0].args;
  const scope = buildScope(['const __run = async () => { return await api.manualUpdate(' + expr + '); };'], '__run');
  const run = vm.runInNewContext(scope, { api, console, Promise, Object, Array, Boolean });
  const r = await run();
  ok(r === true, '调用成功返回');
  eq(calls.length, 1, '恰好调用一次');
  eq(calls[0], [{ confirm: true }], '实参是 { confirm: true }');
}

section('[M-2] 旧库无参 manualUpdate 也不受额外实参影响');
{
  // 旧库签名：async function() —— 多传对象被忽略，仍走原来的确认流程
  let seen = 0;
  const oldApi = { manualUpdate: async function () { seen++; return 'OK'; } };
  const r = await oldApi.manualUpdate({ confirm: true });
  ok(r === 'OK' && seen === 1, '旧签名（无参）忽略额外实参并正常执行', 'r=' + r);
  // 能力探测本来可行：TS 的 `options?: T` 编译后是**普通形参**（不是默认参数），
  // 所以新版 Function.length === 1、旧版 === 0，两者可区分。
  // 但前端刻意**不做**探测：无条件传对象在两版上都对，少一个分支、少一处判断错的机会。
  const withOpt = async function (options) { return options && options.confirm === true; };
  ok(withOpt.length === 1 && (async function () {}).length === 0,
    '新版 length=1 / 旧版 length=0（能力本可探测，但选择不探测）');
  ok(/await api\.manualUpdate\(\{ confirm: true \}\)/.test(src),
    '调用处无条件传对象，没有能力探测分支');
}

section('[M-3] 前置探测仍发生且失败不阻断主流程');
{
  ok(/typeof api\.getManualSelectedTables === 'function'/.test(src), '仍会探测已失效的表选择');
  ok(/已恢复为全表更新/.test(src), '失效选择会被清理并提示');
  const a = anchorIndex(src, "console.warn('[ACU-API] 手动更新前置探测失败，继续按原流程执行:'", 'probe catch');
  ok(a > 0, '前置探测异常被吞掉并继续（不让探测失败阻断填表）');
}

report('manual-update-contract');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
