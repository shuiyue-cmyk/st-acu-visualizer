# 前端测试

零依赖（只用 Node 内置 `fs` / `vm` / `path` / `child_process`）。这是单文件前端扩展，
引入 vitest/jest 只会让「clone 下来就能 `node` 跑」这个属性失效。

```bash
node tests/run-all.js                                     # 全部（除跨仓契约）
node tests/run-all.js --db <TT库> --db <ST库>              # 附带数据库契约探针
node tests/run-all.js --only write-identity               # 只跑名字匹配的
node tests/run-all.js -- <某个 index.js>                  # 针对被改坏的副本跑（注入实验用）
python tests/sabotage-matrix.py                            # 注入矩阵：验证测试本身有没有牙齿
```

## 三条硬规矩

**1. 测真实源码，不测复制品。**
所有行为测试都用 `helpers/extract.js` 从 `index.js` 里**抽取真实代码区间**，
注入依赖后在 `vm` 里以 `'use strict'` 执行。理由是本项目踩过的两次坑：
复制实现的测试证明的是副本（生产改了它照样绿）；只 grep 源码字符串的断言
在任何行为保持的重构下都会红。`vm` 沙箱刻意用 strict —— 历史上两次
「`node --check` 通过、运行时炸」都是 strict 下的 `ReferenceError`
（丢了 `const` 声明 / 悬空标识符），非 strict 会静默建全局变量把问题盖掉。

**2. 每个契约只有一个 owner。**
保存路径拆成 `save-pipeline`（Impl=写不写/写到哪，Wrapper=并发排队），
只读开关只有 `read-only-gates` 拥有。两个套件不重复守同一契约。

**3. 测试名字不许承诺超出输入的东西。**
两个真实踩过的例子：`n ≤ 40 全采样` 其实是 `content.length ≤ 40`
（数据行 + 表头，step=ceil(n/40)）；把 `null` 放在标题位上时表卡片渲染器
整格跳过，断言会「因为什么都没渲染」而假通过。这类名字看起来在守契约，
实际什么都证明不了。

## 套件与所守契约

| 套件 | 守什么 | 关键手法 |
|---|---|---|
| `extract-self` | **抽取器自身**：花括号配平（正则字面量 / 模板串插值 / 注释里的括号）、未闭合块注释不死循环、锚点不唯一必须报错、`sliceDecl` 不吞下一条声明 | 抽取器是全套的地基：配平错一个括号就会抽错代码，而断言仍全绿 |
| `write-identity` | 身份闸门的**锚点/基准分工**（锚点=用户所见取缓存、基准=DB 现状取活引用）；row_id/表头不符→拒；空串表头参与比对；catch 必须 fail-closed；脏数据 fail-closed；活引用不可用时回退 | 活引用与缓存克隆是**两个不同对象**；含一个「锚点也读活引用则闸门恒过」的对照组，证明测试有区分力 |
| `row-edit-two-phase` | 整行编辑先校验后落笔：空表头列、与 DB 提交选项同名的列一律拒提交并说明；提交键用原始表头；身份闸门基准取活引用 | 假 `dialog` 提供 `find('textarea').each`；live/cache 分离 |
| `cell-edit-guard` | 值未变则不写库/不动 DOM；`null≡''`、`0≢''`；读不到旧值时 fail-open 不吞写入；写失败回滚 | Proxy 间谍区分「读属性」与「真正调用」 |
| `cache-freshness` | 活引用隔离；同 key 整表原地替换必须检出；未变时复用缓存；`dataVersion` 语义；采样边界如实钉住 | **不桩** `sheetFingerprints`/`cloneTableDataPartial`，注入计数版 `structuredClone` |
| `data-plumbing` | `processJsonData` 以**表名**为键、跳过表头行、**不改传入对象**（批量删会把 DB 活引用喂进来）；`lightFingerprint` 的轮询变更检测 | 函数直接吃**同一个对象实例**（不 JSON 序列化，否则 mutate 失效、身份断言测不到） |
| `read-only-gates` | 只读时三条写库路径（impl / `insertRow` / 批量 `deleteRow`）一条都碰不到；批量删期间 `bulkOpActive` 挂起通知；查看交互完好；DB 通知仍注册得上 | Proxy 间谍 + 循环内状态观察点；批量删分支按「`deleteRow` 之前最后一次命中」锚定 |
| `render-cells` | DB 的 `null` 不渲染成字面量；`0`/`false` 不被吞；`cellStr` 作用域完整；>50 阈值；表头下标与标题格跳过；`<` `"` `'` `&` 四类转义 | 两处渲染语句**分档**（表卡片 vs 快速查看契约不同）；异常被捕获，不崩套件 |
| `save-pipeline` | 精确写被拒**绝不**降级全量 import；行下标 1-based；缺 `sheet_*` 键拒存；保存串行化且失败不吞后续 | 断言「间谍记录到的调用参数」而非源码字符串 |
| `db-contract` | 跨仓公开 API 契约：13 方法在位、`exportTableAsJson` 返回**活引用**、null 表示、1-based 行下标、`parseMutationOptions_ACU` 从 `rowData` 读选项、DB 侧显式跳过 `isImportMode`、撞名 fail-loud | 直接读数据库源码；**每条断言打印它匹配到的文件与片段**（存在性断言光看 PASS 无意义）；给了路径却不存在 → 硬失败；语料为空 → 硬失败 |

## 注入矩阵（`sabotage-matrix.py`）

**27 处真实缺陷注入，27 处全部被至少一个套件发现。** 这份矩阵是本仓测试有效性的唯一客观证据；
改动测试或生产代码后请重跑，退出码非 0 表示「有注入无人发现」**或**「有注入锚点已失效」。

<details>
<summary>展开（第一批：作者自己的心智模型内）</summary>

```
✓ 采样步长改坏（只采首行+末行）                      → cache-freshness
✓ 第三信号从早退条件摘掉（= V17.6.10 之前）           → cache-freshness
✓ 第三信号基准提前到早退判定之前                      → cache-freshness
✓ 删掉第三信号的状态声明（= 悬空引用）                → cache-freshness
✓ 身份复验改回读缓存克隆（= 静默覆盖回归）            → write-identity
✓ 身份复验改回读缓存克隆（批量删快照）                → read-only-gates
✓ 删掉单元格等值判据（= V17.6.10 之前：无条件写）     → cell-edit-guard
✓ modelReadable 无条件为真（吞合法写入）              → cell-edit-guard
✓ 整行编辑：去掉空表头拒提交（= 两段式之前）          → row-edit-two-phase
✓ 整行编辑：去掉保留名列拒提交                        → row-edit-two-phase
✓ 整行编辑：提交键改用 trim 后的表头                  → row-edit-two-phase
✓ 整行编辑：身份闸门基准改回缓存克隆                  → row-edit-two-phase
✓ 渲染退回 String(cell)（null 渲染成字面量）         → render-cells
✓ 删掉 cellStr 声明（node --check 查不出）            → render-cells
✓ 删掉只读闸门（insertRow 直连路径）                  → read-only-gates
✓ hasPreciseApi 探测失效 → 降级全量 import（整库回退）→ save-pipeline
✓ 保存不再串行化（并发覆盖）                          → save-pipeline
```

</details>

<details>
<summary>展开（第二批：来自独立复核，全部落在上述心智模型<b>之外</b>）</summary>

```
✓ readRowId 也改读活引用（锚点塌缩：改所见却写另一行）   → write-identity
✓ 身份复验去掉活引用回退（老库直接取不到数据）          → write-identity
✓ verifyRowIdentity 的 catch 改成 fail-open            → write-identity
✓ expectedHeader 改成真值判断（空串表头列位移漏拦）     → write-identity
✓ processJsonData 键换成 sheetId（表名索引全取不到）    → data-plumbing
✓ lightFingerprint 恒返回空串（轮询再也发现不了变化）   → data-plumbing
✓ 表头下标错位 headers[cIdx-1] → headers[cIdx]        → render-cells
✓ 不再跳过标题格（标题被重复渲染）                     → render-cells
✓ escapeHtml 去掉单引号转义（可逃逸属性）              → render-cells
✓ 批量删期间不再挂起通知（data_replace 冲突源）        → read-only-gates
```

</details>

第二批的由来值得记住：**第一批 17 条全绿时，套件仍有 10 处真实盲区**，
因为它们全在作者自己的心智模型里，而注入矩阵只会覆盖「已经想到的缺陷」。
所以矩阵的通过率**不能外推**为测试有效性——它只证明「想到的那些确实测到了」。

## 已知的「测不到」的地方（如实记录，不假装覆盖）

- **采样盲区**：`content.length > 40` 时指纹按 `ceil(n/40)` 步长抽样，
  仅未采样中间行的值变化不会被检出。`cache-freshness` 的 C-6 如实钉住这条边界，
  C-6b 单独守「`content.length ≤ 40` 是全采样」。**写安全不依赖这个信号**——
  身份闸门的基准读的是 DB 活引用（见 `write-identity` 的 V-1/V-1b）。
- **`null` 与字面量 `"null"` 在采样指纹里同形**：影响仅限显示陈旧，不影响寻址。
  `data-plumbing` 的 P-8 把这条钉成断言而不是留白。
- **`modelReadable` 的 catch 分支**不可达（`getTableData` 自带 try/catch 不会抛），
  属于双重保险，没有能区分它的用例。
- **脏行导致下游写入抛 TypeError**：渲染路径的 `Array.isArray(row)` 守卫使这类行
  在 UI 上不可达，故未改生产代码，也未写成断言。
- **E-5 查看交互**仍是源码顺序检查（绑定事件的相对位置无法在 vm 里真实触发 jQuery）。
  它守的是「函数级提前 return 不得吞掉只读交互绑定」这个具体回归。
- **`patchSnapshotCell` / `saveSnapshot` / `cloneTableData` 的两条兜底分支**尚未进入任何 vm。
- **DB 隔离运行时**（`isolatedRuntime_ACU`）下 `exportTableAsJson` 恒返回全局视图，
  若该模式在 TT 生产启用，闸门复验的对象与 DB 写库解析下标的对象可能不是同一个。
  未确认该模式是否启用，暂记为待查项。
- **「绝不写活引用」目前只有注释约束**，没有可执行守卫。
  `data-plumbing` 的 P-4 已把「`processJsonData` 不改入参」与「rows 与活引用共享行数组」
  钉成断言，将来有人往 `verifyTables` 上写会先看到它失败——但那需要有人先跑测试。

## 数据库更新后

`db-contract` 是唯一跨仓的套件，必须带库路径重跑；`CHANGELOG.md` 里
「数据库更新必 bump」的检查点就是这一步。
