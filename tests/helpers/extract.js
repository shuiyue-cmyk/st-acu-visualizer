// 源码区间抽取器：所有行为测试共用一份，避免每个测试各写一套（provider-local replay）。
//
// 为什么必须抽真实源码而不是复制实现：
//   复制实现的测试证明的是「副本的行为」，生产代码改了它照样绿（本项目已踩过）。
//   抽真实源码 + 注入依赖，才能让「改坏生产代码 → 测试变红」这条链路成立。
//
// 依赖：仅 Node 内置 fs / vm / path。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX = path.join(ROOT, 'index.js');

/** 读取被测前端源码（整仓只有这一个文件）。 */
function readSource(file) {
  return fs.readFileSync(file || INDEX, 'utf8');
}

/**
 * 从 src[from] 起的第一个 '{' 开始做花括号配平，返回该 '{' 的位置。
 * 正确跳过：行注释、块注释、单/双引号字符串、模板串（含 ${} 嵌套）、正则字面量。
 *
 * 正则字面量的判据是「前一个非空白字符属于可开始正则的位置」——
 * 这是 JS 词法的标准启发式；本项目被测区间内无除法歧义，但保留该处理以防将来。
 */
function findBlockEnd(src, from) {
  let i = src.indexOf('{', from);
  if (i < 0) throw new Error('findBlockEnd: no "{" at/after ' + from);
  let depth = 0;
  const stack = [];
  let prevSignificant = '';
  let prevWord = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { const nl = src.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    if (c === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      // 未闭合时 indexOf 返回 -1，-1+2=1 会让 i 往回退 → 死循环。必须显式失败。
      if (close < 0) throw new Error('findBlockEnd: unterminated block comment at ' + i);
      i = close + 2;
      continue;
    }
    if (c === "'" || c === '"') { i = skipQuoted(src, i, c); prevSignificant = c; prevWord = ''; continue; }
    if (c === '`') { i = skipTemplate(src, i); prevSignificant = '`'; prevWord = ''; continue; }
    if (c === '/' && isRegexStart(prevSignificant, prevWord)) { i = skipRegex(src, i); prevSignificant = '/'; prevWord = ''; continue; }
    if (c === '{') { stack.push('brace'); depth++; i++; prevSignificant = '{'; continue; }
    if (c === '}') {
      const top = stack.pop();
      if (top === 'template') { i++; prevSignificant = '}'; continue; } // 插值结束，回模板串
      depth--;
      i++;
      if (depth === 0) return i;
      prevSignificant = '}';
      continue;
    }
    if (!/\s/.test(c)) {
      prevSignificant = c;
      if (/[A-Za-z0-9_$]/.test(c)) prevWord += c;
      else if (c === ')' || c === ']') prevWord = '';   // 括号本身不是关键字
      else prevWord = '';
    }
    i++;
  }
  throw new Error('findBlockEnd: unbalanced braces from ' + from);
}

function skipQuoted(src, i, quote) {
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i++;
  }
  throw new Error('skipQuoted: unterminated ' + quote);
}

/** 跳过模板串；返回结束引号之后的位置。 */
function skipTemplate(src, i) {
  i++; // 开引号
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '`') return i + 1;
    if (src[i] === '$' && src[i + 1] === '{') {
      i = findBlockEnd(src, i + 1);
      continue;
    }
    i++;
  }
  throw new Error('skipTemplate: unterminated');
}

function skipRegex(src, i) {
  i++;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { i++; while (i < src.length && /[a-z]/.test(src[i])) i++; return i; }
    else if (c === '\n') throw new Error('skipRegex: unterminated');
    i++;
  }
  throw new Error('skipRegex: unterminated');
}

/**
 * 判断一个 `/` 是正则字面量还是除号。
 *
 * 纯字符启发式在这里必然出错，因为 JS 词法依赖解析器上下文：
 *   `if (a) /re/.test(b)`  → 正则（前面是 `)`）
 *   `arr[0] / 2`           → 除号（前面也是 `]`）
 * 所以分两档：
 *   ① 前一个非空白字符是「只可能引出表达式」的符号 → 一定是正则。
 *      漏掉 `)`/`]` 会把正则体里的 `}` 当闭括号 → 配平提前返回 → **静默抽错代码**，
 *      这比误报危险得多。
 *   ② 前一个是 `)`/`]` → 回溯上一个标识符；只有它是控制流关键字
 *      （if/while/for/switch/return…）时才当作正则，否则是除号。
 */
const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%^~<>';
const REGEX_AFTER_KEYWORD = new Set([
  'if', 'while', 'for', 'switch', 'catch', 'return', 'typeof', 'instanceof',
  'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'new', 'delete', 'void', 'throw',
]);
function isRegexStart(prevChar, prevWord) {
  if (prevChar === '') return true;
  if (REGEX_PRECEDERS.includes(prevChar)) return true;
  if (prevChar === ')' || prevChar === ']') return REGEX_AFTER_KEYWORD.has(prevWord);
  return false;
}

/** 断言锚点唯一命中——锚点不唯一时必须修测试，不能取首个。 */
function anchorIndex(src, needle, label) {
  const first = src.indexOf(needle);
  if (first < 0) throw new Error('anchor not found: ' + (label || needle));
  if (src.indexOf(needle, first + 1) >= 0) throw new Error('anchor is ambiguous (hit >1): ' + (label || needle));
  return first;
}

/**
 * 取 limitIdx 之前**最后一次**命中 needle 的位置。
 * 用于同名字符串在文件里多处出现、但只有一处在被测上下文之内的情况
 * （如 `if (pendingDeletes.size > 0)` 有 3 处，只有 deleteRow 之前那处是批量删分支）。
 */
function anchorIndexBefore(src, needle, limitIdx, label) {
  let at = -1, i = -1;
  while ((i = src.indexOf(needle, i + 1)) >= 0 && i < limitIdx) at = i;
  if (at < 0) throw new Error('anchor not found before limit: ' + (label || needle));
  return at;
}

/** 抽取一条完整的语句（从 fromIdx 到语句末尾的 ';'），适用于 forEach 回调等块级语句。 */
function sliceStatement(src, fromIdx) {
  const end = findBlockEnd(src, fromIdx);
  let i = end;
  while (i < src.length && src[i] !== ';' && src[i] !== '\n') i++;
  return src.slice(fromIdx, i + 1);
}

/**
 * 抽取形如 `const NAME = <fnExpr>;` 的完整声明（含分号），按花括号配平定位函数体。
 * 用于 vm 里以 `(<fnExpr>)` 形式求值。
 */
function sliceConstFn(src, needle, label) {
  const start = anchorIndex(src, needle, label);
  const end = findBlockEnd(src, start);
  let i = end;
  while (i < src.length && src[i] !== ';' && src[i] !== '\n') i++;
  return src.slice(start, i + 1);
}

/**
 * 抽取一条**没有花括号体**的声明（表达式箭头函数、单行 const），截到行尾分号为止。
 * 不能用 findBlockEnd：像 `const escapeHtml = (v) => String(...).replace(...)` 这种
 * 整条都没有 `{`，配平会一路向后吞掉大量无关代码。
 */
function sliceDecl(src, needle, label) {
  const start = anchorIndex(src, needle, label);
  const end = findStatementEnd(src, start);
  return src.slice(start, end);
}

/**
 * 从 from 起找到「语句结束分号」的位置（返回分号之后的下标）。
 * 判据是该 `;` 之后（跳过空白）紧跟换行或文件尾——这才是语句边界；
 * 沿途必须跳过字符串/模板/正则，否则 `replace(/'/g, ...)` 里的引号会被当成字符串开头。
 */
function findStatementEnd(src, from) {
  let i = from;
  let prevSignificant = '';
  let prevWord = '';
  while (i < src.length) {
    const c = src[i], next = src[i + 1];
    if (c === '/' && next === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) throw new Error('findStatementEnd: unterminated block comment at ' + i);
      i = close + 2;
      continue;
    }
    if (c === "'" || c === '"') { i = skipQuoted(src, i, c); prevSignificant = c; prevWord = ''; continue; }
    if (c === '`') { i = skipTemplate(src, i); prevSignificant = '`'; prevWord = ''; continue; }
    if (c === '/' && isRegexStart(prevSignificant, prevWord)) { i = skipRegex(src, i); prevSignificant = '/'; prevWord = ''; continue; }
    if (c === ';') {
      let j = i + 1;
      while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
      if (j >= src.length || src[j] === '\n' || src[j] === '\r') return i + 1;
    }
    if (!/\s/.test(c)) {
      prevSignificant = c;
      prevWord = /[A-Za-z0-9_$]/.test(c) ? prevWord + c : '';
    }
    i++;
  }
  throw new Error('findStatementEnd: no statement end found');
}

/** 抽取从 needle 起、到 endNeedle（不含）为止的连续源码区间。 */
function sliceRange(src, needle, endNeedle, label) {
  const start = anchorIndex(src, needle, label);
  const end = src.indexOf(endNeedle, start + needle.length);
  if (end < 0) throw new Error('end anchor not found: ' + endNeedle);
  return src.slice(start, end);
}

/**
 * 在 strict 模式的 vm 沙箱里执行一段真实源码。
 * 刻意用 'use strict'：本项目历史上两次「语法检查通过、运行时炸」都是 strict 下的
 * ReferenceError（丢了 const 声明 / 悬空标识符），非 strict 会静默创建全局变量而掩盖问题。
 * context 中未提供的标识符会真的抛 ReferenceError，而不是变成隐式全局。
 */
function runStrict(code, context) {
  const sandbox = Object.assign(Object.create(null), context);
  return vm.runInNewContext('"use strict";\n' + code, sandbox, { filename: 'extracted.js' });
}

/**
 * 构造一个 strict 作用域：把多段真实源码 + 尾部 return 拼成一个可求值表达式。
 * 依赖注入与被测代码同处一个 strict 作用域，因此漏注入会立刻 ReferenceError。
 */
function buildScope(parts, returnExpr) {
  return '(function () {\n\'use strict\';\n' + parts.join('\n') + '\nreturn ' + returnExpr + ';\n})()';
}

module.exports = {
  ROOT, INDEX, readSource, findBlockEnd, anchorIndex, anchorIndexBefore,
  sliceStatement, sliceConstFn, sliceDecl, sliceRange, runStrict, buildScope,
};
