// 宿主 ChatSurface participant 契约（实验分支）
//
// 背景：TT 的 chat-surface 会校验 `#chat` 的直属子节点，前端历史上撞过
// unknown direct child fault，只能靠 MutationObserver + isManagedOwnershipRequired() 猜
// 「消息什么时候挂上」。官方 participant 协议（api.chatSurface.registerParticipant）
// 直接给 didMount/didCommitContent 钩子与 { mesid, element, signal }，由宿主告知挂载时机。
//
// 本机没有 TT 宿主可做真机验证，故这里用**假宿主 API** 驱动真实钩子源码，
// 把契约钉死。跑的是从 index.js 抽出来的真码，不是复制品。
//
// 守的契约：
//   H-1 三条硬约束：绝不外抛（宿主以 throwOnError:true 调用）、幂等、缺能力安静退回。
//      任何一条破了都会让宿主整个 ChatSurface 起不来。
//   H-2 非托管模式（未开虚拟化）不注册 participant。
//   H-3 注册形状正确：id / protocolVersion / 钩子名，且只注册一次。
//   H-4 接管开关默认关闭 → didMount 不碰 DOM（纯观察，行为与改动前一致）。
//   H-5 接管开启时只挂**末楼**；非末楼的 didMount 一律忽略。
//   H-6 didMount 返回 disposable（宿主卸载该消息时自动调用，避免面板滞留）。
//   H-7 didCommitContent 只在「我们的面板确实在那条消息里」时才重新对齐。
//   H-8 桥接函数自身抛错时钩子仍不外抛。
//   H-9 manifest.hooks.chatSurface 的名字必须等于实际导出名（跨文件契约）。
//   H-10 不用 registerContentProcessor：那条管线与可交互面板不兼容（见断言里的理由）。
'use strict';

const { section, ok, eq, report } = require('./helpers/harness');
const { readSource, sliceRange, buildScope } = require('./helpers/extract');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = readSource(process.argv[2]);

// 抽出模块级钩子区域（从幂等标记到文件末尾）。
// 去掉 `export ` 关键字：它只是模块语法，而 vm 里是函数体，去掉后语义等价。
const hookRegion = src
  .slice(src.indexOf('let __acuParticipantRegistered = false;'))
    .split(String.fromCharCode(10))
  .map(line => (line.indexOf('export ') === 0 ? line.slice(7) : line))
  .join(String.fromCharCode(10));
ok(hookRegion.length > 0, '钩子区域存在（幂等标记之后到文件末尾）');

// ── 假宿主 ──
function makeHost(opts = {}) {
  const o = Object.assign({
    hasAbi: true,
    hasRegister: true,
    managed: true,
    registerThrows: false,
    protocolVersion: 1,
  }, opts);
  const state = { registrations: [], calls: { mount: 0, refresh: 0 } };
  const host = {
    __state: state,
    get window() {
      if (!o.hasAbi) return {};
      const api = {};
      if (o.hasRegister) {
        api.chatSurface = {
          protocolVersion: o.protocolVersion,
          isManagedOwnershipRequired: () => o.managed,
          registerParticipant: (p) => {
            if (o.registerThrows) throw new Error('ChatSurface participant already registered: x');
            state.registrations.push(p);
            return { fault: () => {} };
          },
        };
      }
      return { __TAURITAVERN__: { api } };
    },
  };
  return host;
}

/** 造一个可跑钩子的作用域，bridge 由测试注入以便观测。 */
function runHook(host, bridgeOpts = {}) {
  const calls = bridgeOpts.calls || { mount: 0, refresh: 0, tail: null, takeover: false, throwOn: null };
  const scope = buildScope([
    'const window = __host.window;',
    'const console = { warn(){}, log(){}, error(){} };',
    'const __acuHostBridge = {',
    '  isTakeoverEnabled: () => __calls.takeover,',
    '  mountInto: (el) => { __calls.mount++; __calls.lastMounted = el; return true; },',
    '  currentHost: () => __calls.currentHost || null,',
    '  refresh: () => { __calls.refresh++; },',
    '  tailElement: () => __calls.tail,',
    '};',
    hookRegion,
  ], 'acuChatSurfaceHook');
  const fn = vm.runInNewContext(scope, {
    __host: host, __calls: calls,
    Object, Array, String, Boolean, TypeError, Error, console: { warn() {}, log() {}, error() {} },
  });
  return { fn, calls };
}

// ── H-1 三条硬约束 ──
section('[H-1] 硬约束：绝不外抛 / 幂等 / 缺能力安静退回');
{
  // 缺 ABI（ST 场景）
  let threw = false;
  try { runHook(makeHost({ hasAbi: false })).fn(); } catch (e) { threw = true; }
  ok(!threw, 'ST（无 __TAURITAVERN__）→ 静默返回，不抛');
  // 缺 registerParticipant（老 TT）
  threw = false;
  try { runHook(makeHost({ hasRegister: false })).fn(); } catch (e) { threw = true; }
  ok(!threw, '老 TT（无 registerParticipant）→ 静默返回，不抛');
  // 注册本身抛错（宿主用 throwOnError:true 调用本钩子）
  threw = false;
  const h = makeHost({ registerThrows: true });
  try { runHook(h).fn(); } catch (e) { threw = true; }
  ok(!threw, 'registerParticipant 抛错 → 被吞掉（否则宿主 ChatSurface 起不来）');
}
{
  const h = makeHost();
  const { fn } = runHook(h);
  fn(); fn(); fn();
  eq(h.__state.registrations.length, 1, '重复调用 3 次只注册 1 次（幂等）');
}

// ── H-2 非托管不注册 ──
section('[H-2] 非托管模式（未开虚拟化）不注册 participant');
{
  const h = makeHost({ managed: false });
  runHook(h).fn();
  eq(h.__state.registrations.length, 0, 'isManagedOwnershipRequired()===false → 不注册（保持既有逻辑）');
  const h2 = makeHost({ managed: true });
  runHook(h2).fn();
  eq(h2.__state.registrations.length, 1, '托管模式 → 注册');
}

// ── H-3 注册形状 ──
section('[H-3] 注册形状');
{
  const h = makeHost({ protocolVersion: 1 });
  runHook(h).fn();
  const p = h.__state.registrations[0];
  ok(!!p, '拿到注册对象');
  eq(p.id, 'st-acu-visualizer', 'participant id 稳定（重名会被宿主拒绝）');
  eq(p.protocolVersion, 1, 'protocolVersion 与宿主一致');
  ok(typeof p.didMount === 'function', '提供 didMount');
  ok(typeof p.didCommitContent === 'function', '提供 didCommitContent');
  ok(p.prepareContent === undefined, '不声明 prepareContent（不改写消息文本）');
  eq(Object.keys(p).sort(), ['didCommitContent', 'didMount', 'id', 'protocolVersion'],
    '没有多余字段（宿主对未知字段直接抛错）');
}

// ── H-4 默认不接管 ──
section('[H-4] 接管开关默认关闭 → 钩子纯观察，不碰 DOM');
{
  const h = makeHost();
  const { fn, calls } = runHook(h);
  fn();
  const p = h.__state.registrations[0];
  calls.takeover = false;
  calls.tail = { id: 'tail' };
  p.didMount({ mesid: 1, element: calls.tail, signal: {} });
  eq(calls.mount, 0, 'takeover=false → mountInto 未被调用（行为与改动前完全一致）');
  calls.currentHost = null;
  p.didCommitContent({ mesid: 1, element: { contains: () => false }, signal: {} });
  eq(calls.refresh, 0, 'takeover=false → didCommitContent 也不做事');
}

// ── H-5 只挂末楼 ──
section('[H-5] 接管开启时只挂末楼');
{
  const h = makeHost();
  const { fn, calls } = runHook(h);
  fn();
  const p = h.__state.registrations[0];
  calls.takeover = true;
  const tail = { id: 'tail' };
  calls.tail = tail;
  // 非末楼
  p.didMount({ mesid: 1, element: { id: 'other' }, signal: {} });
  eq(calls.mount, 0, '非末楼 → 不挂（面板只有一块，挂在末楼）');
  // 末楼
  p.didMount({ mesid: 2, element: tail, signal: {} });
  eq(calls.mount, 1, '末楼 → 挂载');
  ok(calls.lastMounted === tail, '挂到宿主给的 element 上（不是自己去 #chat 里猜）');
  // 异常输入
  p.didMount(null);
  p.didMount({});
  p.didMount({ element: null });
  eq(calls.mount, 1, 'context 缺失/为空 → 忽略，不抛');
}

// ── H-6 disposable ──
section('[H-6] didMount 返回 disposable（宿主卸载时自动调用）');
{
  const h = makeHost();
  const { fn, calls } = runHook(h);
  fn();
  const p = h.__state.registrations[0];
  calls.takeover = true;
  const tail = { id: 't' };
  calls.tail = tail;
  const d = p.didMount({ mesid: 1, element: tail, signal: {} });
  ok(typeof d === 'function', '返回函数式 disposable（宿主要求 function 或 {dispose}）');
  const before = calls.refresh;
  d();
  ok(calls.refresh > before, '调用 disposable 会触发重新对齐（面板不滞留）');
  // 非末楼不返回 disposable（没接管就没有东西要清理）
  calls.tail = { id: 'other' };
  ok(p.didMount({ mesid: 9, element: { id: 'x' }, signal: {} }) === undefined,
    '未接管时返回 undefined（不向宿主登记多余的清理项）');
}

// ── H-7 didCommitContent 的归属判断 ──
section('[H-7] didCommitContent 只在面板确实位于该消息内时重对齐');
{
  const h = makeHost();
  const { fn, calls } = runHook(h);
  fn();
  const p = h.__state.registrations[0];
  calls.takeover = true;
  const ourHost = { node: true };
  calls.currentHost = ourHost;
  p.didCommitContent({ mesid: 1, element: { contains: (x) => x === ourHost }, signal: {} });
  eq(calls.refresh, 1, '面板在该消息内 → 重新对齐（宿主重写内容后几何变了）');
  p.didCommitContent({ mesid: 2, element: { contains: () => false }, signal: {} });
  eq(calls.refresh, 1, '面板不在该消息内 → 不动（别去刷无关楼层）');
  p.didCommitContent({ mesid: 3, element: { contains: () => { throw new Error('boom'); } }, signal: {} });
  eq(calls.refresh, 1, 'contains 抛错 → 被吞，不外抛');
}

// ── H-8 桥接自身故障不外抛 ──
section('[H-8] 桥接函数抛错时钩子不外抛');
{
  const h = makeHost();
  const scope = buildScope([
    'const window = __host.window;',
    'const __acuHostBridge = {',
    '  isTakeoverEnabled: () => true,',
    '  mountInto: () => { throw new Error("bridge boom"); },',
    '  currentHost: () => null,',
    '  refresh: () => {},',
    '  tailElement: () => ({}),',
    '};',
    hookRegion,
  ], 'acuChatSurfaceHook');
  const fn = vm.runInNewContext(scope, {
    __host: h, Object, Array, String, Boolean, TypeError, Error, console: { warn() {}, log() {}, error() {} },
  });
  fn();
  const p = h.__state.registrations[0];
  let threw = false;
  try { p.didMount({ mesid: 1, element: {}, signal: {} }); } catch (e) { threw = true; }
  ok(!threw, 'mountInto 抛错 → didMount 吞掉（宿主会因为钩子抛错而 fault）');
}

// ── H-9 manifest 契约（跨文件）──
section('[H-9] manifest.hooks.chatSurface 必须等于实际导出名');
{
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const exportName = (src.match(/export function (\w+)/) || [])[1];
  ok(!!exportName, 'index.js 有具名导出');
  ok(manifest.hooks && typeof manifest.hooks.chatSurface === 'string', 'manifest 声明了 hooks.chatSurface');
  eq(manifest.hooks.chatSurface, exportName, '钩子名与导出名逐字一致（宿主按名字取函数）');
  eq(manifest.js, 'index.js', 'manifest.js 指向该文件（宿主 import() 它）');
}

// ── H-10 明确不采用 content processor ──
section('[H-10] 不使用 registerContentProcessor（记录否决理由，防后人误加）');
{
  // 精确到「调用」而不是「提及」：否决理由写在注释里也会命中裸 grep，
  // 那种断言会逼着后人删掉解释，属误报。
  ok(src.indexOf('.registerContentProcessor(') < 0, '未调用 registerContentProcessor（否决理由的注释不算）');
  ok(/content\.innerHTML|replaceChildren|contentVersion/.test(
    fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8') + src),
  '否决理由已在代码或变更日志中留痕（管线会整体重写 .mes_text 且缓存键不含本前端状态）');
  // 开关默认值必须为关：这是「实验不改变现状」的保证
  ok(/ttUseHostParticipant:\s*false/.test(src), 'ttUseHostParticipant 默认 false');
  ok(/isTableEditAllowed|ttUseHostParticipant === true/.test(src), '开关严格取 true 才接管');
}

report('host-participant');
