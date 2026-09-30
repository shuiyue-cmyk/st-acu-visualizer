#!/usr/bin/env node
// 统一 runner。零依赖：这是单文件前端扩展，引入 vitest/jest 只会让
// 「clone 下来就能 node 跑」这个属性失效。
//
// 用法：
//   node tests/run-all.js                       跑除跨仓契约外的全部
//   node tests/run-all.js --db <TT库> --db <ST库>  附带跨仓契约探针
//   node tests/run-all.js --only write-identity  只跑名字匹配的
//   node tests/run-all.js -- <被测index.js>      针对某个（可能被改坏的）index.js 跑
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const argv = process.argv.slice(2);

const dbs = [];
let only = null;
const passthrough = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--db') dbs.push(argv[++i]);
  else if (argv[i] === '--only') only = argv[++i];
  else if (argv[i] === '--') passthrough.push(...argv.slice(i + 1)), i = argv.length;
}

const target = passthrough[0] || path.resolve(HERE, '..', 'index.js');

const all = fs.readdirSync(HERE)
  .filter(f => f.endsWith('.test.js'))
  .sort();

// db-contract 需要外部仓库路径，单列到最后跑（它的失败通常是"库变了"，需要人判断）
const NEEDS_DB = 'db-contract';
const suites = all.filter(f => {
  if (only && !f.includes(only)) return false;
  if (f.startsWith(NEEDS_DB) && dbs.length === 0) {
    console.log('⏭  跳过 ' + f + '（需要 --db <数据库路径>；静默通过等于没测）\n');
    return false;
  }
  return true;
});

console.log('被测文件: ' + target);
console.log('套件: ' + suites.length + ' 个\n' + '='.repeat(72));

let failed = 0, skipped = all.length - suites.length;
const summary = [];
for (const f of suites) {
  const args = [path.join(HERE, f), target];
  if (f.startsWith(NEEDS_DB)) args.push(...dbs);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+) passed, (\d+) failed/);
  const pass = m ? +m[1] : 0;
  const fail = m ? +m[2] : (r.status === 0 ? 0 : 1);
  if (fail > 0 || r.status !== 0) failed++;
  summary.push({ f, pass, fail, ms: Date.now() - t0 });
  // 失败时把细打印出来，通过时只留汇总行，避免刷屏
  if (fail > 0 || r.status !== 0) {
    console.log(out.trimEnd());
    if (r.status !== 0 && !m) console.log('(套件异常退出，status=' + r.status + ')');
    console.log('');
  }
}

const totalPass = summary.reduce((a, b) => a + b.pass, 0);
const totalFail = summary.reduce((a, b) => a + b.fail, 0);
console.log('='.repeat(72));
for (const s of summary) {
  console.log((s.fail ? '✗' : '✓') + ' ' + s.f.replace('.test.js', '').padEnd(24) +
    String(s.pass).padStart(4) + ' passed' + (s.fail ? '  ' + s.fail + ' FAILED' : '') +
    '   ' + s.ms + 'ms');
}
if (skipped) console.log('⏭ 跳过 ' + skipped + ' 个（' + NEEDS_DB + ' 需要 --db）');
console.log('─'.repeat(72));
console.log('合计 ' + totalPass + ' passed, ' + totalFail + ' failed');
process.exit(failed || totalFail ? 1 : 0);
