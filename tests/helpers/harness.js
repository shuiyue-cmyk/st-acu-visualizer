// 极简断言/汇总器。没有测试框架依赖——本项目是单文件前端扩展，
// 引入 vitest/jest 只会让「clone 下来就能跑」这个属性失效。
'use strict';

const state = { pass: 0, fail: 0, failures: [] };
let currentSection = '';

function section(title) {
  currentSection = title;
  console.log('\n' + title);
}

function ok(cond, name, detail) {
  if (cond) { state.pass++; console.log('  PASS ' + name); return true; }
  state.fail++;
  console.log('  FAIL ' + name + (detail ? '  →  ' + detail : ''));
  state.failures.push(currentSection + ' :: ' + name);
  return false;
}

/**
 * 打印一条溯源信息（不计入断言）。
 * 用于「存在性断言」——光知道 PASS 没用，必须能看出它匹配到了哪段代码，
 * 否则无法判断是真命中还是被无关文本满足。
 */
function note(text) {
  if (text) console.log('       ↳ ' + String(text).replace(/\s+/g, ' ').slice(0, 150));
}

function eq(actual, expected, name) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  return ok(a === b, name, a === b ? '' : `got ${a}, want ${b}`);
}

/** 断言「某段真实源码执行时不抛 ReferenceError」——本项目的头号历史故障模式。 */
function okRuns(fn, name) {
  try {
    fn();
    return ok(true, name);
  } catch (e) {
    return ok(false, name, e.constructor.name + ': ' + e.message);
  }
}

async function okRejects(promiseFn, name) {
  try { await promiseFn(); return ok(false, name, '预期抛错但没抛'); }
  catch (e) { return ok(true, name); }
}

function report(suiteName) {
  console.log(`\n=== [${suiteName}] ${state.pass} passed, ${state.fail} failed ===`);
  if (state.fail) {
    console.log('失败项:');
    for (const f of state.failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
  return state.fail === 0;
}

module.exports = { section, ok, eq, note, okRuns, okRejects, report, state };
