// 单元格渲染契约（DB 的 null 空单元格 + cellStr 作用域完整性）
//
// 守的契约：
//   N-1 DB 用 null 表示空单元格且写入侧不归一化，渲染**不得**出现字面量 "null"
//   N-2 合法值 0 / false / '0' 不得被当成空（cellText 而非 cell || ''）
//   N-3 cellStr 必须在使用它的作用域内有真实声明。
//       回归背景：曾把 `const cellStr = String(cell); const displayCell = cellStr.trim();`
//       折叠成 `const displayCell = cellText(cell).trim();`，删掉了 cellStr 声明，
//       而下方 grid/full 分支仍用 cellStr.length → strict 下 ReferenceError，
//       且异常被 renderInterface 的 try/catch 吞掉，整个面板失去事件绑定。
//       这类错误 `node --check` 完全查不出来，只有真跑能发现。
//   N-4 长文本阈值用**未 trim** 的 cellStr（与基线语义一致）
//   N-5 auto_merged 占位格不渲染
//
// 跑的是两处真实的 `row.forEach((cell, cIdx) => { ... })` 渲染回调。
'use strict';

const { section, ok, eq, report } = require('./helpers/harness');
const { readSource, findBlockEnd, sliceDecl, buildScope } = require('./helpers/extract');
const vm = require('vm');

const src = readSource(process.argv[2]);

// 真实 escapeHtml（20-25 行）与 cellText（72 行）——一起抽进来，避免复制实现。
const escapeHtmlSrc = sliceDecl(src, 'const escapeHtml = (v) =>', 'escapeHtml');
const cellTextSrc = sliceDecl(src, 'const cellText = (cell) =>', 'cellText');

// 两处渲染语句：抽**整条** `row.forEach((cell, cIdx) => { ... });`，
// 连参数一起（只抽函数体的话 cIdx/cell 会变成悬空标识符）。
const RENDER_ANCHOR = 'row.forEach((cell, cIdx) => {';
function extractRenderers() {
  const out = [];
  let i = -1;
  while ((i = src.indexOf(RENDER_ANCHOR, i + 1)) >= 0) {
    const bodyStart = src.indexOf('{', i + RENDER_ANCHOR.length - 2);
    const bodyEnd = findBlockEnd(src, bodyStart);
    // findBlockEnd 停在 forEach 体的 '}'，再吃掉 ');' 收尾
    let end = bodyEnd;
    while (end < src.length && src[end] !== ';') end++;
    out.push({ line: src.slice(0, i).split('\n').length, stmt: src.slice(i, end + 1) });
  }
  return out;
}
const renderers = extractRenderers();

// 两处渲染语句的契约**不同**，不能共用同一套断言：
//   ① 表卡片（第 1 处）：跳过 titleColIndex 那一格；表头取 headers[cIdx-1]；
//      有 diff 高亮；样式开关是 isListMode。
//   ② 快速查看（第 2 处）：不跳标题格；表头取 headers[cIdx]；无高亮；
//      样式开关是 currentStyle。
// 共享的硬契约只有：null 归一、合法 falsy 值、cellStr 作用域、>50 阈值、
// auto_merged 跳过、XSS 转义。
const PROFILES = [
  { key: 'table-card', extra: ['const isListMode = __isListMode;', 'const tableData = __tableData;', 'const realIndex = __realIndex;', 'const currentDiffMap = new Set(__diffKeys || []);'], hasHighlight: true, skipsTitle: true, headersOffset: -1, styleVar: 'isListMode' },
  { key: 'quick-view', extra: ['const currentStyle = __currentStyle;'], hasHighlight: false, skipsTitle: false, headersOffset: 0, styleVar: 'currentStyle' },
];

/**
 * 跑一次渲染语句，**捕获异常**。
 * 不捕获的话，一处悬空标识符就会中断整个套件、把后面所有渲染器的结论一起吞掉——
 * 那样「测试红了」与「测试崩了」无法区分，也看不出是哪一处坏了。
 */
function safeRun(idx, stmt, o) {
  try {
    return { out: runRenderer(idx, stmt, o), err: null };
  } catch (e) {
    return { out: null, err: e };
  }
}

function runRenderer(idx, stmt, o) {
  const p = PROFILES[idx];
  const scope = buildScope([
    escapeHtmlSrc,
    cellTextSrc,
    'let gridHtml = ""; let fullHtml = "";',
    'const headers = __headers;',
    'const titleColIndex = __titleColIndex;',
    'const codeIdx = __codeIdx;',
    'const tableName = __tableName;',
    'const config = { highlightNew: __highlightNew };',
    ...p.extra,
    'const row = __row;',
    'const __render = () => {',
    stmt,
    '};',
  ], '(() => { __render(); return { html: () => gridHtml + fullHtml }; })()');
  return vm.runInNewContext(scope, {
    __headers: o.headers, __titleColIndex: o.titleColIndex, __codeIdx: o.codeIdx ?? 0,
    __isListMode: !!o.isListMode, __currentStyle: o.currentStyle || 'grid',
    __tableName: o.tableName || 'T', __realIndex: o.realIndex ?? 0,
    __tableData: { key: 'sheet_t' }, __highlightNew: o.highlightNew !== false,
    __diffKeys: o.diffKeys || [], __row: o.row,
    console: { ...console, error() {}, warn() {} },
    Array, Object, String, Number, parseInt, isNaN, Set, Math,
  });
}

/** 取渲染结果；抛异常时返回空串，让断言以「内容不符」的形式失败而不是崩套件。 */
function htmlOf(res) {
  return res && res.out ? res.out.html() : '';
}

const H = ['row_id', '名称', '备注'];

(async () => {
  ok(renderers.length === PROFILES.length, `找到 ${renderers.length} 处渲染语句（预期 ${PROFILES.length}）`);

  for (let r = 0; r < renderers.length && r < PROFILES.length; r++) {
    const { stmt, line } = renderers[r];
    const P = PROFILES[r];
    const tag = `${P.key}（第 ${r + 1} 处，源码第 ${line} 行）`;
    // 表卡片会跳过 titleColIndex 那一格（由标题分支单独渲染），快速查看不会。
    const base = { headers: H, titleColIndex: 1, codeIdx: 0, isListMode: false, currentStyle: 'grid' };
    // titleColIndex=0：没有独立标题列的退化布局，此时第 1 格也会被这个回调渲染，
    // 才能断言「标签取 headers[cIdx-1]」这条下标契约。
    const baseNoTitle = { headers: H, titleColIndex: 0, codeIdx: 0, isListMode: false, currentStyle: 'grid' };
    // 长文本必须放在**数据格**里：放在标题格上会被跳过，测不到阈值分支。
    const longRow = P.skipsTitle ? ['r1', '标题', 'x'.repeat(60)] : ['r1', 'x'.repeat(60), 'x'];
    const shortRow = P.skipsTitle ? ['r1', '标题', '短'] : ['r1', '短', 'x'];

    section(`[N-1/N-2] ${tag}：null 与合法 falsy 值`);
    {
      // null / undefined 也必须放在**数据格**里。放在标题位上时表卡片渲染器会整格跳过，
      // 断言会「因为没渲染任何东西」而假通过——这正是 names/fixtures 承诺超出输入的典型形态。
      const nullRow = P.skipsTitle ? ['r1', '标题', null] : ['r1', null, 'x'];
      const undefRow = P.skipsTitle ? ['r1', '标题', undefined] : ['r1', undefined, 'x'];
      let out = safeRun(r, stmt, { ...base, row: nullRow });
      ok(!/null/.test(htmlOf(out)), 'null 单元格不渲染字面量 "null"', htmlOf(out).slice(0, 140));
      out = safeRun(r, stmt, { ...base, row: undefRow });
      ok(!/null|undefined/.test(htmlOf(out)), 'undefined 单元格不渲染字面量');
      // 0 / false 是合法值。必须放在**数据格**里：表卡片渲染器会跳过标题格，
      // 把 0 放在标题位上根本不会进入 HTML，测的就不是 cellText 了。
      const falsyRow = P.skipsTitle ? ['r1', '标题', 0, false] : ['r1', 0, false];
      const falsyHeaders = P.skipsTitle ? ['row_id', '标题', '零', '否'] : ['row_id', '零', '否'];
      out = safeRun(r, stmt, { ...base, row: falsyRow, headers: falsyHeaders });
      ok(/>0</.test(htmlOf(out)), '0 不被当成空', htmlOf(out).slice(0, 160));
      ok(/>false</.test(htmlOf(out)), 'false 不被当成空', htmlOf(out).slice(0, 160));
      out = safeRun(r, stmt, { ...base, row: ['r1', '甲', '乙'] });
      ok(htmlOf(out).includes('乙'), '非标题的数据格进入 HTML', htmlOf(out).slice(0, 120));
    }

    section(`[N-3] ${tag}：cellStr 作用域完整性（strict 下真跑）`);
    {
      const res = safeRun(r, stmt, { ...base, row: shortRow });
      ok(!res.err, '渲染语句在 strict 下可执行（无悬空标识符）',
        res.err ? res.err.constructor.name + ': ' + res.err.message : '');
      ok(htmlOf(res).includes('短'), '数据格确实进入了 HTML（证明不是空跑）');
    }

    section(`[N-4] ${tag}：长文本阈值用未 trim 的 cellStr`);
    {
      const grid = safeRun(r, stmt, { ...base, row: shortRow });
      const longOut = safeRun(r, stmt, { ...base, row: longRow });
      ok(htmlOf(grid).includes('acu-grid-item') || htmlOf(grid).includes('acu-inline-item'),
        '短文本走宫格/列表视图', htmlOf(grid).slice(0, 100));
      ok(htmlOf(longOut).includes('acu-full-item'), '>50 字符走整行视图（阈值消费 cellStr.length）',
        htmlOf(longOut).slice(0, 100));
    }

    section(`[N-5] ${tag}：auto_merged 占位格不渲染`);
    {
      const out = safeRun(r, stmt, { ...base, row: P.skipsTitle ? ['r1', '标题', 'auto_merged'] : ['r1', 'auto_merged', 'x'] });
      ok(!htmlOf(out).includes('auto_merged'), 'auto_merged 格被跳过');
    }

    section(`[N-7] ${tag}：表头下标与标题格跳过（PROFILES.headersOffset 必须是有效契约）`);
    {
      // 之前 headersOffset / styleVar 是**死字段**：写在 profile 里却没有任何断言读它，
      // 于是「表头取 headers[cIdx-1] 还是 headers[cIdx]」这条契约零覆盖，
      // 改错了也没人发现。这里把它变成真断言。
      const probe = P.skipsTitle ? baseNoTitle : base;   // 表卡片需 titleColIndex=0 才会渲染第 1 格
      const out = safeRun(r, stmt, { ...probe, row: ['r1', '甲值', '乙值'], headers: ['H0', 'H1', 'H2'] });
      const wantLabel = 'H' + (1 + P.headersOffset);
      const wrongLabel = 'H' + (1 + (P.headersOffset === 0 ? -1 : 1));
      ok(htmlOf(out).includes(wantLabel),
        `标签取 headers[cIdx${P.headersOffset >= 0 ? '+' + P.headersOffset : P.headersOffset}]（正确契约）`,
        `期望含 ${wantLabel}，实际: ${htmlOf(out).slice(0, 130)}`);
      ok(!htmlOf(out).includes(wrongLabel),
        `不得错取 headers[cIdx${P.headersOffset === 0 ? '-' : '+'}1]`, `不该含 ${wrongLabel}`);

      if (P.skipsTitle) {
        const withTitle = safeRun(r, stmt, { ...base, row: ['r1', '标题格', '数据格'], headers: ['row_id', '名称', '备注'] });
        ok(!htmlOf(withTitle).includes('标题格'), '标题格（cIdx === titleColIndex）被跳过，由标题分支单独渲染');
        ok(htmlOf(withTitle).includes('数据格'), '非标题格正常渲染');
      }
    }

    section(`[N-8] ${tag}：转义覆盖引号与 & （不只是 <）`);
    {
      // 单元格内容会进 value="..." 属性（整行编辑的 textarea、data-* 属性），
      // 只验 '<' 等于漏掉最危险的两个字符。
      const cases = [
        ['<img src=x onerror=1>', '<img', '尖括号'],
        ['" onfocus="alert(1)', 'onfocus="alert', '双引号（可逃逸属性）'],
        ["' onfocus='alert(1)", "onfocus='alert", '单引号（可逃逸属性）'],
        ['a & b', 'a & b', '裸 & （应被转义成 &amp;）'],
      ];
      for (const [input, forbidden, label] of cases) {
        const row = P.skipsTitle ? ['r1', '标题', input] : ['r1', input, 'x'];
        const res = safeRun(r, stmt, { ...base, row });
        ok(!htmlOf(res).includes(forbidden), `${label} 被转义：${JSON.stringify(input)}`, htmlOf(res).slice(0, 140));
      }
    }

    section(`[N-6] ${tag}：XSS 转义${P.hasHighlight ? '与 diff 高亮' : ''}`);
    {
      if (P.hasHighlight) {
        const out = safeRun(r, stmt, { ...base, row: ['r1', '甲', 'x'], diffKeys: ['T-0-2'] });
        ok(htmlOf(out).includes('acu-highlight-changed'), '改动格带高亮类');
      }
      const xss = safeRun(r, stmt, { ...base, row: P.skipsTitle ? ['r1', '标题', '<img src=x onerror=1>'] : ['r1', '<img src=x onerror=1>', 'x'] });
      ok(!htmlOf(xss).includes('<img'), '单元格内容被转义（不产生存储型 XSS）', htmlOf(xss).slice(0, 160));
    }
  }

  report('render-cells');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
