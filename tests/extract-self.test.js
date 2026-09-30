// 抽取器自身的契约。
//
// 这不是"测工具的小测试"——抽取器是全套行为测试的**地基**：它配平错一个花括号，
// 抽出来的就不是被测代码，而所有断言仍然全绿（它们在测一小段无关代码）。
// 所以地基必须自己被验证，尤其是评论里点名的两种误配平：
//   ① 正则字面量里的 `{`/`}` 被当成代码括号
//   ② 模板串插值里的括号
//   ③ 未闭合块注释导致下标往回退 → 死循环
//   ④ 锚点不唯一时必须报错而不是取首个
'use strict';

const { section, ok, eq, report } = require('./helpers/harness');
const {
  findBlockEnd, anchorIndex, anchorIndexBefore, sliceDecl, sliceRange, INDEX,
} = require('./helpers/extract');
const fs = require('fs');

const end = (src) => findBlockEnd(src, src.indexOf('{'));
const wrapped = (inner) => 'function f(){' + inner + '}';
const full = (inner) => 'function f(){' + inner + '}';   // 长度 = 应配平到的位置

section('[X-1] 基础配平');
{
  const s = full(' const a = {x:1}; return a; ');
  eq(end(s), s.length, '普通嵌套对象配平到函数体末尾');
  ok(true, '（占位：长度断言已覆盖）');
}

section('[X-2] 正则字面量里的花括号不得被当成代码括号');
{
  // 关键：/ 的前一个字符是 ')' —— 早期版本漏了 ')' 导致这里误判为除号
  const s = full(' if (a) /[{}]/.test(b); if (c) { return {y:2}; } ');
  eq(end(s), s.length, 'if (x) /re/.test(y) 形式不破坏配平');
  const s2 = full(' const r = /\\/{2,}/; if (r) { return 1; } ');
  eq(end(s2), s2.length, '正则体含 { 与量词不破坏配平');
  const s3 = full(' const n = arr[0] / 2; if (n) { return 1; } ');
  eq(end(s3), s3.length, '右方括号后的除号仍被正确当作除号');
}

section('[X-3] 模板串与嵌套插值');
{
  const s = full(' const t = `a${ {x:1}.x }b`; if (t) { return {z:3}; } ');
  eq(end(s), s.length, '模板串插值内的对象字面量不破坏配平');
  const s2 = full(' const t = `a${ `b${ {q:1}.q }c` }d`; if (t) { return 1; } ');
  eq(end(s2), s2.length, '模板串嵌套模板串不破坏配平');
  const s3 = full(' const t = `}`; if (t) { return 1; } ');
  eq(end(s3), s3.length, '模板串里的裸 } 不破坏配平');
}

section('[X-4] 注释');
{
  const s = full(' // } 这行注释里有花括号\n if (a) { return 1; } ');
  eq(end(s), s.length, '行注释里的 } 被忽略');
  const s2 = full(' /* } 块注释里有花括号 */ if (a) { return 1; } ');
  eq(end(s2), s2.length, '块注释里的 } 被忽略');
}

section('[X-5] 未闭合块注释必须抛错而不是死循环');
{
  // 早期版本 indexOf('*/') 返回 -1，-1+2=1 让下标往回退 → 死循环
  let threw = null;
  const t0 = Date.now();
  try { findBlockEnd('{ /* 没闭合 ', 0); } catch (e) { threw = e; }
  const ms = Date.now() - t0;
  ok(!!threw, '未闭合块注释抛出明确错误', threw ? threw.message : '（没有抛错）');
  ok(ms < 1000, '没有死循环（耗时 ' + ms + 'ms）');
}

section('[X-6] 锚点必须唯一，否则报错');
{
  const s = 'const A = 1;\nconst B = 2;\nconst A = 3;\n';
  let threw = null;
  try { anchorIndex(s, 'const A =', 'A'); } catch (e) { threw = e; }
  ok(!!threw && /ambiguous/.test(threw.message), '锚点出现两次 → 报错（不取首个）', threw ? threw.message : '');
  let missing = null;
  try { anchorIndex(s, 'const C =', 'C'); } catch (e) { missing = e; }
  ok(!!missing && /not found/.test(missing.message), '锚点不存在 → 报错');
  // anchorIndexBefore：取 limit 之前最后一次
  const t = 'x\nMARK\ny\nMARK\nz';
  eq(anchorIndexBefore(t, 'MARK', t.length - 1, 'MARK'), t.lastIndexOf('MARK'), '取 limit 之前最后一次命中');
}

section('[X-7] sliceDecl：无花括号体的表达式箭头函数');
{
  // escapeHtml 整条都没有 '{'，早期用配平会一路吞掉后面大量代码
  const real = fs.readFileSync(INDEX, 'utf8');
  const decl = sliceDecl(real, 'const cellText = (cell) =>', 'cellText');
  ok(decl.startsWith('const cellText =') && decl.endsWith(';'), 'cellText 声明被完整截取', decl);
  eq(decl.split('\n').length, 1, '只截一行（未被后续代码吞掉）');
  ok(decl.includes('String(cell)'), '内容正确');
  // 多行的链式表达式（escapeHtml）
  const esc = sliceDecl(real, 'const escapeHtml = (v) =>', 'escapeHtml');
  ok(esc.includes('&#39;'), '多行链式 escapeHtml 截取完整', esc.slice(-40));
  // 注意：不能数 ';' 个数——HTML 实体 &#39; / &amp; 本身就以分号结尾。
  // 判据必须是「语句结束分号」= 分号后紧跟换行。
  eq((esc.match(/;\s*$/g) || []).length, 1, '恰好在语句结束处收尾');
  ok(!/const cellText/.test(esc), '没有把下一条声明也吞进来');
}

section('[X-8] sliceRange：起止锚点都必须唯一存在');
{
  const real = fs.readFileSync(INDEX, 'utf8');
  const seg = sliceRange(real, 'const cloneTableData = (data) => {', '// 从数据模型读回某个单元格的原文', 'cache region');
  ok(seg.includes('const sheetFingerprints = (data) =>'), '区间包含 sheetFingerprints');
  ok(seg.includes('const getTableData = (forceRefresh'), '区间包含 getTableData');
  ok(!seg.includes('const readCellValue'), '区间不含区间之后的 readCellValue');
  // 真实代码里必须恰好有一处该注释（多一处就说明锚点选错了）
  eq((real.match(/\/\/ 从数据模型读回某个单元格的原文/g) || []).length, 1, '结束锚点在源码中唯一');
}

report('extract-self');
