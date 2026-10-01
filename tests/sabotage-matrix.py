#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""注入矩阵：每个注入都是一处**真实的代码缺陷**，记录各套件是否能发现。

「全绿」本身不能证明测试有效——桩掉的实现、被复制到测试里的副本、
只 grep 源码字符串的断言，都能在生产代码被改坏时依然全绿。
这个脚本是本仓测试有没有牙齿的唯一客观证据：把缺陷注入进去，看谁报警。

用法:  python tests/sabotage-matrix.py [repoRoot] [workdir]
退出码: 有注入无人发现 → 1（CI 应据此失败）
"""
import io, os, subprocess, sys, json
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

REPO = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.path.join(os.environ.get('TEMP', '/tmp'), 'acu-sabotage')
SRC = os.path.join(REPO, 'index.js')
RUNNER = os.path.join(REPO, 'tests', 'run-all.js')

# (标签, needle, replacement, occurrence)
INJECTIONS = [
    ('采样步长改坏（只采首行+末行）',
     'const step = Math.max(1, Math.ceil(n / 40));', 'const step = Math.max(1, n);', 2),
    ('第三信号从早退条件摘掉（= V17.6.10 之前）',
     'raw === lastRawTableRef && !setChanged && !contentChanged',
     'raw === lastRawTableRef && !setChanged', 1),
    ('第三信号基准提前到早退判定之前',
     '            const sheetFp = sheetFingerprints(raw);',
     '            const sheetFp = sheetFingerprints(raw);\n            lastSheetFingerprints = sheetFp;', 1),
    ('删掉第三信号的状态声明（= 我本轮犯过的错）',
     '    let lastSheetFingerprints = null;', '', 1),
    ('身份复验改回读缓存克隆（= 静默覆盖回归）',
     'const data = (live && live[tableKey]) ? live : getTableData(true);',
     'const data = getTableData(true);', 1),
    ('身份复验改回读缓存克隆（批量删快照）',
     'processJsonData(readLiveTableData() || getTableData(true) || {})',
     'processJsonData(getTableData(true) || {})', 1),
    ('删掉单元格等值判据（= V17.6.10 之前：无条件写）',
     'if (modelReadable && cellText(modelOldVal) === cellText(newVal)) return;', '', 1),
    ('modelReadable 无条件为真（读不到也当未变 → 吞写入）',
     'if (Array.isArray(mRow) && colIdx >= 0 && colIdx < mRow.length) {', 'if (true) {', 1),
    ('整行编辑：去掉空表头拒提交（= 两段式之前：静默跳过）',
     '                        if (!header) {', '                        if (false) {', 1),
    ('整行编辑：去掉保留名列拒提交',
     '                        if (RESERVED_OPTION_KEYS.indexOf(header.toLowerCase()) >= 0) {',
     '                        if (false) {', 1),
    ('整行编辑：提交键改用 trim 后的表头',
     'pendingWrites.push({ colIdx, newVal, key: rawHeader });',
     'pendingWrites.push({ colIdx, newVal, key: header });', 1),
    ('整行编辑：身份闸门基准改回缓存克隆',
     'const freshData = readLiveTableData() || getTableData(true);',
     'const freshData = getTableData(true);', 1),
    ('渲染退回 String(cell)（null 渲染成字面量）',
     'const cellStr = cellText(cell);', 'const cellStr = String(cell);', 1),
    ('删掉 cellStr 声明（= 悬空引用，node --check 查不出）',
     'const cellStr = cellText(cell);', '', 1),
    ('删掉只读闸门（insertRow 直连路径）',
     '            if (!isTableEditAllowed()) { notifyEditBlocked(); return; }', '', 1),
    ('hasPreciseApi 探测失效 → 被拒时降级全量 import（整库回退）',
     'const hasPreciseApi = !!(api && (api.updateCell || api.updateRow || api.deleteRow || api.insertRow));',
     'const hasPreciseApi = false;', 1),
    ('保存不再串行化（并发覆盖）',
     '        const queued = saveQueue.then(run, run);',
     '        const queued = run();', 1),
    # ── 第二批：来自独立复核指出的盲区（原先 17 条全落在作者自己的心智模型里）──
    ('readRowId 也改读活引用（锚点塌缩：改所见却写另一行）',
     '            const data = getTableData(false) || cachedTableData;',
     '            const lv = readLiveTableData(); const data = (lv && lv[tableKey]) ? lv : (getTableData(false) || cachedTableData);', 1),
    ('身份复验去掉活引用回退（老库直接取不到数据）',
     'const data = (live && live[tableKey]) ? live : getTableData(true);',
     'const data = live;', 1),
    ('verifyRowIdentity 的 catch 改成 fail-open（异常即放行）',
     "        } catch (_) { return { ok: false, reason: '数据校验失败' }; }",
     '        } catch (_) { return { ok: true }; }', 1),
    ('expectedHeader 改成真值判断（空串表头的列位移漏拦）',
     '            if (expectedHeader != null) {',
     '            if (expectedHeader) {', 1),
    ('processJsonData 键换成 sheetId（表名索引全部取不到）',
     '                tables[sheet.name] = { key: sheetId, headers, rows };',
     '                tables[sheetId] = { key: sheetId, headers, rows };', 1),
    ('lightFingerprint 恒返回空串（轮询再也发现不了变化）',
     'const lightFingerprint = (data) => {',
     'const lightFingerprint = (data) => { if (data) return "";', 1),
    ('表头下标错位：headers[cIdx-1] → headers[cIdx]',
     'const headerName = headers[cIdx - 1] || `属性${cIdx}`;',
     'const headerName = headers[cIdx] || `属性${cIdx}`;', 1),
    ('不再跳过标题格（标题被重复渲染）',
     'if (cIdx > 0 && cIdx !== titleColIndex) {',
     'if (cIdx > 0) {', 1),
    ('escapeHtml 去掉单引号转义（可逃逸属性）',
     ".replace(/'/g, '&#39;');",
     ".replace(/x/g, 'y');", 1),
    ('批量删期间不再挂起通知（data_replace 冲突源）',
     '                    bulkOpActive = true;',
     '                    bulkOpActive = false;', 1),
    # ── 第三批：V17.7.2（ST 1.0.0）引入的回归 ──
    ('manualUpdate 退回无参调用（跳过高风险确认框）',
     'await api.manualUpdate({ confirm: true });',
     'await api.manualUpdate();', 1),
    # ── 第五批：TT 宿主耦合（选择器边界 / bounded 检测）──
    ('消息选择器退回后代语义（与宿主 directMessages 边界不一致）',
     "$('#chat > .mes')", "$('#chat .mes')", 1),
    ('归位逻辑退回 $chat.find 语义（后代选择器）',
     "$chat.children('.mes')", "$chat.find('.mes')", 1),
    ('删掉 detectTTBounded 的 localStorage 老宿主兜底（老宿主会直挂 #chat 而 fault）',
     "            if (typeof localStorage !== 'undefined' && localStorage.getItem('chat_virtualization_enabled') === 'true') return true;",
     '', 1),
    ('detectTTBounded 的 catch 不再 fail-safe 到 bounded（未初始化时误走直挂 #chat）',
     '                return true;', '                return false;', 1),
    ('前端自造 class 混入宿主选择器类名 mes_text',
     'class="acu-cell acu-grid-item"', 'class="acu-cell mes_text acu-grid-item"', 1),
]


def run_suites(repo, target):
    r = subprocess.run(['node', os.path.join(repo, 'tests', 'run-all.js'), '--', target],
                       capture_output=True, cwd=repo, encoding='utf-8', errors='replace')
    return r.returncode, (r.stdout or '') + (r.stderr or '')


def parse(out):
    per = {}
    for line in out.splitlines():
        if line.startswith(('✓', '✗')):
            name = line[1:].strip().split()[0]
            per[name] = 'FAIL' if line.startswith('✗') else 'ok'
    return per


def main():
    if not os.path.isdir(WORK):
        os.makedirs(WORK, exist_ok=True)
    base_code, base_out = run_suites(REPO, SRC)
    baseline = parse(base_out)
    total_base = base_out.count(' passed,')
    print('基线: %s' % ('OK' if base_code == 0 else 'FAIL'))
    print('套件: ' + ', '.join('%s=%s' % (k, v) for k, v in baseline.items()))
    print()

    rows = []
    for i, (label, needle, repl, occ) in enumerate(INJECTIONS):
        dst = os.path.join(WORK, 'sab%02d.js' % i)
        s = io.open(SRC, encoding='utf-8').read()
        count = s.count(needle)
        if count < occ:
            # 锚点未命中 = 矩阵自身已失效（生产代码演进了，注入打不进去）。
            # 这种情况**必须算失败**：否则矩阵会随着代码演进而静默退化，
            # 而它声称要防的恰恰就是这种退化。
            rows.append((label, ['<锚点未命中：出现 %d 次，需要第 %d 次>' % (count, occ)], count, 'stale'))
            continue
        idx = -1
        for _ in range(occ):
            idx = s.index(needle, idx + 1)
        io.open(dst, 'w', encoding='utf-8', newline='').write(s[:idx] + repl + s[idx + len(needle):])
        code, out = run_suites(REPO, dst)
        res = parse(out)
        caught = [k for k, v in res.items() if v == 'FAIL']
        rows.append((label, caught or ['<无人发现>'], count, 'ok' if caught else 'missed'))
        os.remove(dst)

    print('=' * 78)
    missed = 0
    stale = 0
    for label, caught, count, kind in rows:
        if kind == 'missed':
            mark = '✗'
            missed += 1
        elif kind == 'stale':
            mark = '!'
            stale += 1
        else:
            mark = '✓'
        print('%s %-46s → %s' % (mark, label[:46], ', '.join(caught) if caught else ''))
    print('=' * 78)
    print('注入 %d 处：无人发现 %d，锚点失效 %d' % (len(rows), missed, stale))
    if stale:
        print('⚠ 有注入的锚点已不存在——矩阵与生产代码脱节，请更新 INJECTIONS。')
    return 1 if (missed or stale) else 0


sys.exit(main())
