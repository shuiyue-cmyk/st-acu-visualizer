// TauriTavern 宿主耦合契约
//
// 这套测试的存在理由：一次独立否证审计发现，我此前对宿主虚拟化的判断**依据取错了行**
// （引了 mutation guard 关闭时的分支），并漏掉了「前端到底碰宿主哪些面」。
// 说明性断言防不住这类错误——它们只钉住我已知的东西。
// 所以这里把**宿主侧的契约**显式写下来，让「碰了哪些面」「边界在哪」变成可回归的东西。
//
// 宿主基线：TauriTavern 2.3.0（a1855be4）。
// 守的契约：
//   T-1 消息选择器必须是 `#chat` 的**直属子** `.mes`，与宿主
//       `chat-dom-adapter.js:7 directMessages()`（`:scope > .mes`）同边界。
//   T-2 detectTTBounded 的三条路径：API 正常 / API 抛错（fail-safe 到 bounded）/
//       老宿主 localStorage 兜底（**故意保留**，删掉会让老宿主直挂 #chat 而 fault）。
//   T-3 bounded 模式下**绝不能**把面板挂成 `#chat` 的直属子节点——
//       那是宿主唯一的真实 fault 入口：`Bounded ChatSurface contains an unknown
//       direct child`（chat-dom-adapter.js:323-332）。
//   T-4 closePanel 会把关闭前记下的 scrollTop 写回 `#chat`（宿主的唯一 scroll root）。
//       本轮**不改**（它有正当用途：面板折叠后布局位移需要回正），但把现状钉住，
//       并记录待实测的风险：写陈旧值可能被宿主判为非程序化滚动而挂起投影。
//   T-5 不得复用宿主的选择器类名（`mes_text` / `mesIDDisplay` 等）：
//       宿主用 `querySelector` 取**文档序第一个**，在其之前插入同名节点会触发
//       `DOM identity changed during content reconciliation`。
'use strict';

const { section, ok, eq, report } = require('./helpers/harness');
const { readSource, sliceConstFn, buildScope } = require('./helpers/extract');
const vm = require('vm');

const src = readSource(process.argv[2]);

// 极简 DOM：只需支持 querySelectorAll 的 '> ' 与后代两种语义
class DOMShim {
  constructor(html) {
    this.nodes = [];
    const re = /<div([^>]*)>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const attrs = m[1];
      const id = (attrs.match(/id="([^"]+)"/) || [])[1];
      const cls = (attrs.match(/class="([^"]+)"/) || [])[1] || '';
      this.nodes.push({ id, cls: cls.split(/\s+/), depth: this.depthOf(m.index, html) });
    }
  }
  depthOf(index, html) {
    return (html.slice(0, index).match(/<div/g) || []).length;
  }
  querySelectorAll(sel) {
    const direct = sel.startsWith(':scope > ');
    const cls = sel.replace(':scope > ', '').replace(/^\./, '');
    return this.nodes.filter(n => n.cls.includes(cls) && (!direct || n.depth === 1));
  }
}


// ── T-1 选择器边界 ──
section('[T-1] 消息选择器与宿主同边界（#chat 的直属子 .mes）');
{
  // 宿主用 :scope > .mes（chat-dom-adapter.js:7）
  const descendant = src.match(/\$\('#chat \.mes'\)/g) || [];
  const findStyle = src.match(/\$chat\.find\('\.mes'\)/g) || [];
  eq(descendant.length, 0, "不再有 $('#chat .mes')（后代选择器）",
    descendant.length + ' 处');
  eq(findStyle.length, 0, "不再有 $chat.find('.mes')（后代选择器）",
    findStyle.length + ' 处');
  const direct = src.match(/\$\('#chat > \.mes'\)/g) || [];
  const children = src.match(/\$chat\.children\('\.mes'\)/g) || [];
  ok(direct.length + children.length >= 5,
    `取消息处一律用直属语义（> .mes ${direct.length} 处 / children ${children.length} 处）`);
  // 语义等价性：用一个带嵌套 .mes 的假 DOM 证明两者会分叉
  const host = '<div id="chat"><div class="mes" id="outer"><div class="mes_text">t</div>'
    + '<div class="mes" id="nested"><div class="mes_text">n</div></div></div></div>';
  const pick = (sel) => [...new DOMShim(host).querySelectorAll(sel)].map(e => e.id);
  eq(pick(':scope > .mes'), ['outer'], '宿主边界：只认直属');
  eq(pick('.mes'), ['outer', 'nested'], '后代边界：会多拿到嵌套那个（故前端不能用）');
}

// ── T-2 detectTTBounded 三条路径（真跑）──
section('[T-2] detectTTBounded：API 正常 / 抛错 fail-safe / 老宿主兜底');
{
  // 块体箭头函数：必须用花括号配平截取，不能按行截断（函数体内部就有分号）
  const decl = sliceConstFn(src, 'const detectTTBounded = () => {', 'detectTTBounded');
  const expr = decl.replace(/^const\s+detectTTBounded\s*=\s*/, '').replace(/;\s*$/, '');
  const run = (abi, ls) => vm.runInNewContext('"use strict";((' + expr + '))()', {
    window: { __TAURITAVERN__: abi },
    localStorage: ls,
    Boolean, Object, console,
  });

  ok(run({ api: { chatSurface: { isManagedOwnershipRequired: () => true } } }, undefined) === true,
    'API 说开启 → true');
  ok(run({ api: { chatSurface: { isManagedOwnershipRequired: () => false } } }, undefined) === false,
    'API 说关闭 → false（原生路径）');
  ok(run({ api: { chatSurface: { isManagedOwnershipRequired: () => { throw new Error('not initialized'); } } } },
    undefined) === true,
    'API 抛错（未初始化）→ fail-safe 到 true（避免误走直挂 #chat）');
  ok(run(undefined, { getItem: () => 'true' }) === true,
    '老宿主 localStorage 兜底命中 → true（保留是有意的：删掉会让老宿主直挂 #chat 而 fault）');
  ok(run(undefined, { getItem: () => null }) === false,
    '无 API 且无兜底 → false（ST 场景，ST 从不虚拟化）');
  ok(run({}, undefined) === false, 'window.__TAURITAVERN__ 存在但无 api → false，不抛');
  ok(run(undefined, undefined) === false, 'localStorage 也不存在 → false，不抛');
}

// ── T-3 bounded 下不得直挂 #chat ──
section('[T-3] bounded 模式下不把面板挂成 #chat 的直属子节点');
{
  // 静态：bounded 分支里不得出现对 $chat 的 append/before/appendTo/prepend
  const start = src.indexOf('const isTTBoundedM = detectTTBounded();');
  const end = src.indexOf('chatObsRafPending = false;', start) > start
    ? src.indexOf('const stopSelectors', start) : src.length;
  const region = src.slice(start, end);
  ok(region.length > 0, '定位到归位逻辑区间');
  // 原生分支（在 !isTTBoundedM 时）才允许直挂 #chat，这里只断言 bounded 早退分支在
  // 直挂之前已经 return
  const boundedReturns = region.split('isTTBoundedM')[1] || '';
  const firstDirectAppend = boundedReturns.search(/\$chat\s*\)?\s*\.\s*(append|prepend|before|after)\b|\$chat\s*\.\s*append\(/);
  ok(firstDirectAppend === -1 || boundedReturns.slice(0, firstDirectAppend).includes('return'),
    'bounded 分支在任何直挂 #chat 之前就已 return',
    firstDirectAppend === -1 ? '(bounded 段内无直挂)' : '');
  // 兜底注释留痕：说明这条约束的由来
  ok(/unknown direct child/.test(src), '代码里留有该 fault 的由来说明（防后人改成直挂）');
}

// ── T-4 closePanel 的 scrollTop 写回（钉住现状 + 记录风险）──
section('[T-4] closePanel 的 scrollTop 写回：现状钉住，风险记录在案');
{
  ok(/const currentScroll = \$chat\.length \? \$chat\.scrollTop\(\) : 0;/.test(src),
    '关闭前记下 #chat 的 scrollTop');
  ok(/setTimeout\(\(\) => \{\s*\$chat\.scrollTop\(currentScroll\);\s*\}, 10\);/.test(src),
    '10ms 后把该值写回（现状：本轮刻意不改）');
  // 它确实写在宿主的唯一 scroll root 上——这是风险所在，必须显式记录
  ok(/#chat/.test(src.slice(src.indexOf('const closePanel'), src.indexOf('const closePanel') + 4000)),
    '写回目标是 #chat（= 宿主 chat-scroll-adapter 的唯一 scroll root）');
  // 「本轮不改」必须留下可查的记录，否则下一个读代码的人无从知道这是个已知风险。
  // 断言的是「变更日志里确实写了这笔未实测的风险」——可证伪，不是恒真。
  const fs2 = require('fs');
  const path2 = require('path');
  const changelog = fs2.readFileSync(path2.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  ok(changelog.includes('scrollTop') && /未实测|待实测|未验证/.test(changelog),
    '该风险已作为「未实测」记录在 CHANGELOG 里（断言的是记录在不在，不是恒真）');
}

// ── T-5 不得复用宿主选择器类名 ──
section('[T-5] 不复用宿主的选择器类名（mes_text / mesIDDisplay 等）');
{
  // 前端自造的元素里不得出现这些类名。取所有 acu- 前缀的 class 声明做集合运算。
  const hostOwned = ['mes_text', 'mes_block', 'mesIDDisplay', 'name_text', 'mes', 'mesAvatarWrapper'];
  const acuClasses = new Set();
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !c.startsWith('acu-') && !c.startsWith('fa-')) acuClasses.add(c);
  }
  // 动态拼出的类名（acu-cell / acu-wrapper 等）都在模板里，这里只查静态可见的
  const collisions = hostOwned.filter(c => acuClasses.has(c));
  eq(collisions, [], '前端自造 class 未与宿主选择器类名冲突',
    collisions.length ? '冲突: ' + collisions.join(',') : '');
  // 另外：不得在真 .mes_text 之前插入 mes_text 同名节点——本轮不做注入，故只断言
  // 前端没有创建名为 mes_text 的元素
  ok(!/createElement\(['"]mes_text['"]\)|<[^>]*class="mes_text"/.test(src),
    '前端不创建 mes_text 节点（避免抢在宿主真 .mes_text 之前被 querySelector 命中）');
}

report('tt-host-coupling');
