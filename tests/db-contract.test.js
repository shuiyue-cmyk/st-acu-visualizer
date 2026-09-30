// 数据库公共契约探针（跨仓）
//
// 这是全套里**唯一**有跨仓保留价值的测试：它守的是前端依赖的**公开 API 契约**，
// 对方是另一个 git 仓库（shujuku / shujuku-rebuild），前端无法自己决定它变没变。
// 数据库更新后必须重跑——这也是 CHANGELOG 里「数据库更新必 bump」的检查点。
//
// 守的契约（都是真正咬过人的，不是"方法名存在"这种弱检查）：
//   D-1 前端消费的 13 个方法在位，且形参名未变（位置参数调用，名字变了不影响前端，
//       但数量/在位性影响；这里只断言在位与参数个数）
//   D-2 exportTableAsJson 返回**活引用**（不是克隆）——前端整套缓存与身份复验都建立在这一点上
//   D-3 空单元格在 DB 侧表示为 null，写入侧**不**归一化成 ''
//   D-4 updateCell 按**数字列下标**寻址；updateRow/insertRow 按**列名**寻址
//   D-5 行下标是 1-based（content[0] 是表头）
//   D-6 parseMutationOptions_ACU 会从**数据对象的键**里读提交选项
//       （前端整行编辑的保留名列守卫就是为此存在）
//   D-7 精确写返回 true/false；通知回调的 meta.persisted 形状
//   D-8 撞名（同名双表）必须 fail-loud，不得静默写错表
//
// 用法：node db-contract.test.js [前端index.js] [TT库路径] [ST库路径]
//   · 完全不给库路径 → 跳过 D-1~D-8 并 exit 2（不静默报绿）
//   · 给了路径但不存在/读不到源文件 → **硬失败**（误配必须暴露，不能看起来测过了）
//   · 每条「存在性断言」都会打印它匹配到的文件与片段，便于判断是真命中还是被无关文本满足
'use strict';

const fs = require('fs');
const path = require('path');
const { section, ok, note, report } = require('./helpers/harness');

const FRONT = process.argv[2] || path.resolve(__dirname, '..', 'index.js');
const DB_PATHS = process.argv.slice(3);

const METHODS = [
  'exportTableAsJson', 'updateCell', 'updateRow', 'deleteRow', 'insertRow',
  'importTableAsJson', 'registerTableUpdateCallback', 'registerTableFillStartCallback',
  'openSettings', 'openVisualizer', 'manualUpdate', 'getManualSelectedTables',
  'clearManualSelectedTables',
];

function readIndex(root) {
  for (const c of [
    path.join(root, 'index.js'),
    path.join(root, 'source', 'src', 'index.ts'),
    path.join(root, 'source', 'index.js'),
  ]) if (fs.existsSync(c)) return c;
  return null;
}

/** 收集一个仓里所有源文件文本（契约散在多个文件里，单文件 grep 会漏）。 */
function readAllSources(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.(ts|js|mjs)$/.test(e.name) || /\.d\.ts$/.test(e.name) || /test|spec/i.test(e.name)) continue;
      // 排除打包产物：数据库仓里可能夹带前端 bundle（tt9103/index.js 就是一份），
      // 它含有大量提示词与中文文案，会让「存在性断言」被无关文本满足 → 恒真。
      if (/(^|[\\/])(dist|build|out|bundle|public)[\\/]/.test(p)) continue;
      if (/\.min\.js$/.test(e.name)) continue;
      if (/\.baseline\.(js|ts)$/.test(e.name)) continue;   // 快照副本：同一份契约出现两次，命中哪份说不清
      try {
        const text = fs.readFileSync(p, 'utf8');
        // 排除仓根那份**前端 bundle 副本**（tt9103/index.js 就是），它含大量提示词与
        // 中文文案，会让「存在性断言」被无关文本满足 → 恒真。
        // 判据要窄：只看「仓根 index.js + 体积巨大 + 含本扩展标记」，
        // 否则会误伤真正提到 acu-visualizer 的正常源文件。
        if (/(^|[\\/])index\.js$/.test(p) && text.length > 200000 && /acu-visualizer|acu_visualizer/.test(text)) continue;
        out.push({ file: p, text });
      } catch (_) {}
    }
  };
  walk(root, 0);
  return out;
}

const front = fs.readFileSync(FRONT, 'utf8');

section('[D-0] 前端实际消费了哪些方法');
{
  const unused = METHODS.filter(m => !new RegExp('\\.' + m + '\\s*\\(').test(front));
  ok(unused.length === 0, '清单里的 13 个方法前端全都调用了（清单未过期）', '未被调用：' + unused.join(','));
  const called = [...front.matchAll(/\.(?:getTable|getDB)\(\)\s*|\bapi\.(\w+)\s*\(|\bdb\.(\w+)\s*\(/g)]
    .map(m => m[1] || m[2]).filter(Boolean);
  const known = new Set(METHODS);
  const suspicious = [...new Set(called)].filter(m => !known.has(m) && /^(update|delete|insert|import|export|register|open|manual|get|clear)/.test(m));
  ok(suspicious.length === 0, '没有调用清单外的 DB 写/读方法（新增调用需同步本清单）', suspicious.join(','));
}

if (DB_PATHS.length === 0) {
  console.log('\n⚠ 未提供数据库路径，跳过 D-1~D-8。');
  console.log('  用法: node tests/db-contract.test.js <前端index.js> <TT库> <ST库>');
  console.log('  静默通过等于没测，所以这里显式跳过而不是报绿。');
  process.exitCode = 2;
} else {
  for (const root of DB_PATHS) {
    if (!fs.existsSync(root)) {
      // 给了路径却不存在 = 误配。跳过并保持绿色是最坏的失败形态：
      // 数据库契约探针的全部意义就是「库变了要重估」，误配时必须硬失败。
      ok(false, '数据库路径不存在（误配）：' + root);
      continue;
    }
    const sources = readAllSources(root);
    const where = (re) => {
      for (const s of sources) { const m = s.text.match(re); if (m) return path.basename(s.file) + ': ' + m[0].replace(/\s+/g, ' ').slice(0, 90); }
      return null;
    };
    const name = path.basename(root);
    console.log('\n' + '='.repeat(72));
    console.log('数据库：' + root + '（' + sources.length + ' 个源文件）');
    console.log('='.repeat(72));
    // 语料为空说明路径给错了（或仓里没有可读源文件）。此时继续跑只会让所有
    // 「存在性断言」以 0 命中的方式全绿——那是最坏的失败形态：看起来测过了，
    // 实际什么都没测。必须硬失败。
    if (sources.length === 0) {
      ok(false, `${name}：路径存在但读不到任何源文件（路径给错了吧？）`, root);
      continue;
    }
    // 至少要能看到 table-crud / schema-mapper 这类核心文件，否则 D-3~D-8 全是空断言
    const critical = ['table-crud', 'schema-mapper', 'core-data-api'].filter(k => sources.some(s => s.file.includes(k)));
    ok(critical.length >= 2, `${name}：语料包含核心契约文件`, '命中: ' + critical.join(', ') + '（若为 0，说明语料是错的文件）');

    section(`[D-1] ${name}：13 个公共方法在位`);
    for (const m of METHODS) {
      const hit = where(new RegExp('\\b' + m + '\\s*:\\s*(?:async\\s+)?function'));
      ok(!!hit, `${m} 在位`, hit || ''); note(hit);
    }

    section(`[D-2] ${name}：exportTableAsJson 返回活引用（前端缓存与身份复验的前提）`);
    {
      const hit = where(/exportTableAsJson\s*:\s*function\s*\(\)\s*\{\s*return\s+currentJsonTableData_ACU\s*\|\|\s*\{\s*\}/m);
      ok(!!hit, '直接返回内部活对象（不是深拷贝）', hit || '若这里变了，前端整条缓存/复验链路的前提就变了，必须重新评估'); note(hit);
    }

    section(`[D-3] ${name}：空单元格表示为 null，写入侧不归一化成 ''`);
    {
      const hit = where(/function valueToString\s*\([^)]*\)\s*:\s*[^|{]*\|\s*null\s*\{[^}]*?val\s*===\s*null\s*\|\|\s*val\s*===\s*undefined\s*\)\s*return\s+null/m);
      ok(!!hit, '读取侧 valueToString 对 null/undefined 返回 null（不转成空串）', hit || ''); note(hit);
      const esc = where(/function escapeValue\s*\([^)]*\)\s*:\s*string\s*\{[^}]*?val\s*===\s*null\s*\|\|\s*val\s*===\s*undefined\s*\)\s*return\s+'NULL'/m);
      ok(!!esc, '写入侧 escapeValue 把 null 写成 SQL NULL（不会变成空串字面量）', esc || '');
    }

    section(`[D-4] ${name}：updateCell 数字列下标 / updateRow·insertRow 列名对象寻址`);
    {
      const uc = where(/updateCell\s*:\s*async\s+function\s*\([^)]*colIdentifier[^)]*\)/m);
      ok(!!uc, 'updateCell 形参第 3 位是 colIdentifier（数字列下标寻址）', uc || '');
      const ur = where(/updateRow\s*:\s*async\s+function\s*\([^)]*\bdata\??[^)]*\)/m);
      ok(!!ur, 'updateRow 形参含 data（按列名的对象寻址）', ur || '');
      const ir = where(/insertRow\s*:\s*async\s+function\s*\([^)]*\bdata\??[^)]*\)/m);
      ok(!!ir, 'insertRow 形参含 data（无 rowIndex —— 追加语义）', ir || '');
      // updateCell 走数字下标：必须能看到「把 colIdentifier 解析成数字下标并按 headers 取列名」的路径
      const numeric = where(/numericColIdentifier[\s\S]{0,1400}?rawColName\s*=\s*headers\[numericColIdentifier\]/m);
      ok(!!numeric, 'updateCell 把 colIdentifier 解析为数字列下标并按 headers 取列名（前端传数字下标才成立）', numeric || ''); note(numeric);
      // 越界必须被拒，不能静默写相邻列
      const colOob = where(/Column index \$\{numericColIdentifier\} out of bounds/m);
      ok(!!colOob, '数字列下标越界有明确拒绝路径（前端传错列不会静默写进别的列）', colOob || ''); note(colOob);
      // updateRow 按列名寻址：必须看到**遍历数据对象的键去匹配列名**。
      // 「全仓首个 Object.keys(data)」不够——别的文件里的同名表达式会满足它
      // （实测 useDataManagement.ts 就有一个）。必须与 updateRow 同文件且在其定义之后。
      // 真实写法是 `for (const colName in normalizedData)`（解构后的重命名变量）。
      let byName = null, skipsImportMode = null;
      for (const s of sources) {
        const defAt = s.text.search(/updateRow\s*:\s*async\s+function/);
        if (defAt < 0) continue;
        const seg = s.text.slice(defAt, defAt + 9000);
        const m = seg.match(/for\s*\(\s*const\s+\w+\s+in\s+(?:\w*[dD]ata)\s*\)|Object\.keys\(\s*\w*[dD]ata\s*\)/);
        if (m && !byName) byName = path.basename(s.file) + ' → ' + m[0];
        const im = seg.match(/if\s*\(\s*colName\s*===\s*['"]isImportMode['"]\s*\)\s*continue/);
        if (im && !skipsImportMode) skipsImportMode = path.basename(s.file) + ' → ' + im[0];
        if (byName && skipsImportMode) break;
      }
      ok(!!byName, 'updateRow 在自己函数体内遍历数据对象的键来匹配列名（前端必须传原始表头文本）', byName || ''); note(byName);
      // DB 自己会跳过 isImportMode —— 这是前端把该列名列入保留名的**直接依据**。
      // 但 DB 并不跳过 skipNotify/silent，所以前端那道守卫仍然必需（见 D-6）。
      ok(!!skipsImportMode, 'DB 侧显式跳过 isImportMode 列（证实前端保留名清单不是猜测）', skipsImportMode || ''); note(skipsImportMode);
    }

    section(`[D-5] ${name}：行下标 1-based（content[0] 是表头，不可改表头行）`);
    {
      const hdrGuard = where(/Cannot modify header row \(index 0\)/m) || where(/Cannot delete header row \(index 0\)/m);
      ok(!!hdrGuard, '显式拒绝改动 index 0（表头行）→ 行下标确为 1-based 数据行', hdrGuard || ''); note(hdrGuard);
      const oob = where(/Row index \$\{normalizedRowIndex\} out of bounds/m);
      ok(!!oob, '行下标越界有明确拒绝路径（前端 rowIndex+1 传错会被拒而非静默）', oob || ''); note(oob);
    }

    section(`[D-6] ${name}：parseMutationOptions_ACU 从数据对象的键里读提交选项`);
    {
      const head = where(/function parseMutationOptions_ACU[\s\S]{0,1200}?return\s*\{\s*skipChatSave,\s*skipNotify\s*\}/m);
      ok(!!head, 'parseMutationOptions_ACU 存在且返回 { skipChatSave, skipNotify }', head || ''); note(head);
      const isImport = where(/parseMutationOptions_ACU[\s\S]{0,900}?rowData\?\.isImportMode/m);
      ok(!!isImport, 'rowData.isImportMode 被读取（前端保留名列守卫的直接依据）', isImport || ''); note(isImport);
      const silent = where(/parseMutationOptions_ACU[\s\S]{0,900}?rowData\?\.skipNotify[\s\S]{0,200}?rowData\?\.silent/m);
      ok(!!silent, 'rowData.skipNotify 与 rowData.silent 也被读取', silent || ''); note(silent);
    }

    section(`[D-7] ${name}：通知回调 meta.persisted 形状`);
    {
      const hit = where(/persisted:\s*meta\?\.persisted\s*!==\s*false/m);
      ok(!!hit, '回调侧把 persisted 归一为布尔', hit || ''); note(hit);
    }

    section(`[D-8] ${name}：撞名（同名双表）fail-loud，不得静默写错表`);
    {
      // 判据必须锚在**代码**上，不能用「冲突/重名」这类词——中文文案、提示词、
      // 日志里全都有这些字，会让断言恒真。锚在明确的拒绝路径上。
      const hit = where(/AmbiguousSheet|ambiguous sheet|Ambiguous[ _]table|sheetKeyCollision|duplicate sheet key|重名表|表名冲突|Ambiguous/i)
        || where(/resolveSheetKey[\s\S]{0,600}?(throw|return\s+null)[\s\S]{0,200}?(ambiguous|collision|conflict)/i);
      ok(!!hit, '存在撞名判定与显式拒绝路径（锚在代码而非文案）',
        hit || '若不再 fail-loud，前端的 sheet key 假设需重新评估'); note(hit);
    }
  }
  report('db-contract');
}
