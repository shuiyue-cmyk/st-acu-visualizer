(function () {
    'use strict';
    
    const SCRIPT_ID = 'acu_visualizer_ui_v20_pagination';
    const STORAGE_KEY_TABLE_ORDER = 'acu_table_order';
    const STORAGE_KEY_ACTION_ORDER = 'acu_action_order';
    const STORAGE_KEY_ACTIVE_TAB = 'acu_active_tab';
    const STORAGE_KEY_UI_CONFIG = 'acu_ui_config_v18';
    const STORAGE_KEY_LAST_SNAPSHOT = 'acu_data_snapshot_v18_5'; 
    const STORAGE_KEY_UI_COLLAPSE = 'acu_ui_collapse_state';
    const STORAGE_KEY_TABLE_HEIGHTS = 'acu_table_heights';
    const STORAGE_KEY_REVERSE_TABLES = 'acu_reverse_tables';
    const STORAGE_KEY_HIDDEN_TABLES = 'acu_hidden_tables';
    const STORAGE_KEY_TABLE_STYLES = 'acu_table_styles';
    
    const TAB_DASHBOARD = 'acu_tab_dashboard_home';
    const STORAGE_KEY_DASH_CONFIG = 'acu_dash_config_v1';
    let isDashEditing = false;


    let isInitialized = false;
    let isSaving = false;
    let isEditingOrder = false;
    let currentDiffMap = new Set();
    let observer = null;
    let columnResizeObserver = null;
    let isCollapsed = (() => { try { return localStorage.getItem(STORAGE_KEY_UI_COLLAPSE) === 'true'; } catch (e) { return false; } })();
    let globalScrollTop = 0;
    let currentPage = 1;
    let currentSearchTerm = '';
    let selectedRows = new Map();
    let cachedTableData = null;
    let isMultiSelectMode = false;
    let pendingDeletes = new Set();

    // 追平完成检测轮询的模块级单例状态：防止连点多个 setInterval 并存、双 finishCatchup。
    let catchupTimer = null;
    let catchupStable = 0;
    let catchupLastFp = null;
    let catchupStartTs = 0;
    let catchupFallbackTimer = null;
    // 模块级：停止追平轮询（含兜底 timer）。供 click 闭包与 CHAT_CHANGED 共用，
    // 切聊天时必须停掉旧追平轮询，避免对新聊天误弹 toast / 误刷新（跨聊天污染）。
    const stopCatchupPoll = () => {
        if (catchupTimer) { clearInterval(catchupTimer); catchupTimer = null; }
        if (catchupFallbackTimer) { clearTimeout(catchupFallbackTimer); catchupFallbackTimer = null; }
        catchupLastFp = null;
    };

    let hideOptionsUntilUpdate = false;
    let lastOptionDataCheck = '';

    const UpdateController = {
        runSilently: async (action) => {
            let result = false;
            try {
                result = await action();
            } catch (e) {
                console.error(e);
                result = false;
            }
            return result;
        },
        handleUpdate: (incomingData) => {
            // 不再让 _suppressNext 吞掉 DB 的填表完成通知：前一次保存的 2 秒抑制窗口
            // 会挡住 DB 在填表结束时发的 _notifyTableUpdate，导致表格更新了前端没刷新。
            // 填表流程的更新通知应始终放行。
            if (isEditingOrder) return;
            // 通知到达 = DB 数据已更新：失效全部缓存，走 renderInterface(true) 让 getTableData(true)
            // 从 DB 统一 clone + 重算 diffMap（若走 renderInterface(false)，getTableData(false) 缓存
            // 命中会重置 lastTableDataRefreshed，diffMap 高亮陈旧——交叉验证确认的缺陷）。
            // 不手动 clone incomingData：通知时 DB 已换新引用，重拉即最新，避免双 clone。
            lastRawTableRef = null;
            lastTableSetFingerprint = '';
            lastTableDataRefreshed = true;
            cachedTableData = null;
            renderInterface(true);
        }
    };

    const DEFAULT_CONFIG = {
        theme: 'aurora',
        fontFamily: 'default',
        cardWidth: 280,
        fontSize: 13,
        optionFontSize: 13,
        dashboardFontSize: 13,
        itemsPerPage: 20, 
        highlightNew: false,
        highlightColor: 'orange',
        layout: 'vertical',
        limitLongText: false,
        showDashboard: true,
        customTitleColor: false,
        titleColor: 'orange',
        gridColumns: (window.innerWidth <= 768 ? 4 : 0),
        showOptionPanel: false,
        clickOptionToAutoSend: false,
        collapseStyle: 'bar',
        collapsePosition: 'center',
        frontendPosition: 'bottom',
        dashboardPosition: 'embedded',
        dbTheme: 'default',
        dbTransparentMap: {},
        dbAppleGlass: false
    };

    const THEMES = [
        { id: 'retro', name: '复古羊皮' },
        { id: 'dark', name: '极夜深空' },
        { id: 'modern', name: '现代清爽' },
        { id: 'forest', name: '森之物语' },
        { id: 'ocean', name: '深海幽蓝' },
        { id: 'cyber', name: '赛博霓虹' },
        { id: 'sakura', name: '浅粉落樱' },
        { id: 'aurora', name: '极光幻境' },
        { id: 'sunset', name: '日落沙滩' },
        { id: 'starship', name: '星际迷航' },
        { id: 'sky', name: '天空之境' },
        { id: 'apple', name: '苹果设计' },
        { id: 'claude', name: '克劳德风' },
        { id: 'blushglass', name: '粉白磨砂' }
    ];

    // 毛玻璃类主题：overlay 需要拿到主题类才能套上「轻压暗 + 模糊」那组规则
    // （普通主题的 overlay 用纯色压暗，不需要）。新增磨砂主题时加进这个表即可。
    const GLASS_THEMES = ['apple', 'blushglass'];
    const overlayThemeClass = (theme) =>
        GLASS_THEMES.includes(theme) ? ` acu-theme-${theme}` : '';

        const FONTS = [
        { id: 'default', name: '系统默认', val: `'Segoe UI', 'Microsoft YaHei', sans-serif` },
        { id: 'noto-sans', name: '思源黑体', val: `'Noto Sans SC', sans-serif` },
        { id: 'noto-serif', name: '思源宋体', val: `'Noto Serif SC', serif` },
        { id: 'mashanzheng', name: '古风书法', val: `'Ma Shan Zheng', cursive` },
        { id: 'zcool', name: '快乐圆体', val: `'ZCOOL KuaiLe', cursive` },
        { id: 'longcang', name: '行书手写', val: `'Long Cang', cursive` },
        { id: 'mono', name: '代码等宽', val: `'Consolas', 'Monaco', monospace` },
        { id: 'kaiti', name: '清雅楷体', val: `'KaiTi', 'STKaiti', '楷体', serif` },
    ];

    const HIGHLIGHT_COLORS = {
        orange: { main: '#d35400', bg: 'rgba(211, 84, 0, 0.1)', name: '活力橙' },
        red:    { main: '#e91e63', bg: 'rgba(233, 30, 99, 0.1)', name: '绯红' },
        blue:   { main: '#2196f3', bg: 'rgba(33, 150, 243, 0.1)', name: '海蓝' },
        green:  { main: '#27ae60', bg: 'rgba(39, 174, 96, 0.1)', name: '翠绿' },
        purple: { main: '#9b59b6', bg: 'rgba(155, 89, 182, 0.1)', name: '梦幻紫' },
        cyan:   { main: '#00bcd4', bg: 'rgba(0, 188, 212, 0.1)', name: '青空蓝' },
        teal:   { main: '#1abc9c', bg: 'rgba(26, 188, 156, 0.1)', name: '青绿' }
    };

    const THEME_VARS = {
        retro: { bgNav: '#e6e2d3', bgPanel: '#e6e2d3', border: '#bfb29e', textMain: '#5e4b35', textSub: '#888', btnBg: '#d6ccbc', btnHover: '#cbbba8', btnActiveBg: '#8d7b6f', btnActiveText: '#fdfaf5', tableHead: '#efebe4', tableHover: '#f0ebe0', shadow: 'rgba(0,0,0,0.1)', menuBg: '#fff', menuText: '#333', cardBg: '#fffef9', badgeBg: '#efebe4', inputBg: 'rgba(255,255,255,0.5)', overlayBg: 'rgba(94, 75, 53, 0.4)' },
        dark: { uiColor: '#6a5acd', bgNav: 'rgba(30, 30, 30, 0.95)', bgPanel: 'rgba(25, 25, 25, 0.95)', border: '#555', textMain: '#f5f5f5', textSub: '#bbb', btnBg: '#3a3a3a', btnHover: '#4a4a4a', btnActiveBg: '#6a5acd', btnActiveText: '#fff', tableHead: 'rgba(40, 40, 40, 0.9)', tableHover: 'rgba(58, 58, 58, 0.5)', shadow: 'rgba(0,0,0,0.6)', cardBg: 'rgba(35, 35, 35, 0.9)', badgeBg: '#3a3f4b', menuBg: '#333', menuText: '#f5f5f5', inputBg: 'rgba(0,0,0,0.3)', overlayBg: 'rgba(0,0,0,0.75)' },
        modern: { bgNav: '#ffffff', bgPanel: '#f8f9fa', border: '#dee2e6', textMain: '#333', textSub: '#6c757d', btnBg: '#e9ecef', btnHover: '#dee2e6', btnActiveBg: '#0d6efd', btnActiveText: '#fff', tableHead: '#f8f9fa', tableHover: '#e9ecef', shadow: 'rgba(0,0,0,0.08)', cardBg: '#ffffff', badgeBg: '#f1f3f5', menuBg: '#fff', menuText: '#333', inputBg: '#ffffff', overlayBg: 'rgba(0,0,0,0.3)' },
        forest: { bgNav: '#e8f5e9', bgPanel: '#e8f5e9', border: '#a5d6a7', textMain: '#333333', textSub: '#555555', uiColor: '#1b5e20', btnBg: '#c8e6c9', btnHover: '#a5d6a7', btnActiveBg: '#2e7d32', btnActiveText: '#fff', tableHead: '#dcedc8', tableHover: '#f1f8e9', shadow: 'rgba(0,0,0,0.1)', cardBg: '#ffffff', badgeBg: '#dcedc8', menuBg: '#fff', menuText: '#2e7d32', inputBg: 'rgba(255,255,255,0.7)', overlayBg: 'rgba(27, 94, 32, 0.2)' },
        ocean: { bgNav: '#f0f9ff', bgPanel: '#f0f9ff', border: '#bae6fd', textMain: '#333333', textSub: '#555555', uiColor: '#0369a1', btnBg: '#e0f2fe', btnHover: '#bae6fd', btnActiveBg: '#0ea5e9', btnActiveText: '#fff', tableHead: '#e0f2fe', tableHover: '#f0f9ff', shadow: 'rgba(3, 105, 161, 0.15)', cardBg: '#ffffff', badgeBg: '#e0f2fe', menuBg: '#fff', menuText: '#0369a1', inputBg: 'rgba(255,255,255,0.75)', overlayBg: 'rgba(3, 105, 161, 0.2)' },
        cyber: { bgNav: '#050505', bgPanel: '#0a0a0a', border: '#444', textMain: '#00ffcc', textSub: '#ff00ff', btnBg: '#1f1f1f', btnHover: '#333', btnActiveBg: '#ff00ff', btnActiveText: '#fff', tableHead: '#111', tableHover: '#1a1a1a', shadow: '0 0 10px rgba(0,255,204,0.3)', cardBg: '#050505', badgeBg: '#222', menuBg: '#111', menuText: '#00ffcc', inputBg: '#111', overlayBg: 'rgba(0,0,0,0.85)' },
        sakura: { bgNav: '#fff9fb', bgPanel: '#fff9fb', border: '#f0d4df', textMain: '#333333', textSub: '#555555', uiColor: '#a85876', btnBg: '#fff0f5', btnHover: '#f8deea', btnActiveBg: '#e090ad', btnActiveText: '#fff', tableHead: '#fff0f5', tableHover: '#fff5fa', shadow: 'rgba(168, 88, 118, 0.1)', cardBg: '#ffffff', badgeBg: '#fff0f5', menuBg: '#fff', menuText: '#a85876', inputBg: 'rgba(255,255,255,0.8)', overlayBg: 'rgba(168, 88, 118, 0.15)' },
        aurora: { uiColor: '#38bdf8', bgNav: 'linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.9))', bgPanel: 'linear-gradient(180deg, rgba(15, 23, 42, 0.95) 0%, rgba(51, 65, 85, 0.9) 100%)', border: 'rgba(56, 189, 248, 0.6)', textMain: '#ffffff', textSub: '#cccccc', btnBg: 'linear-gradient(135deg, rgba(56, 189, 248, 0.15), rgba(168, 85, 247, 0.15))', btnHover: 'linear-gradient(135deg, rgba(56, 189, 248, 0.25), rgba(168, 85, 247, 0.25))', btnActiveBg: 'linear-gradient(135deg, #38bdf8, #a855f7)', btnActiveText: '#fff', tableHead: 'linear-gradient(90deg, rgba(56, 189, 248, 0.1), rgba(168, 85, 247, 0.1))', tableHover: 'rgba(56, 189, 248, 0.08)', shadow: '0 8px 32px rgba(56, 189, 248, 0.15), 0 4px 16px rgba(168, 85, 247, 0.1)', cardBg: 'linear-gradient(145deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.98))', badgeBg: 'rgba(56, 189, 248, 0.2)', menuBg: '#1e293b', menuText: '#e2e8f0', inputBg: 'rgba(15, 23, 42, 0.5)', overlayBg: 'rgba(15, 23, 42, 0.8)' },
        sunset: { bgNav: 'linear-gradient(135deg, #fffaf0 0%, #fff9e6 50%, #fff5fa 100%)', bgPanel: 'linear-gradient(180deg, #fffcf5 0%, #fffafa 100%)', border: 'rgba(251, 146, 60, 0.85)', textMain: '#8a4a3b', textSub: '#d97757', btnBg: 'linear-gradient(135deg, rgba(251, 146, 60, 0.1), rgba(244, 114, 182, 0.1))', btnHover: 'linear-gradient(135deg, rgba(251, 146, 60, 0.2), rgba(244, 114, 182, 0.2))', btnActiveBg: 'linear-gradient(135deg, #ffab73, #f48fb1)', btnActiveText: '#fff', tableHead: 'linear-gradient(90deg, rgba(251, 191, 36, 0.1), rgba(251, 113, 133, 0.1))', tableHover: 'rgba(251, 146, 60, 0.05)', shadow: '0 8px 32px rgba(251, 146, 60, 0.15), 0 4px 16px rgba(244, 114, 182, 0.1)', cardBg: 'linear-gradient(145deg, #fffcf7, #fffafa)', badgeBg: '#fffaf5', menuBg: '#fff', menuText: '#8a4a3b', inputBg: 'rgba(255,255,255,0.7)', overlayBg: 'rgba(124, 45, 18, 0.1)' },
        starship: { uiColor: '#6366f1', bgNav: 'radial-gradient(ellipse at top, rgba(30, 27, 75, 0.98), rgba(15, 23, 42, 0.95)), linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e1b4b 100%)', bgPanel: 'linear-gradient(180deg, rgba(30, 27, 75, 0.98) 0%, rgba(49, 46, 129, 0.95) 100%)', border: 'rgba(199, 210, 254, 0.6)', textMain: '#ffffff', textSub: '#cccccc', btnBg: 'linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(236, 72, 153, 0.15), rgba(34, 211, 238, 0.1))', btnHover: 'linear-gradient(135deg, rgba(99, 102, 241, 0.3), rgba(236, 72, 153, 0.25), rgba(34, 211, 238, 0.2))', btnActiveBg: 'linear-gradient(135deg, #6366f1, #ec4899, #22d3ee)', btnActiveText: '#fff', tableHead: 'linear-gradient(90deg, rgba(99, 102, 241, 0.15), rgba(236, 72, 153, 0.1))', tableHover: 'rgba(99, 102, 241, 0.1)', shadow: '0 8px 40px rgba(99, 102, 241, 0.2), 0 4px 20px rgba(236, 72, 153, 0.1)', cardBg: 'linear-gradient(145deg, rgba(30, 27, 75, 0.95), rgba(49, 46, 129, 0.9))', badgeBg: 'rgba(99, 102, 241, 0.2)', menuBg: '#1e1b4b', menuText: '#e0e7ff', inputBg: 'rgba(0,0,0,0.4)', overlayBg: 'rgba(0,0,0,0.85)' },
        sky: { bgNav: 'linear-gradient(135deg, rgba(224, 242, 254, 0.95), rgba(238, 242, 255, 0.95))', bgPanel: 'linear-gradient(180deg, rgba(240, 249, 255, 0.95) 0%, rgba(230, 240, 255, 0.9) 100%)', border: 'rgba(56, 189, 248, 0.6)', textMain: '#000000', textSub: '#555555', uiColor: '#3b82f6', btnBg: 'linear-gradient(135deg, rgba(56, 189, 248, 0.15), rgba(129, 140, 248, 0.15))', btnHover: 'linear-gradient(135deg, rgba(56, 189, 248, 0.25), rgba(129, 140, 248, 0.25))', btnActiveBg: 'linear-gradient(135deg, #38bdf8, #818cf8)', btnActiveText: '#fff', tableHead: 'linear-gradient(90deg, rgba(56, 189, 248, 0.1), rgba(129, 140, 248, 0.1))', tableHover: 'rgba(56, 189, 248, 0.08)', shadow: '0 8px 32px rgba(56, 189, 248, 0.15), 0 4px 16px rgba(129, 140, 248, 0.1)', cardBg: 'linear-gradient(145deg, rgba(255, 255, 255, 0.9), rgba(240, 249, 255, 0.95))', badgeBg: 'rgba(56, 189, 248, 0.2)', menuBg: '#f0f9ff', menuText: '#0f172a', inputBg: 'rgba(255, 255, 255, 0.6)', overlayBg: 'rgba(15, 23, 42, 0.15)' },
        // 苹果设计主题：参照 Apple 毛玻璃材料规范（WWDC Designing Fluid Interfaces / Materials）——
        // 半透明毛玻璃背景 + 亮顶边（光打材料上）+ 深色系统文字；配合 .acu-nav-container 已内置的
        // backdrop-filter: blur(5px) 呈现 iOS 式 translucent material。accent 用苹果蓝 #007aff。
        apple: { bgNav: 'rgba(246, 246, 246, 0.62)', bgPanel: 'rgba(248, 248, 250, 0.7)', border: 'rgba(255, 255, 255, 0.5)', textMain: '#1d1d1f', textSub: '#6e6e73', uiColor: '#007aff', btnBg: 'rgba(255, 255, 255, 0.55)', btnHover: 'rgba(255, 255, 255, 0.85)', btnActiveBg: '#007aff', btnActiveText: '#ffffff', tableHead: 'rgba(255, 255, 255, 0.5)', tableHover: 'rgba(0, 122, 255, 0.08)', shadow: '0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06)', cardBg: 'rgba(255, 255, 255, 0.6)', badgeBg: 'rgba(0, 122, 255, 0.12)', menuBg: 'rgba(255, 255, 255, 0.85)', menuText: '#1d1d1f', inputBg: 'rgba(255, 255, 255, 0.65)', overlayBg: 'rgba(0, 0, 0, 0.35)' },
        // 克劳德风（Anthropic 设计系统）：色值取自官方 design token（bg-base #ECE9E0 /
        // bg-raised #F5F3EC / bg-overlay #FDFCF8 / text #141413 / secondary #6B6860 /
        // border-default #D8D5CC / border-subtle #E8E6DC / accent-orange #D97757 /
        // accent-warm #C96442）。特征是暖米色纸感底 + 克制的橙作强调，不用霓虹不用渐变；
        // 卡片按官方「工具优先」规范以边框代阴影，所以 shadow 压得极淡。
        claude: { bgNav: '#ECE9E0', bgPanel: '#F5F3EC', border: '#D8D5CC', textMain: '#141413', textSub: '#6B6860', uiColor: '#C96442', btnBg: '#FDFCF8', btnHover: '#E8E6DC', btnActiveBg: '#D97757', btnActiveText: '#FAF9F5', tableHead: '#ECE9E0', tableHover: '#F5F3EC', shadow: 'rgba(20, 20, 19, 0.06)', cardBg: '#FDFCF8', badgeBg: 'rgba(217, 119, 87, 0.12)', menuBg: '#FDFCF8', menuText: '#141413', inputBg: '#FDFCF8', overlayBg: 'rgba(20, 20, 19, 0.45)' },
        // 粉白磨砂：沿用苹果主题那套毛玻璃材料机制（半透明底 + backdrop blur + 亮顶边），
        // 但把色相挪到暖粉。白是主体——所有面/卡片/按钮底都是高透明度白，只在
        // 边框/hover/激活/徽章这些「点」上用粉，避免整片糊成粉色。
        // accent 用玫瑰粉 #e86b9a（比 hotpink 稳，压得住白底上的文字对比度）。
        // 注意 shadow 必须给「纯色」不能给 box-shadow 简写：全部 11 处消费方都是
        // `box-shadow: 0 4px 15px var(--acu-shadow)`，塞简写会让整条声明失效变成无阴影
        // （apple 主题就是这么写的，实测它其实一处阴影都没渲染）。
        blushglass: { bgNav: 'rgba(255, 252, 253, 0.78)', bgPanel: 'rgba(255, 253, 254, 0.8)', border: 'rgba(232, 107, 154, 0.24)', textMain: '#3d2b33', textSub: '#8a7480', uiColor: '#d1568a', btnBg: 'rgba(255, 250, 252, 0.82)', btnHover: 'rgba(255, 235, 243, 0.95)', btnActiveBg: '#e86b9a', btnActiveText: '#ffffff', tableHead: 'rgba(255, 240, 247, 0.78)', tableHover: 'rgba(232, 107, 154, 0.07)', shadow: 'rgba(209, 86, 138, 0.16)', cardBg: 'rgba(255, 255, 255, 0.8)', badgeBg: 'rgba(232, 107, 154, 0.12)', menuBg: 'rgba(255, 252, 253, 0.95)', menuText: '#3d2b33', inputBg: 'rgba(255, 255, 255, 0.85)', overlayBg: 'rgba(120, 60, 85, 0.3)' }
    };

    
    
    const updateDynamicActionButton = () => {
        const { $ } = getCore();
        const $refreshBtn = $('#acu-btn-refresh, #acu-btn-refresh-emb');
        if (!$refreshBtn.length) return;
        if (pendingDeletes.size > 0) {
            $refreshBtn.html('<i class="fa-solid fa-save"></i>').addClass('acu-btn-save-mode').attr('title', '保存删除');
        } else {
            $refreshBtn.html('<i class="fa-solid fa-sync-alt"></i>').removeClass('acu-btn-save-mode').attr('title', '刷新数据');
        }
    };

    const bindScrollFade = ($els) => {
        if (!$els || !$els.length) return;
        $els.each(function() {
            const $t = $(this);
            $t.off('scroll.fade').on('scroll.fade', function() {
                $t.addClass('acu-show-scroll');
                clearTimeout($t.data('fadeT'));
                $t.data('fadeT', setTimeout(() => {
                    $t.removeClass('acu-show-scroll');
                }, 500));
            });
        });
    };

    // 同时取旧 API（AutoCardUpdaterAPI，含 exportTableAsJson/updateCell 等）
    // 与新 V2 API（AutoCardUpdaterV2API，含 open=打开带"基础模式/高手模式"切换的新工作台）。
    // 两者由数据库分别挂载到 window 与可能的 host 窗口，互不重合。
    const getCore = () => {
        const w = window.parent || window;
        return {
            $: window.jQuery || w.jQuery,
            getDB: () => w.AutoCardUpdaterAPI || window.AutoCardUpdaterAPI,
            getDBV2: () => w.AutoCardUpdaterV2API || window.AutoCardUpdaterV2API
        };
    };

    const getIconForTableName = (name) => {
        if (!name) return 'fa-table';
        const n = name.toLowerCase();
        if (n.includes('主角') || n.includes('角色')) return 'fa-user-circle';
        if (n.includes('通用') || n.includes('全局') || n.includes('世界') || n.includes('设定')) return 'fa-globe-asia';
        if (n.includes('背包') || n.includes('物品') || n.includes('资源') || n.includes('物资')) return 'fa-briefcase';
        if (n.includes('技能') || n.includes('武魂') || n.includes('功法') || n.includes('能力') || n.includes('神通') || n.includes('法术')) return 'fa-dragon';
        if (n.includes('势力') || n.includes('阵营') || n.includes('门派') || n.includes('组织')) return 'fa-flag';
        if (n.includes('关系') || n.includes('周边') || n.includes('npc') || n.includes('人物')) return 'fa-address-book';
        if (n.includes('任务') || n.includes('日志')) return 'fa-scroll';
        if (n.includes('地点') || n.includes('位置')) return 'fa-map-marker-alt';
        if (n.includes('总结') || n.includes('大纲')) return 'fa-book-reader';
        if (n.includes('装备') || n.includes('武器')) return 'fa-shield-alt';
        if (n.includes('事件') || n.includes('备忘') || n.includes('记录') || n.includes('日程') || n.includes('纪要')) return 'fa-clipboard-list';
        return 'fa-table';
    };

    const getBadgeStyle = (text) => { return ''; };

    const getActiveTabState = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY_ACTIVE_TAB)); } catch (e) { return null; } };
    const saveActiveTabState = (tableName) => { try { localStorage.setItem(STORAGE_KEY_ACTIVE_TAB, JSON.stringify(tableName)); } catch (e) { console.error(e); } };
    const getSavedTableOrder = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY_TABLE_ORDER)); } catch (e) { return null; } };
    const saveTableOrder = (tableNames) => { try { localStorage.setItem(STORAGE_KEY_TABLE_ORDER, JSON.stringify(tableNames)); } catch (e) { console.error(e); } };
    const getSavedActionOrder = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY_ACTION_ORDER)); } catch (e) { return null; } };
    const saveActionOrder = (list) => { try { localStorage.setItem(STORAGE_KEY_ACTION_ORDER, JSON.stringify(list)); } catch (e) { console.error(e); } };
    const getConfig = () => { try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_UI_CONFIG)); return { ...DEFAULT_CONFIG, ...saved }; } catch (e) { return DEFAULT_CONFIG; } };
    const saveConfig = (newConfig) => { const current = getConfig(); const merged = { ...current, ...newConfig }; try { localStorage.setItem(STORAGE_KEY_UI_CONFIG, JSON.stringify(merged)); } catch (e) { console.error(e); } applyConfigStyles(merged); };
    
    const getTableHeights = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY_TABLE_HEIGHTS)) || {}; } catch (e) { return {}; } };
    const saveTableHeights = (heights) => { try { localStorage.setItem(STORAGE_KEY_TABLE_HEIGHTS, JSON.stringify(heights)); } catch (e) { console.error(e); } };

    const getTableStyles = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY_TABLE_STYLES)) || {}; } catch (e) { return {}; } };
    const saveTableStyles = (styles) => { try { localStorage.setItem(STORAGE_KEY_TABLE_STYLES, JSON.stringify(styles)); } catch (e) { console.error(e); } };
    const getDashConfig = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY_DASH_CONFIG)) || {}; } catch (e) { return {}; } };
    const saveDashConfig = (cfg) => { try { localStorage.setItem(STORAGE_KEY_DASH_CONFIG, JSON.stringify(cfg)); } catch (e) { console.error(e); } };


    const getReverseOrderTables = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY_REVERSE_TABLES)) || []; } catch (e) { return []; } };
    const saveReverseOrderTables = (list) => { try { localStorage.setItem(STORAGE_KEY_REVERSE_TABLES, JSON.stringify(list)); } catch (e) { console.error(e); } };

    const getHiddenTables = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY_HIDDEN_TABLES)) || []; } catch (e) { return []; } };
    const saveHiddenTables = (list) => { try { localStorage.setItem(STORAGE_KEY_HIDDEN_TABLES, JSON.stringify(list)); } catch (e) { console.error(e); } };

    // 高楼层/大数据量下 localStorage 5MB 配额极易打满（纪要表尤甚）。
    // 内存快照优先；localStorage 仅作冷启动兜底，写入失败静默降级。
    let memorySnapshot_ACU = null;
    const SNAPSHOT_LS_MAX_CHARS = 1500000; // ~1.5MB 文本，预留配额给其他配置项
    const loadSnapshot = () => {
        if (memorySnapshot_ACU) return memorySnapshot_ACU;
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY_LAST_SNAPSHOT)); } catch (e) { return null; }
    };
    const saveSnapshot = (data) => {
        if (!data || typeof data !== 'object') return;
        memorySnapshot_ACU = data;
        try {
            const text = JSON.stringify(data);
            if (text && text.length <= SNAPSHOT_LS_MAX_CHARS) {
                localStorage.setItem(STORAGE_KEY_LAST_SNAPSHOT, text);
            } else {
                try { localStorage.removeItem(STORAGE_KEY_LAST_SNAPSHOT); } catch (_) {}
            }
        } catch (e) {
            try { localStorage.removeItem(STORAGE_KEY_LAST_SNAPSHOT); } catch (_) {}
        }
    };

    const generateDiffMap = (currentData) => {
        const lastData = loadSnapshot();
        const diffSet = new Set();
        if (!lastData || !currentData) return diffSet;
        // 高楼层保护：单表超过阈值时只标记新增尾部行，跳过逐格比对，
        // 避免鸡尾酒开启后用户堆到高楼层时主线程被 diff 卡死导致纪要表像「无法显示」。
        const HEAVY_ROW_THRESHOLD = 400;
        for (const sheetId in currentData) {
            const newSheet = currentData[sheetId];
            const oldSheet = lastData[sheetId];
            if (!newSheet || !newSheet.name) continue;
            const tableName = newSheet.name;
            const newRows = newSheet.content || [];
            const oldRows = (oldSheet && oldSheet.content) || [];
            if (!oldSheet) {
                newRows.forEach((row, rIdx) => { if (rIdx > 0) diffSet.add(`${tableName}-row-${rIdx-1}`); });
                continue;
            }
            const dataRowCount = Math.max(0, newRows.length - 1);
            if (dataRowCount > HEAVY_ROW_THRESHOLD) {
                if (newRows.length > oldRows.length) {
                    for (let rIdx = oldRows.length; rIdx < newRows.length; rIdx++) {
                        if (rIdx > 0) diffSet.add(`${tableName}-row-${rIdx-1}`);
                    }
                }
                continue;
            }
            newRows.forEach((row, rIdx) => {
                if (rIdx === 0) return;
                const oldRow = oldRows[rIdx];
                if (!oldRow) { diffSet.add(`${tableName}-row-${rIdx-1}`); } else {
                    const colLimit = Math.max(row.length, oldRow.length);
                    for (let cIdx = 1; cIdx < colLimit; cIdx++) {
                        if (String(row[cIdx] ?? '') !== String(oldRow[cIdx] ?? '')) {
                            diffSet.add(`${tableName}-${rIdx-1}-${cIdx}`);
                        }
                    }
                }
            });
        }
        return diffSet;
    };

    const injectDatabaseStyles = (config) => {
        const { $ } = getCore();
        if (!$) return;
        const $style = $('#acu-db-beautify');
        // ── 数据库新 UI(#acu-app-v2,SP·数据库VIII)苹果毛玻璃模式 ──
        // 与旧 dbTheme 机制互不干扰:开启时把 #acu-app-v2 的 23 个主题 token 全部
        // 覆盖成苹果材料(半透明白 + blur 只给外层容器),关闭即移除、恢复 DB 原主题。
        // DB 侧 applyTheme 会重写 <style id="acu-v2-theme">,但变量声明无 !important,
        // 这里全部带 !important 且 style 后插入,层叠上必定压住 DB 重写。
        // 不依赖任何 class:style 存在=开关开启,移除=恢复;选择器直接挂 #acu-app-v2,
        // DB 异步挂载后规则声明式自动命中,无需 MutationObserver 补挂。
        const $apple = $('#acu-v2-apple');
        if (config.dbAppleGlass) {
            const injectApple = () => {
                const css = `
                    <style id="acu-v2-apple">
                        /* 苹果毛玻璃材料 token(全 !important 压 DB 侧 applyTheme 重写) */
                        #acu-app-v2 {
                            /* 三档透明度梯度拉开纵深(实机反馈:原来 bg0/bg1 明度差仅 0.9%,
                               近白面板把毛玻璃填平)。shell 最透、面板次透、灰块再一档,
                               每层之间能透出模糊背景形成层次。 */
                            --acu-bg-0: rgba(244, 244, 247, 0.72) !important;
                            --acu-bg-1: rgba(250, 250, 252, 0.85) !important;
                            --acu-bg-2: rgba(226, 226, 232, 0.62) !important;
                            --acu-sidebar-bg: rgba(246, 246, 248, 0.78) !important;
                            --acu-hover-overlay: rgba(0, 122, 255, 0.08) !important;
                            --acu-border: rgba(255, 255, 255, 0.5) !important;
                            --acu-border-2: rgba(0, 0, 0, 0.06) !important;
                            --acu-text-1: #1d1d1f !important;
                            --acu-text-2: #6e6e73 !important;
                            --acu-text-3: #86868b !important;
                            --acu-accent: #007aff !important;
                            --acu-accent-2: #0a84ff !important;
                            --acu-on-accent: #ffffff !important;
                            --acu-accent-glow: rgba(0, 122, 255, 0.25) !important;
                            --acu-success: #34c759 !important;
                            --acu-warning: #ff9f0a !important;
                            --acu-danger: #ff3b30 !important;
                            --acu-font-ui: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'Microsoft YaHei', sans-serif !important;
                            --acu-font-mono: ui-monospace, 'SF Mono', Consolas, monospace !important;
                            --acu-radius-lg: 16px !important;
                            --acu-radius-md: 12px !important;
                            --acu-radius-sm: 8px !important;
                            --acu-shadow: 0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06) !important;
                        }
                        /* 毛玻璃只给外层容器(shell/各弹层)。子元素零 backdrop-filter:
                           每加一个就是多一个合成层 + 一次对背景的高斯模糊。 */
                        #acu-app-v2 .acu-v2-app__shell,
                        #acu-app-v2 .acu-dialog-layer,
                        #acu-app-v2 .acu-v2-drawer-layer,
                        #acu-app-v2 .acu-v2-app__mobile-nav-layer {
                            -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
                            backdrop-filter: blur(20px) saturate(180%) !important;
                        }
                        /* 亮顶边(光打在材料上):所有玻璃容器——shell/侧栏/弹窗/抽屉都补,
                           否则外壳看起来是「普通边框」而不是被光照亮的材料 */
                        #acu-app-v2 .acu-v2-app__shell,
                        #acu-app-v2 .acu-dialog,
                        #acu-app-v2 .acu-v2-drawer,
                        #acu-app-v2 .acu-panel,
                        #acu-app-v2 .acu-v2-app__theme-menu {
                            border-top: 1px solid rgba(255, 255, 255, 0.7) !important;
                        }
                        #acu-app-v2 .acu-v2-sidebar--desktop { border-right: 1px solid rgba(255, 255, 255, 0.4) !important; }
                        #acu-app-v2 .acu-v2-app__header { border-bottom: 1px solid rgba(255, 255, 255, 0.45) !important; }
                        /* 内层面板:比 shell 实一档但保持可见透明(0.80),让 shell 的模糊
                           透出来形成毛玻璃感;柔和投影(0.10/y 6px)从 shell 上浮起。
                           太实(0.85+)会退化成白卡,毛玻璃质感消失。 */
                        #acu-app-v2 .acu-panel,
                        #acu-app-v2 .acu-v2-app__theme-menu {
                            background: rgba(255, 255, 255, 0.8) !important;
                            -webkit-backdrop-filter: none !important;
                            backdrop-filter: none !important;
                            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.1), 0 1px 3px rgba(0, 0, 0, 0.05) !important;
                        }
                        /* 浮层:半透明保持玻璃感(0.82,别做实色),投影更深压住遮罩 */
                        #acu-app-v2 .acu-dialog,
                        #acu-app-v2 .acu-v2-drawer {
                            background: rgba(255, 255, 255, 0.82) !important;
                            box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08) !important;
                        }
                        /* 表格:表头加极淡底与 shell 区分,行分隔线用淡灰(不再是隐形白边) */
                        #acu-app-v2 .acu-v2-form-fill-page__table-wrap th {
                            background: rgba(0, 0, 0, 0.03) !important;
                            border-bottom: 1px solid rgba(0, 0, 0, 0.08) !important;
                        }
                        #acu-app-v2 .acu-v2-form-fill-page__table-wrap td {
                            border-bottom: 1px solid rgba(0, 0, 0, 0.05) !important;
                        }
                        /* 仪表盘健康卡:面板同款浮起 */
                        #acu-app-v2 .acu-dashboard-page__health-item {
                            background: rgba(255, 255, 255, 0.8) !important;
                            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.07) !important;
                        }
                        /* 弹层遮罩轻压暗 + 模糊,替掉 DB 默认纯色压暗 */
                        #acu-app-v2 .acu-dialog-layer { background: rgba(0, 0, 0, 0.18) !important; }
                        #acu-app-v2 .acu-v2-drawer-layer { background: rgba(0, 0, 0, 0.14) !important; }
                        /* 不支持 backdrop-filter:提实浅色背景保证可读(@supports 与
                           prefers-reduced-transparency 选择器集合与主规则完全一致) */
                        @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
                            #acu-app-v2 .acu-v2-app__shell,
                            #acu-app-v2 .acu-dialog-layer,
                            #acu-app-v2 .acu-v2-drawer-layer,
                            #acu-app-v2 .acu-v2-app__mobile-nav-layer {
                                background: #f5f5f7 !important;
                                -webkit-backdrop-filter: none !important;
                                backdrop-filter: none !important;
                            }
                            #acu-app-v2 .acu-panel,
                            #acu-app-v2 .acu-dialog,
                            #acu-app-v2 .acu-v2-drawer,
                            #acu-app-v2 .acu-v2-app__theme-menu {
                                background: #ffffff !important;
                            }
                        }
                        @media (prefers-reduced-transparency: reduce) {
                            #acu-app-v2 .acu-v2-app__shell,
                            #acu-app-v2 .acu-dialog-layer,
                            #acu-app-v2 .acu-v2-drawer-layer,
                            #acu-app-v2 .acu-v2-app__mobile-nav-layer {
                                background: #f5f5f7 !important;
                                -webkit-backdrop-filter: none !important;
                                backdrop-filter: none !important;
                            }
                            #acu-app-v2 .acu-panel,
                            #acu-app-v2 .acu-dialog,
                            #acu-app-v2 .acu-v2-drawer,
                            #acu-app-v2 .acu-v2-app__theme-menu {
                                background: #ffffff !important;
                            }
                        }
                    </style>
                `;
                if ($apple.length) $apple.replaceWith(css); else $('head').append(css);
            };
            injectApple();
            return;
        } else {
            $apple.remove();
        }
        if (config.dbTheme && config.dbTheme !== 'default') {
            const t = THEME_VARS[config.dbTheme] || THEME_VARS.aurora;
            let h = HIGHLIGHT_COLORS[config.highlightColor];
            if (!h && config.highlightColor && String(config.highlightColor).startsWith('#')) {
                h = { main: config.highlightColor, bg: config.highlightColor + '1a' };
            }
            h = h || HIGHLIGHT_COLORS.orange;
            const fontVal = FONTS.find(f => f.id === config.fontFamily)?.val || FONTS[0].val;
            
            let finalBg0 = t.bgPanel;
            let finalBg1 = t.bgNav;
            


            const css = `
                <style id="acu-db-beautify">
                    
                    html body .auto-card-updater-popup .button-group.acu-data-mgmt-buttons button,
                    html body .auto-card-updater-popup .button-group.acu-data-mgmt-buttons .button,
                    :not(#z):not(#z) .auto-card-updater-popup .acu-data-mgmt-buttons button,
                    :not(#z):not(#z) .auto-card-updater-popup .acu-data-mgmt-buttons .button {
                        background: ${t.btnBg} !important;
                        color: ${t.textMain} !important;
                        border: 1px solid ${t.border} !important;
                        opacity: 1 !important;
                        box-shadow: none !important;
                    }
                    :not(#z):not(#z) .auto-card-updater-popup .acu-data-mgmt-buttons button:hover,
                    :not(#z):not(#z) .auto-card-updater-popup .acu-data-mgmt-buttons .button:hover {
                        background: ${t.btnHover} !important;
                    }

                    
                    .auto-card-updater-popup .acu-header {
                        box-shadow: none !important;
                        background: ${t.bgNav} !important;
                        border-bottom: 1px solid ${t.border} !important;
                    }

                    
                    .acu-window {
                        background: ${t.bgPanel} !important;
                        box-shadow: ${t.shadow} !important;
                        border: 1px solid ${t.border} !important;
                    }
                    
                    .acu-window .acu-window-header {
                        background: ${t.bgNav} !important;
                        border-bottom: 1px solid ${t.border} !important;
                    }
                    
                    .acu-window .acu-window-title {
                        color: ${t.textMain} !important;
                    }
                    .acu-window .acu-window-title i {
                        color: ${h.main} !important;
                    }
                    .acu-window .acu-window-btn {
                        background: ${t.btnBg} !important;
                        color: ${t.textSub} !important;
                        border: 1px solid ${t.border} !important;
                    }
                    .acu-window .acu-window-btn:hover {
                        background: ${t.btnHover} !important;
                        color: ${t.textMain} !important;
                    }

                    
                    html body .auto-card-updater-popup .acu-tabs-nav,
                    .auto-card-updater-popup .acu-tabs-nav {
                        background: ${t.bgNav} !important;
                        border-color: ${t.border} !important;
                        
                        opacity: 1 !important;
                    }

                    
                    .auto-card-updater-popup .acu-tab-button {
                        color: ${t.textSub} !important;
                        border-radius: 8px !important;
                    }
                    .auto-card-updater-popup .acu-tab-button:hover {
                        background: ${t.btnHover} !important;
                        color: ${t.textMain} !important;
                    }
                    .auto-card-updater-popup .acu-tab-button.active {
                        background: ${t.btnActiveBg} !important;
                        color: ${t.btnActiveText} !important;
                        box-shadow: 0 2px 6px rgba(0,0,0,0.15) !important; 
                        border-color: transparent !important;
                    }

                    .acu-window-overlay {
                        background-color: ${t.overlayBg} !important;
                        backdrop-filter: blur(5px) !important;
                    }
                    .auto-card-updater-popup {
                        --acu-bg-0: ${finalBg0} !important;
                        --acu-bg-1: ${finalBg1} !important;
                        --acu-bg-2: ${t.btnBg} !important;
                        --acu-border: ${t.border} !important;
                        --acu-border-2: ${t.border} !important;
                        --acu-text-1: ${t.textMain} !important;
                        --acu-text-2: ${t.textSub} !important;
                        --acu-text-3: ${t.textSub} !important;
                        --acu-accent: ${t.uiColor || t.textMain} !important;
                        --acu-accent-glow: transparent !important;
                        font-family: ${fontVal} !important;
                    }
                                        .auto-card-updater-popup button, .auto-card-updater-popup .button {
                        border-radius: 8px !important;
                        background: ${t.btnBg} !important;
                        color: ${t.textMain} !important;
                        border: 1px solid ${t.border} !important;
                    }
                    .auto-card-updater-popup button:hover, .auto-card-updater-popup .button:hover {
                        background: ${t.btnHover} !important;
                    }
                    .auto-card-updater-popup button.primary, .auto-card-updater-popup .button.primary {
                        background: ${t.btnActiveBg} !important;
                        color: ${t.btnActiveText} !important;
                    }
                    :not(#z):not(#z) .auto-card-updater-popup input:not([type="checkbox"]):not([type="radio"]),
                    :not(#z):not(#z) .auto-card-updater-popup textarea {
                        background-color: ${t.inputBg} !important;
                        color: ${t.textMain} !important;
                        border-color: ${t.border} !important;
                    }
                    /* 修复：下拉框使用主题搭配色边框 (t.border) */
                    :not(#z):not(#z) .auto-card-updater-popup select {
                        background-color: ${t.inputBg} !important;
                        color: ${t.textMain} !important;
                        border: 1px solid ${t.border} !important;
                    }
                    /* 修复：强制设置下拉选项背景色，防止透明导致看不清 */
                    :not(#z):not(#z) .auto-card-updater-popup select option {
                        background-color: ${t.cardBg} !important;
                        color: ${t.textMain} !important;
                    }
                    /* 修复：强制设置输入框占位符颜色，防止美化后说明文字消失 */
                    :not(#z):not(#z) .auto-card-updater-popup input::placeholder,
                    :not(#z):not(#z) .auto-card-updater-popup textarea::placeholder {
                        color: ${t.textSub} !important;
                        opacity: 0.7 !important;
                    }
                    .auto-card-updater-popup [style*="lightgreen"] {
                        color: ${h.main} !important;
                    }
                    /* --- 1. 通用容器美化 --- */
                    .auto-card-updater-popup .acu-card,
                    .auto-card-updater-popup .settings-section {
                        background: ${t.cardBg} !important;
                        border-color: ${t.border} !important;
                        color: ${t.textMain} !important;
                        box-shadow: ${t.shadow} !important;
                    }

                    /* --- 2. 输入组与列表容器美化 --- */
                    .auto-card-updater-popup .prompt-segment,
                    .auto-card-updater-popup .plot-prompt-segment,
                    .auto-card-updater-popup .qrf_worldbook_list, 
                    .auto-card-updater-popup .qrf_worldbook_entry_list,
                    .auto-card-updater-popup .checkbox-group,
                    .auto-card-updater-popup .qrf_radio_group {
                        background: ${t.bgNav} !important;
                        border-color: ${t.border} !important;
                        color: ${t.textMain} !important;
                    }

                    /* --- 3. 针对性修复：状态显示框与底部栏 --- */
                    /* 使用属性选择器匹配 ID 结尾，覆盖数据库脚本硬编码的背景色 */
                    .auto-card-updater-popup [id$="-card-update-status-display"],
                    .auto-card-updater-popup [id$="-status-message"],
                    .auto-card-updater-popup [id$="-loop-status-indicator"] {
                        background: ${t.bgNav} !important;
                        border: 1px solid ${t.border} !important;
                        color: ${t.textMain} !important;
                        box-shadow: inset 0 1px 4px rgba(0,0,0,0.05) !important;
                    }

                    /* --- 4. 文本颜色修正 --- */
                    .auto-card-updater-popup .acu-header-sub,
                    .auto-card-updater-popup .notes, 
                    .auto-card-updater-popup small.notes,
                    .auto-card-updater-popup label {
                        color: ${t.textSub} !important;
                    }
                    .auto-card-updater-popup h3, 
                    .auto-card-updater-popup h4 {
                        color: ${t.textMain} !important;
                        border-bottom-color: ${t.border} !important;
                    }

                    /* 修复表格内的状态文本颜色 */
                    .auto-card-updater-popup [id$="-granular-status-table-body"] td {
                        color: ${t.textMain} !important;
                    }

                    /* 修复 Toggle Switch (0TK开关) 可见性 */
                    .auto-card-updater-popup .toggle-switch .slider {
                        background-color: ${t.border} !important;
                        border: 1px solid ${t.border} !important;
                        opacity: 0.6 !important;
                    }
                    .auto-card-updater-popup .toggle-switch input:checked + .slider {
                        background: ${t.btnActiveBg} !important;
                        border-color: transparent !important;
                        opacity: 1 !important;
                    }
                    .auto-card-updater-popup .toggle-switch .slider:before {
                        background-color: #fff !important;
                        box-shadow: 0 1px 3px rgba(0,0,0,0.3) !important;
                    }
                    
                    /* --- 5. 复选框美化 (Checkboxes) - Theme Adaptive (Gradient Fix) --- */
                    :not(#z) .auto-card-updater-popup input[type="checkbox"] {
                        background-color: ${t.inputBg} !important;
                        border: 1px solid ${t.border} !important;
                        width: 18px !important;
                        height: 18px !important;
                        border-radius: 4px !important;
                        appearance: none !important;
                        -webkit-appearance: none !important;
                        cursor: pointer !important;
                        box-shadow: inset 0 1px 2px rgba(0,0,0,0.1) !important;
                    }
                    :not(#z) .auto-card-updater-popup input[type="checkbox"]:checked {
                        /* 修复：使用 background 简写以支持渐变色主题 (如 Aurora/Sunset) */
                        background: ${t.btnActiveBg} !important;
                        border-color: transparent !important;
                    }
                    :not(#z) .auto-card-updater-popup input[type="checkbox"]:hover {
                        border-color: ${t.textMain} !important;
                    }

                </style>
            `;
            if ($style.length) $style.replaceWith(css); else $('head').append(css);
        } else {
            $style.remove();
        }
    };

    const applyConfigStyles = (config) => {
        const { $ } = getCore();
        if (!$) return;
        const $wrapper = $('.acu-wrapper');
        const $embedded = $('.acu-embedded-options-container .acu-option-panel');
        const fontVal = FONTS.find(f => f.id === config.fontFamily)?.val || FONTS[0].val;
        $('#acu-dynamic-font').remove();
        $('head').append(`
            <style id="acu-dynamic-font">
                .acu-wrapper, .acu-edit-dialog, .acu-cell-menu, .acu-nav-container, .acu-data-card, .acu-panel-title, .acu-settings-label, .acu-checkbox-label, .acu-btn-block, .acu-nav-btn, .acu-dash-card, .acu-quick-view-card, .acu-option-panel, .acu-opt-btn, .acu-opt-header, .acu-nice-select, .acu-edit-dialog select, .acu-edit-dialog input, .acu-edit-dialog textarea, .acu-close-pill, .acu-embedded-dashboard-container, .acu-embedded-options-container {
                    font-family: ${fontVal} !important;
                }
            </style>
        `);
        
        let colorVal = HIGHLIGHT_COLORS[config.highlightColor];
        if (!colorVal && config.highlightColor && String(config.highlightColor).startsWith('#')) {
            colorVal = { main: config.highlightColor, bg: config.highlightColor + '1a' };
        }
        colorVal = colorVal || HIGHLIGHT_COLORS.orange;
        let titleColorVal = 'var(--acu-text-main)';
        if (config.customTitleColor) {
             const tRaw = config.titleColor;
             if (tRaw && String(tRaw).startsWith('#')) {
                 titleColorVal = tRaw;
             } else {
                 titleColorVal = (HIGHLIGHT_COLORS[tRaw] || HIGHLIGHT_COLORS.orange).main;
             }
        }
        const gridCols = config.gridColumns > 0 ? `repeat(${config.gridColumns}, 1fr)` : 'repeat(auto-fill, minmax(110px, 1fr))';
        
        const cssProps = { 
            '--acu-card-width': `${config.cardWidth}px`, 
            '--acu-font-size': `${config.fontSize}px`,
            '--acu-opt-font-size': `${config.optionFontSize || 13}px`,
            '--acu-dash-font-size': `${config.dashboardFontSize || 13}px`,
            '--acu-highlight': colorVal.main,
            '--acu-highlight-bg': colorVal.bg,
            '--acu-accent': colorVal.main,
            '--acu-title-color': titleColorVal,
            '--acu-nav-cols': gridCols
        };
        
        if ($wrapper.length) {
            $wrapper.removeClass(THEMES.map(t => `acu-theme-${t.id}`).join(' '));
            $wrapper.addClass(`acu-theme-${config.theme}`);
            $wrapper.css(cssProps);
            const $display = $('.acu-data-display');
            $display.removeClass('acu-layout-vertical acu-layout-horizontal').addClass(`acu-layout-${config.layout}`);
        }

        if ($embedded.length) {
             $embedded.removeClass(THEMES.map(t => `acu-theme-${t.id}`).join(' '));
             $embedded.addClass(`acu-theme-${config.theme}`);
             $embedded.css(cssProps);
        }
        const $embDash = $('.acu-embedded-dashboard-container');
        if ($embDash.length) {
             $embDash.removeClass(THEMES.map(t => `acu-theme-${t.id}`).join(' '));
             $embDash.addClass(`acu-theme-${config.theme}`);
             $embDash.css(cssProps);
        }

        injectDatabaseStyles(config);
    };

    const addStyles = () => {
        const { $ } = getCore();
        if (!$) return;
        $(`#${SCRIPT_ID}-styles`).remove();
        let themeCss = '';
        Object.keys(THEME_VARS).forEach(k => {
            const t = THEME_VARS[k];
            themeCss += `.acu-theme-${k} { --acu-bg-nav: ${t.bgNav}; --acu-bg-panel: ${t.bgPanel}; --acu-border: ${t.border}; --acu-text-main: ${t.textMain}; --acu-ui-color: ${t.uiColor || t.textMain}; --acu-text-sub: ${t.textSub}; --acu-btn-bg: ${t.btnBg}; --acu-btn-hover: ${t.btnHover}; --acu-btn-active-bg: ${t.btnActiveBg}; --acu-btn-active-text: ${t.btnActiveText}; --acu-table-head: ${t.tableHead}; --acu-table-hover: ${t.tableHover}; --acu-shadow: ${t.shadow}; --acu-card-bg: ${t.cardBg}; --acu-badge-bg: ${t.badgeBg}; --acu-menu-bg: ${t.menuBg}; --acu-menu-text: ${t.menuText}; --acu-input-bg: ${t.inputBg}; --acu-overlay-bg: ${t.overlayBg}; }\n`;
        });

        const styles = `
            <style id="${SCRIPT_ID}-styles">
                /* 国内镜像字体源，无需VPN */
                @import url('https://fonts.loli.net/css2?family=Long+Cang&family=Ma+Shan+Zheng&family=Noto+Sans+SC:wght@400;700&family=Noto+Serif+SC:wght@400;700&family=ZCOOL+KuaiLe&family=Zhi+Mang+Xing&display=swap');

                /* 选项面板容器：脱离父级（ST 消息块 .mes_block）的 flex/对齐影响，避免窄屏/平板上被右靠。
                   注意：display 不加 !important，否则会压掉 jQuery .hide() 的内联 display:none（发送后隐藏面板）。 */
                .acu-embedded-options-container {
                    display: block;
                    flex: 0 0 auto !important;
                    width: 100% !important;
                    max-width: 100% !important;
                    margin-left: 0 !important;
                    margin-right: auto !important;
                    box-sizing: border-box !important;
                }
                /* 窄屏（≤480px 手机）才单列；iPad 竖屏（768px）保留 3 列居中，避免整行右靠 */
                @media (max-width: 480px) {
                    .acu-embedded-options-container .acu-opt-btn {
                        width: 100% !important;
                        flex: 0 0 100% !important;
                        max-width: 100% !important;
                    }
                }
                /* 苹果设计主题：毛玻璃材料增强 + 降级兜底 */
                .acu-theme-apple .acu-nav-container,
                .acu-theme-apple .acu-data-display,
                .acu-theme-apple.acu-embedded-options-container,
                .acu-theme-apple.acu-embedded-options-container .acu-option-panel,
                .acu-theme-apple.acu-embedded-options-container .acu-opt-ctrl-bar,
                .acu-theme-apple.acu-embedded-options-container .acu-opt-content-wrapper {
                    -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
                    backdrop-filter: blur(20px) saturate(180%) !important;
                }
                /* 亮顶边（光打在材料上）：只给导航栏/数据面板加；选项容器保留自身圆角 border，
                   不在其上加亮边，避免「方形边框罩住圆角按钮」。 */
                .acu-theme-apple .acu-nav-container,
                .acu-theme-apple .acu-data-display {
                    border-top: 1px solid rgba(255, 255, 255, 0.65) !important;
                    border-left: 1px solid rgba(255, 255, 255, 0.4) !important;
                }
                /* 不支持 backdrop-filter 时提实背景，保证文字可读（对应 prefers-reduced-transparency 精神） */
                @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
                    .acu-theme-apple .acu-nav-container,
                    .acu-theme-apple .acu-data-display,
                    .acu-theme-apple.acu-embedded-options-container,
                    .acu-theme-apple.acu-embedded-options-container .acu-option-panel,
                    .acu-theme-apple.acu-embedded-options-container .acu-opt-ctrl-bar,
                    .acu-theme-apple.acu-embedded-options-container .acu-opt-content-wrapper {
                        background: #f5f5f7 !important;
                        -webkit-backdrop-filter: none !important;
                        backdrop-filter: none !important;
                    }
                    .acu-theme-apple .acu-data-card {
                        background: #ffffff !important;
                    }
                }
                /* prefers-reduced-transparency：降低毛玻璃透明度（材料更实） */
                @media (prefers-reduced-transparency: reduce) {
                    .acu-theme-apple .acu-nav-container,
                    .acu-theme-apple .acu-data-display,
                    .acu-theme-apple.acu-embedded-options-container,
                    .acu-theme-apple.acu-embedded-options-container .acu-option-panel,
                    .acu-theme-apple.acu-embedded-options-container .acu-opt-ctrl-bar,
                    .acu-theme-apple.acu-embedded-options-container .acu-opt-content-wrapper {
                        background: #f5f5f7 !important;
                        -webkit-backdrop-filter: none !important;
                        backdrop-filter: none !important;
                    }
                    /* 与 @supports 兜底一致并补齐：减透明时弹窗/详情卡也要提实 */
                    .acu-edit-dialog.acu-theme-apple { background-color: #f5f5f7 !important; }
                    .acu-edit-dialog.acu-theme-apple textarea,
                    .acu-edit-dialog.acu-theme-apple input:not([type="checkbox"]):not([type="radio"]):not([type="color"]),
                    .acu-edit-dialog.acu-theme-apple select { background-color: #ffffff !important; }
                    .acu-quick-view-card.acu-theme-apple { background: #f5f5f7 !important; }
                    .acu-quick-view-card.acu-theme-apple .acu-quick-view-header { background: #ffffff !important; }
                    .acu-quick-view-card.acu-theme-apple .acu-full-item,
                    .acu-quick-view-card.acu-theme-apple .acu-grid-item { background: #ffffff !important; }
                }

                /* ── 粉白磨砂 ──
                   材料机制与苹果主题同源（半透明底 + backdrop-filter + 亮顶边），色相挪到暖粉。
                   白为主体：面和卡片一律高透明度白；粉只出现在边框微光、hover、激活、徽章上。 */
                /* 毛玻璃只给外层容器。卡片不单独给 backdrop-filter：每张卡各自起一个
                   合成层，会逐张对背景做 20px 高斯模糊，实测 20 行一页的 insert+layout
                   从 1.5ms 涨到 10.3ms。卡片在被模糊过的容器里，靠自身半透明白底就有
                   玻璃质感，不需要自己再模糊一遍背景。 */
                .acu-theme-blushglass .acu-nav-container,
                .acu-theme-blushglass .acu-data-display,
                .acu-theme-blushglass.acu-embedded-options-container,
                .acu-theme-blushglass.acu-embedded-options-container .acu-option-panel,
                .acu-theme-blushglass.acu-embedded-options-container .acu-opt-ctrl-bar,
                .acu-theme-blushglass.acu-embedded-options-container .acu-opt-content-wrapper {
                    -webkit-backdrop-filter: blur(20px) saturate(170%) !important;
                    backdrop-filter: blur(20px) saturate(170%) !important;
                }
                /* 白与「磨砂」的平衡点：白底不透明度太低（<0.7）会被背后深色/彩色聊天背景
                   透上来染色，整片泛褐泛绿，白就不是主体了；垫死不透明白底又会把玻璃质感
                   彻底杀掉，背后什么都透不出来，就不叫磨砂了。这里取 0.8 上下 —— 高饱和
                   blur 仍能把背后揉成柔光，白又足够压住色偏。不要再往任何一边推。 */
                .acu-theme-blushglass.acu-embedded-options-container {
                    /* 选项容器自身透明但带 backdrop-filter，内边距那一圈会直接透出聊天内容，
                       和里面的面板色不接。给它同样的白底色补上。 */
                    background: rgba(255, 252, 253, 0.8) !important;
                    /* 容器有了可见背景就必须跟内部 .acu-option-panel 的 12px 圆角对齐，
                       否则半透明白底是尖角正方形、里面却包着圆角面板——和苹果主题当初
                       踩的「方形边框罩圆角」是同一类错。 */
                    border-radius: 12px !important;
                }
                /* 边框用淡粉而不是亮白：白已经是主体面色，白边压在白底上等于隐形，
                   分界只能交给粉——正好落在「粉色点缀」的用法上。 */
                .acu-theme-blushglass .acu-nav-container,
                .acu-theme-blushglass .acu-data-display {
                    border: 1px solid rgba(232, 107, 154, 0.22) !important;
                    border-top-color: rgba(232, 107, 154, 0.3) !important;
                }
                /* 卡片：白底磨砂 + 粉边；hover 时粉再明显一档 */
                .acu-theme-blushglass .acu-data-card {
                    border: 1px solid rgba(232, 107, 154, 0.2) !important;
                }
                .acu-theme-blushglass .acu-data-card:hover {
                    border-color: rgba(232, 107, 154, 0.35) !important;
                    box-shadow: 0 6px 22px rgba(209, 86, 138, 0.16) !important;
                }
                /* 卡片头：白磨砂上用极淡粉实线分隔，圆角对齐卡片 12px 免得四角鼓出来 */
                .acu-theme-blushglass .acu-card-header {
                    background: rgba(255, 245, 249, 0.55) !important;
                    border-bottom: 1px solid rgba(232, 107, 154, 0.16) !important;
                    border-radius: 12px 12px 0 0 !important;
                }
                /* 行分隔线：淡粉实线，替掉默认的灰虚线 */
                .acu-theme-blushglass .acu-inline-item,
                .acu-theme-blushglass .acu-full-item,
                .acu-theme-blushglass .acu-grid-item {
                    border-color: rgba(232, 107, 154, 0.14) !important;
                }
                .acu-theme-blushglass .acu-inline-item {
                    border-bottom-style: solid !important;
                }
                /* 按钮 hover：淡粉底 + 粉边，激活态才用实心粉 */
                .acu-theme-blushglass .acu-nav-btn:hover,
                .acu-theme-blushglass .acu-opt-btn:hover,
                .acu-theme-blushglass .acu-action-btn:hover {
                    border-color: rgba(232, 107, 154, 0.42) !important;
                    background: rgba(255, 240, 246, 0.92) !important;
                }
                /* 设置弹窗/详情弹窗：白磨砂材料化，粉只留在边缘微光 */
                .acu-edit-dialog.acu-theme-blushglass,
                .acu-quick-view-card.acu-theme-blushglass {
                    background: rgba(255, 252, 253, 0.75) !important;
                    -webkit-backdrop-filter: blur(24px) saturate(175%) !important;
                    backdrop-filter: blur(24px) saturate(175%) !important;
                    /* 边框同样用淡粉：白边在白底（尤其 @supports 兜底提实成 #fffafc 之后）
                       等于隐形，弹窗会缺上边和左边。 */
                    border: 1px solid rgba(232, 107, 154, 0.24) !important;
                    border-top-color: rgba(232, 107, 154, 0.3) !important;
                    color: #3d2b33 !important;
                }
                .acu-quick-view-card.acu-theme-blushglass .acu-quick-view-header {
                    background: rgba(255, 245, 249, 0.6) !important;
                    border-bottom: 1px solid rgba(232, 107, 154, 0.18) !important;
                }
                .acu-edit-overlay.acu-theme-blushglass,
                .acu-quick-view-overlay.acu-theme-blushglass {
                    background: rgba(120, 60, 85, 0.26) !important;
                    -webkit-backdrop-filter: blur(6px) !important;
                    backdrop-filter: blur(6px) !important;
                }
                /* 不支持 backdrop-filter 时提实背景（偏白，粉只留边），保证文字可读 */
                @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
                    .acu-theme-blushglass .acu-nav-container,
                    .acu-theme-blushglass .acu-data-display,
                    .acu-theme-blushglass.acu-embedded-options-container,
                    .acu-theme-blushglass.acu-embedded-options-container .acu-option-panel,
                    .acu-theme-blushglass.acu-embedded-options-container .acu-opt-ctrl-bar,
                    .acu-theme-blushglass.acu-embedded-options-container .acu-opt-content-wrapper {
                        background: #fffafc !important;
                        -webkit-backdrop-filter: none !important;
                        backdrop-filter: none !important;
                    }
                    .acu-theme-blushglass .acu-data-card,
                    .acu-theme-blushglass .acu-dash-card { background: #ffffff !important; }
                    .acu-edit-dialog.acu-theme-blushglass,
                    .acu-quick-view-card.acu-theme-blushglass { background: #fffafc !important; }
                }
                /* prefers-reduced-transparency：材料提实。
                   选择器集合要和上面 @supports 的一致——只提实外层容器、里面的卡片和弹窗
                   仍是半透明的话，用户明确要求的「减少透明」只被兑现了一半。 */
                @media (prefers-reduced-transparency: reduce) {
                    .acu-theme-blushglass .acu-nav-container,
                    .acu-theme-blushglass .acu-data-display,
                    .acu-theme-blushglass.acu-embedded-options-container,
                    .acu-theme-blushglass.acu-embedded-options-container .acu-option-panel,
                    .acu-theme-blushglass.acu-embedded-options-container .acu-opt-ctrl-bar,
                    .acu-theme-blushglass.acu-embedded-options-container .acu-opt-content-wrapper {
                        background: #fffafc !important;
                        -webkit-backdrop-filter: none !important;
                        backdrop-filter: none !important;
                    }
                    .acu-theme-blushglass .acu-data-card,
                    .acu-theme-blushglass .acu-dash-card {
                        background: #ffffff !important;
                        -webkit-backdrop-filter: none !important;
                        backdrop-filter: none !important;
                    }
                    .acu-edit-dialog.acu-theme-blushglass,
                    .acu-quick-view-card.acu-theme-blushglass {
                        background: #fffafc !important;
                        -webkit-backdrop-filter: none !important;
                        backdrop-filter: none !important;
                    }
                }

                /* ── 克劳德风（Anthropic 设计系统）──
                   官方规范的三条硬性特征，靠 THEME_VARS 的色值给不到，必须在这里补：
                   1) 以边框代阴影（design-rules.md「工具优先模式」：卡片无阴影，用边框替代）
                   2) 固定圆角刻度 --radius-sm 4px / md 8px / lg 16px，不用别处的 12px
                   3) 缓动统一 cubic-bezier(0.16, 1, 0.3, 1)，时长 150/250ms
                   不引入外部字体：仓库自带 woff2 无法随扩展分发，按「形散神不散」原则
                   用系统里已有的衬线/无衬线栈保住「温暖有机 + 克制现代」的气质。 */
                .acu-theme-claude {
                    --acu-claude-ease: cubic-bezier(0.16, 1, 0.3, 1);
                }
                /* 卡片/面板：边框优先，阴影几乎不可见（只留一层极淡的分层感）。
                   .acu-quick-view-card 的主题类挂在自身而非祖先，写成后代选择器永不命中，
                   所以放到下面和圆角规则一起用 .acu-quick-view-card.acu-theme-claude 写。
                   导航栏排除胶囊折叠态：那条规则的 border-radius:50px 没带 !important，
                   会被这里压成 8px，胶囊就变成小方块了。 */
                .acu-theme-claude .acu-data-card,
                .acu-theme-claude .acu-dash-card,
                .acu-theme-claude .acu-nav-container:not(.acu-collapse-pill),
                .acu-theme-claude .acu-data-display {
                    box-shadow: none !important;
                    border: 1px solid var(--acu-border) !important;
                    border-radius: 8px !important;
                }
                /* 胶囊折叠态：保留 50px 圆角，只接管边框/阴影 */
                .acu-theme-claude .acu-nav-container.acu-collapse-pill {
                    box-shadow: none !important;
                    border: 1px solid var(--acu-border) !important;
                }
                .acu-quick-view-card.acu-theme-claude {
                    box-shadow: none !important;
                    border: 1px solid var(--acu-border) !important;
                }
                /* hover 才给阴影（design-rules.md 上下文 Token 表：默认模式 hover 时显示） */
                .acu-theme-claude .acu-data-card:hover {
                    box-shadow: 0 2px 8px rgba(20, 20, 19, 0.06) !important;
                    border-color: #9B9890 !important;
                }
                /* 按钮：小圆角 + 官方缓动；强调按钮用暖橙，不用渐变 */
                .acu-theme-claude .acu-nav-btn,
                .acu-theme-claude .acu-action-btn,
                .acu-theme-claude .acu-opt-btn,
                .acu-theme-claude .acu-page-btn,
                .acu-theme-claude .acu-header-btn,
                .acu-theme-claude .acu-btn-block,
                .acu-theme-claude .acu-dialog-btn {
                    border-radius: 4px !important;
                    box-shadow: none !important;
                    transition: background var(--acu-claude-ease) 150ms,
                                border-color var(--acu-claude-ease) 150ms,
                                color var(--acu-claude-ease) 150ms !important;
                }
                /* 表格：官方 Table 组件是 subtle 分隔线 + raised 底 hover，没有斑马纹。
                   .acu-grid-item 也要一起软化，否则网格格子的边比相邻行明显硬一档。 */
                .acu-theme-claude .acu-full-item,
                .acu-theme-claude .acu-inline-item,
                .acu-theme-claude .acu-grid-item {
                    border-color: #E8E6DC !important;
                }
                /* 面板头/脚的圆角也要跟着卡片对齐到 8px，否则 12px 的头压在 8px 的面板里，
                   顶部两角会露出一线 #ECE9E0 的色差（和上面 .acu-card-header 同类问题）。 */
                .acu-theme-claude .acu-panel-header {
                    border-radius: 8px 8px 0 0 !important;
                }
                .acu-theme-claude .acu-inline-item {
                    border-bottom-style: solid !important;
                }
                /* 选项面板：纸感底 + 边框，橙色只用在 hover/激活，避免大面积橙 */
                .acu-theme-claude .acu-opt-btn:hover {
                    border-color: #D97757 !important;
                    background: rgba(217, 119, 87, 0.08) !important;
                }
                /* 选项按钮装的是整句中文，官方 typography-cn 要求中文行高 1.7–1.8、
                   正文字号下限 15px；再按 space-3/space-4 给足内距，免得长句挤成两行还贴边。
                   列数是用户设置项（--acu-opt-btn-w），不在主题里改；这里只把断行方式从
                   break-word 换成 normal，避免「回春/丹」这种末行只剩一个字的孤字。 */
                .acu-theme-claude .acu-opt-btn {
                    padding: 12px 16px !important;
                    line-height: 1.75 !important;
                    min-height: 44px !important;
                    word-break: normal !important;
                    /* 必须是 anywhere 不能是 break-word：break-word 不参与 min-content 计算，
                       flex 项的自动最小尺寸仍按整串不可断的宽度算，配上 .acu-opt-btn 自带的
                       overflow:hidden 会把超出部分静默裁掉（实测长 URL 287px 挤进 179px）。
                       anywhere 会缩 min-content，长串正常折行，中文不产生孤字的收益也保留。 */
                    overflow-wrap: anywhere !important;
                }
                /* 弹窗：官方 Modal 用 bg-overlay 纸白 + lg 圆角 */
                .acu-theme-claude.acu-edit-dialog,
                .acu-theme-claude .acu-edit-dialog {
                    border-radius: 16px !important;
                    border: 1px solid var(--acu-border) !important;
                    box-shadow: 0 4px 24px rgba(20, 20, 19, 0.10) !important;
                }
                .acu-quick-view-card.acu-theme-claude {
                    border-radius: 16px !important;
                }
                /* 卡片头：基础样式写死 12px 圆角和 dashed 边，与本主题 8px 圆角 + 实线分隔冲突。
                   dashed 用的是 --acu-border，但本主题 --acu-title-color 是近黑，视觉上过硬，
                   这里统一压成 subtle 实线，并把圆角对齐卡片的 8px 免得头部四角鼓出来。 */
                .acu-theme-claude .acu-card-header {
                    border-radius: 8px 8px 0 0 !important;
                    border-bottom: 1px solid #E8E6DC !important;
                }
                /* 标题用衬线体呼应官方 Lora/DM Serif 的「温暖有机」气质，
                   正文保持无衬线以便扫读（工具优先模式的原话：衬线体不利于快速浏览）。 */
                .acu-theme-claude .acu-panel-title,
                .acu-theme-claude .acu-quick-view-header,
                .acu-theme-claude .acu-editable-title,
                .acu-theme-claude .acu-card-header {
                    font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Noto Serif CJK SC', 'Songti SC', 'STSong', Georgia, serif !important;
                    letter-spacing: 0.01em;
                }
                /* 中文排版：官方 typography-cn 要求正文行高 1.7–1.8（1.55 对中文偏紧） */
                .acu-theme-claude .acu-full-value,
                .acu-theme-claude .acu-inline-value,
                .acu-theme-claude .acu-grid-value {
                    line-height: 1.75 !important;
                }

                .acu-badge-pending { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-15deg); width: 80px; height: 80px; border: 4px solid #e74c3c; border-radius: 50%; color: #e74c3c; font-size: 20px; font-weight: 900; display: flex; align-items: center; justify-content: center; z-index: 50; pointer-events: none; opacity: 0.6; box-shadow: inset 0 0 10px rgba(231, 76, 60, 0.2); background: rgba(255,255,255,0.1); }
                @keyframes acu-alert-pulse { 0% { box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(231, 76, 60, 0); } 100% { box-shadow: 0 0 0 0 rgba(231, 76, 60, 0); } }
                .acu-btn-save-mode { color: #e74c3c !important; border-color: #e74c3c !important; animation: acu-alert-pulse 2s infinite; }

                .acu-wrapper { --acu-highlight: #d35400; --acu-highlight-bg: rgba(211, 84, 0, 0.1); --acu-title-color: var(--acu-text-main); z-index: 20000; }
                ${themeCss}
                .acu-wrapper { position: relative; width: 100%; margin: 10px 0 10px 0; z-index: 20000; display: flex; flex-direction: column; contain: layout; }
                .acu-nav-container { display: flex; gap: 0; padding: 6px; background: var(--acu-bg-nav); border: 1px solid var(--acu-border); border-radius: 14px; box-shadow: 0 4px 15px var(--acu-shadow); position: relative; z-index: 20001; backdrop-filter: blur(5px); flex-direction: column; }
                .acu-nav-tabs-area { display: grid; grid-template-columns: var(--acu-nav-cols, repeat(auto-fill, minmax(110px, 1fr))); gap: 6px; width: 100%; }
                .acu-nav-separator { width: 100%; height: 1px; border-top: 1px dashed var(--acu-border); margin: 6px 0 6px 0; opacity: 0.6; }
                .acu-nav-actions-area { display: flex; gap: 6px; width: 100%; justify-content: center; align-items: center; background: transparent; padding-top: 4px; }
                .acu-nav-btn { width: 100%; display: flex; align-items: center; justify-content: center; gap: 4px; padding: 5px 2px; border: 1px solid var(--acu-border); background-origin: border-box; border-radius: 8px; background: var(--acu-btn-bg); color: var(--acu-text-main); font-weight: 600; font-size: 13px; cursor: pointer; transition: all 0.2s ease; user-select: none; text-align: center; white-space: nowrap; overflow: hidden; } .acu-nav-btn i { font-size: 0.85em; }
                .acu-nav-btn span { overflow: hidden; text-overflow: ellipsis; }
                .acu-nav-btn:hover { background: var(--acu-btn-hover); transform: translateY(-2px); }
                .acu-nav-btn.active { background: var(--acu-btn-active-bg); color: var(--acu-btn-active-text); box-shadow: 0 2px 6px rgba(0,0,0,0.15); }
                .acu-action-btn { flex: 1; height: 30px; display: flex; align-items: center; justify-content: center; background: var(--acu-btn-bg); border-radius: 8px; color: var(--acu-text-sub); cursor: pointer; border: 1px solid var(--acu-border); transition: all 0.2s; font-size: 10px; }
                .acu-action-btn:hover { background: var(--acu-btn-hover); color: var(--acu-text-main); transform: scale(1.1); border-color: var(--acu-border); }
                #acu-btn-save-global:hover { background: var(--acu-btn-active-bg); color: var(--acu-btn-active-text); }

                .acu-option-panel { display: flex; flex-wrap: wrap; justify-content: center; align-items: stretch; gap: 8px; padding: 8px; background: var(--acu-bg-nav); border: 1px solid var(--acu-border); border-radius: 12px; margin-bottom: 8px; backdrop-filter: blur(5px); width: 100%; box-sizing: border-box; z-index: 20001; contain: layout style; transition: opacity 0.15s ease-out; opacity: 1; }
                .acu-opt-btn { background: var(--acu-card-bg); border: 1px solid var(--acu-border); box-shadow: 0 2px 5px var(--acu-shadow); padding: 8px 15px; border-radius: 8px; cursor: pointer; color: var(--acu-text-main); font-size: var(--acu-opt-font-size); transition: all 0.2s; font-weight: 500; user-select: none; text-align: left; width: auto; flex: 1 1 var(--acu-opt-btn-w, calc((100% - 16px) / 3)); max-width: var(--acu-opt-btn-w, calc((100% - 16px) / 3)); box-sizing: border-box; overflow: hidden; white-space: pre-wrap; word-break: break-word; min-height: 38px; display: flex; align-items: center; }
                .acu-opt-btn:focus { outline: none; scroll-margin: 0; }
                .acu-opt-btn:hover { background: var(--acu-highlight); color: #fff; transform: translateY(-2px); border-color: var(--acu-highlight); box-shadow: 0 4px 10px var(--acu-highlight-bg); }
                .acu-opt-btn:active { transform: translateY(0); opacity: 0.8; }
                .acu-opt-header { flex: 0 0 100%; width: 100%; text-align: center; font-size: 12px; font-weight: bold; color: var(--acu-title-color); padding: 2px 0; border-bottom: 1px dashed var(--acu-border); margin-bottom: 4px; opacity: 0.9; }

                .acu-data-display { position: absolute; bottom: calc(100% +  8px); left: 0; right: 0; max-height: 95vh; height: auto; background: var(--acu-bg-panel); border: 1px solid var(--acu-border); border-radius: 12px; box-shadow: 0 12px 40px var(--acu-shadow); display: none; flex-direction: column; z-index: 20002; animation: popUp 0.25s cubic-bezier(0.34, 1.56, 0.64, 1); backdrop-filter: blur(8px); overflow: hidden; }
                .acu-data-display.visible { display: flex; }
                .acu-no-anim { animation: none !important; transform: none !important; }
                @keyframes popUp { from { opacity: 0; transform: translateY(15px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

                .acu-wrapper *:focus { scroll-margin: 0 !important; scroll-padding: 0 !important; outline: none !important; }
                .acu-nav-btn, .acu-action-btn, .acu-opt-btn, .acu-page-btn, .acu-header-btn, .acu-btn-block, .acu-dialog-btn, .acu-dash-interactive, .acu-grid-item, .acu-full-item, .acu-inline-item, .acu-editable-title, .acu-tab-btn, .acu-close-pill, .acu-cell-menu-item, .acu-slot-setting-btn { -webkit-tap-highlight-color: transparent; }
                .acu-data-display { contain: layout style; }
                .acu-data-display:not(.visible) { visibility: hidden; pointer-events: none; position: absolute; }

                .acu-panel-header { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: var(--acu-table-head); border-bottom: 1px solid var(--acu-border); border-radius: 12px 12px 0 0; }
                .acu-panel-title { font-weight: bold; color: var(--acu-text-main); display: flex; align-items: center; gap: 8px; white-space: nowrap; font-size: calc(var(--acu-font-size) + 1px); }
                .acu-header-actions { display: flex; align-items: center; gap: 6px; }
                .acu-search-wrapper { position: relative; display: flex; align-items: center; }
                .acu-search-input { height: 32px; box-sizing: border-box; background: var(--acu-btn-bg); border: 1px solid var(--acu-border); color: var(--acu-text-main); padding: 0 10px; border-radius: 8px; font-size: 12px; width: 100px; transition: all 0.2s; }
                .acu-search-input:focus { width: 140px; outline: none; border-color: var(--acu-highlight); background: var(--acu-input-bg); }
                .acu-search-icon { position: absolute; left: 10px; font-size: 10px; color: var(--acu-text-sub); pointer-events: none; }
                
                .acu-header-btn { width:  28px; height:  28px; display: flex; align-items: center; justify-content: center; border-radius: 8px; border: 1px solid var(--acu-border); background: var(--acu-btn-bg); color: var(--acu-text-sub); cursor: pointer; transition: all 0.2s; font-size:  12px; flex-shrink: 0; }
                .acu-header-btn:hover { background: var(--acu-btn-hover); color: var(--acu-text-main); transform: translateY(-1px); border-color: var(--acu-highlight); box-shadow: 0 2px 6px var(--acu-shadow); }
                .acu-header-btn:active { background: var(--acu-btn-active-bg); color: var(--acu-btn-active-text); transform: translateY(0); border-color: transparent; }
                .acu-header-btn#acu-btn-close:hover, .acu-header-btn#qv-close:hover { color: #e74c3c; border-color: #e74c3c; background: var(--acu-btn-hover); }
                .acu-header-btn#acu-btn-close i { transform: scale(1.3); transition: transform 0.2s; }

                .acu-panel-content { flex: 1; padding: 15px; padding-bottom: 10px; background: transparent;  overflow-y: auto; overflow-x: hidden; }
                .acu-panel-content::-webkit-scrollbar, .acu-dash-container::-webkit-scrollbar, .acu-edit-textarea::-webkit-scrollbar, .acu-card-edit-input::-webkit-scrollbar, .acu-settings-content::-webkit-scrollbar, .acu-quick-view-body::-webkit-scrollbar, .acu-dash-npc-grid::-webkit-scrollbar { width: 6px; height: 6px; } 
                
                .acu-panel-content::-webkit-scrollbar-thumb, 
                .acu-dash-container::-webkit-scrollbar-thumb, 
                .acu-edit-textarea::-webkit-scrollbar-thumb, 
                .acu-card-edit-input::-webkit-scrollbar-thumb, 
                .acu-settings-content::-webkit-scrollbar-thumb, 
                .acu-quick-view-body::-webkit-scrollbar-thumb, 
                .acu-dash-npc-grid::-webkit-scrollbar-thumb { 
                    background-color: transparent; 
                    border-radius: 3px; 
                    transition: background-color 0.2s; 
                }
                .acu-show-scroll::-webkit-scrollbar-thumb { 
                    background-color: var(--acu-text-sub) !important; 
                }

                

                .acu-panel-footer { flex: 0 0 auto; padding: 8px; border-top: 1px dashed var(--acu-border); background: var(--acu-table-head); display: flex; justify-content: center; align-items: center; gap: 5px; flex-wrap: wrap; }
                .acu-page-btn { padding: 4px 10px; min-width: 32px; height: 28px; border-radius: 4px; border: 1px solid var(--acu-border); background: var(--acu-btn-bg); color: var(--acu-text-main); cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
                .acu-page-btn:hover:not(:disabled):not(.active) { background: var(--acu-btn-hover); color: var(--acu-text-main); transform: translateY(-1px); }
                .acu-page-btn.active { background: var(--acu-btn-active-bg); color: var(--acu-btn-active-text); border-color: transparent; box-shadow: 0 2px 6px rgba(0,0,0,0.15); font-weight: bold; }
                .acu-page-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .acu-page-info { font-size: 12px; color: var(--acu-text-sub); margin: 0 10px; }

                .acu-dash-container { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0; height: 100%; padding: 0; overflow: hidden; box-sizing: border-box; font-size: var(--acu-dash-font-size, var(--acu-font-size)); } .acu-dash-col { display: flex; flex-direction: column; gap: 0; height: 100%; overflow: hidden; }
                @media (max-width: 768px) { .acu-dash-container { grid-template-columns: 1fr; overflow-y: auto; display: flex; flex-direction: column; height: auto; } .acu-dash-col { height: auto; flex: none; overflow: visible; } }
                .acu-dash-card { background: var(--acu-card-bg); border-radius: 0; border: none; padding: 16px; display: flex; flex-direction: column; gap: 12px; box-shadow: none; }
                .acu-dash-title { font-size: var(--acu-dash-font-size, var(--acu-font-size)); font-weight: bold; color: var(--acu-highlight); border-bottom: 1px dashed var(--acu-border); padding-bottom: 8px; margin-bottom: 4px; display: flex; justify-content: center; align-items: center; }
                .acu-dash-char-info { display: flex; flex-direction: column; gap: 10px; } @media (min-width: 769px) { .acu-dash-top-kv { display: grid !important; grid-template-columns: 1fr 1fr; } }
                .acu-dash-stat-row { display: flex; justify-content: space-between; align-items: center; padding: 8px; background: var(--acu-btn-bg); border-radius: 8px; }
                .acu-dash-stat-label { color: var(--acu-text-sub); font-size: 0.9em; }
                .acu-dash-stat-val { color: var(--acu-text-main); font-weight: bold; font-size: 1.1em; }
                .acu-dash-npc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; height: 100%; overflow-y: auto; padding-right: 4px; scrollbar-width: thin; align-content: start; }
                
                
                .acu-dash-npc-item { background: var(--acu-table-head); padding: 10px; border-radius: 8px; cursor: default; text-align: center; border: 1px solid transparent; transition: all 0.2s; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--acu-text-main); font-size: 1em; }
                .acu-dash-npc-item:hover { border-color: var(--acu-highlight); color: var(--acu-highlight); background: var(--acu-btn-bg); }
                .acu-dash-sub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: auto; }
                .acu-dash-list-item { padding: 6px 0; border-bottom: 1px solid var(--acu-border); color: var(--acu-text-sub); font-size: 1em; display: flex; align-items: center; gap: 6px; cursor: default; }
                .acu-dash-list-item:hover { color: var(--acu-text-main); padding-left: 4px; }
                .acu-dash-list-item i { font-size: 0.8em; color: var(--acu-highlight); }
                
                .acu-dash-interactive { cursor: pointer !important; position: relative; }
                
                
                .acu-tab-header { display: flex; gap: 5px; border-bottom: 1px solid var(--acu-border); margin-bottom: 10px; }
                .acu-tab-btn { padding: 6px 12px; cursor: pointer; font-size: var(--acu-dash-font-size, var(--acu-font-size)); font-weight: bold; color: var(--acu-text-sub); border-bottom: none; transition: all 0.2s; flex: 1; text-align: center; }
                .acu-tab-btn:hover { color: var(--acu-text-main); background: var(--acu-table-hover); border-radius: 4px 4px 0 0; }
                .acu-tab-btn.active { color: var(--acu-highlight);  }
                .acu-tab-pane { display: none; animation: fadeIn 0.3s; }
                .acu-tab-pane.active { display: block; }
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

                .acu-quick-view-overlay { position: fixed !important; top: 0; left: 0; right: 0; bottom: 0; width: 100vw; height: 100vh; background: var(--acu-overlay-bg) !important; z-index: 2147483648 !important; display: flex !important; justify-content: center !important; align-items: center !important; backdrop-filter: blur(4px); }
                .acu-quick-view-card { background: var(--acu-card-bg); border-radius: 12px; border: 1px solid var(--acu-border); box-shadow: 0 15px 50px var(--acu-shadow); width: 90%; max-width: 450px; max-height: 80vh; display: flex; flex-direction: column; overflow: hidden; animation: popUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); color: var(--acu-text-main); }
                .acu-quick-view-header { padding: 5px; background: var(--acu-table-head); border-bottom: 1px solid var(--acu-border); font-weight: bold; display: flex; justify-content: space-between; align-items: center; font-size: 1.1em; color: var(--acu-highlight); }
                .acu-quick-view-body { padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; scrollbar-width: thin; }
                
                

                .acu-layout-vertical .acu-card-grid { display: flex; flex-wrap: wrap; justify-content: center; gap: 14px; }
                .acu-layout-vertical .acu-data-card { flex: 0 0 var(--acu-card-width, 280px); width: var(--acu-card-width, 280px); }
                .acu-layout-horizontal .acu-panel-content { display: block; white-space: nowrap; overflow-x: auto !important; overflow-y: hidden; }
                .acu-layout-horizontal .acu-card-grid { display: inline-flex; flex-wrap: nowrap; gap: 14px; height: 100%; align-items: flex-start; padding-bottom: 10px; min-width: 100%; }
                .acu-layout-horizontal .acu-data-card { flex: 0 0 var(--acu-card-width, 280px); width: var(--acu-card-width, 280px); max-height: 98%; overflow-y: auto; white-space: normal; }

                .acu-data-card { background: var(--acu-card-bg); border: 1px solid var(--acu-border); box-shadow: 0 2px 8px var(--acu-shadow); border-radius: 12px; transition: all 0.25s ease; display: flex; flex-direction: column; position: relative; overflow: hidden; }
                
                .acu-card-checkbox, .acu-reverse-check, .acu-kv-col-check {
                    appearance: none !important;
                    -webkit-appearance: none !important;
                    width: 18px !important;
                    height: 18px !important;
                    border: 1px solid var(--acu-border) !important;
                    border-radius: 4px !important;
                    background-color: var(--acu-input-bg) !important;
                    cursor: pointer !important;
                    position: relative !important;
                    box-sizing: border-box !important;
                    margin: 0 !important;
                    display: inline-block !important;
                    box-shadow: inset 0 1px 2px rgba(0,0,0,0.1) !important;
                }
                .acu-card-checkbox {
                    position: absolute !important; 
                    right: 10px !important; 
                    top: 50% !important; 
                    transform: translateY(-50%) !important; 
                    z-index: 10 !important;
                }
                .acu-card-checkbox:checked, .acu-reverse-check:checked, .acu-kv-col-check:checked {
                    background: var(--acu-ui-color, var(--acu-highlight, #0ea5e9)) !important;
                    border-color: var(--acu-ui-color, var(--acu-highlight, #0ea5e9)) !important;
                    box-shadow: 0 0 5px var(--acu-ui-color, var(--acu-highlight, #0ea5e9)) !important;
                }
                .acu-card-checkbox:checked::after, .acu-reverse-check:checked::after, .acu-kv-col-check:checked::after {
                    content: '' !important;
                    position: absolute !important;
                    left: 6px !important;
                    top: 2px !important;
                    width: 4px !important;
                    height: 8px !important;
                    border: solid white !important;
                    border-width: 0 2px 2px 0 !important;
                    transform: rotate(45deg) !important;
                }

                .acu-layout-vertical .acu-data-card:hover { transform: translateY(-4px); box-shadow: 0 8px 25px var(--acu-shadow); z-index: 5; }
                .acu-card-header { padding: 6px 24px; background: var(--acu-table-head); border-bottom: 1px dashed var(--acu-border); border-radius: 12px 12px 0 0; font-weight: bold; color: var(--acu-title-color); font-size: 14px; display: flex; justify-content: center; align-items: center; position: relative; flex: 0 0 auto; }
                .acu-editable-title { cursor: pointer; border-bottom: 1px dashed transparent; transition: all 0.2s; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: calc(var(--acu-font-size) + 1px); font-weight: 800; text-align: center; width: 100%; padding: 2px 5px; border-radius: 4px; }
                .acu-editable-title:hover { background: var(--acu-table-hover); color: var(--acu-highlight); }
                .acu-card-index { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: 10px; color: var(--acu-text-sub); font-weight: normal; background: var(--acu-badge-bg); padding: 1px 6px; border-radius: 8px; opacity: 0.8; }
                .acu-card-body { padding: 0; display: flex; flex-direction: column; gap: 0; font-size: var(--acu-font-size, 13px); }
                .acu-card-main-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 12px; }
                .acu-grid-item { display: flex; flex-direction: column; gap: 2px; padding: 4px 6px; border-radius: 6px; cursor: pointer; overflow: hidden; border: 1px solid var(--acu-border); background: rgba(0,0,0,0.02); }
                .acu-grid-item:hover { background: var(--acu-table-hover); }
                .acu-grid-label { font-size: var(--acu-font-size, 13px); color: var(--acu-title-color); font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .acu-grid-value { font-size: var(--acu-font-size, 13px); color: var(--acu-text-main); font-weight: 500; white-space: pre-wrap; word-break: break-word; line-height: 1.35; }
                .acu-card-full-area { display: flex; flex-direction: column; gap: 0; padding: 0 12px 10px 12px; }
                .acu-full-item { display: flex; flex-direction: column; gap: 2px; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--acu-border); background: rgba(0,0,0,0.02); cursor: pointer; margin-top: 4px; }
                .acu-full-item:hover { background: var(--acu-table-hover); }
                .acu-full-label { font-size: var(--acu-font-size, 13px); color: var(--acu-title-color); font-weight: bold; }
                .acu-full-value { font-size: var(--acu-font-size, 13px); color: var(--acu-text-main); line-height: 1.4; word-break: break-all; white-space: pre-wrap; max-height: var(--acu-text-max-height, 80px); overflow-y: var(--acu-text-overflow, auto); scrollbar-width: none; }
                
                .acu-inline-item { display: block; padding: 2px 8px; border-bottom: 1px dashed var(--acu-border); cursor: pointer; max-height: var(--acu-text-max-height, 80px); overflow-y: var(--acu-text-overflow, auto); scrollbar-width: none; }
                .acu-inline-item:last-child { border-bottom: none; }
                .acu-inline-item:hover { background: var(--acu-table-hover); }
                .acu-inline-label { display: inline; color: var(--acu-title-color); font-weight: bold; font-size: var(--acu-font-size, 13px); line-height: 1.4; margin-right: 4px; }
                .acu-inline-label::after { content: '：'; }
                .acu-inline-value { display: inline; color: var(--acu-text-main); font-size: var(--acu-font-size, 13px); line-height: 1.4; word-break: break-word; white-space: pre-wrap; }
                .acu-inline-value.acu-highlight-changed { display: inline; }

                .acu-highlight-changed { color: var(--acu-highlight) !important; background-color: var(--acu-highlight-bg); border-radius: 4px; padding: 0 4px; font-weight: bold; animation: pulse-highlight 2s infinite; display: inline-block; }
                @keyframes pulse-highlight { 0% { opacity: 0.7; } 50% { opacity: 1; } 100% { opacity: 0.7; } }
                @keyframes acu-shake { 0% { transform: rotate(0deg); } 25% { transform: rotate(10deg); } 50% { transform: rotate(0deg); } 75% { transform: rotate(-10deg); } 100% { transform: rotate(0deg); } }

                .acu-menu-backdrop { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: transparent; z-index: 2147483640; }
                .acu-cell-menu { position: fixed !important; background: var(--acu-menu-bg) !important; border: 1px solid var(--acu-border) !important; color: var(--acu-text-main) !important; box-shadow: 0 6px 20px var(--acu-shadow) !important; z-index: 2147483647 !important; border-radius: 8px; overflow: hidden; min-width: 150px; backdrop-filter: blur(5px); }
                .acu-cell-menu-item { padding: 12px 16px; cursor: pointer; font-size: 14px; display: flex; gap: 12px; align-items: center; color: var(--acu-text-main); font-weight: 500; background: transparent; }
                .acu-cell-menu-item:hover { background-color: var(--acu-table-hover); }
                .acu-cell-menu-item#act-delete { color: #e74c3c; }

                .acu-edit-overlay { position: fixed !important; top: 0; left: 0; right: 0; bottom: 0; width: 100vw; height: 100vh; background: var(--acu-overlay-bg) !important; z-index: 2147483646 !important; display: flex !important; justify-content: center !important; align-items: center !important; backdrop-filter: blur(2px); }
                .acu-edit-dialog { background-color: var(--acu-bg-panel) !important; width: 90%; max-width: 900px; max-height: 85vh; border-radius: 12px; display: flex; flex-direction: column; box-shadow: 0 15px 50px var(--acu-shadow); color: var(--acu-text-main) !important; border: 1px solid var(--acu-border); margin: auto !important; overflow: hidden; padding: 0; }
                .acu-edit-title { flex: 0 0 auto; margin: 0; padding: 20px 24px; font-size: 16px; font-weight: bold; color: var(--acu-text-main); border-bottom: 1px solid var(--acu-border); }
                .acu-settings-content { flex: 1; overflow-y: auto; padding: 20px 24px; display: block; }
                .acu-edit-textarea { width: 100%; flex: 1; min-height: 200px; max-height: 60vh; padding: 12px; border: 1px solid var(--acu-border); background-color: var(--acu-input-bg) !important; color: var(--acu-text-main) !important; border-radius: 6px; resize: vertical; box-sizing: border-box; font-size: 14px; line-height: 1.5; font-family: monospace; overflow-y: auto; }
                .acu-dialog-btns { flex: 0 0 auto; display: flex; justify-content: center; gap: 20px; padding: 16px 24px; border-top: 1px solid var(--acu-border); background: var(--acu-bg-panel); }
                .acu-dialog-btn { background: none; border: none; cursor: pointer; font-size: 14px; font-weight: bold; display: flex; align-items: center; gap: 6px; color: var(--acu-text-sub); transition: color 0.2s; }
                .acu-order-controls { display: none; width: 100%; text-align: center; background: var(--acu-table-head); padding: 5px; margin-bottom: 5px; border-radius: 4px; border: 1px dashed var(--acu-border); }
                .acu-order-controls.visible { display: block; }
                .acu-nav-container.editing-order .acu-nav-btn, .acu-nav-container.editing-order .acu-action-btn { border: 1px dashed #f0ad4e; cursor: grab; opacity: 0.8; }
                .acu-divider { width: 1px; height: 18px; background: var(--acu-border); margin: 0 6px; }
                .acu-nav-container.collapsed > *:not(#acu-btn-toggle):not(.acu-collapsed-text) { display: none !important; }
                .acu-nav-container.collapsed { width: 100%; justify-content: center; cursor: pointer; padding: 8px 0; flex-direction: column; gap: 0; height: auto; transition: all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1); }
                .acu-nav-container.collapsed.acu-collapse-pill { width: auto !important; border-radius: 50px; padding: 8px 25px; margin-top: 5px; box-shadow: 0 5px 15px var(--acu-shadow); background: var(--acu-bg-nav); border: 1px solid var(--acu-border); }
                .acu-nav-container.collapsed.acu-collapse-pill.acu-pill-center { align-self: center; }
                .acu-nav-container.collapsed.acu-collapse-pill.acu-pill-left { align-self: flex-start; margin-left: 15px; }
                .acu-nav-container.collapsed.acu-collapse-pill.acu-pill-right { align-self: flex-end; margin-right: 15px; }
                .acu-nav-container.collapsed.acu-collapse-pill:hover { transform: scale(1.05); border-color: var(--acu-highlight); color: var(--acu-highlight); }
                .acu-nav-container.collapsed.acu-collapse-pill #acu-btn-toggle { display: none !important; }
                .acu-nav-container.collapsed.acu-collapse-pill .acu-collapsed-text { display: block; font-size: 12px; margin: 0; font-weight: bold; }
                .acu-nav-container.collapsed #acu-btn-toggle { background: transparent; border: none; width: 100%; pointer-events: none; height: 24px; }
                .acu-collapsed-text { display: none; font-size: 12px; color: var(--acu-text-sub); margin-top: 2px; text-align: center; width: 100%; pointer-events: none; font-weight: bold; letter-spacing: 1px; }
                .acu-nav-container.collapsed .acu-collapsed-text { display: block; }

                .acu-height-drag-handle { cursor: ns-resize !important; touch-action: none; }
                .acu-height-drag-handle.active { color: var(--acu-highlight); background: var(--acu-table-hover); }
                
                .acu-btn-block { width: 100%; padding: 10px; background: var(--acu-table-head); color: var(--acu-text-main); border: 1px solid var(--acu-border); border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 10px; }
                
                

                

                .acu-switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; -webkit-tap-highlight-color: transparent; }
                .acu-switch input { opacity: 0; width: 0; height: 0; }
                .acu-switch-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .3s; border-radius: 22px; }
                .acu-switch-slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 3px; bottom: 3px; background-color: white; transition: .3s; border-radius: 50%; }
                .acu-switch input:checked + .acu-switch-slider { background-color: var(--acu-highlight); opacity: 1; box-shadow: 0 0 8px var(--acu-highlight); filter: brightness(1.3); }
                .acu-switch input:checked + .acu-switch-slider:before { transform: translateX(18px); }
                
                .acu-card-edit-field { margin-bottom: 10px; }
                .acu-card-edit-label { display: block; font-size: 12px; color: var(--acu-highlight); font-weight: bold; margin-bottom: 4px; }
                .acu-card-edit-input { width: 100%; min-height: 38px; padding: 8px; border: 1px solid var(--acu-border); background: var(--acu-input-bg); color: var(--acu-text-main); border-radius: 6px; resize: none; overflow-y: hidden; line-height: 1.4; font-family: inherit; font-size: 14px; box-sizing: border-box; }
                .acu-card-edit-input:focus { border-color: var(--acu-highlight); outline: none; }
                .acu-cell-menu-item#act-edit-card { color: var(--acu-highlight); }
                .acu-cell-menu-item#act-insert { color: #2980b9; }
                .acu-wrapper button:focus, .acu-edit-dialog button:focus, .acu-cell-menu button:focus { outline: none !important; }
                
                
                .acu-nav-container {
                    backdrop-filter: blur(16px) saturate(150%);
                    -webkit-backdrop-filter: blur(16px) saturate(150%);
                }
                .acu-data-display {
                    backdrop-filter: blur(20px) saturate(180%);
                    -webkit-backdrop-filter: blur(20px) saturate(180%);
                }
                
                .acu-theme-aurora .acu-data-card::before, .acu-theme-sunset .acu-data-card::before, .acu-theme-starship .acu-data-card::before, .acu-theme-sky .acu-data-card::before {
                    content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0;
                    background: linear-gradient(135deg, var(--acu-highlight), var(--acu-text-sub));
                    border-radius: inherit; z-index: -1; opacity: 0; transition: opacity 0.3s ease; filter: blur(8px);
                }
                .acu-theme-aurora .acu-data-card:hover::before, .acu-theme-sunset .acu-data-card:hover::before, .acu-theme-starship .acu-data-card:hover::before, .acu-theme-sky .acu-data-card:hover::before { opacity: 0.3; }
                
                @media (max-width: 768px) {
                    .acu-nav-btn {
                        padding: 8px 1px !important;
                        font-size: 11px !important;
                    } .acu-nav-btn i { font-size: 0.85em; }
                    .acu-nav-actions-area {
                         padding-top: 2px !important;
                         gap: 8px !important;
                         display: flex !important;
                         width: 100% !important;
                    }
                    .acu-action-btn {
                         width: auto !important;
                         flex: 1 !important;
                         height: 30px !important;
                         border-radius: 8px !important;
                         background: var(--acu-btn-bg);
                         margin: 0 !important;
                    }
                    .acu-opt-btn {
                         white-space: normal !important;
                         height: auto !important;
                    }
                }

                
                .acu-edit-dialog.acu-theme-aurora, .acu-edit-dialog.acu-theme-starship, .acu-edit-dialog.acu-theme-sunset, .acu-edit-dialog.acu-theme-sky {
                     background-image: none !important;
                }
                .acu-edit-dialog.acu-theme-aurora { background-color: #0f172a !important; }
                .acu-edit-dialog.acu-theme-aurora textarea, .acu-edit-dialog.acu-theme-aurora input:not([type="checkbox"]):not([type="radio"]):not([type="color"]) { background-color: #1e293b !important; }

                .acu-edit-dialog.acu-theme-dark { background-color: rgba(20, 20, 20, 0.98) !important; }
                .acu-edit-dialog.acu-theme-dark textarea, .acu-edit-dialog.acu-theme-dark input:not([type="checkbox"]):not([type="radio"]):not([type="color"]) { background-color: rgba(15, 15, 15, 0.95) !important; color: #f5f5f5 !important; border-color: #666 !important; }

                .acu-edit-dialog.acu-theme-starship { background-color: #0b0f19 !important; }
                .acu-edit-dialog.acu-theme-starship textarea, .acu-edit-dialog.acu-theme-starship input:not([type="checkbox"]):not([type="radio"]):not([type="color"]) { background-color: #1e293b !important; }

                .acu-edit-dialog.acu-theme-sunset { background-color: #fffbf0 !important; }
                .acu-edit-dialog.acu-theme-sunset textarea, .acu-edit-dialog.acu-theme-sunset input:not([type="checkbox"]):not([type="radio"]):not([type="color"]) { background-color: #ffffff !important; border-color: #fed7aa !important; }
                .acu-edit-dialog.acu-theme-sky { background-color: #f0f9ff !important; }
                .acu-edit-dialog.acu-theme-sky textarea, .acu-edit-dialog.acu-theme-sky input:not([type="checkbox"]):not([type="radio"]):not([type="color"]) { background-color: #ffffff !important; border-color: #bae6fd !important; }
                
                /* 苹果主题设置弹窗：毛玻璃材料化——半透明白背景 + blur，替代默认纯色面板。
                   内联样式 background-color !important 优先级高，此处同样 !important 覆盖。 */
                .acu-edit-dialog.acu-theme-apple {
                    background-color: rgba(250, 250, 252, 0.55) !important;
                    -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
                    backdrop-filter: blur(24px) saturate(180%) !important;
                    border-top: 1px solid rgba(255, 255, 255, 0.7) !important;
                    border-left: 1px solid rgba(255, 255, 255, 0.45) !important;
                }
                .acu-edit-dialog.acu-theme-apple textarea,
                .acu-edit-dialog.acu-theme-apple input:not([type="checkbox"]):not([type="radio"]):not([type="color"]),
                .acu-edit-dialog.acu-theme-apple select {
                    background-color: rgba(255, 255, 255, 0.6) !important;
                    border-color: rgba(0, 0, 0, 0.08) !important;
                    color: #1d1d1f !important;
                }
                .acu-edit-dialog.acu-theme-apple .acu-section-header {
                    border-bottom: 1px solid rgba(0, 0, 0, 0.06) !important;
                }
                /* 苹果主题 overlay（JS 已给 overlay 加 acu-theme-apple 类）：更轻压暗 + 更强模糊，
                   让弹窗毛玻璃背景透出聊天内容而非黑幕。 */
                .acu-edit-overlay.acu-theme-apple {
                    background: rgba(0, 0, 0, 0.28) !important;
                    -webkit-backdrop-filter: blur(6px) !important;
                    backdrop-filter: blur(6px) !important;
                }
                /* 苹果主题详情弹窗（点单元格/卡片弹出的快速查看）：
                   默认只有 background: var(--acu-card-bg)，苹果主题下那是 rgba(255,255,255,0.6)——
                   半透明白底却没有 backdrop-filter，深色文字直接压在聊天内容上，几乎读不了。
                   这里补上与设置弹窗一致的毛玻璃材料 + 提高底色不透明度保证对比度。 */
                .acu-quick-view-card.acu-theme-apple {
                    background: rgba(250, 250, 252, 0.72) !important;
                    -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
                    backdrop-filter: blur(24px) saturate(180%) !important;
                    border-top: 1px solid rgba(255, 255, 255, 0.7) !important;
                    border-left: 1px solid rgba(255, 255, 255, 0.45) !important;
                    color: #1d1d1f !important;
                }
                /* 表头/正文分区在毛玻璃上要用极浅的实色分隔，避免叠加透明层糊成一片 */
                .acu-quick-view-card.acu-theme-apple .acu-quick-view-header {
                    background: rgba(255, 255, 255, 0.5) !important;
                    border-bottom: 1px solid rgba(0, 0, 0, 0.08) !important;
                }
                .acu-quick-view-card.acu-theme-apple .acu-full-item,
                .acu-quick-view-card.acu-theme-apple .acu-grid-item {
                    background: rgba(255, 255, 255, 0.55) !important;
                    border: 1px solid rgba(0, 0, 0, 0.06) !important;
                }
                .acu-quick-view-card.acu-theme-apple .acu-full-item:hover,
                .acu-quick-view-card.acu-theme-apple .acu-grid-item:hover {
                    background: rgba(0, 122, 255, 0.08) !important;
                }
                /* 列表布局（savedStyles 缺省即 'list'，是最常见的布局）用 .acu-inline-item，
                   其分隔线是 1px dashed var(--acu-border)——苹果主题下那是 rgba(255,255,255,0.5)，
                   压在浅色毛玻璃上等于看不见。这里换成极浅实色，保证行与行分得开。 */
                .acu-quick-view-card.acu-theme-apple .acu-inline-item {
                    border-bottom-color: rgba(0, 0, 0, 0.08) !important;
                }
                .acu-quick-view-card.acu-theme-apple .acu-inline-item:hover {
                    background: rgba(0, 122, 255, 0.08) !important;
                }
                .acu-quick-view-card.acu-theme-apple .acu-full-value,
                .acu-quick-view-card.acu-theme-apple .acu-inline-value,
                .acu-quick-view-card.acu-theme-apple .acu-grid-value {
                    color: #1d1d1f !important;
                }
                .acu-quick-view-card.acu-theme-apple .acu-full-label,
                .acu-quick-view-card.acu-theme-apple .acu-inline-label,
                .acu-quick-view-card.acu-theme-apple .acu-grid-label {
                    color: #6e6e73 !important;
                }
                /* 苹果主题详情弹窗 overlay：轻压暗 + 模糊，和设置弹窗一致 */
                .acu-quick-view-overlay.acu-theme-apple {
                    background: rgba(0, 0, 0, 0.28) !important;
                    -webkit-backdrop-filter: blur(6px) !important;
                    backdrop-filter: blur(6px) !important;
                }
                /* 不支持 backdrop-filter 时设置弹窗/详情弹窗都提实背景 */
                @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
                    .acu-edit-dialog.acu-theme-apple { background-color: #f5f5f7 !important; }
                    .acu-edit-dialog.acu-theme-apple textarea,
                    .acu-edit-dialog.acu-theme-apple input:not([type="checkbox"]):not([type="radio"]):not([type="color"]),
                    .acu-edit-dialog.acu-theme-apple select { background-color: #ffffff !important; }
                    .acu-quick-view-card.acu-theme-apple { background: #f5f5f7 !important; }
                    .acu-quick-view-card.acu-theme-apple .acu-quick-view-header { background: #ffffff !important; }
                    .acu-quick-view-card.acu-theme-apple .acu-full-item,
                    .acu-quick-view-card.acu-theme-apple .acu-grid-item { background: #ffffff !important; }
                }
                
                .acu-theme-modern .acu-opt-btn { background: var(--acu-btn-bg) !important; }

                .acu-theme-dark .acu-data-card, .acu-theme-dark .acu-quick-view-card { background-color: rgba(30, 30, 30, 0.95) !important; color: #f5f5f5 !important; }
                .acu-theme-dark .acu-card-title, .acu-theme-dark .acu-card-value, .acu-theme-dark .acu-full-value { color: #f5f5f5 !important; }
                .acu-theme-dark .acu-cell-menu { background-color: rgba(25, 25, 25, 0.98) !important; color: #f5f5f5 !important; border-color: #666 !important; }
                
                .acu-full-value::-webkit-scrollbar, 
                .acu-inline-item::-webkit-scrollbar, 
                .acu-no-scrollbar::-webkit-scrollbar, .acu-data-card::-webkit-scrollbar { 
                    display: none !important; 
                    width: 0 !important; 
                    height: 0 !important; 
                    background: transparent !important;
                }
    
            .acu-embedded-dashboard-container .acu-dash-container { gap: 0 !important; padding: 0 !important; }
                .acu-embedded-dashboard-container .acu-dash-col { gap: 0 !important; }
                .acu-embedded-dashboard-container .acu-dash-card { border-radius: 0 !important; box-shadow: none !important; border: none !important; margin: 0 !important; } @media (max-width: 768px) { .acu-embedded-dashboard-container .acu-dash-container { overflow: visible !important; height: auto !important; } } /* 全局隐藏仪表盘卡槽滚动条 (嵌入+悬浮) */ .acu-dash-npc-grid::-webkit-scrollbar, .acu-dash-char-info::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; background: transparent !important; } .acu-dash-npc-grid, .acu-dash-char-info { scrollbar-width: none !important; -ms-overflow-style: none !important; } .acu-theme-aurora .acu-dash-card { background: rgba(30, 41, 59, 0.95) !important; } .acu-theme-starship .acu-dash-card { background: rgba(30, 27, 75, 0.95) !important; } .acu-theme-sky .acu-dash-card { background: rgba(240, 249, 255, 0.95) !important; } 
            </style>
        `;
        $('head').append(styles);
    };

    // 轻量指纹：每表行数 + 步长采样（前 20 行内隔行取）+ 末行全列。
    // 追平/填表主要写最新楼层（末行），也可能改更早楼层（中间行）；步长采样覆盖中间行变更，
    // 又避免对整份数据 JSON.stringify（大表/高楼层开销大）。顶层定义，供两个轮询共享。
    const lightFingerprint = (data) => {
        if (!data || typeof data !== 'object') return '';
        try {
            let out = '';
            const sheets = Object.keys(data).filter(k => k.startsWith('sheet_'));
            for (const k of sheets) {
                const s = data[k];
                if (!s || !Array.isArray(s.content) || s.content.length === 0) { out += k + ':0;'; continue; }
                out += k + ':' + s.content.length + ';';
                // 隔行采样前 20 行（步长 2）每行前 6 列，再加末行前 6 列。
                // 行数变化已由长度部分捕获。
                const ROWS_SCAN = 20, COLS_SCAN = 6;
                const n = s.content.length;
                const rowLimit = Math.min(n, ROWS_SCAN);
                for (let r = 0; r < rowLimit; r += 2) {
                    const row = s.content[r];
                    if (Array.isArray(row)) {
                        const cl = Math.min(row.length, COLS_SCAN);
                        for (let cc = 0; cc < cl; cc++) out += (row[cc] ?? '') + '|';
                    }
                    out += ';';
                }
                // 末行全列（补最新楼层写入；若末行在前 20 行内已采，此处重复但确定性一致）
                const last = s.content[n - 1];
                if (Array.isArray(last)) {
                    const cl = Math.min(last.length, COLS_SCAN);
                    for (let cc = 0; cc < cl; cc++) out += (last[cc] ?? '') + '|';
                }
                out += ';';
            }
            return out;
        } catch (_) { return String(Date.now()); }
    };

    // 是否处于用户编辑/弹窗上下文：排序模式、设置弹窗、单元格编辑、cell menu、快速预览任一打开即 true。
    // 顶层定义，供 init 的填表轮询与 bindEvents 的追平轮询共用（两者是兄弟 IIFE 闭包）。
    const inEditingContext = () => {
        const jq = getCore().$;
        return isEditingOrder || !!(jq && (jq('.acu-edit-overlay, .acu-cell-menu, .acu-quick-view-overlay').length));
    };

    // 深拷贝工具：避免对外暴露数据库内部对象的引用，防止前端就地修改污染 DB 运行时状态。
    // 高楼层大数据时 structuredClone/JSON 都可能抛错，必须有最终兜底，不能让调用方被异常打断。
    const cloneTableData = (data) => {
        if (!data || typeof data !== 'object') return data;
        try { return structuredClone(data); }
        catch (e1) {
            try { return JSON.parse(JSON.stringify(data)); }
            catch (e2) {
                console.warn('[ACU-UI] cloneTableData failed, returning shallow sheet shell:', e2);
                // 最后兜底：按 sheet 浅拷贝 content 引用，至少保证读路径可用；
                // 写路径仍应走 API 而非就地改写。
                const shell = {};
                try {
                    for (const k of Object.keys(data)) {
                        const v = data[k];
                        if (v && typeof v === 'object' && Array.isArray(v.content)) {
                            shell[k] = { ...v, content: v.content };
                        } else {
                            shell[k] = v;
                        }
                    }
                } catch (_) { return data; }
                return shell;
            }
        }
    };

    // 缓存数据来源的原始引用：exportTableAsJson 返回 DB 内部 currentJsonTableData_ACU，
    // DB 在数据合并时以不可变式替换整个对象（_set_currentJsonTableData_ACU 换新引用）。
    // 引用相同 = 数据未变 → forceRefresh 时可跳过深拷贝直接复用缓存，避免高频全表 clone。
    // ⚠ 已知例外（交叉验证确认）：DB 的 SqlTableService._ensureTablesFromTemplate 在 SQLite
    // 缺表建表时会原地往活对象加 sheet key（引用不变但表集合变），故引用未变时仍须比对表集合。
    let lastRawTableRef = null;
    // 标记最近一次 getTableData 是否产生了新数据（引用变化 → 需要重算 diffMap）
    let lastTableDataRefreshed = false;
    // 上次缓存的表集合指纹（sheet key 名 + 数量），用于捕获"引用不变但新增/删除了表"的建表场景
    let lastTableSetFingerprint = '';

    // 轻量表集合指纹：只列 sheet key 名与数量，成本极低
    const tableSetFingerprint = (raw) => {
        if (!raw || typeof raw !== 'object') return '';
        const keys = Object.keys(raw).filter(k => k.startsWith('sheet_')).sort();
        return keys.join(',') + '#' + keys.length;
    };

    const getTableData = (forceRefresh = false) => {
        if (!forceRefresh && cachedTableData) {
            lastTableDataRefreshed = false;
            return cachedTableData;
        }
        try {
            const api = getCore().getDB();
            const raw = api && api.exportTableAsJson ? api.exportTableAsJson() : null;
            // 引用未变时仍比对表集合：DB 建表场景会原地加 sheet key（引用不变但表集合变）
            const setFp = tableSetFingerprint(raw);
            const setChanged = setFp !== lastTableSetFingerprint;
            // 引用未变 + 表集合未变 + 已有缓存 → 数据确实没动，复用缓存跳过 clone
            if (forceRefresh && raw === lastRawTableRef && !setChanged && cachedTableData) {
                lastTableDataRefreshed = false;
                return cachedTableData;
            }
            lastRawTableRef = raw;
            lastTableSetFingerprint = setFp;
            lastTableDataRefreshed = true;
            // 关键：exportTableAsJson 返回的是 DB 内部 currentJsonTableData_ACU 的直接引用，
            // 必须深拷贝后再对外返回，否则前端的就地修改会绕过 DB 的事务/校验逻辑。
            const data = cloneTableData(raw);
            if (data) {
                cachedTableData = data;
            }
            return data;
        } catch (e) {
            console.error('[ACU-UI] getTableData failed:', e);
            lastTableDataRefreshed = false;
            return cachedTableData || null;
        }
    };

    // 从数据模型读回某个单元格的原文。
    // 取代表格单元格上一度内嵌的 data-val 属性（已因体积暴涨被移除）：
    // 页面上的 cell 带 data-key/data-row/data-col，row 是 0 起的数据行索引，
    // 对应 content[rowIdx + 1]（content[0] 是表头）。读不到时退回可见文本，
    // 保证 showCellMenu 至少有个可编辑的起手内容，不至于空白。
    const readCellValue = (cell, rowIdx, colIdx, tableKey) => {
        try {
            const data = getTableData(false) || cachedTableData;
            const sheet = data && tableKey ? data[tableKey] : null;
            const content = sheet && Array.isArray(sheet.content) ? sheet.content : null;
            if (content) {
                const row = content[rowIdx + 1];
                if (row && row[colIdx] !== undefined && row[colIdx] !== null) {
                    return String(row[colIdx]);
                }
            }
        } catch (_) { /* 走可见文本兜底 */ }
        // 兜底：从单元格可见内容反取（先精确子元素，再退到整体文本）
        try {
            const $c = $(cell);
            const $t = $c.find('.acu-grid-value, .acu-full-value, .acu-inline-value, .acu-editable-title').first();
            const txt = ($t.length ? $t.text() : $c.text());
            return txt != null ? String(txt) : '';
        } catch (_) { return ''; }
    };

    const saveDataToDatabase = async (tableData, skipRender = false, commitDeletes = false, updateContext = null) => {
        if (isSaving) return false;
        if (tableData && typeof tableData === 'object') {
            if (!tableData.mate) {
                tableData.mate = { type: 'chatSheets', version: 1 };
            }
            if (!Object.keys(tableData).some(k => k.startsWith('sheet_'))) {
                if (tableData.content && tableData.name) {
                    const tempKey = tableData.uid || ('sheet_' + Math.random().toString(36).substr(2, 9));
                    const wrapper = { mate: { type: 'chatSheets', version: 1 } };
                    wrapper[tempKey] = tableData;
                    tableData = wrapper;
                }
            }
        }
        const { $ } = getCore();
        const $saveBtn = $('#acu-btn-save-global');
        let originalIcon = '';

        const executeCoreSave = async () => {
            isSaving = true;
            const api = getCore().getDB();
            let saveSuccessful = false;

            try {
                if (api && updateContext) {
                    let apiResult;
                    if (updateContext.type === 'cell_edit' && api.updateCell) {
                        apiResult = await api.updateCell(updateContext.tableName, updateContext.rowIndex + 1, updateContext.colIndex, updateContext.newValue);
                    } else if (updateContext.type === 'row_edit' && api.updateRow) {
                        apiResult = await api.updateRow(updateContext.tableName, updateContext.rowIndex + 1, updateContext.updateObj);
                    } else if (updateContext.type === 'row_delete' && api.deleteRow) {
                        apiResult = await api.deleteRow(updateContext.tableName, updateContext.rowIndex + 1);
                    }
                    if (apiResult !== false) {
                        saveSuccessful = true;
                    }
                }
            } catch (apiErr) {
                console.warn('[ACU-API] API 调用失败:', apiErr);
            }

            if (!saveSuccessful && api && api.importTableAsJson) {
                try {
                    saveSuccessful = await api.importTableAsJson(JSON.stringify(tableData));
                } catch (bulkErr) {
                    console.warn('[ACU-API] 全量保存异常:', bulkErr);
                }
            }

            return !!saveSuccessful;
        };

        try {
            if (!skipRender) {
                originalIcon = $saveBtn.html();
                $saveBtn.html('<i class="fa-solid fa-spinner fa-spin"></i>').prop('disabled', true);
            }

            const saveResult = await UpdateController.runSilently(executeCoreSave);
            if (saveResult === false) {
                throw new Error('保存失败');
            }

            cachedTableData = null;
            if (!skipRender) {
                if (window.toastr) window.toastr.success('保存成功！');
                $('.acu-highlight-changed').removeClass('acu-highlight-changed');
                currentDiffMap.clear();
                saveSnapshot(tableData);
                renderInterface(true);
            }
            return true;
        } catch (e) {
            console.error("Save failed:", e);
            if (!skipRender && window.toastr) window.toastr.error('保存失败');
            return false;
        } finally {
            isSaving = false;
            if (!skipRender && $saveBtn.length) {
                $saveBtn.html(originalIcon || '<i class="fa-solid fa-save"></i>').prop('disabled', false);
            }
        }
    };

    const processJsonData = (json) => {
        const tables = {};
        if (!json || typeof json !== 'object') return {};
        try {
            for (const sheetId in json) {
                const sheet = json[sheetId];
                if (!sheet || typeof sheet !== 'object' || !sheet.name) continue;
                // content 可能缺失/非数组（脏数据、半残快照）；一律兜底为空表，避免上层 throw
                const content = Array.isArray(sheet.content) ? sheet.content : [];
                const headers = Array.isArray(content[0]) ? content[0] : [];
                const rows = content.length > 1 ? content.slice(1) : [];
                tables[sheet.name] = { key: sheetId, headers, rows };
            }
        } catch (e) {
            console.warn('[ACU-UI] processJsonData partial failure:', e);
        }
        // 始终返回对象，调用方无需再判 null（旧实现返回 null 会让 Object.keys 直接抛错）
        return tables;
    };
    
    const showSettingsModal = () => {
        const { $ } = getCore();
        if (!$) {
            if (window.toastr) window.toastr.error('设置面板打开失败：jQuery 未就绪');
            return;
        }
        $('.acu-edit-overlay').remove();
        const config = getConfig();
        let allTableNames = [];
        try {
            const rawData = getTableData();
            const processed = processJsonData(rawData || {});
            allTableNames = Object.keys(processed || {});
        } catch (e) {
            console.warn('[ACU-UI] showSettingsModal: 读取表名失败，以空列表继续:', e);
            allTableNames = [];
        }
        const reversedTables = getReverseOrderTables();
        const hiddenTables = getHiddenTables();
        
        const modalStyles = `
        <style>
            .acu-edit-overlay { 
                position: fixed !important; top: 0; left: 0; right: 0; bottom: 0; 
                background: rgba(0, 0, 0, 0.5) !important; 
                backdrop-filter: blur(3px); 
                z-index: 2147483647 !important; 
                display: flex !important; 
                align-items: center; justify-content: center;
                opacity: 0; animation: acuFadeIn 0.2s forwards;
            }
            .acu-edit-dialog { 
                background: var(--acu-bg-panel) !important; 
                color: var(--acu-text-main) !important; 
                border: 1px solid var(--acu-border) !important; 
                display: flex; flex-direction: column;
                box-shadow: 0 10px 50px rgba(0,0,0,0.3) !important;
                transition: background 0.3s, box-shadow 0.3s, opacity 0.3s, transform 0.3s;
                overflow: hidden;
            }
            @media (min-width: 769px) {
                .acu-edit-dialog { 
                    width: 60% !important; max-width: 800px !important; min-width: 400px;
                    height: auto !important; max-height: 70vh !important;
                    border-radius: 16px !important;
                    margin: auto !important;
                }
            }
            @media (max-width: 768px) {
                .acu-edit-overlay {
                    display: block !important;
                    height: 100vh !important;
                    height: 100dvh !important;
                }
                .acu-edit-dialog {
                    position: absolute !important;
                    bottom: 0 !important;
                    left: 0 !important;
                    margin: 0 !important;
                    width: 100% !important;
                    max-width: 100% !important;
                    height: 70vh !important;
                    border-radius: 20px 20px 0 0 !important;
                    animation: acuSlideUp 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
                    transform-origin: bottom center;
                }
            }
            @keyframes acuFadeIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes acuSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
            .acu-control-row {
                display: flex; justify-content: space-between; align-items: center;
                padding: 12px 0;
                border-bottom: 1px dashed var(--acu-border);
            }
            .acu-control-row:last-child { border-bottom: none; }
            .acu-label-col { display: flex; flex-direction: column; gap: 4px; max-width: 60%; }
            .acu-label-main { font-size: 12px; font-weight: bold; color: var(--acu-text-main); }
            .acu-label-sub { font-size: 10px; color: var(--acu-text-sub); }
            .acu-input-col { width: 40%; display: flex; justify-content: flex-end; align-items: center; }
			.acu-switch {
				position: relative; display: inline-block; width: 40px; height: 20px;
                -webkit-tap-highlight-color: transparent;
			}
			.acu-switch input { opacity: 0; width: 0; height: 0; }
            .acu-slider-switch {
                position: absolute; cursor: pointer;
                top: 0; left: 0; right: 0; bottom: 0;
                background-color: var(--acu-border);
                transition: .4s; border-radius: 34px;
                border: 1px solid rgba(0,0,0,0.15);
                box-sizing: border-box;
            }
            .acu-slider-switch:before {
                position: absolute; content: "";
                height: 16px; width: 16px; left: 1px; bottom: 1px;
                background-color: white; transition: .4s; border-radius: 50%;
                box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            }
			input:checked + .acu-slider-switch { background-color: var(--acu-ui-color) !important; border: 1px solid var(--acu-ui-color) !important; opacity: 1 !important; }
			input:checked + .acu-slider-switch:before { transform: translateX(20px); background-color: #ffffff !important; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
            .acu-sub-setting {
                background: rgba(0,0,0,0.02);
                padding-left: 20px !important;
                display: none;
            }
            .acu-color-row {
                display: flex; gap: 8px; justify-content: flex-end; flex-wrap: nowrap;
            }
            .acu-color-circle {
                width: 22px; height: 22px; border-radius: 50%; cursor: pointer;
                border: 2px solid transparent; transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
                position: relative;
                flex-shrink: 0;
                -webkit-tap-highlight-color: transparent;
                outline: none;
            }
            .acu-color-circle:hover { transform: scale(1.15); }
            .acu-color-circle:active { transform: scale(0.9); }
            .acu-color-circle.selected {
                border-color: var(--acu-ui-color);
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                transform: scale(1.25);
            }
            .acu-color-circle.selected::after {
                content: ''; position: absolute; top: 50%; left: 50%;
                width: 6px; height: 6px; background: var(--acu-ui-color);
                border-radius: 50%; transform: translate(-50%, -50%);
                opacity: 0.7;
            }
            .acu-nice-select {
                appearance: none !important; border: 1px solid var(--acu-border) !important; background-color: var(--acu-btn-bg) !important;
                color: var(--acu-text-main) !important; padding: 6px 24px 6px 10px !important; border-radius: 8px !important;
                font-size: 12px !important; text-align: center !important; font-weight: bold !important; outline: none !important; box-shadow: none !important;
                background-image: url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23999%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E") !important;
                background-repeat: no-repeat !important; background-position: right 8px center !important; background-size: 10px !important;
                min-width: 100px !important;
            }
            .acu-nice-slider { width: 100% !important; height: 6px !important; background: var(--acu-text-sub) !important; opacity: 0.5; border-radius: 3px !important; outline: none !important; appearance: none !important; }
            .acu-nice-slider::-webkit-slider-thumb { appearance: none !important; width: 20px !important; height: 20px !important; background: var(--acu-text-main) !important; border: 2px solid var(--acu-highlight) !important; border-radius: 50% !important; cursor: pointer !important; box-shadow: 0 2px 5px rgba(0,0,0,0.2) !important; }
            .acu-settings-group { background: var(--acu-table-head); border-radius: 12px; padding: 0 15px; margin-bottom: 10px; border: 1px solid rgba(0,0,0,0.05); }
            .acu-edit-header { padding: 10px 20px; border-bottom: 1px solid var(--acu-border); display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.02); }
            .acu-close-pill {
                background-color: var(--acu-ui-color) !important;
                color: var(--acu-menu-bg) !important;
                border: none !important;
                padding: 6px 20px;
                border-radius: 20px;
                font-weight: bold; font-size: 12px;
                cursor: pointer;
                box-shadow: 0 4px 10px var(--acu-highlight-bg);
                transition: transform 0.2s, filter 0.2s;
                display: inline-flex; align-items: center; justify-content: center;
            }
            .acu-close-pill:hover {
                filter: brightness(0.85);
                transform: scale(1.05);
            }
            .acu-btn-block {
                width: 100%;
                display: flex;
                justify-content: center;
                align-items: center;
                background: var(--acu-btn-bg);
                color: var(--acu-text-main);
                border: 1px solid var(--acu-border);
                border-radius: 8px;
                cursor: pointer;
                transition: background 0.2s;
                text-align: center;
            }
            .acu-btn-block:hover {
                background: var(--acu-btn-hover);
            }
            

            .acu-edit-overlay.acu-transparent-mode { background: transparent !important; backdrop-filter: none !important; }
            .acu-edit-overlay.acu-transparent-mode .acu-edit-dialog { background: transparent !important; box-shadow: none !important; border: none !important; }
            .acu-edit-overlay.acu-transparent-mode .acu-edit-dialog > *:not(.acu-settings-content) { opacity: 0; pointer-events: none; }
            .acu-edit-overlay.acu-transparent-mode .acu-settings-group { background: transparent !important; border: none !important; }
            .acu-edit-overlay.acu-transparent-mode .acu-control-row { opacity: 0; pointer-events: none; }
            .acu-edit-overlay.acu-transparent-mode .acu-settings-content > div:not(.acu-settings-group) { opacity: 0; pointer-events: none; }
            .acu-edit-overlay.acu-transparent-mode .acu-control-row.acu-active-control { opacity: 1; pointer-events: auto; background: var(--acu-bg-panel); border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); border: 1px solid var(--acu-border); }
            
            .acu-theme-aurora .acu-slider-switch { background-color: rgba(226, 232, 240, 0.2) !important; border-color: rgba(226, 232, 240, 0.2) !important; opacity: 1 !important; }
            .acu-theme-aurora input:checked + .acu-slider-switch { background-color: var(--acu-border) !important; border-color: var(--acu-border) !important; opacity: 1 !important; }
        
            
            .acu-edit-dialog ::-webkit-scrollbar { width: 6px; height: 6px; }
            .acu-edit-dialog ::-webkit-scrollbar-thumb { background-color: transparent; border-radius: 3px; transition: background-color 0.2s; } 
            
            .acu-stepper { display: flex; align-items: center; border: 1px solid var(--acu-border); border-radius: 8px; background: var(--acu-btn-bg); overflow: hidden; width: 100%; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
            .acu-step-btn { background: transparent; border: none; color: var(--acu-text-main); width: 36px; height: 32px; flex: 0 0 36px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.2s; font-size: 14px; }
            .acu-step-btn:hover { background: var(--acu-btn-hover); color: var(--acu-highlight); }
            .acu-step-btn:active { background: var(--acu-btn-active-bg); color: var(--acu-btn-active-text); }
            .acu-step-val { flex: 1; text-align: center; font-weight: bold; font-size: 14px; color: var(--acu-text-main); user-select: none; border-left: 1px solid var(--acu-border); border-right: 1px solid var(--acu-border); height: 32px; display: flex; align-items: center; justify-content: center; background: var(--acu-input-bg); }
.acu-edit-dialog .acu-show-scroll::-webkit-scrollbar-thumb { background-color: var(--acu-text-sub); }
        
            .acu-custom-color-btn { width: 22px; height: 22px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); position: relative; flex-shrink: 0; -webkit-tap-highlight-color: transparent; outline: none; box-sizing: content-box; overflow: hidden; }
            .acu-custom-color-btn:hover { transform: scale(1.15); }
            .acu-custom-color-btn:active { transform: scale(0.9); }
            .acu-custom-color-btn.selected { border-color: var(--acu-ui-color); box-shadow: 0 4px 12px rgba(0,0,0,0.2); transform: scale(1.25); }
            .acu-custom-color-btn.selected::after { content: ''; position: absolute; top: 50%; left: 50%; width: 6px; height: 6px; background: var(--acu-ui-color); border-radius: 50%; transform: translate(-50%, -50%); opacity: 0.7; pointer-events: none; z-index: 3; }
            .acu-custom-bg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border-radius: 50%; z-index: 1; }
            .acu-custom-color-btn input[type="color"] { position: absolute; top: -10px; left: -10px; width: 200%; height: 200%; opacity: 0; cursor: pointer; z-index: 2; padding: 0; margin: 0; border: none; outline: none; }
            .acu-settings-content::-webkit-scrollbar { display: none !important; width: 0 !important; }
            .acu-section-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: var(--acu-btn-bg); border: 1px solid var(--acu-border); border-radius: 12px; margin-bottom: 8px; cursor: pointer; transition: all 0.2s; user-select: none; -webkit-tap-highlight-color: transparent; outline: none; }
            .acu-section-header:hover { background: var(--acu-btn-hover); transform: translateY(-1px); }
            .acu-section-header.active { background: var(--acu-table-head); border-radius: 12px 12px 0 0; border-bottom: 1px solid var(--acu-border); margin-bottom: 0; box-shadow: none; }
            .acu-section-header.active:hover { transform: none; }
            .acu-section-title { font-weight: bold; font-size: 13px; color: var(--acu-text-main); display: flex; align-items: center; gap: 10px; } .acu-section-title i { color: var(--acu-ui-color); }
            .acu-section-desc { font-size: 11px; color: var(--acu-text-sub); font-weight: normal; margin-left: 5px; display: none; } .acu-section-header.active .acu-section-desc { display: inline; }
            .acu-section-icon { color: var(--acu-text-sub); transition: transform 0.3s; font-size: 12px; }
            .acu-section-header.active .acu-section-icon { transform: rotate(90deg); }
            .acu-section-content { display: none; background: var(--acu-table-head); border: 1px solid var(--acu-border); border-top: none; border-radius: 0 0 12px 12px; padding: 0 15px 15px 15px; margin-bottom: 8px; }
            .acu-section-content .acu-settings-group { border: none !important; background: transparent !important; padding: 0 !important; margin: 0 !important; box-shadow: none !important; }

        </style>

        `;



        const dialog = $(`
            <div class="acu-edit-overlay${overlayThemeClass(config.theme)}">
                ${modalStyles}
                <div class="acu-edit-dialog acu-theme-${config.theme}">                     <div class="acu-edit-header">
                        <span style="font-size:13px; font-weight:bold;">设置选项</span>
                        <button id="dlg-close" class="acu-close-pill">完成</button>
                     </div>
                    <div class="acu-settings-content" style="flex: 1; overflow-y: auto; padding: 20px;">
                        
                        <div class="acu-section-header" data-target="sec-appearance"><div class="acu-section-title"><i class="fa-solid fa-palette"></i> 主题与外观</div><i class="fa-solid fa-chevron-right acu-section-icon"></i></div><div class="acu-section-content" id="sec-appearance"><div class="acu-settings-group">
                            <div class="acu-control-row">
                                <div class="acu-label-col"><span class="acu-label-main">背景主题</span></div>
                                <div class="acu-input-col">
                                    <select id="cfg-theme" class="acu-nice-select">
                                        ${THEMES.map(t => `<option value="${t.id}" ${t.id === config.theme ? 'selected' : ''}>${t.name}</option>`).join('')}
                                    </select>
                                </div>
                            </div>
                            <div class="acu-control-row">
                                <div class="acu-label-col"><span class="acu-label-main">数据库主题</span></div>
                                <div class="acu-input-col" style="gap:5px">
                                    <select id="cfg-db-theme" class="acu-nice-select">
                                        <option value="default" ${config.dbTheme === 'default' ? 'selected' : ''}>默认主题</option>
                                        ${THEMES.map(t => `<option value="${t.id}" ${t.id === config.dbTheme ? 'selected' : ''}>${t.name}</option>`).join('')}
                                    </select>
                                </div>
                            </div>
                            <div class="acu-control-row">
                                <div class="acu-label-col" style="flex-direction:row;align-items:center;gap:8px"><span class="acu-label-main">数据库UI苹果风</span><span class="acu-label-sub" style="font-weight:normal;margin-top:2px">新UI(#acu-app-v2)套苹果毛玻璃,关闭恢复原样</span></div>
                                <div class="acu-input-col">
                                    <label class="acu-switch">
                                        <input type="checkbox" id="cfg-db-apple-glass" ${config.dbAppleGlass ? 'checked' : ''}>
                                        <span class="acu-slider-switch"></span>
                                    </label>
                                </div>
                            </div>
                            
                             
                            <div class="acu-control-row">
                                <div class="acu-label-col"><span class="acu-label-main">字体样式</span></div>
                                <div class="acu-input-col">
                                    <select id="cfg-font-family" class="acu-nice-select">
                                        ${FONTS.map(f => `<option value="${f.id}" ${f.id === config.fontFamily ? 'selected' : ''}>${f.name}</option>`).join('')}
                                    </select>
                                </div>
                            </div><div class="acu-control-row">
                                <div class="acu-label-col"><span class="acu-label-main">字体大小</span></div>
                                <div class="acu-input-col">
                                    <div class="acu-stepper">
                                        <button class="acu-step-btn minus" data-key="fontSize" data-step="1" data-min="10" data-max="20"><i class="fa-solid fa-minus"></i></button>
                                        <div class="acu-step-val" id="val-fontSize">${config.fontSize}</div>
                                        <button class="acu-step-btn plus" data-key="fontSize" data-step="1" data-min="10" data-max="20"><i class="fa-solid fa-plus"></i></button>
                                    </div>
                                </div>
                            </div><div class="acu-control-row">
                                <div class="acu-label-col"><span class="acu-label-main">卡片宽度</span></div>
                                <div class="acu-input-col">
                                    <div class="acu-stepper">
                                        <button class="acu-step-btn minus" data-key="cardWidth" data-step="10" data-min="220" data-max="500"><i class="fa-solid fa-minus"></i></button>
                                        <div class="acu-step-val" id="val-cardWidth">${config.cardWidth}</div>
                                        <button class="acu-step-btn plus" data-key="cardWidth" data-step="10" data-min="220" data-max="500"><i class="fa-solid fa-plus"></i></button>
                                    </div>
                                </div>
                            </div>
                            
                            
                        <div class="acu-control-row" style="border-bottom:none; ${config.highlightNew ? 'padding-bottom:5px' : ''}">
                                <div class="acu-label-col">
                                    <span class="acu-label-main">新增内容高亮 <span id="hint-new" style="font-size:11px;color:var(--acu-text-sub);font-weight:normal;margin-left:5px;display:${config.highlightNew ? 'inline' : 'none'}">下方选择高亮颜色</span></span>
                                </div>
                                <div class="acu-input-col">
                                    <label class="acu-switch">
                                        <input type="checkbox" id="cfg-new" ${config.highlightNew ? 'checked' : ''}>
                                        <span class="acu-slider-switch"></span>
                                    </label>
                                </div>
                            </div><div class="acu-control-row" id="row-highlight-color" style="display:${config.highlightNew ? 'flex' : 'none'}; border-top:none; border-bottom:none; padding-top:8px;">
                                  <div style="width:100%">
                                      <div class="acu-color-row" id="cfg-color-opts" style="justify-content: flex-start; align-items: center;">
                                        ${Object.keys(HIGHLIGHT_COLORS).map(k => `<div class="acu-color-circle ${config.highlightColor === k ? 'selected' : ''}" data-val="${k}" data-type="highlight" title="${HIGHLIGHT_COLORS[k].name}" style="background-color:${HIGHLIGHT_COLORS[k].main}"></div>`).join('')}
                                      <div style="width:1px;height:20px;background:var(--acu-border);margin:0 8px;"></div>
                                      <div class="acu-custom-color-btn ${(config.highlightColor && !HIGHLIGHT_COLORS[config.highlightColor] && String(config.highlightColor).startsWith('#')) ? 'selected' : ''}" title="自定义颜色">
                                          <div class="acu-custom-bg" style="background:${(config.highlightColor && !HIGHLIGHT_COLORS[config.highlightColor] && String(config.highlightColor).startsWith('#')) ? config.highlightColor : 'conic-gradient(red, orange, yellow, green, blue, indigo, violet, red)'}"></div>
                                          <input type="color" id="cfg-highlight-custom" value="${(config.highlightColor && String(config.highlightColor).startsWith('#')) ? config.highlightColor : '#d35400'}">
                                      </div>
                                      </div>
                                </div>
                            </div><div class="acu-nav-separator"></div><div class="acu-control-row" style="${config.customTitleColor ? 'border-bottom:none; padding-bottom:5px' : ''}">
                                <div class="acu-label-col">
                                    <span class="acu-label-main">标题颜色自定义 <span id="hint-title" style="font-size:11px;color:var(--acu-text-sub);font-weight:normal;margin-left:5px;display:${config.customTitleColor ? 'inline' : 'none'}">下方选择标题颜色</span></span>
                                </div>
                                <div class="acu-input-col">
                                    <label class="acu-switch">
                                        <input type="checkbox" id="cfg-custom-title" ${config.customTitleColor ? 'checked' : ''}>
                                        <span class="acu-slider-switch"></span>
                                    </label>
                                </div>
                            </div><div class="acu-control-row" id="row-title-color" style="display:${config.customTitleColor ? 'flex' : 'none'}; border-top:none; padding-top:8px;">
                                  <div style="width:100%">
                                      <div class="acu-color-row" id="cfg-title-color-opts" style="justify-content: flex-start; align-items: center;">
                                        ${Object.keys(HIGHLIGHT_COLORS).map(k => `<div class="acu-color-circle ${config.titleColor === k ? 'selected' : ''}" data-val="${k}" data-type="title" title="${HIGHLIGHT_COLORS[k].name}" style="background-color:${HIGHLIGHT_COLORS[k].main}"></div>`).join('')}
                                      <div style="width:1px;height:20px;background:var(--acu-border);margin:0 8px;"></div>
                                      <div class="acu-custom-color-btn ${(config.titleColor && !HIGHLIGHT_COLORS[config.titleColor] && String(config.titleColor).startsWith('#')) ? 'selected' : ''}" title="自定义颜色">
                                          <div class="acu-custom-bg" style="background:${(config.titleColor && !HIGHLIGHT_COLORS[config.titleColor] && String(config.titleColor).startsWith('#')) ? config.titleColor : 'conic-gradient(red, orange, yellow, green, blue, indigo, violet, red)'}"></div>
                                          <input type="color" id="cfg-title-custom" value="${(config.titleColor && String(config.titleColor).startsWith('#')) ? config.titleColor : '#d35400'}">
                                      </div>
                                      </div>
                                </div>
                            </div><div class="acu-control-row">
                                <div class="acu-label-col" style="flex-direction:row;align-items:center;gap:8px"><span class="acu-label-main">长文本折叠</span><span class="acu-label-sub" style="font-weight:normal;margin-top:2px">限制卡片内文本高度</span></div>
                                <div class="acu-input-col">
                                    <label class="acu-switch">
                                        <input type="checkbox" id="cfg-limit-height" ${config.limitLongText !== false ? 'checked' : ''}>
                                        <span class="acu-slider-switch"></span>
                                    </label>
                                </div>
                            </div></div></div><div class="acu-section-header" data-target="sec-layout"><div class="acu-section-title"><i class="fa-solid fa-layer-group"></i> 布局与样式</div><i class="fa-solid fa-chevron-right acu-section-icon"></i></div><div class="acu-section-content" id="sec-layout"><div class="acu-settings-group"><div class="acu-control-row">
                                <div class="acu-label-col"><span class="acu-label-main">页面布局</span></div>
                                <div class="acu-input-col">
                                    <select id="cfg-layout" class="acu-nice-select">
                                       <option value="vertical" ${config.layout === 'vertical' ? 'selected' : ''}>竖向布局</option>
                                        <option value="horizontal" ${config.layout === 'horizontal' ? 'selected' : ''}>横向布局</option>
                                    </select>
                                </div>
                            </div><div class="acu-control-row">
                                <div class="acu-label-col"><span class="acu-label-main">前端位置</span></div>
                                <div class="acu-input-col">
                                    <select id="cfg-frontend-pos" class="acu-nice-select">
                                        <option value="bottom" ${config.frontendPosition === 'bottom' ? 'selected' : ''}>上下文底部</option>
                                        <option value="message" ${config.frontendPosition === 'message' ? 'selected' : ''}>最新消息内</option>
                                    </select>
                                </div>
                            </div><div class="acu-control-row">
                                <div class="acu-label-col"><span class="acu-label-main">底部按钮列数</span></div>
                                 <div class="acu-input-col">
                                     <select id="cfg-grid-cols" class="acu-nice-select">
                                        <option value="0" ${!config.gridColumns ? 'selected' : ''}>自动</option>
                                        <option value="2" ${config.gridColumns == 2 ? 'selected' : ''}>2 列</option>
                                        <option value="3" ${config.gridColumns == 3 ? 'selected' : ''}>3 列</option>
                                        <option value="4" ${config.gridColumns == 4 ? 'selected' : ''}>4 列</option>
                                    </select>
                                </div>
                            </div><div class="acu-control-row">
                                <div class="acu-label-col"><span class="acu-label-main">收起样式</span></div>
                                <div class="acu-input-col" style="gap:5px">
                                    <select id="cfg-collapse-pos" class="acu-nice-select" style="display:${config.collapseStyle === 'pill' ? 'block' : 'none'}; width:auto; min-width:80px;">
                                        <option value="left" ${config.collapsePosition === 'left' ? 'selected' : ''}>左侧</option>
                                        <option value="center" ${config.collapsePosition === 'center' ? 'selected' : ''}>居中</option>
                                        <option value="right" ${config.collapsePosition === 'right' ? 'selected' : ''}>右侧</option>
                                    </select>
                                    <select id="cfg-collapse-style" class="acu-nice-select">
                                        <option value="bar" ${config.collapseStyle === 'bar' ? 'selected' : ''}>全宽窄条</option>
                                        <option value="pill" ${config.collapseStyle === 'pill' ? 'selected' : ''}>胶囊按钮</option>
                                    </select>
                                </div>
                            </div><div class="acu-control-row">
                                <div class="acu-label-col"><span class="acu-label-main">每页卡片数</span></div>
                                <div class="acu-input-col">
                                    <div class="acu-stepper">
                                        <button class="acu-step-btn minus" data-key="itemsPerPage" data-step="5" data-min="5" data-max="100"><i class="fa-solid fa-minus"></i></button>
                                        <div class="acu-step-val" id="val-itemsPerPage">${config.itemsPerPage || 20}</div>
                                        <button class="acu-step-btn plus" data-key="itemsPerPage" data-step="5" data-min="5" data-max="100"><i class="fa-solid fa-plus"></i></button>
                                    </div>
                                </div>
                            </div></div></div><div class="acu-section-header" data-target="sec-actions"><div class="acu-section-title"><i class="fa-solid fa-list-check"></i> 选项面板 ${!allTableNames.some(n => n.includes('选项')) ? '<span class="acu-section-desc" style="color:#e74c3c !important;">未检测到选项表</span>' : ''}</div><i class="fa-solid fa-chevron-right acu-section-icon"></i></div><div class="acu-section-content" id="sec-actions"><div class="acu-settings-group">
<div class="acu-control-row" >
                                <div class="acu-label-col"><span class="acu-label-main">选项面板开关</span></div>
                                <div class="acu-input-col">
                                    <label class="acu-switch">
                                        <input type="checkbox" id="cfg-show-option" ${config.showOptionPanel !== false ? 'checked' : ''}>
                                        <span class="acu-slider-switch"></span>
                                    </label>
                                </div>
                            </div>
<div class="acu-control-row" id="row-auto-send" >
                                <div class="acu-label-col"><span class="acu-label-main">点击选项直接发送</span></div>
                                <div class="acu-input-col">
                                    <label class="acu-switch">
                                        <input type="checkbox" id="cfg-auto-send" ${config.clickOptionToAutoSend ? 'checked' : ''}>
                                        <span class="acu-slider-switch"></span>
                                    </label>
                                </div>
                            </div>
<!-- 选项字体大小 -->
                            <div class="acu-control-row">
                                <div class="acu-label-col"><span class="acu-label-main">选项字体大小</span></div>
                                <div class="acu-input-col">
                                    <div class="acu-stepper">
                                        <button class="acu-step-btn minus" data-key="optionFontSize" data-step="1" data-min="10" data-max="20"><i class="fa-solid fa-minus"></i></button>
                                        <div class="acu-step-val" id="val-optionFontSize">${config.optionFontSize || 13}</div>
                                        <button class="acu-step-btn plus" data-key="optionFontSize" data-step="1" data-min="10" data-max="20"><i class="fa-solid fa-plus"></i></button>
                                    </div>
                                </div>
                            </div>
</div></div><div class="acu-section-header" data-target="sec-dashboard"><div class="acu-section-title"><i class="fa-solid fa-tachometer-alt"></i> 仪表盘</div><i class="fa-solid fa-chevron-right acu-section-icon"></i></div><div class="acu-section-content" id="sec-dashboard"><div class="acu-settings-group">
<div class="acu-control-row" >
                                <div class="acu-label-col"><span class="acu-label-main">仪表盘开关</span></div>
                                <div class="acu-input-col">
                                    <label class="acu-switch">
                                        <input type="checkbox" id="cfg-show-dash" ${config.showDashboard !== false ? 'checked' : ''}>
                                        <span class="acu-slider-switch"></span>
                                    </label>
                                </div>
                            </div>
<div class="acu-control-row" id="row-dash-pos" >
                                <div class="acu-label-col"><span class="acu-label-main">仪表盘位置</span></div>
                                <div class="acu-input-col">
                                    <select id="cfg-dash-pos" class="acu-nice-select">
                                        <option value="embedded" ${config.dashboardPosition === 'embedded' ? 'selected' : ''}>最新消息内</option>
                                        <option value="panel" ${config.dashboardPosition === 'panel' ? 'selected' : ''}>导航悬浮窗</option>
                                    </select>
                                </div>
                            </div>
                            <div class="acu-control-row">
                                <div class="acu-label-col"><span class="acu-label-main">仪表盘字体大小</span></div>
                                <div class="acu-input-col">
                                    <div class="acu-stepper">
                                        <button class="acu-step-btn minus" data-key="dashboardFontSize" data-step="1" data-min="10" data-max="20"><i class="fa-solid fa-minus"></i></button>
                                        <div class="acu-step-val" id="val-dashboardFontSize">${config.dashboardFontSize || 13}</div>
                                        <button class="acu-step-btn plus" data-key="dashboardFontSize" data-step="1" data-min="10" data-max="20"><i class="fa-solid fa-plus"></i></button>
                                    </div>
                                </div>
                            </div>
</div></div><div class="acu-section-header" data-target="sec-table-mgmt"><div class="acu-section-title"><i class="fa-solid fa-table"></i> 表格管理</div><i class="fa-solid fa-chevron-right acu-section-icon"></i></div><div class="acu-section-content" id="sec-table-mgmt"><div class="acu-settings-group">
${allTableNames.map(tName => {
    const isHidden = hiddenTables.includes(tName);
    const isReversed = reversedTables.includes(tName);
    return `
        <div class="acu-control-row">
            <div class="acu-label-col">
                <span class="acu-label-main">${tName}</span>
            </div>
            <div class="acu-input-col" style="display:flex; gap:10px; align-items:center;">
                <label style="display:flex; align-items:center; gap:5px; cursor:pointer;">
                    <input type="checkbox" class="acu-reverse-check" value="${tName}" ${isReversed ? 'checked' : ''} style="cursor:pointer;">
                    <span style="font-size:12px; color:var(--acu-text-sub);">倒序</span>
                </label>
                <i class="fa-solid ${isHidden ? 'fa-eye-slash' : 'fa-eye'} acu-visibility-toggle" data-table="${tName}" style="cursor:pointer; color:var(--acu-text-sub); font-size:16px;" title="${isHidden ? '显示' : '隐藏'}表格"></i>
            </div>
        </div>
    `;
}).join('')}
</div></div><div style="display:flex; gap:10px; margin: 10px 0;">
                            <button class="acu-btn-block" id="btn-enter-sort" style="margin:0; flex:1; justify-content:center; font-weight:bold; padding:12px;">进入表格排序模式</button>
                        </div>

                    </div>
                </div>
            </div>
        `);
        $('body').append(dialog); bindScrollFade(dialog.find('.acu-settings-content, .acu-dash-npc-grid'));
        dialog.find('.acu-section-header').on('click', function() {
            const $this = $(this);
            const $target = dialog.find('#' + $this.data('target'));
            const isOpen = $this.hasClass('active');
            dialog.find('.acu-section-header.active').not(this).removeClass('active');
            dialog.find('.acu-section-content:visible').not($target).slideUp(200);
            if (isOpen) { $this.removeClass('active'); $target.slideUp(200); } 
            else { $this.addClass('active'); $target.slideDown(200); }
        });

        dialog.find('#cfg-theme').on('change', function() { 
              const newTheme = $(this).val();
            const allThemes = THEMES.map(t => 'acu-theme-' + t.id).join(' ');
            dialog.find('.acu-edit-dialog').removeClass(allThemes).addClass('acu-theme-' + newTheme);
            saveConfig({ theme: newTheme });
        });
        dialog.find('#cfg-layout').on('change', function() { saveConfig({ layout: $(this).val() }); renderInterface(false); });
        dialog.find('#cfg-frontend-pos').on('change', function() { saveConfig({ frontendPosition: $(this).val() }); renderInterface(false); });
        dialog.find('#cfg-font-family').on('change', function() { saveConfig({ fontFamily: $(this).val() }); });
        
        dialog.find('#cfg-highlight-custom').on('input change', function() {
            const hex = $(this).val();
            dialog.find('#cfg-color-opts .acu-color-circle').removeClass('selected');
            const $btn = $(this).closest('.acu-custom-color-btn');
            $btn.addClass('selected').find('.acu-custom-bg').css('background', hex);
            saveConfig({ highlightColor: hex });
        });
        dialog.find('#cfg-title-custom').on('input change', function() {
            const hex = $(this).val();
            dialog.find('#cfg-title-color-opts .acu-color-circle').removeClass('selected');
            const $btn = $(this).closest('.acu-custom-color-btn');
            $btn.addClass('selected').find('.acu-custom-bg').css('background', hex);
            saveConfig({ titleColor: hex });
        });
        dialog.find('.acu-color-circle').on('click', function() {
            const type = $(this).data('type');
            $(this).siblings().removeClass('selected'); $(this).addClass('selected');
            $(this).parent().find('.acu-custom-color-btn').removeClass('selected').find('.acu-custom-bg').css('background', 'conic-gradient(red, orange, yellow, green, blue, indigo, violet, red)');
            if (type === 'highlight') {
                 saveConfig({ highlightColor: $(this).data('val') });
            } else if (type === 'title') {
                 saveConfig({ titleColor: $(this).data('val') });
            }
        });
        
        

        
        dialog.find('.acu-step-btn').on('click', function() {
            const $btn = $(this);
            const key = $btn.data('key');
            const step = parseInt($btn.data('step'));
            const min = parseInt($btn.data('min'));
            const max = parseInt($btn.data('max'));
            const isPlus = $btn.hasClass('plus');
            const $disp = dialog.find('#val-' + key);

            let val = parseInt($disp.text());
            if (isNaN(val)) val = min;

            if (isPlus) val += step; else val -= step;

            if (val < min) val = min;
            if (val > max) val = max;

            $disp.text(val);

            const cfg = {};
            cfg[key] = val;
            saveConfig(cfg);

            if (key === 'itemsPerPage') renderInterface(false);
        });

        dialog.find('#cfg-show-dash').on('change', function() {
            const checked = $(this).is(':checked');
            saveConfig({ showDashboard: checked });
            renderInterface(false);
        });
        dialog.find('#cfg-dash-pos').on('change', function() { saveConfig({ dashboardPosition: $(this).val() }); renderInterface(false); });
        dialog.find('#cfg-show-option').on('change', function() {
            const checked = $(this).is(':checked');
            saveConfig({ showOptionPanel: checked });
            renderInterface(false);
        });
        dialog.find('#cfg-auto-send').on('change', function() { saveConfig({ clickOptionToAutoSend: $(this).is(':checked') }); });
        dialog.find('#cfg-new').on('change', function() { 
            const checked = $(this).is(':checked');
            saveConfig({ highlightNew: checked }); 
            const $row = dialog.find('#row-highlight-color');
            const $hint = dialog.find('#hint-new');
            const $parent = $(this).closest('.acu-control-row');
            if(checked) { 
                $row.slideDown(200).css('display', 'flex');
                $hint.fadeIn(200).css('display', 'inline');
                $parent.css({'border-bottom': 'none', 'padding-bottom': '5px'});
            } else { 
                $row.slideUp(200); 
                $hint.fadeOut(200);
                $parent.css({'border-bottom': 'none', 'padding-bottom': '12px'});
            }
            renderInterface(false);
        });
        dialog.find('#cfg-grid-cols').on('change', function () { saveConfig({ gridColumns: parseInt($(this).val()) }); renderInterface(false); });
        
        dialog.find('#cfg-collapse-style').on('change', function() { 
            const val = $(this).val();
            saveConfig({ collapseStyle: val }); 
            const $posSelect = dialog.find('#cfg-collapse-pos');
            if (val === 'pill') {
                $posSelect.fadeIn(200);
            } else {
                $posSelect.fadeOut(200);
            }
            renderInterface(false);
        });
        dialog.find('#cfg-collapse-pos').on('change', function() { saveConfig({ collapsePosition: $(this).val() }); renderInterface(false); });

        dialog.find('#cfg-limit-height').on('change', function() { saveConfig({ limitLongText: $(this).is(':checked') }); renderInterface(false); });
        dialog.find('#cfg-custom-title').on('change', function() { 
            const checked = $(this).is(':checked');
            saveConfig({ customTitleColor: checked }); 
            const $row = dialog.find('#row-title-color');
            const $hint = dialog.find('#hint-title');
            const $parent = $(this).closest('.acu-control-row');
            if(checked) { 
                $row.slideDown(200).css('display', 'flex');
                $hint.fadeIn(200).css('display', 'inline');
                $parent.css({'border-bottom': 'none', 'padding-bottom': '5px'});
            } else { 
                $row.slideUp(200);
                $hint.fadeOut(200);
                $parent.css({'border-bottom': '', 'padding-bottom': '12px'});
            }
        });

        dialog.find('#cfg-db-theme').on('change', function() {
            const val = $(this).val();
            saveConfig({ dbTheme: val });
        });

        dialog.find('#cfg-db-apple-glass').on('change', function() {
            saveConfig({ dbAppleGlass: $(this).is(':checked') });
        });

        dialog.find('.acu-reverse-check').on('change', function() {
            const tName = $(this).val();
            const checked = $(this).is(':checked');
            let currentList = getReverseOrderTables();
            if (checked) { if (!currentList.includes(tName)) currentList.push(tName); }
            else { currentList = currentList.filter(n => n !== tName); }
            saveReverseOrderTables(currentList);
            const activeTab = getActiveTabState();
            if (activeTab === tName) renderInterface(false);
        });
        dialog.find('.acu-visibility-toggle').on('click', function() {
            const tName = $(this).data('table');
            let currentList = getHiddenTables();
            if (currentList.includes(tName)) {
                currentList = currentList.filter(n => n !== tName);
                $(this).removeClass('fa-eye-slash').addClass('fa-eye');
            } else {
                currentList.push(tName);
                $(this).removeClass('fa-eye').addClass('fa-eye-slash');
            }
            saveHiddenTables(currentList);
            renderInterface(false);
        });
        dialog.find('.col-toggle').change(function() {
            const col = $(this).data('col');
            config.visibleColumns[col] = $(this).is(':checked');
            saveConfig();
            renderInterface(false);
        });
        dialog.find('#btn-enter-sort').click(() => { dialog.remove(); toggleOrderEditMode(); });
        dialog.find('#dlg-close').click(() => { dialog.remove(); renderInterface(false); });
        dialog.on('click', function(e) { if ($(e.target).hasClass('acu-edit-overlay')) dialog.remove(); });
    };

        
    const injectEmbeddedDashboard = (htmlContent, themeClass, cssVars) => {
        const { $ } = getCore();
        if (!htmlContent) {
            $('.acu-embedded-dashboard-container').remove();
            return;
        }

        // 共享选择器（倒序找 + offsetParent 判隐藏），替掉原来那份 per-message
        // getComputedStyle + 子树查询的内嵌 getTargetContainer
        const $target = getEmbeddedTargetBlock();
        if ($target && $target.length) {
            const $existing = $('.acu-embedded-dashboard-container');
            let shouldUpdate = false;
            // 检查是否存在且在正确的位置
            if ($existing.length && $existing.parent()[0] === $target[0]) {
                shouldUpdate = true;
            } else {
                $existing.remove();
            }

            if (shouldUpdate) {
                // 原地更新，避免滚动条跳动
                const $container = $('.acu-embedded-dashboard-container');
                $container.removeClass().addClass(`acu-embedded-dashboard-container ${themeClass}`);
                // 保留基本样式并更新变量
                $container.attr('style', 'margin-top: 6px; width: 100%; clear: both; ' + cssVars);

                const $wrapper = $container.find('.acu-dash-content-wrapper');
                $wrapper.html(htmlContent);

                // 处理编辑模式下的状态同步
                const $editBtn = $container.find('#acu-btn-dash-edit-emb');
                const $editIcon = $editBtn.find('i');
                const $header = $container.find('.acu-dash-ctrl-bar');

                if (isDashEditing) {
                    // 编辑模式强制展开
                    if ($wrapper.css('height') === '0px' || $wrapper.css('opacity') === '0') {
                        $wrapper.css({ 'height': (window.innerWidth <= 768 ? 'auto' : '500px'), 'opacity': '1', 'padding': '0' });
                        $header.css({ 'border-radius': '12px 12px 0 0', 'margin-bottom': '-1px' });
                    }
                    $editBtn.css('display', 'inline-flex');
                    $editIcon.removeClass('fa-edit').addClass('fa-check').css('color', 'var(--acu-highlight)');
                } else {
                    $editIcon.removeClass('fa-check').addClass('fa-edit').css('color', '');
                    // 非编辑模式下，根据折叠状态显示/隐藏编辑按钮
                    if ($wrapper.css('height') === '0px' || $wrapper.css('opacity') === '0') {
                        $editBtn.hide();
                    } else {
                        $editBtn.css('display', 'inline-flex');
                    }
                }
            } else {
                // 首次创建或位置变更
                let isCollapsed = true; 
                if (isDashEditing) isCollapsed = false;

                const $container = $('<div class="acu-embedded-dashboard-container" style="margin-top: 6px; width: 100%; clear: both;"></div>');
                $container.addClass(themeClass).attr('style', $container.attr('style') + '; ' + cssVars);

                const headerHtml = `
                    <div class="acu-dash-ctrl-bar" style="
                        display: flex; justify-content: space-between; align-items: center;
                        padding: 10px 12px;
                        background: var(--acu-bg-nav);
                        border: 1px solid var(--acu-border);
                        border-radius: ${isCollapsed ? '12px' : '12px 12px 0 0'};
                        cursor: pointer;
                        user-select: none;
                        transition: all 0.2s;
                        margin-bottom: ${isCollapsed ? '0' : '-1px'};
                        position: relative; z-index: 2;
                        backdrop-filter: blur(5px);
                        -webkit-tap-highlight-color: transparent;
                    ">
                        <div style="display:flex; align-items:center; gap:8px;">
                             <i class="fa-solid fa-tachometer-alt" style="color:var(--acu-highlight);"></i>
                             <span style="font-weight: bold; color: var(--acu-title-color); font-size: 13px;">仪表盘</span>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <button id="acu-btn-dash-edit-emb" title="编辑布局" style="background:transparent; border:none; color:var(--acu-text-sub); cursor:pointer; padding:0 4px; height:16px; display:${isCollapsed ? 'none' : 'inline-flex'}; align-items:center;"><i class="fa-solid ${isDashEditing ? 'fa-check' : 'fa-edit'}" style="${isDashEditing ? 'color:var(--acu-highlight)' : ''}"></i></button>
                        </div>
                    </div>
                `;

                const contentStyle = isCollapsed ? 'height: 0; opacity: 0; padding: 0; overflow: hidden;' : (window.innerWidth <= 768 ? 'height: auto; opacity: 1; padding: 0; overflow: hidden;' : 'height: 500px; opacity: 1; padding: 0; overflow: hidden;');
                const contentWrapperHtml = `
                    <div class="acu-dash-content-wrapper" style="
                        overflow: hidden;
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        background: var(--acu-bg-nav);
                        border: 1px solid var(--acu-border);
                        border-top: none;
                        border-radius: 0 0 12px 12px;
                        backdrop-filter: blur(5px);
                        ${contentStyle}
                    ">
                        ${htmlContent}
                    </div>
                `;

                $container.append(headerHtml);
                $container.append(contentWrapperHtml);

                const $header = $container.find('.acu-dash-ctrl-bar');
                const $wrapper = $container.find('.acu-dash-content-wrapper');

                $header.on('click', function(e) {
                    if ($(e.target).closest('button').length) return;
                    e.stopPropagation();

                    const currentOpacity = $wrapper.css('opacity');
                    const isCurrentlyCollapsed = (currentOpacity === '0' || $wrapper.css('height') === '0px');

                    if (isCurrentlyCollapsed) {
                        $wrapper.css({ 'height': (window.innerWidth <= 768 ? 'auto' : '500px'), 'opacity': '1', 'padding': '0' });
                        $header.css({ 'border-radius': '12px 12px 0 0', 'margin-bottom': '-1px' });
                        $container.find('#acu-btn-dash-edit-emb').css('display', 'inline-flex');
                    } else {
                        $wrapper.css({ 'height': '0', 'opacity': '0', 'padding': '0' });
                        $header.css({ 'border-radius': '12px', 'margin-bottom': '0' });
                        $container.find('#acu-btn-dash-edit-emb').hide();
                    }
                });

                const $opts = $target.find('.acu-embedded-options-container');
                if ($opts.length) { $opts.before($container); } else { $target.append($container); }
            }
            // 新建/原地更新后都要对齐正文列，否则容器保持 width:100% 会比 wrapper 宽
            alignWrapperToMessageColumn();
        } else {
            $('.acu-embedded-dashboard-container').remove();
        }
    };


    const injectIndependentOptions = (htmlContent, themeClass, cssVars) => {
        const { $ } = getCore();
        if (!htmlContent) {
            $('.acu-embedded-options-container').remove();
            return;
        }

        // 共享选择器，同 injectEmbeddedDashboard
        const $target = getEmbeddedTargetBlock();
        if ($target && $target.length) {
            const $existing = $('.acu-embedded-options-container');
            let shouldUpdate = false;
            if ($existing.length && $existing.parent()[0] === $target[0]) {
                shouldUpdate = true;
            } else {
                $existing.remove();
            }

            if (shouldUpdate) {
                const $container = $('.acu-embedded-options-container');
                $container.removeClass().addClass(`acu-embedded-options-container ${themeClass}`);
                $container.attr('style', 'margin-top: 6px; width: 100%; clear: both; ' + cssVars);

                const $panel = $container.find('.acu-option-panel');
                $panel.html(htmlContent);
            } else {
                const STORAGE_KEY_OPT_COLLAPSE = 'acu_opt_collapse_state';
                let isCollapsed;
                try { isCollapsed = localStorage.getItem(STORAGE_KEY_OPT_COLLAPSE) === 'true'; }
                catch (e) { isCollapsed = false; }

                const $container = $('<div class="acu-embedded-options-container" style="margin-top: 6px; width: 100%; clear: both;"></div>');
                $container.addClass(themeClass).attr('style', $container.attr('style') + '; ' + cssVars);

                const headerHtml = `
                    <div class="acu-opt-ctrl-bar" style="
                        display: flex; justify-content: center; align-items: center;
                        padding: 10px 12px;
                        background: var(--acu-bg-nav);
                        border: 1px solid var(--acu-border);
                        border-radius: ${isCollapsed ? '12px' : '12px 12px 0 0'};
                        cursor: pointer;
                        user-select: none;
                        transition: all 0.2s;
                        margin-bottom: ${isCollapsed ? '0' : '-1px'};
                        position: relative; z-index: 2;
                        backdrop-filter: blur(5px);
                        -webkit-tap-highlight-color: transparent;
                    ">
                        <span style="font-weight: bold; color: var(--acu-title-color); font-size: 13px;">行动选项</span>
                    </div>
                `;

                const contentStyle = isCollapsed ? 'max-height: 0; opacity: 0; padding: 0;' : 'max-height: 1000px; opacity: 1; padding: 8px;';
                const contentWrapperHtml = `
                    <div class="acu-opt-content-wrapper" style="
                        overflow: hidden;
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        background: var(--acu-bg-nav);
                        border: 1px solid var(--acu-border);
                        border-top: none;
                        border-radius: 0 0 12px 12px;
                        backdrop-filter: blur(5px);
                        ${contentStyle}
                    ">
                        <div class="acu-option-panel" style="display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; padding: 0; border: none; background: transparent; box-shadow: none; margin: 0;">
                            ${htmlContent}
                        </div>
                    </div>
                `;

                $container.append(headerHtml);
                $container.append(contentWrapperHtml);

                const $header = $container.find('.acu-opt-ctrl-bar');
                const $wrapper = $container.find('.acu-opt-content-wrapper');

                $header.on('click', function(e) {
                    e.stopPropagation();
                    const currentIsCollapsed = localStorage.getItem(STORAGE_KEY_OPT_COLLAPSE) === 'true';

                    if (currentIsCollapsed) {
                        $wrapper.css({ 'max-height': '1000px', 'opacity': '1', 'padding': '8px' });
                        $header.css({ 'border-radius': '12px 12px 0 0', 'margin-bottom': '-1px' });
                        localStorage.setItem(STORAGE_KEY_OPT_COLLAPSE, 'false');
                    } else {
                        $wrapper.css({ 'max-height': '0', 'opacity': '0', 'padding': '0' });
                        $header.css({ 'border-radius': '12px', 'margin-bottom': '0' });
                        localStorage.setItem(STORAGE_KEY_OPT_COLLAPSE, 'true');
                    }
                });

                $target.append($container);
            }
            // 新建/原地更新后都要对齐正文列，否则容器保持 width:100% 会比 wrapper 宽
            alignWrapperToMessageColumn();
        } else {
             $('.acu-embedded-options-container').remove();
        }
    };

    const renderInterface = (forceRefresh = false) => {
        const { $ } = getCore();
        if (!$) return;
        try {
             const $lastPanel = $('.acu-panel-content');
            if ($lastPanel.length) { globalScrollTop = $lastPanel.scrollTop(); }

            const rawData = getTableData(forceRefresh) || {};
            const allTables = processJsonData(rawData);
            const tables = {};
            const optionTables = [];

            const config = getConfig();

            if(allTables) {
                 Object.keys(allTables).forEach(k => {
                     const sheet = allTables[k];
                     // 选项表识别收紧：
                     // 路径1 - 表名含'选项'（强信号）；
                     // 路径2 - uid 为 sheet_OptionsNew（默认选项表）；
                     // 路径3 - 形态特征：除 row_id 之外的列名都以'选项'开头。
                     //   这是选项表的本质特征（选项一/二/…/N），既能兼容扩列，
                     //   又能排除只是某列偶然含'选项'字样的其他表（上轮过宽识别的根因）。
                     const headersNoId = Array.isArray(sheet?.headers)
                         ? sheet.headers.filter(h => h && String(h).toLowerCase() !== 'row_id')
                         : [];
                     const looksLikeOptionsByShape = headersNoId.length > 0
                         && headersNoId.every(h => String(h).trim().startsWith('选项'));
                     const isOptionSheet = k.includes('选项')
                         || sheet?.key === 'sheet_OptionsNew'
                         || looksLikeOptionsByShape;
                     if (isOptionSheet) {
                         if (config.showOptionPanel !== false) {
                             optionTables.push(sheet);
                         }
                     } else {
                         tables[k] = sheet;
                     }
                 });
            }

            // 优化D：diffMap 惰性重算——只有数据真正刷新（引用变化走深拷贝）才重算，
            // 纯 UI 态变化（切 tab/折叠/设置调整 renderInterface(false)）复用现有 diffMap，
            // 避免每次渲染都 O(rows×cols) 全表比对。
            if (lastTableDataRefreshed) {
                currentDiffMap = generateDiffMap(rawData);
            }
            const savedOrder = getSavedTableOrder();
            let orderedNames = Object.keys(tables);
            if (savedOrder) orderedNames = savedOrder.filter(n => tables[n]).concat(orderedNames.filter(n => !savedOrder.includes(n)));

            const hiddenTables = getHiddenTables();
            const showDash = config.showDashboard !== false;
            const activeTab = getActiveTabState();
            let currentTabName = activeTab;

            if (isEditingOrder) currentTabName = null;

            if (currentTabName === TAB_DASHBOARD && config.dashboardPosition !== 'panel') currentTabName = null;
            if (currentTabName && currentTabName !== TAB_DASHBOARD && !tables[currentTabName]) currentTabName = null;

            let colorVal = HIGHLIGHT_COLORS[config.highlightColor];
        if (!colorVal && config.highlightColor && String(config.highlightColor).startsWith('#')) {
            colorVal = { main: config.highlightColor, bg: config.highlightColor + '1a' };
        }
        colorVal = colorVal || HIGHLIGHT_COLORS.orange;
            let titleColorVal = 'var(--acu-text-main)';
        if (config.customTitleColor) {
             const tRaw = config.titleColor;
             if (tRaw && String(tRaw).startsWith('#')) {
                 titleColorVal = tRaw;
             } else {
                 titleColorVal = (HIGHLIGHT_COLORS[tRaw] || HIGHLIGHT_COLORS.orange).main;
             }
        }
            const showPanel = !isCollapsed && currentTabName !== null;
            const tableHeights = getTableHeights();
            let styleHeight = 'height:auto; max-height:500px;';

            if (currentTabName && (tables[currentTabName] || currentTabName === TAB_DASHBOARD)) {
                const h = tableHeights[currentTabName];
                styleHeight = h ? `height:${h}px; max-height:95vh;` : `height:60vh; max-height:95vh;`;
            }

            const gridCols = config.gridColumns > 0 ? `repeat(${config.gridColumns}, 1fr)` : 'repeat(auto-fill, minmax(110px, 1fr))';
            const collapseStyle = config.collapseStyle || 'bar';
            const collapsePos = config.collapsePosition || 'center';

            const isAlreadyVisible = $('#acu-data-area').hasClass('visible');

            const actionBtns = {
                'acu-btn-open-db': `<button class="acu-action-btn" id="acu-btn-open-db" title="打开数据库工作台（基础/高手模式）"><i class="fa-solid fa-database"></i></button>`,
                'acu-btn-open-visualizer': `<button class="acu-action-btn" id="acu-btn-open-visualizer" title="打开表格编辑器"><i class="fa-solid fa-table-cells"></i></button>`,
                'acu-btn-manual-update': `<button class="acu-action-btn" id="acu-btn-manual-update" title="立即手动更新"><i class="fa-solid fa-bolt"></i></button>`,
                'acu-btn-settings': `<button class="acu-action-btn" id="acu-btn-settings" title="全能设置"><i class="fa-solid fa-cog"></i></button>`,
                'acu-btn-toggle': `<button class="acu-action-btn" id="acu-btn-toggle" title="${isCollapsed ? '展开' : '收起'}"><i class="fa-solid ${isCollapsed ? 'fa-chevron-up' : 'fa-chevron-down'}"></i></button>`
            };

            const savedActionOrder = getSavedActionOrder() || Object.keys(actionBtns);
            let finalActionOrder = savedActionOrder.filter(k => actionBtns[k]);
            Object.keys(actionBtns).forEach(k => { if (!finalActionOrder.includes(k)) finalActionOrder.push(k); });

            let navActionsHtml = '';
            finalActionOrder.forEach(k => { navActionsHtml += actionBtns[k]; });

            const orderControlsHtml = isEditingOrder 
                ? `<div class="acu-order-controls visible" id="acu-order-hint" style="display:flex;justify-content:space-between;align-items:center"><span style="color:var(--acu-title-color);font-weight:bold;">点击表格调整位置</span><div><button id="acu-btn-cancel-mode" style="margin-right:5px;cursor:pointer;background:var(--acu-btn-bg);border:1px solid var(--acu-border);padding:3px 8px;border-radius:4px;color:var(--acu-title-color)">取消</button><button id="acu-btn-save-mode" style="cursor:pointer;background:var(--acu-btn-active-bg);border:none;padding:3px 8px;border-radius:4px;color:var(--acu-btn-active-text);font-weight:bold">保存</button></div></div>`
                : `<div class="acu-order-controls" id="acu-order-hint"></div>`;

            let contentHtml = '';
            if (currentTabName === TAB_DASHBOARD) {
                contentHtml = renderDashboard(tables);
            } else if (currentTabName && tables[currentTabName]) {
                contentHtml = renderTableContent(tables[currentTabName], currentTabName);
            }

            // 选项表变化检测：用轻量摘要替代全量 JSON.stringify（选项表结构 {key,headers,rows}）。
            // 按 headers 长度全列投影（选项表列数少，全列成本低），避免前 12 列截断漏检 13+ 列变化。
            const optionStr = optionTables.map(ot => {
                const hdrArr = Array.isArray(ot?.headers) ? ot.headers : [];
                const h = hdrArr.join(',');
                const rowsArr = Array.isArray(ot?.rows) ? ot.rows : [];
                const rs = rowsArr.map(r => {
                    if (!Array.isArray(r)) return '';
                    const cl = hdrArr.length || r.length; // 按表头列数投影；无表头时按行长度
                    let s = '';
                    for (let cc = 0; cc < cl; cc++) s += (r[cc] ?? '') + '|';
                    return s;
                }).join(';');
                return h + '@' + rowsArr.length + ':' + rs;
            }).join('~');
            if (optionStr !== lastOptionDataCheck) {
                hideOptionsUntilUpdate = false;
                lastOptionDataCheck = optionStr;
            }

            let optionBtnContent = '';
            let optBtnCount = 0; if (optionTables.length > 0 && !hideOptionsUntilUpdate) {
                let buttonsHtml = '';
                let hasBtns = false;
                optionTables.forEach(table => {
                    if(table.rows && Array.isArray(table.headers)) {
                         // 关键修复：按 headers 的列数遍历，而不是按 row 的实际长度。
                         // 当用户在 DB 里把选项表从 4 列扩到 6/8 列后，row 数组往往没自动补齐新列，
                         // 旧的 row.forEach 遍历不到新增列下标，新增选项永远不显示。
                         // 这里按 headers 长度迭代并对 row[idx] 缺值做空字符串兜底，
                         // 同时用 encodeURIComponent 安全转义，空按钮跳过不生成（避免出现空格占位）。
                         const colCount = table.headers.length;
                         table.rows.forEach(row => {
                              for (let idx = 1; idx < colCount; idx++) {
                                   const cell = (row && row[idx] != null) ? String(row[idx]) : '';
                                   if (cell) {
                                       buttonsHtml += `<button class="acu-opt-btn" data-val="${encodeURIComponent(cell)}">${cell}</button>`;
                                       hasBtns = true; optBtnCount++;
                                   }
                              }
                         });
                    }
                });
                if (hasBtns) {
                    optionBtnContent = buttonsHtml;
                }
            }


            // ≤4：每行排满；>4：每行最多 3，flex 居中（末行也居中）
            let optMaxPerRow = 3;
            if (optBtnCount > 0) {
                 if (optBtnCount <= 4) optMaxPerRow = optBtnCount;
                 else optMaxPerRow = 3;
            }
            // 按钮宽度 = (100% - gap*(n-1)) / n；gap 与 CSS 中 8px 对齐
            const optGapPx = 8;
            const optBtnW = optMaxPerRow <= 1
                ? '100%'
                : `calc((100% - ${optGapPx * (optMaxPerRow - 1)}px) / ${optMaxPerRow})`;
            const cssVars = `--acu-opt-cols:repeat(${optMaxPerRow}, 1fr); --acu-opt-btn-w:${optBtnW}; --acu-card-width:${config.cardWidth}px; --acu-font-size:${config.fontSize}px; --acu-opt-font-size:${config.optionFontSize || 13}px; --acu-dash-font-size:${config.dashboardFontSize || 13}px; --acu-highlight:${colorVal.main}; --acu-highlight-bg:${colorVal.bg}; --acu-accent:${colorVal.main}; --acu-title-color:${titleColorVal}; --acu-nav-cols:${gridCols}; --acu-text-max-height:${config.limitLongText!==false?'80px':'none'}; --acu-text-overflow:${config.limitLongText!==false?'auto':'visible'}`;

            let html = `
                <div class="acu-wrapper acu-theme-${config.theme}" style="${cssVars}">
                    <div class="acu-data-display acu-layout-${config.layout} ${showPanel ? 'visible' : ''} ${isAlreadyVisible ? 'acu-no-anim' : ''}" id="acu-data-area" style="${styleHeight}">
                        ${contentHtml}
                    </div>
                    <div class="acu-nav-container ${isCollapsed ? 'collapsed' : ''} ${isEditingOrder ? 'editing-order' : ''} acu-collapse-${collapseStyle} acu-pill-${collapsePos}" id="acu-nav-bar">
                        ${orderControlsHtml}
                        <div class="acu-nav-tabs-area">
                            ${(showDash && config.dashboardPosition === 'panel') ? `<button class="acu-nav-btn ${currentTabName === TAB_DASHBOARD ? 'active' : ''}" data-table="${TAB_DASHBOARD}"><i class="fa-solid fa-tachometer-alt"></i><span>仪表盘</span></button>` : ''}
            `;
            orderedNames.forEach(name => {
                if (hiddenTables.includes(name)) return;
                let iconClass = getIconForTableName(name);

                const isActive = currentTabName === name ? 'active' : '';
                html += `<button class="acu-nav-btn ${isActive}" data-table="${name}"><i class="fa-solid ${iconClass}"></i><span>${name}</span></button>`;
              });
            html += `   </div>
                        <div class="acu-nav-separator"></div>
                        <div class="acu-nav-actions-area">
                            ${navActionsHtml}
                        </div>
                        <div class="acu-collapsed-text">展开面板</div>
                    </div>
                </div>`;
            insertHtmlToPage(html); 

            if (showDash && config.dashboardPosition === 'embedded') {
                 const dashHtml = renderDashboard(tables, true);
                 injectEmbeddedDashboard(dashHtml, `acu-theme-${config.theme}`, cssVars);
            } else {
                 $('.acu-embedded-dashboard-container').remove();
            }

            if (optionBtnContent) {
                injectIndependentOptions(optionBtnContent, `acu-theme-${config.theme}`, cssVars);
            } else {
                $('.acu-embedded-options-container').remove();
            }

            bindEvents(tables);
            if (globalScrollTop > 0) {
                $('.acu-panel-content').scrollTop(globalScrollTop);
            }
            if (isEditingOrder) initSortable();
        } catch(e) { console.error("UI Render Error:", e); }
    };

    
    const renderDashboard = (tables, isEmbedded = false) => {
        const config = getConfig();
        const dashConfig = getDashConfig() || {};

        const defaults = {
            'slot_1_1': {isEmpty:true}, 'slot_1_2': {isEmpty:true}, 
            'slot_2_1': {isEmpty:true}, 'slot_2_2': {isEmpty:true}, 
            'slot_3_1': {isEmpty:true}, 'slot_3_2': {isEmpty:true}, 
            'slot_4_1': {isEmpty:true}, 'slot_4_2': {isEmpty:true}, 
            'slot_5_1': {isEmpty:true}, 'slot_5_2': {isEmpty:true}, 
            'slot_6_1': {isEmpty:true}, 'slot_6_2': {isEmpty:true}
        };

        const getSlotCfg = (id) => ({ ...defaults[id], ...(dashConfig[id] || {}) });

        const findKey = (keyword, exact = false) => {
            if (!keyword) return null;
            return Object.keys(tables).find(k => exact ? k === keyword : k.includes(keyword));
        };

        let _cfgChanged = false;
        const _autoSetup = [
            { id: 'slot_2_1', kw: '主角信息', rule: 'kv' },
            { id: 'slot_3_1', kw: '全局数据', rule: 'kv' },
            { id: 'slot_4_1', kw: '重要角色', rule: 'capsule', col: 1 },
            { id: 'slot_5_1', kw: '背包', rule: 'capsule', col: 1 },
            { id: 'slot_5_2', kw: '技能', rule: 'capsule', col: 1 },
            { id: 'slot_6_1', kw: '任务', rule: 'capsule', col: 1, capCols: 2 },
            { id: 'slot_6_2', kw: '地点', rule: 'capsule', col: 1, capCols: 2 }
        ];
        _autoSetup.forEach(s => {
            if (!dashConfig[s.id]) {
                const k = findKey(s.kw);
                if (k && tables[k]) {
                    const t = tables[k];
                    const entry = { isEmpty: false, title: (k.endsWith('表') ? k.slice(0, -1) : k), text: k, rule: s.rule };
                    let valid = false;
                    if (s.rule === 'kv') {
                        if (t.rows && t.rows.length) { entry.card = t.rows[0][1]; }
                        if (s.cols) entry.showCols = s.cols;
                        valid = true;
                    } else if (s.rule === 'capsule') {
                        entry.capCol = s.col;
                        if (s.capCols) entry.capCols = s.capCols;
                        valid = true;
                    }
                    if (valid) { dashConfig[s.id] = entry; _cfgChanged = true; }
                }
            }
        });
        if (_cfgChanged) saveDashConfig(dashConfig);

        const renderFirstRowAllCols = (slotId) => {
            const cfg = getSlotCfg(slotId);
            const keyword = cfg.text;
            const key = findKey(keyword);
            const table = key ? tables[key] : null;

            if (!table || !table.rows || table.rows.length === 0) {
                return `<div style="padding:15px; color:var(--acu-text-sub); font-size:12px; text-align:center;">未找到表格: ${keyword}</div>`;
            }

            const headers = table.headers || [];
            let targetRow = table.rows[0];

            if (cfg.card) {
                const found = table.rows.find(r => r[1] === cfg.card);
                if (found) targetRow = found;
            }

            let itemsHtml = '';
            const colsToShow = (cfg.showCols && cfg.showCols.length > 0) ? cfg.showCols.map(Number) : null;

            targetRow.forEach((cell, idx) => {
                if (idx === 0) return; 
                if (colsToShow && !colsToShow.includes(idx)) return;

                const label = headers[idx] || `列${idx}`;
                if (cell !== undefined && cell !== null && String(cell).trim() !== '') {
                    itemsHtml += `
                        <div class="acu-dash-stat-row" style="display:flex; justify-content:flex-start; align-items:center; padding:8px 10px; background:var(--acu-btn-bg); border-radius:8px; border:1px solid transparent; width:100%; box-sizing:border-box;">
                            <span class="acu-dash-stat-label" style="color:var(--acu-title-color); font-size:1em; margin-right:8px; white-space:normal; overflow-wrap:break-word; flex-shrink:0; width:90px;">${label}</span>
                            <span class="acu-dash-stat-val" style="color:var(--acu-text-main); font-weight:bold; font-size:1em; white-space:pre-wrap; word-break:break-word; text-align:left;">${cell}</span>
                        </div>
                    `;
                }
            });

            return `<div class="acu-dash-char-info" style="display:flex; flex-direction:column; gap:8px; overflow-y: auto; height: 100%; padding-right: 4px;">${itemsHtml}</div>`;
        };

        const renderSecondColCapsules = (slotId) => {
            const cfg = getSlotCfg(slotId);
            const keyword = cfg.text;
            const key = findKey(keyword);
            const table = key ? tables[key] : null;

            if (!table || !table.rows || table.rows.length === 0) {
                 return `<div style="padding:15px; color:var(--acu-text-sub); font-size:12px; text-align:center;">未找到表格: ${keyword}</div>`;
            }

            const targetColIdx = (cfg.capCol !== undefined && cfg.capCol !== null) ? parseInt(cfg.capCol) : 1;
            const capCols = cfg.capCols || 0;

            let gridStyleOverride = '';
            if (capCols > 0) {
                gridStyleOverride = `grid-template-columns: repeat(${capCols}, 1fr) !important;`;
            }

            let iconHtml = '';
            if (capCols === 2) {
                const iconClass = getIconForTableName(key);
                iconHtml = `<i class="fa-solid ${iconClass}" style="margin-right:6px; opacity:0.7; font-size:0.9em;"></i>`;
            }

            // 胶囊槽位不分页会成为最大的渲染成本：任务/地点这类表会无界增长，
            // 实测 500 行 × 5 个默认槽位 = 929KB HTML，而嵌入式仪表盘创建时恒为
            // 折叠态（height:0/opacity:0），这些 DOM 用户根本看不到却每次渲染都重建。
            // 这里封顶：只渲染前 CAPSULE_RENDER_CAP 条，超出用一个提示条代替。
            const CAPSULE_RENDER_CAP = 60;
            let itemsHtml = '';
            let shown = 0, skipped = 0;
            for (let rIdx = 0; rIdx < table.rows.length; rIdx++) {
                const row = table.rows[rIdx];
                const val = (row && row[targetColIdx] !== undefined) ? row[targetColIdx] : '';
                if (!val || String(val).trim() === '') continue;
                if (shown >= CAPSULE_RENDER_CAP) { skipped++; continue; }
                shown++;
                const flexStyle = capCols === 2 ? 'display:flex; align-items:center; justify-content:center;' : '';
                itemsHtml += `<div class="acu-dash-npc-item acu-dash-interactive" data-tname="${key}" data-row="${rIdx}" data-col="${targetColIdx}" style="cursor:pointer; padding:10px 10px; background:var(--acu-table-head); border-radius:8px; border:1px solid transparent; font-size:0.9em; font-weight:500; transition:all 0.2s; ${flexStyle}">${iconHtml}${val}</div>`;
            }
            if (skipped > 0) {
                itemsHtml += `<div style="padding:8px 10px; color:var(--acu-text-sub); font-size:11px; text-align:center; grid-column:1/-1;">仅显示前 ${CAPSULE_RENDER_CAP} 条，另有 ${skipped} 条请到表格页查看</div>`;
            }

            const customStyle = 'height: 100%; ' + gridStyleOverride + (window.innerWidth <= 768 ? 'max-height: 200px;' : '');

            return `<div class="acu-dash-npc-grid acu-no-scrollbar" style="${customStyle}">${itemsHtml}</div>`;
        };

        const renderSlotContent = (slotId) => {
            const cfg = getSlotCfg(slotId);
            if (cfg.isEmpty) {
                return `<div style="width:100%; height:100%; min-height:120px; display:flex; flex-direction:column; align-items:center; justify-content:center; opacity:0.6;">
                    <button class="acu-slot-setting-btn" data-slot="${slotId}" style="width:40px; height:40px; border-radius:50%; background:transparent; color:var(--acu-text-sub); border:2px dashed var(--acu-text-sub); cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:16px; transition:all 0.2s;">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                    <div style="margin-top:8px; font-size:12px; color:var(--acu-text-sub);">点击配置</div>
                </div>`;
            }
            if (cfg.rule === 'kv') return renderFirstRowAllCols(slotId);
            return renderSecondColCapsules(slotId);
        };

        const getSlotTitle = (slotId) => {
            const cfg = getSlotCfg(slotId);
            return cfg.isEmpty ? '未配置' : cfg.title;
        };

        const renderSlotWrapper = (slotId, contentHtml) => {
             const cfg = getSlotCfg(slotId);
             if (cfg.isEmpty) {
                 return `<div class="acu-dash-card" style="position:relative; border: 2px dashed var(--acu-border); background: rgba(0,0,0,0.02); box-shadow:none;">
                    ${contentHtml}
                 </div>`;
             }
             const editBtn = isDashEditing ? 
                `<button class="acu-slot-setting-btn" data-slot="${slotId}" style="position:absolute; top:8px; right:8px; z-index:10; width:24px; height:24px; border-radius:50%; background:var(--acu-btn-active-bg); color:#fff; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 5px rgba(0,0,0,0.2);"><i class="fa-solid fa-cog" style="font-size:12px;"></i></button>` : '';

             return `
                <div class="acu-dash-card" style="position:relative; width:100%; box-sizing:border-box; flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden;">
                    ${editBtn}
                    <div class="acu-dash-title">${cfg.title || '未命名'}</div>
                    ${contentHtml}
                </div>
             `;
        };

        const getTabEditBtn = (sid) => isDashEditing ? 
             `<button class="acu-slot-setting-btn" data-slot="${sid}" style="margin-left:5px; width:20px; height:20px; border-radius:50%; background:var(--acu-btn-active-bg); color:#fff; border:none; cursor:pointer; display:inline-flex; align-items:center; justify-content:center;"><i class="fa-solid fa-cog" style="font-size:10px;"></i></button>` : '';

        const render3In1Group = (groupId, slotIds, minHeight, isAutoHeight) => {
            let visibleIds = slotIds.filter(id => !getSlotCfg(id).isEmpty);
            if (isDashEditing) visibleIds = slotIds; 

            if (visibleIds.length === 0) return '';

            let header = '<div class="acu-tab-header">';
            let body = '<div class="acu-tab-content-container" style="flex:1;">';

            visibleIds.forEach((sid, i) => {
                const active = i === 0 ? 'active' : '';
                const title = getSlotTitle(sid);
                const tabId = `${groupId}-${sid}`;
                header += `<div class="acu-tab-btn ${active}" data-target="${tabId}">${title} ${getTabEditBtn(sid)}</div>`;
                body += `<div id="${tabId}" class="acu-tab-pane ${active}">${renderSlotContent(sid)}</div>`;
            });
            header += '</div>';
            body += '</div>';

                const flexStyle = 'flex: 1 1 auto;';

            return `<div class="acu-dash-card" style="${minHeight ? 'min-height:'+minHeight+';' : ''} width:100%; box-sizing:border-box; display:flex; flex-direction:column; padding:0; overflow:hidden; gap:0; ${flexStyle} min-height: 0;">
                <div style="padding:10px 16px 0 16px;">${header}</div>
                <div class="acu-no-scrollbar" style="padding:6px 16px 16px 16px; flex:1; overflow-y:auto;">${body}</div>
            </div>`;
        };

                const c1Ids = ['slot_1_1', 'slot_1_2', 'slot_2_1', 'slot_2_2'];
        const c2Ids = ['slot_3_1', 'slot_3_2', 'slot_4_1', 'slot_4_2'];
        const c3Ids = ['slot_5_1', 'slot_5_2', 'slot_6_1', 'slot_6_2'];

        const hasC1 = isDashEditing || c1Ids.some(id => !getSlotCfg(id).isEmpty);
        const hasC2 = isDashEditing || c2Ids.some(id => !getSlotCfg(id).isEmpty);
        const hasC3 = isDashEditing || c3Ids.some(id => !getSlotCfg(id).isEmpty);

        let activeCols = 0;
        if (hasC1) activeCols++;
        if (hasC2) activeCols++;
        if (hasC3) activeCols++;

        const gridStyle = activeCols > 0 ? `grid-template-columns: repeat(${activeCols}, 1fr) !important;` : 'display: flex; flex-direction: column;';

        const content = `
            <div class="acu-dash-container" style="${gridStyle}">
                ${hasC1 ? `<div class="acu-dash-col">
                    ${render3In1Group('grp_1', ['slot_1_1', 'slot_1_2'], null, true)}
                    ${render3In1Group('grp_2', ['slot_2_1', 'slot_2_2'], null, false)}
                </div>` : ''}
                ${hasC2 ? `<div class="acu-dash-col">
                    ${render3In1Group('grp_3', ['slot_3_1', 'slot_3_2'], null, true)}
                    ${render3In1Group('grp_4', ['slot_4_1', 'slot_4_2'], null, false)}
                </div>` : ''}
                ${hasC3 ? `<div class="acu-dash-col">
                    ${render3In1Group('grp_5', ['slot_5_1', 'slot_5_2'], null, true)}
                    ${render3In1Group('grp_6', ['slot_6_1', 'slot_6_2'], null, false)}
                </div>` : ''}
            </div>
        `;

        if (isEmbedded) {
            return content;
        }

        const html = `
            <div class="acu-panel-header">
                <div class="acu-panel-title">
                    <i class="fa-solid fa-tachometer-alt"></i> 仪表盘
                    ${isDashEditing ? '<span style="font-size:12px; margin-left:10px; color:var(--acu-highlight); background:var(--acu-highlight-bg); padding:2px 8px; border-radius:4px;">编辑模式</span>' : ''}
                </div>
                <div class="acu-header-actions">
                    <div class="acu-header-btn-group" style="display:flex; gap:6px; align-items:center;">
                        <button class="acu-header-btn" id="acu-btn-dash-edit" title="${isDashEditing ? '退出编辑' : '编辑仪表盘'}">
                            <i class="fa-solid ${isDashEditing ? 'fa-check' : 'fa-edit'}" style="${isDashEditing ? 'color:var(--acu-highlight)' : ''}"></i>
                        </button>
                        <button class="acu-header-btn acu-height-drag-handle" data-table="acu_tab_dashboard_home" title="按住拖动调整高度">
                            <i class="fa-solid fa-arrows-up-down"></i>
                        </button>
                        
                        <button class="acu-header-btn" id="acu-btn-close" title="关闭">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>
            </div>

            <div class="acu-panel-content acu-no-scrollbar" style="overflow-y:auto; padding:0;">
                ${content}
            </div>
        `;
        return html;
    };

    // 挑一条能代表正文列几何的消息来量。
    //
    // 不能无脑取最后一条：ST 给系统小消息加 .smallSysMes，其样式把
    // `.mes_text { padding: 0 !important }`、`.mes_block { margin-right: unset !important }`，
    // 量到的「正文宽」等于整块宽，面板就会又宽出 30px —— 正是本次要修的溢出。
    // 所以优先取最后一条正常消息（非系统/非小系统），没有再退回最后一条。
    const getMeasurableMes = () => {
        const { $ } = getCore();
        const $all = $('#chat .mes');
        if (!$all.length) return null;
        // 从末尾倒着找，命中即停 —— 不要用 .filter() 扫全部消息。
        // 原写法对每条消息调 $m.css('display')，那是 per-message getComputedStyle：
        // 1000 层聊天实测单次 1.1ms、一次渲染 5 次扫描 5.7ms，且随聊天变长线性恶化。
        // 倒序 + offsetParent 判隐藏不触发样式解析，实测同规模 0.01ms（快 100 倍以上）。
        const nodes = $all.get();
        for (let i = nodes.length - 1; i >= 0; i--) {
            const el = nodes[i];
            if (el.classList.contains('smallSysMes') || el.classList.contains('sys_mes')) continue;
            if (el.getAttribute('is_system') === 'true') continue;
            // 隐藏判定：offsetParent 为空且无 client rect（比 getComputedStyle 便宜得多）
            if (el.offsetParent === null && el.getClientRects().length === 0) continue;
            return $(el);
        }
        const $last = $all.last();
        return $last.length ? $last : null;
    };

    // 找嵌入选项/仪表盘要挂的那条消息块。
    // 之前仪表盘注入和选项注入各自内置一份一模一样的 getTargetContainer，
    // 都靠 .filter() 全表扫 + 每条消息调 .css('display')（per-message getComputedStyle）
    // 和 .find('.name_text')（子树查询）。这里提一份共享的，倒序找 + offsetParent
    // 判隐藏，不再做那两个 per-node 调用。返回 .mes_block（没有则退回 .mes）。
    const getEmbeddedTargetBlock = () => {
        const { $ } = getCore();
        const $all = $('#chat .mes');
        if (!$all.length) return null;
        const nodes = $all.get();
        for (let i = nodes.length - 1; i >= 0; i--) {
            const el = nodes[i];
            if (el.getAttribute('is_user') === 'true' || el.getAttribute('is_system') === 'true') continue;
            if (el.classList.contains('sys_mes')) continue;
            const $name = el.querySelector('.name_text');
            if ($name && $name.textContent.trim() === 'System') continue;
            if (el.offsetParent === null && el.getClientRects().length === 0) continue;
            const $el = $(el);
            const $block = $el.find('.mes_block');
            return $block.length ? $block : $el;
        }
        return null;
    };

    // 正文列内容盒 = .mes_text 去掉左右 padding 后的可视文字区。
    // 取不到（正文被 inline_media 隐藏、消息不可见等）时回退到 .mes_block 内容宽
    // 减去 --mes-right-spacing，保证仍能对齐而不是干脆放弃。
    const getMessageColumnBox = ($lastMes) => {
        const contentBox = (el) => {
            const r = el.getBoundingClientRect();
            const cs = window.getComputedStyle(el);
            const pl = parseFloat(cs.paddingLeft) || 0;
            const pr = parseFloat(cs.paddingRight) || 0;
            return { left: r.left + pl, width: r.width - pl - pr };
        };

        const $mesText = $lastMes.find('.mes_text').first();
        if ($mesText.length && $mesText.is(':visible')) {
            const box = contentBox($mesText[0]);
            if (box.width > 0) return { box, contentBox };
        }
        // 回退：.mes_block 内容宽 - 正文右留白。
        // 没有 .mes_block 时不要退到 .mes——那个盒子含头像，量出来会偏左偏宽，
        // 宁可放弃对齐（保持原宽度）也不要对到错的盒子上。
        const $block = $lastMes.find('.mes_block').first();
        if (!$block.length) return null;
        const box = contentBox($block[0]);
        // 右留白直接读 .mes_text 的 computed padding-right：CSSOM 给的是已换算好的
        // 绝对 px，display:none 的元素同样能读到，所以不必解析 --mes-right-spacing
        // 的原始 token（'2em' 之类 parseFloat 会读错），也不用往 DOM 里塞探针。
        let spacing = 30; // 兜底用 ST 根变量默认值，别用 0——那等于没修
        if ($mesText.length) {
            const px = parseFloat(window.getComputedStyle($mesText[0]).paddingRight);
            if (px >= 0) spacing = px;
        }
        box.width -= spacing;
        return box.width > 0 ? { box, contentBox } : null;
    };

    // 把一个注入到消息里的面板对齐到正文列。
    //
    // 关键点：.mes_text 有 padding-right: var(--mes-right-spacing)（ST 默认 30px），
    // 所以 outerWidth() 含这段留白，恰好等于 .mes_block 的内容宽 —— 也就是面板
    // 作为块级子元素本来就有的宽度。早前版本用 outerWidth() 赋值是空操作，面板始终右溢。
    // 这里一律取「内容宽」，并用 margin-left 补上面板父容器与正文列的左缘差
    // （挂 .mes_block 时为 0；bottom 模式挂 #chat 时为头像+间距，约 70px）。
    //
    // 注意：选项容器的样式表规则带 !important（见 .acu-embedded-options-container），
    // 普通内联样式压不过它，必须用 setProperty 的 important 优先级写入。
    // inset：两侧各内缩多少 px。嵌入式仪表盘/选项是主面板的附属块，
    // 与主面板齐宽会显得呆板，内缩一点做出层次。
    // 只负责「量」，不写样式：读写必须分离，否则前一个面板的写会让后一个面板的
    // 读触发强制同步重排。实测 1000 层聊天下交错读写 3 次 ≈ 11.8ms，
    // 批量读再批量写 1 次 ≈ 3.4ms。
    const planPanelAlignment = ($panel, column, inset = 0) => {
        if (!$panel || !$panel.length || !column) return null;
        const { box, contentBox } = column;
        try {
            const el = $panel[0];
            const parentEl = el && el.parentElement;
            if (!parentEl) return null;
            const parent = contentBox(parentEl);
            // 窄屏别硬缩：内缩后至少留 240px 可用宽。
            // 注意是「夹住」不是「归零」——早前写成不够就 pad=0，会在列宽 260px 处
            // 突跳 19.5px，而且更宽的列反而得到更窄的面板（非单调）。实测该阈值
            // 正好落在 375px 和 390px 两种常见手机之间，拖窗宽跨过去会看到面板抽动。
            const pad = inset > 0
                ? Math.max(0, Math.min(inset, Math.floor((box.width - 240) / 2)))
                : 0;
            return {
                el,
                width: (box.width - pad * 2) + 'px',
                marginLeft: (box.left - parent.left + pad) + 'px',
            };
        } catch (e) {
            console.debug('[ACU-UI] 正文列测量失败:', e);
            return null;
        }
    };

    const applyPanelAlignment = (plan) => {
        if (!plan) return;
        try {
            plan.el.style.setProperty('width', plan.width, 'important');
            plan.el.style.setProperty('max-width', plan.width, 'important');
            plan.el.style.setProperty('margin-left', plan.marginLeft, 'important');
            plan.el.style.setProperty('margin-right', '0', 'important');
        } catch (e) {
            // 保持原宽度，不影响功能。留一条 debug：对齐失效过去很难发现
            // （量错宽度只是视觉偏移，不报错），排查时至少有个抓手。
            console.debug('[ACU-UI] 正文列对齐失败:', e);
        }
    };

    // 三个面板都注入在同一个 .mes_block 里（wrapper / 嵌入仪表盘 / 嵌入选项），
    // 只对齐其中一个会让它们右缘参差，所以统一在这里一起对齐。
    //
    // 主面板对齐正文列满宽；嵌入的仪表盘/选项两侧各内缩一点——它们是主面板的
    // 附属块，齐宽会显得跟主面板平级、整屏一根笔直的边，缩进后层次清楚。
    // 内缩量取正文列宽的 3%，夹在 10~28px：宽屏不至于缩太多，窄屏不至于没效果。
    const EMBED_INSET_RATIO = 0.03;
    const EMBED_INSET_MIN = 10;
    const EMBED_INSET_MAX = 28;
    // 一次 renderInterface 会经 insertHtmlToPage / 仪表盘注入 / 选项注入 三条路径
    // 各调一次对齐，而最后一次就已覆盖全部三个面板 —— 前两次纯属重复测量。
    // 用 rAF 合并到同一帧只跑一次；调用方仍可随便调，不必关心谁先谁后。
    let alignRafPending = false;
    const alignWrapperToMessageColumn = () => {
        if (alignRafPending) return;
        alignRafPending = true;
        requestAnimationFrame(() => {
            alignRafPending = false;
            alignWrapperToMessageColumnNow();
        });
    };

    const alignWrapperToMessageColumnNow = () => {
        const { $ } = getCore();
        const $mes = getMeasurableMes();
        if (!$mes) return;
        const column = getMessageColumnBox($mes);
        if (!column) return;
        const inset = Math.round(Math.min(
            EMBED_INSET_MAX,
            Math.max(EMBED_INSET_MIN, column.box.width * EMBED_INSET_RATIO)
        ));
        // 主面板(.acu-wrapper)不参与正文列对齐：保持 width:100% 全宽横跨屏幕。
        // 原因（用户实测确认）：对齐到正文列后左边是角色头像、右边空白，左右天生
        // 不等长，视觉上反而显得不居中；全宽铺满底部才是平衡的。
        // 嵌入的仪表盘/选项仍是附属块，对齐正文列并两侧内缩做出层次。
        // 先全部量完再全部写，避免写-读交错触发强制重排（见 planPanelAlignment 注释）
        const plans = [
            planPanelAlignment($('.acu-embedded-dashboard-container'), column, inset),
            planPanelAlignment($('.acu-embedded-options-container'), column, inset),
        ];
        for (const p of plans) applyPanelAlignment(p);
    };

    const insertHtmlToPage = (html) => {
        const { $ } = getCore();
        const $chat = $('#chat');
        const config = getConfig();
        
        $('.acu-wrapper').remove();
        
        const $newContent = $(html);
        
        if (config.frontendPosition === 'message') {
             const $lastMes = $chat.find('.mes').last();
             if ($lastMes.length) {
                 const $targetBlock = $lastMes.find('.mes_block').length ? $lastMes.find('.mes_block') : $lastMes;
                 $targetBlock.append($newContent);
                 alignWrapperToMessageColumn();
             } else {
                 if ($chat.length) $chat.append($newContent); else $('body').append($newContent);
             }
        } else {
            if ($chat.length) { $chat.append($newContent); } else { $('body').append($newContent); }
            alignWrapperToMessageColumn();
        }

        // 优化：去掉 subtree 监听，只观察 #chat 直接子级增删（新 .mes 是 #chat 直接子元素）。
        // 原 subtree:true 会监听消息内部深层渲染（swipe/代码块展开等）触发大量无意义回调。
        // 再加节流：批量增删时只处理最后一次，避免高频 jQuery 查找。
        let obsRafPending = false;
        const handleChatMutation = () => {
            if (obsRafPending) return;
            obsRafPending = true;
            requestAnimationFrame(() => {
                obsRafPending = false;
                const currentConfig = getConfig();
                const $chatNode = $('#chat');
                const $wrapper = $('.acu-wrapper');
                if (!$chatNode.length || !$wrapper.length) return;
                if (currentConfig.frontendPosition === 'message') {
                    const $lastMes = $chatNode.find('.mes').last();
                    if ($lastMes.length) {
                        const $targetBlock = $lastMes.find('.mes_block').length ? $lastMes.find('.mes_block') : $lastMes;
                        if (!$targetBlock.find('.acu-wrapper').length) {
                            $targetBlock.append($wrapper);
                        } else if ($targetBlock.children().last()[0] !== $wrapper[0]) {
                            $targetBlock.append($wrapper);
                        }
                        alignWrapperToMessageColumnNow(); // 已在 rAF 内，直调免再延一帧
                    }
                } else {
                    const children = $chatNode.children();
                    const lastChild = children.last()[0];
                    if (lastChild && lastChild !== $wrapper[0]) {
                        if ($(lastChild).hasClass('mes') || $(lastChild).hasClass('message-body')) {
                            $chatNode.append($wrapper);
                        }
                    }
                    // 消息增删后重新对齐面板到正文列
                    alignWrapperToMessageColumnNow(); // 已在 rAF 内，直调免再延一帧
                }
            });
        };
        if (observer) observer.disconnect();
        observer = new MutationObserver(handleChatMutation);

        // 窗口 resize / 转屏后消息列宽度变化，复用对齐逻辑防重新贴边。
        // rAF 合并，避免转屏/软键盘的 resize 风暴里反复强制布局。
        let resizeRafPending = false;
        $(window).off('resize.acu_align').on('resize.acu_align', () => {
            if (resizeRafPending) return;
            resizeRafPending = true;
            requestAnimationFrame(() => {
                resizeRafPending = false;
                alignWrapperToMessageColumnNow(); // 已在 rAF 内，直调免再延一帧
            });
        });

        // ST 的「聊天宽度」滑块改的是 --sheldWidth，既不触发 window resize
        // 也不动 #chat 的直接子级，光靠上面两个监听会让面板卡在旧的像素宽度。
        // 直接观察 #chat 尺寸变化补上这一类。
        if (columnResizeObserver) { columnResizeObserver.disconnect(); columnResizeObserver = null; }
        if ($chat.length && typeof ResizeObserver !== 'undefined') {
            let roRafPending = false;
            columnResizeObserver = new ResizeObserver(() => {
                if (roRafPending) return;
                roRafPending = true;
                requestAnimationFrame(() => {
                    roRafPending = false;
                    alignWrapperToMessageColumnNow(); // 已在 rAF 内，直调免再延一帧
                });
            });
            columnResizeObserver.observe($chat[0]);
        }

        if ($chat.length) {
            // 只观察直接子级增删；消息内部渲染不再触发
            observer.observe($chat[0], { childList: true });
        }
    };

    const renderTableContent = (tableData, tableName) => {
        if (!tableData || !tableData.rows.length) return `<div class="acu-panel-header"><div class="acu-panel-title">${tableName} ${(tableData && tableData._missingInfo) ? '<span style="color:#e74c3c;font-weight:bold;">缺少' + tableData._missingInfo + '</span>' : ((tableData && tableData._hasWarning) ? '<span style="color:#e74c3c;font-weight:bold;">数量异常</span>' : '<span style="color:var(--acu-text-sub);font-weight:normal;">0</span>')}</div><div class="acu-header-actions"><button class="acu-header-btn" id="acu-btn-close" title="关闭"><i class="fa-solid fa-times"></i></button></div></div><div class="acu-panel-content"><div style="text-align:center;color:var(--acu-text-sub);padding:20px;">暂无数据</div></div>`;
        
        const headers = tableData.headers.slice(1);
        let titleColIndex = 1;const codeIdx = tableData.headers.findIndex(h => h && (String(h).includes('编码') || String(h).includes('索引')));if (codeIdx > 0) titleColIndex = codeIdx;
        
        const config = getConfig();
        const itemsPerPage = config.itemsPerPage || 20;
        
        const savedStyles = getTableStyles();
        const currentStyle = savedStyles[tableName] || 'list';
        const isListMode = currentStyle === 'list';

const checkRowChanged = (realIdx, row) => {
            if (currentDiffMap.has(`${tableName}-row-${realIdx}`)) return true;
            if (!row) return false;
            // 大行保护：只扫前 64 列，避免单行超长把主线程拖死
            const colLimit = Math.min(row.length, 64);
            for (let c = 1; c < colLimit; c++) {
                if (currentDiffMap.has(`${tableName}-${realIdx}-${c}`)) return true;
            }
            return false;
        };

        const reverseTables = getReverseOrderTables();
        const isReversed = reverseTables.includes(tableName);
        const totalRaw = tableData.rows.length;
        // 高楼层/纪要表保护：无搜索时不做全量 map+sort，按索引窗口切片后再包一层元数据。
        // 鸡尾酒启用后用户更容易堆到高楼层，全量 map 会让纪要表打开卡死甚至像「无法显示」。
        const HEAVY_RENDER_THRESHOLD = 300;
        const useHeavyFastPath = totalRaw > HEAVY_RENDER_THRESHOLD && !currentSearchTerm;

        let slicedRows;
        let displayTotal;

        if (useHeavyFastPath) {
            displayTotal = totalRaw;
            const totalPagesFast = Math.ceil(displayTotal / itemsPerPage) || 1;
            if (currentPage > totalPagesFast) currentPage = 1;
            if (currentPage < 1) currentPage = 1;
            const startIdx = (currentPage - 1) * itemsPerPage;
            const endIdx = Math.min(startIdx + itemsPerPage, totalRaw);
            slicedRows = [];
            if (isReversed) {
                // 倒序：第 1 页对应原数组尾部
                const revStart = totalRaw - endIdx;
                const revEnd = totalRaw - startIdx;
                for (let i = revEnd - 1; i >= revStart; i--) {
                    const row = tableData.rows[i];
                    slicedRows.push({ data: row, originalIndex: i, hasChange: checkRowChanged(i, row) });
                }
            } else {
                for (let i = startIdx; i < endIdx; i++) {
                    const row = tableData.rows[i];
                    slicedRows.push({ data: row, originalIndex: i, hasChange: checkRowChanged(i, row) });
                }
            }
        } else {
            let processedRows = tableData.rows.map((row, index) => ({
                data: row,
                originalIndex: index,
                hasChange: checkRowChanged(index, row)
            }));

            if (currentSearchTerm) {
                const term = String(currentSearchTerm).toLowerCase();
                processedRows = processedRows.filter(item =>
                    item.data && item.data.some(cell => String(cell).toLowerCase().includes(term))
                );
            }

            processedRows.sort((a, b) => {
                if (a.hasChange && !b.hasChange) return -1;
                if (!a.hasChange && b.hasChange) return 1;
                if (isReversed) return b.originalIndex - a.originalIndex;
                return a.originalIndex - b.originalIndex;
            });

            displayTotal = processedRows.length;
            const totalPages = Math.ceil(displayTotal / itemsPerPage) || 1;
            if (currentPage > totalPages) currentPage = 1;
            if (currentPage < 1) currentPage = 1;
            const startIdx = (currentPage - 1) * itemsPerPage;
            const endIdx = startIdx + itemsPerPage;
            slicedRows = processedRows.slice(startIdx, endIdx);
        }

        const totalPages = Math.ceil(displayTotal / itemsPerPage) || 1;
        const displayPages = totalPages;

        const selectedCount = Array.from(selectedRows.values()).filter(s => s.tableName === tableName).length;
        const isBatchMode = isMultiSelectMode && selectedCount > 0;

        let html = `
            <div class="acu-panel-header">
                  <div class="acu-panel-title">
                    ${tableName} ${(tableData && tableData._missingInfo) ? '<span style="color:#e74c3c;font-weight:bold;">缺少' + tableData._missingInfo + '</span>' : ((tableData && tableData._hasWarning) ? '<span style="color:#e74c3c;font-weight:bold;">数量异常</span>' : '<span style="color:var(--acu-text-sub);font-weight:normal;">' + displayTotal + '</span>')}
                    ${isBatchMode ? `<span style="margin-left:10px; font-size:12px; color:var(--acu-highlight); background:var(--acu-highlight-bg); padding:2px 8px; border-radius:4px;">已选 ${selectedCount}</span>` : ''}
                </div>
                <div class="acu-header-actions">
                    <div class="acu-header-btn-group" style="display:flex; gap:6px; align-items:center;">
                        <button class="acu-header-btn" id="acu-btn-search-toggle" title="搜索" style="${currentSearchTerm ? 'display:none' : ''}">
                            <i class="fa-solid fa-search"></i>
                        </button>
                        <input type="text" class="acu-search-input" id="acu-search-input" placeholder="搜索..." value="${currentSearchTerm}" style="${currentSearchTerm ? '' : 'display:none'}; width: 120px; margin-right: 4px; padding-left: 10px;" />
                        ${isMultiSelectMode ? `
                        <button class="acu-header-btn" id="acu-btn-exit-multiselect" title="退出多选">
                            <i class="fa-solid fa-times"></i>
                        </button>
                        ` : `
                        <button class="acu-header-btn" id="acu-btn-multiselect" title="多选">
                            <i class="fa-solid fa-check-square"></i>
                        </button>
                        `}
                        <button class="acu-header-btn" id="acu-btn-switch-style" data-table="${tableName}" title="切换视图 (当前: ${isListMode?'单列':'双列'})">
                            <i class="fa-solid ${isListMode ? 'fa-list' : 'fa-th-large'}"></i>
                        </button>
                        <button class="acu-header-btn acu-height-drag-handle" data-table="${tableName}" title="按住拖动调整高度 (双击重置)">
                            <i class="fa-solid fa-arrows-up-down"></i>
                        </button>
                        <button class="acu-header-btn" id="acu-btn-refresh" title="刷新数据">
                            <i class="fa-solid fa-sync-alt"></i>
                        </button>
                        <button class="acu-header-btn" id="acu-btn-close" title="关闭">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>
            </div>
            <div class="acu-panel-content">
                <div class="acu-card-grid">`;

        slicedRows.forEach((item) => {
            const row = item.data;
            const realIndex = item.originalIndex;
             const cardTitle = row[titleColIndex] || '未命名';
            const showDefaultIndex = (titleColIndex === 1);
            const isRowNew = currentDiffMap.has(`${tableName}-row-${realIndex}`);
            const rowClass = isRowNew && config.highlightNew ? 'acu-highlight-changed' : '';
            const rowKey = `${tableName}-${realIndex}`;
            const isSelected = selectedRows.has(rowKey);
            const isPendingDelete = pendingDeletes.has(`${tableName}-row-${realIndex}`);

            html += `<div class="acu-data-card ${isSelected ? 'acu-card-selected' : ''}" data-row-key="${rowKey}">
                        ${isPendingDelete ? '<div class="acu-badge-pending">待删除</div>' : ''}
                        <div class="acu-card-header">
                            <input type=\"checkbox\" class=\"acu-card-checkbox\" data-row-key=\"${rowKey}\" ${isSelected ? 'checked' : ''} style=\"${isMultiSelectMode ? 'visibility:visible;' : 'visibility:hidden;'}\">
                            <span class="acu-card-index">${showDefaultIndex ? '#' + (realIndex + 1) : ''}</span>
                            <span class="acu-cell acu-editable-title" data-key="${tableData.key}" data-tname="${tableName}" data-row="${realIndex}" data-col="${titleColIndex}" title="点击编辑标题">${cardTitle}</span>
                        </div>
                        <div class="acu-card-body">`;
            let gridHtml = ''; let fullHtml = '';
            row.forEach((cell, cIdx) => {
                if (cIdx > 0 && cIdx !== titleColIndex) {
                    const headerName = headers[cIdx - 1] || `属性${cIdx}`;
                    const cellStr = String(cell);
                    const displayCell = cellStr.trim();
                    if (displayCell === 'auto_merged') return;
                    const badgeStyle = getBadgeStyle(displayCell);
                    const isCellChanged = currentDiffMap.has(`${tableName}-${realIndex}-${cIdx}`);
                    const cellHighlight = isCellChanged && config.highlightNew ? 'acu-highlight-changed' : '';
                    // 不再往属性里塞 data-val：encodeURIComponent 会把每个中文字扩成
                    // 9 个字符（中 → %E4%B8%AD），实测 25 列 × 100 字的一页从 133KB
                    // 涨到 560KB（4.2 倍），200 字时 180KB → 1029KB（5.7 倍），而这段
                    // 内容只是页面上已经显示过的文字的副本。
                    // 单元格已带 key/row/col，取值时从数据模型读回即可（见 readCellValue）。
                    const dataAttrs = `data-key="${tableData.key}" data-tname="${tableName}" data-row="${realIndex}" data-col="${cIdx}"`;
                    const contentHtml = badgeStyle ? `<span class="acu-badge ${badgeStyle}">${displayCell}</span>` : displayCell;

                    if (isListMode) {
                         fullHtml += `<div class="acu-cell acu-inline-item" ${dataAttrs}><div class="acu-inline-label">${headerName}</div><div class="acu-inline-value ${cellHighlight}">${contentHtml}</div></div>`;
                    } else {
                         if (codeIdx > 0) {
                             fullHtml += `<div class="acu-cell acu-full-item" ${dataAttrs}><div class="acu-full-label">${headerName}</div><div class="acu-full-value ${cellHighlight}">${displayCell}</div></div>`;
                         } else {
                            if (cellStr.length > 50) {
                                fullHtml += `<div class="acu-cell acu-full-item" ${dataAttrs}><div class="acu-full-label">${headerName}</div><div class="acu-full-value ${cellHighlight}">${displayCell}</div></div>`;
                            }
                            else {
                                gridHtml += `<div class="acu-cell acu-grid-item" ${dataAttrs}><div class="acu-grid-label">${headerName}</div><div class="acu-grid-value ${cellHighlight}">${contentHtml}</div></div>`;
                            }
                         }
                    }
                }
            });
            if (gridHtml) html += `<div class="acu-card-main-grid">${gridHtml}</div>`;
            if (fullHtml) html += `<div class="acu-card-full-area">${fullHtml}</div>`;
            html += `   </div></div>`;
        });
        html += `</div></div>`;
        if (displayPages > 1) {
             html += `<div class="acu-panel-footer"><button class="acu-page-btn" data-page="${currentPage - 1}" ${currentPage===1?'disabled':''}><i class="fa-solid fa-angle-left"></i></button>`;
             const range = [];
             if (displayPages <= 7) { for (let i = 1; i <= displayPages; i++) range.push(i); }
             else { if (currentPage <= 4) range.push(1, 2, 3, 4, 5, '...', displayPages); else if (currentPage >= displayPages - 3) range.push(1, '...', displayPages - 4, displayPages - 3, displayPages - 2, displayPages - 1, displayPages); else range.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', displayPages); }
             range.forEach(p => { if (p === '...') html += `<span class="acu-page-info">...</span>`; else html += `<button class="acu-page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`; });
             html += `<button class="acu-page-btn" data-page="${currentPage + 1}" ${currentPage===displayPages?'disabled':''}><i class="fa-solid fa-angle-right"></i></button></div>`;
        }
        return html;
    };

    const closePanel = () => {
        const { $ } = getCore();
        if (!$) return;

        const $chat = $('#chat');
        const config = getConfig();
        const currentScroll = $chat.length ? $chat.scrollTop() : 0;

        $('#acu-data-area').removeClass('visible');
        isMultiSelectMode = false;
        selectedRows.clear();
        pendingDeletes.clear();
        if (typeof updateDynamicActionButton === 'function') updateDynamicActionButton();
        $('.acu-nav-btn').removeClass('active');
        saveActiveTabState(null);

        if ($chat.length) {
            setTimeout(() => {
                 $chat.scrollTop(currentScroll);
            }, 10);
        }
    };

    const bindEvents = (tables) => {
        const { $ } = getCore();
        const stopSelectors = '.acu-data-display, .acu-nav-container, .acu-wrapper, .acu-edit-overlay, .acu-quick-view-overlay, .acu-cell-menu';
        $('body').off('wheel touchstart touchmove touchend click', stopSelectors).on('wheel touchstart touchmove touchend click', stopSelectors, function(e) {
            e.stopPropagation();
        });
        
        $('body').off('click.acu_autoclose').on('click.acu_autoclose', function(e) {
            if (isEditingOrder) return;
            
            if (!$('#acu-data-area').hasClass('visible')) return;

            const $target = $(e.target);
            
            if ($target.closest('.acu-wrapper').length) return;

            if ($target.closest('.acu-cell-menu').length) return;
            if ($target.closest('.acu-edit-overlay').length) return;
            if ($target.closest('.acu-popup-overlay').length) return;
            if ($target.closest('.acu-quick-view-overlay').length) return;
            
            if ($target.closest('#send_textarea, #send_but, #send_form, .bottom_bar_container').length) return;
            if ($target.is('input, textarea') || $target.prop('isContentEditable')) return;

            closePanel();
        });

        const switchTab = (tableName) => {
            isMultiSelectMode = false;
            selectedRows.clear();
            pendingDeletes.clear();
            currentPage = 1;
            currentSearchTerm = '';
            globalScrollTop = 0;
            
            if (tableName === TAB_DASHBOARD) {
                $('#acu-data-area').html(renderDashboard(tables)).addClass('visible');
                const h = getTableHeights()[TAB_DASHBOARD];
                $('#acu-data-area').css({height: h ? h + 'px' : '60vh', maxHeight: '95vh'});
                bindDataAreaEvents();
            } else if (tables[tableName]) {
                $('#acu-data-area').html(renderTableContent(tables[tableName], tableName)).addClass('visible');
                const h = getTableHeights()[tableName];
                $('#acu-data-area').css({height: h ? h + 'px' : '60vh', maxHeight: '95vh'});
                bindDataAreaEvents();
            }
            $('.acu-nav-btn').removeClass('active');
            $(`.acu-nav-btn[data-table="${tableName}"]`).addClass('active');
            saveActiveTabState(tableName);
            // 这里原本还有一次无条件 bindDataAreaEvents()：上面两个分支已各自绑过，
            // 等于整套选择器扫描 + 数百个单元格 off/on 白跑一遍（.off 保证不重复
            // 绑定，所以只是纯浪费不是泄漏）。删掉。
          };

        $('.acu-nav-btn').off('click').on('click', function(e) {
            e.stopPropagation(); 
            if (isEditingOrder) return;
            const tableName = $(this).data('table');
            if ($(this).hasClass('active')) { closePanel(); } else { switchTab(tableName); }
        });
        
        const bindDynamicContentEvents = () => {
            $('.acu-cell').off('click').on('click', function(e) { if(isMultiSelectMode) return; e.stopPropagation(); showCellMenu(e, this); });
             $('.acu-dash-interactive').off('click').on('click', function(e) {
                e.stopPropagation();
                const tableName = $(this).data('tname');
                const rowIdx = $(this).data('row'); const colIdx = $(this).data('col');
                if (tableName && tables[tableName]) {
                     const table = tables[tableName];
                     const row = table.rows[rowIdx];
                     if (row) showQuickView(row, table.headers, tableName, colIdx);
                }
            });
            $('.acu-tab-btn').off('click').on('click', function(e) {
                 e.stopPropagation();

                 const $container = $(this).closest('.acu-dash-card');
                 const index = $(this).index(); 

                 $container.find('.acu-tab-btn').removeClass('active');
                 $(this).addClass('active');

                 const $panes = $container.find('.acu-tab-pane');
                 $panes.removeClass('active');
                 if ($panes.length > index) {
                     $panes.eq(index).addClass('active');
                 }
            });
            $('.acu-page-btn').off('click').on('click', function(e) {
                e.stopPropagation();
                if ($(this).hasClass('disabled') || $(this).attr('disabled') || $(this).hasClass('active')) return;
                const p = parseInt($(this).data('page'));
                if (!p) return;
                currentPage = p;
                globalScrollTop = 0;
                const tableName = $('.acu-nav-btn.active').data('table');
                if (tableName && tables[tableName]) {
                    $('#acu-data-area').html(renderTableContent(tables[tableName], tableName));
                    bindDataAreaEvents();
                }
            });
        };
        
        const bindDataAreaEvents = () => {
            $('#acu-btn-close').off('click').on('click', function(e) { e.stopPropagation(); closePanel(); });

            $('#acu-btn-multiselect').off('click').on('click', function(e) {
                e.stopPropagation();
                isMultiSelectMode = true;
                const tableName = $('.acu-nav-btn.active').data('table');
                if (tableName && tables[tableName]) {
                    $('#acu-data-area').html(renderTableContent(tables[tableName], tableName));
                    bindDataAreaEvents();
                }
            });

            $('#acu-btn-exit-multiselect').off('click').on('click', function(e) {
                e.stopPropagation();
                isMultiSelectMode = false;
                const tableName = $('.acu-nav-btn.active').data('table');

                Array.from(selectedRows.values()).forEach(item => {
                    if (item.tableName === tableName) {
                        pendingDeletes.delete(`${tableName}-row-${item.rowIndex}`);
                    }
                });

                selectedRows.clear();
                updateDynamicActionButton();
                if (tableName && tables[tableName]) {
                    $('#acu-data-area').html(renderTableContent(tables[tableName], tableName));
                    bindDataAreaEvents();
                }
            });

            $('.acu-data-card').off('click').on('click', function(e) {
                if (isMultiSelectMode) {
                    if (!$(e.target).is('.acu-card-checkbox')) {
                        const $cb = $(this).find('.acu-card-checkbox');
                        $cb.prop('checked', !$cb.prop('checked')).trigger('change');
                    }
                }
            });
            $('.acu-card-checkbox').off('change').on('change', function(e) {
                e.stopPropagation();
                const rowKey = $(this).data('row-key');
                const tableName = $('.acu-nav-btn.active').data('table');
                const $card = $(this).closest('.acu-data-card');
                const rowIndex = parseInt($card.find('.acu-editable-title').data('row'));
                const key = $card.find('.acu-editable-title').data('key');
                const delKey = `${tableName}-row-${rowIndex}`;

                if ($(this).is(':checked')) {
                    selectedRows.set(rowKey, { tableName, rowIndex, key });
                    $card.addClass('acu-card-selected');
                    pendingDeletes.add(delKey);
                    if ($card.find('.acu-badge-pending').length === 0) {
                        $card.prepend('<div class="acu-badge-pending">待删除</div>');
                    }
                } else {
                    selectedRows.delete(rowKey);
                    $card.removeClass('acu-card-selected');
                    pendingDeletes.delete(delKey);
                    $card.find('.acu-badge-pending').remove();
                }

                // 只更新头部的选中计数和按钮状态，不重新渲染整个表格
                const selectedCount = Array.from(selectedRows.values()).filter(s => s.tableName === tableName).length;
                const isBatchMode = isMultiSelectMode && selectedCount > 0;

                // 更新标题中的选中计数
                const $title = $('.acu-panel-title');
                $title.find('span[style*="margin-left:10px"]').remove();
                if (isBatchMode) {
                    $title.append(`<span style="margin-left:10px; font-size:12px; color:var(--acu-highlight); background:var(--acu-highlight-bg); padding:2px 8px; border-radius:4px;">已选 ${selectedCount}</span>`);
                }

                updateDynamicActionButton();
            });

            $('#acu-btn-search-toggle').off('click').on('click', function(e) {
                e.stopPropagation();
                $(this).hide();
                $('#acu-search-input').show().focus();
            });

            $('#acu-search-input').off('blur').on('blur', function() {
                 if (!$(this).val()) {
                     $(this).hide();
                     $('#acu-btn-search-toggle').show();
                 }
            });

            let isComposing = false;
            $('.acu-search-input').off('compositionstart').on('compositionstart', function() {
                isComposing = true;
            });
            $('.acu-search-input').off('compositionend').on('compositionend', function() {
                isComposing = false;
                $(this).trigger('input');
            });
            // 搜索必须防抖：带搜索词时 useHeavyFastPath 会被关掉（它要求 !currentSearchTerm），
            // 于是每敲一个字都对全表做 map+filter+sort，还要重建并重绑整页单元格。
            // 大表（几千行纪要）上逐字重算会明显卡输入。180ms 足够连续输入合并成一次。
            let searchDebounceTimer = null;
            const runSearchRender = () => {
                const tableName = $('.acu-nav-btn.active').data('table');
                if (!tableName || !tables[tableName]) return;
                const fullHtml = renderTableContent(tables[tableName], tableName);
                const $temp = $('<div>').html(fullHtml);
                // 用 contents().appendTo 搬节点，避免 .html() 再序列化一遍又重新解析
                // （原写法等于对同一份 HTML 走三遍：build → parse → serialize+parse）
                const $dst = $('.acu-panel-content').empty();
                $temp.find('.acu-panel-content').contents().appendTo($dst);
                const $dstTitle = $('.acu-panel-title').empty();
                $temp.find('.acu-panel-title').contents().appendTo($dstTitle);
                bindDynamicContentEvents();
                bindScrollFade($('.acu-panel-content, .acu-dash-container, .acu-dash-npc-grid'));
            };
            $('.acu-search-input').off('input').on('input', function() {
                if (isComposing) return;
                currentSearchTerm = $(this).val().toLowerCase();
                currentPage = 1;
                globalScrollTop = 0;
                if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
                searchDebounceTimer = setTimeout(runSearchRender, 180);
             });

            $('.acu-height-drag-handle').off('pointerdown').on('pointerdown', function(e) {
                if (e.button !== 0 || isEditingOrder) return; // 排序模式下不响应高度拖拽
                e.preventDefault(); e.stopPropagation();
                const handle = this;
                handle.setPointerCapture(e.pointerId);
                $(handle).addClass('active');
                const $panel = $('#acu-data-area');
                const startHeight = $panel.height();
                const startY = e.clientY;
                const tableName = $(handle).data('table');
                
                const onMove = function(moveE) {
                    const dy = moveE.clientY - startY;
                    let newHeight = startHeight - dy;
                    if (newHeight < 200) newHeight = 200;
                    if (newHeight > 1500) newHeight = 1500;
                    $panel.css('height', newHeight + 'px');
                };

                const onEnd = function(upE) {
                    $(handle).removeClass('active');
                    try { handle.releasePointerCapture(upE.pointerId); } catch(err){}
                    handle.removeEventListener('pointermove', onMove);
                    handle.removeEventListener('pointerup', onEnd);
                    handle.removeEventListener('pointercancel', onEnd);
                    if (tableName) {
                         const h = parseInt($panel.css('height'));
                         const heights = getTableHeights();
                         heights[tableName] = h;
                         saveTableHeights(heights);
                    }
                };

                handle.addEventListener('pointermove', onMove);
                handle.addEventListener('pointerup', onEnd);
                handle.addEventListener('pointercancel', onEnd);
            });
            
            $('.acu-panel-header').off('dblclick').on('dblclick', function(e) {
                if (isEditingOrder) return; // 排序模式下不响应双击重置高度
                if ($(e.target).closest('button, input, .acu-height-drag-handle, .acu-search-wrapper').length) return;
                e.preventDefault(); e.stopPropagation();
                
                const activeBtn = $('.acu-nav-btn.active');
                const tableName = activeBtn.data('table');
                
                if (tableName) {
                     const heights = getTableHeights();
                     delete heights[tableName];
                     saveTableHeights(heights);
                     if (window.toastr) window.toastr.info('已重置为默认高度');
                     
                     // 重置为默认高度：仪表盘与数据表共用同一套高度，无需分支
                     $('#acu-data-area').css({height: '60vh', maxHeight: '95vh'});
                }
            });
            
            $('#acu-btn-switch-style').off('click').on('click', function(e) {
                e.preventDefault(); e.stopPropagation();
                const tableName = $(this).data('table');
                const styles = getTableStyles();
                const current = styles[tableName] || 'list';
                styles[tableName] = current === 'grid' ? 'list' : 'grid';
                saveTableStyles(styles);
                
                 if (tableName && tables[tableName]) {
                     const fullHtml = renderTableContent(tables[tableName], tableName);
                     const $temp = $('<div>').html(fullHtml);
                     $('.acu-panel-content').html($temp.find('.acu-panel-content').html());
                     $('.acu-panel-header').replaceWith($temp.find('.acu-panel-header'));
                     bindDataAreaEvents(); 
               }
            });

            $('#acu-btn-refresh, #acu-btn-refresh-emb').off('click').on('click', async (e) => {
                e.stopPropagation();
                if (pendingDeletes.size > 0) {
                    const api = getCore().getDB();
                    if (!api || !api.deleteRow) return;
                    const group = {};
                    for (const k of pendingDeletes) {
                        const parts = k.split('-row-');
                        if (parts.length === 2) {
                            if (!group[parts[0]]) group[parts[0]] = [];
                            group[parts[0]].push(parseInt(parts[1]));
                        }
                    }
                    let failedRows = 0;
                    let failedTableNames = [];
                    for (const t in group) {
                        const rows = group[t].sort((a,b) => b - a);
                        for (const r of rows) {
                            try {
                                const res = await api.deleteRow(t, r + 1);
                                // DB 8.9 deleteRow 只返回 true/false；放宽为 res !== true 防御未来返回 -1 等
                                if (res !== true) { failedRows++; if (!failedTableNames.includes(t)) failedTableNames.push(t); }
                            } catch (e) { failedRows++; if (!failedTableNames.includes(t)) failedTableNames.push(t); console.warn('[ACU-API] deleteRow 失败:', e); }
                        }
                    }
                    pendingDeletes.clear();
                    isMultiSelectMode = false;
                    selectedRows.clear();
                    if (window.toastr) {
                        if (failedRows === 0) window.toastr.success('删除成功');
                        else window.toastr.warning(`删除部分完成：${failedRows} 行失败（${failedTableNames.join('、') || '未知表'}），请检查数据库状态。`);
                    }
                    cachedTableData = null;
                    lastRawTableRef = null;
                    lastTableSetFingerprint = '';
                    renderInterface(true);
                } else {
                    cachedTableData = null; const _d = getTableData(true); if(_d) saveSnapshot(_d); currentDiffMap.clear(); renderInterface(true); if (window.toastr) window.toastr.info('已刷新');
                }
            });

            $('#acu-btn-dash-edit, #acu-btn-dash-edit-emb').off('click').on('click', (e) => { e.stopPropagation(); if (isEditingOrder) return; isDashEditing = !isDashEditing; renderInterface(false); });
            $('.acu-slot-setting-btn').off('click').on('click', function(e) { e.stopPropagation(); showDashSlotSettings($(this).data('slot')); });

              
              bindDynamicContentEvents(); bindScrollFade($('.acu-panel-content, .acu-dash-container, .acu-dash-npc-grid'));
            updateDynamicActionButton();
        };

        const toggleUI = () => { isCollapsed = !isCollapsed; localStorage.setItem(STORAGE_KEY_UI_COLLAPSE, isCollapsed); renderInterface(false); };
        $('#acu-btn-toggle').off('click').on('click', (e) => { e.stopPropagation(); if (isEditingOrder) return; toggleUI(); });
        if (isCollapsed) { $('.acu-nav-container').off('click').on('click', (e) => { e.stopPropagation(); toggleUI(); }); }
        
        $('#acu-btn-settings').off('click').on('click', (e) => {
            e.stopPropagation();
            if (isEditingOrder) return;
            try {
                showSettingsModal();
            } catch (err) {
                console.error('设置面板打开失败:', err);
                if (window.toastr) window.toastr.error('设置面板打开失败');
            }
        });
        $('#acu-btn-cancel-mode').off('click').on('click', (e) => { e.stopPropagation(); isEditingOrder = false; renderInterface(false); });
        $('#acu-btn-save-mode').off('click').on('click', (e) => { e.stopPropagation(); toggleOrderEditMode(); });
        $('#acu-btn-open-db').off('click').on('click', async function(e) {
            e.preventDefault(); e.stopPropagation();
            if (isEditingOrder) return;
            const core = getCore();
            // 优先走 V2 新 UI（带"基础模式/高手模式"切换的工作台），
            // 通过 window.AutoCardUpdaterV2API.open() 暴露；旧版数据库无此 API 时回退到原 openSettings。
            const apiV2 = core.getDBV2();
            if (apiV2 && typeof apiV2.open === 'function') {
                try { await apiV2.open(); return; }
                catch (err) { console.warn('[ACU-API] V2 open 失败，回退旧入口:', err); }
            }
            const api = core.getDB();
            if (api && api.openSettings) {
                await api.openSettings();
            } else if (window.toastr) {
                window.toastr.error('无法调用数据库设置接口');
            }
        });
        $('#acu-btn-open-visualizer').off('click').on('click', async function(e) {
            e.preventDefault(); e.stopPropagation();
            if (isEditingOrder) return;
            const core = getCore();
            // 优先走 V2 新 UI 的表格编辑器（openVisualizerSurface_ACU），旧版数据库无 V2 API 时回退。
            const apiV2 = core.getDBV2();
            if (apiV2 && typeof apiV2.openVisualizer === 'function') {
                try { await apiV2.openVisualizer(); return; }
                catch (err) { console.warn('[ACU-API] V2 openVisualizer 失败，回退旧入口:', err); }
            }
            const api = core.getDB();
            if (api && api.openVisualizer) {
                api.openVisualizer();
            } else if (window.toastr) {
                window.toastr.error('无法调用表格编辑器接口');
            }
        });
        $('#acu-btn-manual-update').off('click').on('click', async function(e) {
            e.preventDefault(); e.stopPropagation();
            if (isEditingOrder) return;
            const core = getCore();
            const w = window.parent || window;
            const doc = w.document || document;
            const apiV2 = core.getDBV2();

            // 工具：按按钮 visible text 精确等值匹配（不做 includes，避免误命中「执行手动填表」等含相似字的按钮）。
            // excludeTexts：候选中显式排除的文案，命中即跳过该按钮。
            const findButtonByExactText = (root, texts, excludeTexts = ['执行手动填表']) => {
                const root_ = root || doc;
                const buttons = root_.querySelectorAll('button');
                for (const btn of buttons) {
                    const txt = (btn.textContent || '').trim();
                    if (!txt) continue;
                    if (excludeTexts && excludeTexts.some(ex => txt === ex || txt.includes(ex))) continue;
                    for (const t of texts) {
                        if (txt === t) return btn;
                    }
                }
                return null;
            };
            // 轮询等待目标按钮出现且可点（非 disabled），找到即 click；最多 maxTries 次（每次 100ms）。
            const waitAndClick = async (findFn, maxTries = 30, requireEnabled = true) => {
                for (let i = 0; i < maxTries; i++) {
                    const root = doc.getElementById('acu-app-v2') || doc;
                    const btn = findFn(root);
                    if (btn && (!requireEnabled || !btn.disabled)) { btn.click(); return true; }
                    await new Promise(r => setTimeout(r, 100));
                }
                return false;
            };

            const runLegacyManualUpdate = async () => {
                const api = core.getDB();
                if (!api || typeof api.manualUpdate !== 'function') {
                    if (window.toastr) window.toastr.error('无法调用数据库更新接口');
                    return;
                }
                try {
                    const rawData = getTableData() || {};
                    const available = Object.keys(rawData).filter(k => k.startsWith('sheet_'));
                    if (typeof api.getManualSelectedTables === 'function') {
                        const sel = api.getManualSelectedTables() || {};
                        const saved = Array.isArray(sel.selectedTables) ? sel.selectedTables : [];
                        const intersect = saved.filter(k => available.includes(k));
                        if (available.length > 0 && intersect.length === 0 && sel.hasManualSelection === true) {
                            if (typeof api.clearManualSelectedTables === 'function') {
                                await api.clearManualSelectedTables();
                                if (window.toastr) window.toastr.info('已恢复为全表更新（之前的表选择已失效）。');
                            }
                        }
                    }
                } catch (probeErr) {
                    console.warn('[ACU-API] 手动更新前置探测失败，继续按原流程执行:', probeErr);
                }
                try {
                    if (typeof api.openSettings === 'function') {
                        await api.openSettings();
                        await new Promise(r => setTimeout(r, 120));
                    }
                } catch (openErr) {
                    console.warn('[ACU-API] openSettings 失败，继续尝试 manualUpdate:', openErr);
                }
                try {
                    await api.manualUpdate();
                } catch (err) {
                    console.error('[ACU-API] manualUpdate 调用失败:', err);
                    if (window.toastr) window.toastr.error('手动更新调用失败，请查看控制台。');
                }
            };

            // 仅当 V2 真正不可用时走旧 UI 回退；V2 路径中的任何异常都不再回退到 manualUpdate，
            // 否则会出现「新 UI 已打开 + 全选成功」之后误触发旧 UI 手动填表的串味。
            if (!apiV2 || typeof apiV2.open !== 'function') {
                await runLegacyManualUpdate();
                return;
            }

            // V2 优先路径：打开工作台 → 切到填表工作台页 → 静默点「全选」→ 点「一键追平所选表未填楼层」。
            try {
                await apiV2.open();
            } catch (openErr) {
                console.warn('[ACU-API] V2 open 失败，回退旧 UI 手动填表:', openErr);
                await runLegacyManualUpdate();
                return;
            }

            const root0 = doc.getElementById('acu-app-v2');
            if (root0 && root0.style.display === 'none') root0.style.display = '';

            // 1) 切到填表工作台页（侧边栏 button[data-page-id="form-fill"] 触发 setActivePage）
            const okNav = await waitAndClick((rt) => rt.querySelector('button[data-page-id="form-fill"]'), 30, false);
            if (!okNav) {
                if (window.toastr) window.toastr.info('已打开数据库工作台，请在「填表工作台」页点「一键追平」按钮。', { timeOut: 3500 });
                return;
            }
            // 给 form-fill 页 mount + 选择器渲染留时间
            await new Promise(r => setTimeout(r, 350));

            // 2) 静默全选：填表工作台手动填表面板里的「全选」按钮（精确等值匹配）
            const okSel = await waitAndClick((rt) => findButtonByExactText(rt, ['全选'], []), 25, false);
            if (!okSel) console.warn('[ACU-API] 未找到「全选」按钮，将直接尝试追平（可能被「未选择表格」拦下）。');

            // 给 Vue 响应式把 selectedManualTableKeys 传到追平按钮 disabled 绑定上留时间
            await new Promise(r => setTimeout(r, 250));

            // 3) 点「一键追平所选表未填楼层」；显式排除「执行手动填表」按钮（否则 includes 会误命中）
            //    追平按钮文案在忙时显示「追平中...」，此时 disabled，需等到非忙态可点。
            const okCatch = await waitAndClick((rt) => findButtonByExactText(rt, ['一键追平所选表未填楼层'], ['执行手动填表']), 30, true);
            if (okCatch) {
                if (window.toastr) window.toastr.info('已在数据库工作台静默全选并触发追平。', { timeOut: 2500 });
                // 追平（runManualCatchUp）成功**不触发** _notifyTableUpdate / _notifyTableFillStart，
                // 前端拿不到任何刷新信号 → 选项表/表格停在旧数据。这里启动追平完成检测轮询：
                // 每 1.5s 轻量指纹比对 DB 数据，连续 3 次稳定判定追平结束，随后强制重拉+重渲染。
                // 注意：timer/状态必须是模块级单例，防止连点多个 setInterval 并存导致双 finishCatchup。
                const CATCHUP_POLL_MS = 1500;
                const CATCHUP_STABLE_N = 3;
                const CATCHUP_MAX_MS = 10 * 60 * 1000; // 10 分钟硬上限
                const apiDB = core.getDB();
                // stopCatchupPoll 为模块级定义（见 IIFE 顶层），此处直接引用
                const finishCatchup = (saved) => {
                    if (!catchupTimer) return; // 已结束（幂等守卫）
                    stopCatchupPoll();
                    // 追平结束：清缓存 + 强制重拉 + 重渲染（含选项表），并把当前态存为新基线
                    cachedTableData = null;
                    lastRawTableRef = null;
                    lastTableSetFingerprint = '';
                    currentDiffMap.clear();
                    try { const d = getTableData(true); if (d) saveSnapshot(d); } catch (_) {}
                    try { renderInterface(true); } catch (_) {}
                    if (window.toastr) window.toastr.success(saved ? '追平完成，数据已刷新。' : '追平结束，数据已刷新。', { timeOut: 2500 });
                };
                // 连点保护：新点击先停掉旧轮询
                stopCatchupPoll();
                catchupStable = 0;
                catchupStartTs = Date.now();
                // 首 tick 前先同步采样基线，避免把"追平刚开始还没写"误判为稳定
                try {
                    if (apiDB && typeof apiDB.exportTableAsJson === 'function') {
                        catchupLastFp = lightFingerprint(apiDB.exportTableAsJson());
                    }
                } catch (_) { /* 采样失败，下一 tick 补基线 */ }
                catchupTimer = setInterval(() => {
                    try {
                        if (Date.now() - catchupStartTs > CATCHUP_MAX_MS) { finishCatchup(false); return; }
                        if (inEditingContext()) return; // 用户编辑/弹窗打开中不打扰
                        if (!apiDB || typeof apiDB.exportTableAsJson !== 'function') { stopCatchupPoll(); return; }
                        const fp = lightFingerprint(apiDB.exportTableAsJson());
                        if (catchupLastFp !== null && fp !== catchupLastFp) {
                            catchupStable = 0; // 数据还在变：追平进行中
                        } else {
                            catchupStable++;
                            if (catchupStable >= CATCHUP_STABLE_N) { finishCatchup(true); return; }
                        }
                        catchupLastFp = fp;
                    } catch (_) { /* 轮询一次异常忽略，继续 */ }
                }, CATCHUP_POLL_MS);
                // 兜底：若 10 分钟没到（被 stop 或异常），确保不悬挂。
                // 单例 timer：新点击先 stop（clearTimeout），旧兜底不会误终止新轮询。
                if (catchupFallbackTimer) clearTimeout(catchupFallbackTimer);
                catchupFallbackTimer = setTimeout(() => { finishCatchup(false); }, CATCHUP_MAX_MS + 2000);
            } else {
                if (window.toastr) window.toastr.warning('未找到追平按钮，请在「填表工作台」页手动点击「一键追平所选表未填楼层」。', { timeOut: 3500 });
            }
        });

        $('#send_but').off('click.acu_opt_hide').on('click.acu_opt_hide', function() {
             hideOptionsUntilUpdate = true;
             $('.acu-embedded-options-container').hide();
        });
        $('#send_textarea').off('keydown.acu_opt_hide').on('keydown.acu_opt_hide', function(e) {
             if (e.key === 'Enter' && !e.shiftKey) {
                 hideOptionsUntilUpdate = true;
                 $('.acu-embedded-options-container').hide();
             }
        });
        
        $('.acu-opt-btn').off('click').on('click', function(e) {
             e.preventDefault(); e.stopPropagation();
             $(this).blur();
             const val = decodeURIComponent($(this).data('val'));
             const config = getConfig();
             
             let win = window.parent || window;
             let parentDoc = win.document;
             let ta = parentDoc.getElementById('send_textarea');

             if(ta) {
                 ta.value = (ta.value || '') + val;
                 ta.dispatchEvent(new Event('input', { bubbles: true }));
                 ta.dispatchEvent(new Event('change', { bubbles: true }));
                 if (!config.clickOptionToAutoSend) ta.focus();
                 
                 if (config.clickOptionToAutoSend) {
                     hideOptionsUntilUpdate = true;
                     $('.acu-embedded-options-container').hide();
                 

                     const sendBtn = parentDoc.getElementById('send_but');
                     if(sendBtn) sendBtn.click();
                 }
             }
        });

        bindDataAreaEvents();
    };
    
    const showQuickView = (row, headers, tableName, titleColIdx) => {
        const { $ } = getCore();
        const config = getConfig();
        $('.acu-quick-view-overlay').remove();
        const codeIdx = headers.findIndex(h => h && (String(h).includes('编码') || String(h).includes('索引')));
        const savedStyles = getTableStyles();
        const currentStyle = savedStyles[tableName] || 'list';

        let gridHtml = ''; let fullHtml = '';
        row.forEach((cell, cIdx) => {
             if (cIdx > 0) {
                const headerName = headers[cIdx] || `属性${cIdx}`;
                const cellStr = String(cell);
                const displayCell = cellStr.trim();
                if (displayCell === 'auto_merged') return;
                const badgeStyle = getBadgeStyle(displayCell);
                const contentHtml = badgeStyle ? `<span class="acu-badge ${badgeStyle}">${displayCell}</span>` : displayCell;
                
                if (currentStyle === 'list' || codeIdx > 0) {
                     fullHtml += `<div class="acu-cell acu-inline-item" style="cursor:default"><div class="acu-inline-label">${headerName}</div><div class="acu-inline-value">${contentHtml}</div></div>`;
                } else {
                     if (cellStr.length > 50) {
                        fullHtml += `<div class="acu-cell acu-full-item" style="cursor:default"><div class="acu-full-label">${headerName}</div><div class="acu-full-value">${displayCell}</div></div>`;
                     } else {
                        gridHtml += `<div class="acu-cell acu-grid-item" style="cursor:default"><div class="acu-grid-label">${headerName}</div><div class="acu-grid-value">${contentHtml}</div></div>`;
                     }
                }
             }
        });
        
        const html = `
            <div class="acu-quick-view-overlay${overlayThemeClass(config.theme)}">
                <div class="acu-quick-view-card acu-theme-${config.theme}" style="--acu-font-size: ${config.fontSize}px; font-size: ${config.fontSize}px; --acu-text-max-height:${config.limitLongText!==false?'80px':'none'}; --acu-text-overflow:${config.limitLongText!==false?'auto':'visible'}">
                     <div class="acu-quick-view-header">
                        <span><i class="fa-solid ${getIconForTableName(tableName)}"></i> ${row[(titleColIdx !== undefined && titleColIdx !== null) ? titleColIdx : 1] || '详情'}</span>
                        <button class="acu-header-btn" id="qv-close"><i class="fa-solid fa-times"></i></button>
                     </div>
                     <div class="acu-quick-view-body">
                          ${gridHtml ? `<div class="acu-card-main-grid">${gridHtml}</div>` : ''}
                          ${fullHtml ? `<div class="acu-card-full-area">${fullHtml}</div>` : ''}
                     </div>
                </div>
            </div>
        `;
        $('body').append(html); bindScrollFade($('.acu-quick-view-body'));
        
        const close = () => $('.acu-quick-view-overlay').remove();
        $('#qv-close').click(close);
        $('.acu-quick-view-overlay').click((e) => {
             if ($(e.target).hasClass('acu-quick-view-overlay')) close();
        });
    };

    const toggleOrderEditMode = () => {
        if (isEditingOrder) {
            const { $ } = getCore();
            const newOrder = []; 
            $('.acu-nav-tabs-area .acu-nav-btn').each(function() { const t = $(this).data('table'); if(t && t!==TAB_DASHBOARD) newOrder.push(t); });
            saveTableOrder(newOrder);
            const newActionOrder = [];
            $('.acu-nav-actions-area .acu-action-btn').each(function() { if(this.id) newActionOrder.push(this.id); });
            saveActionOrder(newActionOrder);
            isEditingOrder = false;
        } else {
            isEditingOrder = true;
        }
        renderInterface(false);
    };

    const initSortable = () => {
        const { $ } = getCore();
        let selectedEl = null;

        const setup = (selector) => {
             const $items = $(selector);

             $items.attr('draggable', false);
             $items.css('cursor', 'pointer');

             $items.off('dragstart dragend dragover drop touchstart touchmove touchend click.swap');

             $items.on('click.swap', function(e) { 
                 e.preventDefault();
                 e.stopPropagation();

                 const $this = $(this);

                 if (selectedEl === this) {
                     $this.css({ 'border-color': '', 'box-shadow': '', 'transform': '' }); 
                     selectedEl = null;
                     return;
                 }

                 if (!selectedEl) {

                     selectedEl = this;
                     $this.css({ 'border-color': '#e74c3c', 'box-shadow': '0 0 8px rgba(231, 76, 60, 0.4)', 'transform': 'scale(1.05)' });
                 } else {

                     const $src = $(selectedEl);
                     const $dest = $this;

                     if ($src.parent()[0] === $dest.parent()[0]) {
                        const $siblings = $dest.parent().children();
                        const srcIdx = $siblings.index($src);
                        const targetIdx = $siblings.index($dest);

                        if (srcIdx < targetIdx) {
                            $dest.after($src);
                        } else {
                            $dest.before($src);
                        }
                     }

                     $src.css({ 'border-color': '', 'box-shadow': '', 'transform': '' });
                     selectedEl = null;
                 }
             });
        };

        setup('.acu-nav-tabs-area .acu-nav-btn');
        setup('.acu-nav-actions-area .acu-action-btn');
    };

    const showCellMenu = (e, cell) => {
        const { $ } = getCore();
        $('.acu-cell-menu, .acu-menu-backdrop').remove();
        const backdrop = $('<div class="acu-menu-backdrop"></div>');
        $('body').append(backdrop);
        const rowIdx = parseInt($(cell).data('row'));
        const colIdx = parseInt($(cell).data('col'));
        const tableKey = $(cell).data('key');
        const tableName = $(cell).data('tname');
        const content = readCellValue(cell, rowIdx, colIdx, tableKey);
        const config = getConfig();
        const deleteKey = `${tableName}-row-${rowIdx}`;

        const menu = $(`
            <div class="acu-cell-menu acu-theme-${config.theme}">
                <div class="acu-cell-menu-item" id="act-edit"><i class="fa-solid fa-pen"></i> 编辑内容</div>
                <div class="acu-cell-menu-item" id="act-edit-card"><i class="fa-solid fa-edit"></i> 整体编辑</div>
                <div class="acu-cell-menu-item" id="act-insert" style="color:#2980b9"><i class="fa-solid fa-plus"></i> 插入新行</div>
                ${pendingDeletes.has(`${tableName}-row-${rowIdx}`) ? `<div class="acu-cell-menu-item" id="act-restore" style="color:#27ae60;"><i class="fa-solid fa-undo"></i> 恢复整行</div>` : `<div class="acu-cell-menu-item" id="act-delete"><i class="fa-solid fa-trash"></i> 删除整行</div>`}
                <div class="acu-cell-menu-item" id="act-close"><i class="fa-solid fa-times"></i> 关闭菜单</div>
            </div>
        `);
        $('body').append(menu);
        const mWidth = menu.outerWidth();
        const mHeight = menu.outerHeight();
        const winWidth = $(window).width();
        const winHeight = $(window).height();

        let left = e.clientX + 5;
        let top = e.clientY + 5;

        if (left + mWidth > winWidth) {
            left = e.clientX - mWidth - 5;
        }

        if (top + mHeight > winHeight) {
            top = e.clientY - mHeight - 5;
        }
        
        if (left < 0) left = 0;
        if (top < 0) top = 0;

        menu.css({ top: top + 'px', left: left + 'px' });
        const closeAll = () => { menu.remove(); backdrop.remove(); };
        backdrop.on('click', function(e) { e.stopPropagation(); closeAll(); });
        menu.find('#act-close').click(closeAll);



        menu.find('#act-delete').click(() => {
            closeAll();
            pendingDeletes.add(deleteKey);
            const $card = $(`.acu-data-card[data-row-key="${tableName}-${rowIdx}"]`);
            if ($card.length && $card.find('.acu-badge-pending').length === 0) {
                $card.prepend('<div class="acu-badge-pending">待删除</div>');
            }
            updateDynamicActionButton();
        });
        menu.find('#act-restore').click(() => {
            closeAll();
            pendingDeletes.delete(deleteKey);
            const $card = $(`.acu-data-card[data-row-key="${tableName}-${rowIdx}"]`);
            $card.find('.acu-badge-pending').remove();
            updateDynamicActionButton();
        });

        menu.find('#act-edit').click(() => { 
            closeAll();
            showEditDialog(content, async (newVal) => {
                const $cell = $(cell);
                // 单元格不再存 data-val，模型以 content[rowIdx+1][colIdx] 为准。
                // 缓存同步挪到下面紧邻持久化处做，这样失败回滚能一并撤回，
                // 否则 save 静默失败时缓存里会一直留着 DB 拒绝掉的值。

                let $displayTarget = $cell;
                if ($cell.hasClass('acu-grid-item')) $displayTarget = $cell.find('.acu-grid-value');
                else if ($cell.hasClass('acu-full-item')) $displayTarget = $cell.find('.acu-full-value');
                else if ($cell.hasClass('acu-inline-item')) $displayTarget = $cell.find('.acu-inline-value');
                else if ($cell.hasClass('acu-editable-title')) $displayTarget = $cell;

                const badgeStyle = getBadgeStyle(newVal);
                if (badgeStyle && !$cell.hasClass('acu-editable-title')) {
                     $displayTarget.html(`<span class="acu-badge ${badgeStyle}">${newVal}</span>`);
                } else {
                     $displayTarget.text(newVal);
                }
                $displayTarget.addClass('acu-highlight-changed');

                const rawData = getTableData();
                if (rawData && rawData[tableKey]?.content[rowIdx + 1]) {
                      const oldVal = rawData[tableKey].content[rowIdx + 1][colIdx];
                      // 先暂存乐观写入的标记，失败时连同 cachedTableData 一起回滚
                      const cacheSheet = cachedTableData && tableKey ? cachedTableData[tableKey] : null;
                      if (cacheSheet && Array.isArray(cacheSheet.content) && cacheSheet.content[rowIdx + 1]) {
                          cacheSheet.content[rowIdx + 1][colIdx] = newVal;
                      }
                      rawData[tableKey].content[rowIdx + 1][colIdx] = newVal;
                      const ok = await saveDataToDatabase(rawData, true, false, {
                          type: 'cell_edit',
                          tableName: tableName,
                          rowIndex: rowIdx,
                          colIndex: colIdx,
                          newValue: newVal
                      });
                      if (ok === false) {
                          // 保存失败：回滚上游数据与乐观写入的缓存，防止显示与 DB 持久分歧
                          try { rawData[tableKey].content[rowIdx + 1][colIdx] = oldVal; } catch (_) {}
                          try { if (cacheSheet && cacheSheet.content[rowIdx + 1]) cacheSheet.content[rowIdx + 1][colIdx] = oldVal; } catch (_) {}
                          cachedTableData = null;
                          lastRawTableRef = null;
                          lastTableSetFingerprint = '';
                          renderInterface(true);
                          if (window.toastr) window.toastr.error('保存失败，已回滚并刷新。');
                      }
                } 
            });
        });
        menu.find('#act-insert').click(async () => {
            closeAll();
            const rawData = getTableData();
            if (rawData && rawData[tableKey]?.content) {
                const sheet = rawData[tableKey];
                const headers = sheet.content[0] || [];
                const colCount = headers.length || 2;
                // 不再伪造 row_id（在 SQLite 存储模式下 row_id 是主键，伪造会触发静默写入失败）。
                // 改为构造以列名为键的数据对象交给 DB 的 insertRow，让 DB 自行处理主键与持久化。
                const newRowObj = {};
                for (let c = 0; c < colCount; c++) {
                    const colName = headers[c];
                    if (!colName) continue;
                    // row_id 列跳过，交给 DB 自增；其余列置空。
                    if (colName === 'row_id' || colName === 'row_id ' || /行号|行ID|编号/i.test(colName)) continue;
                    newRowObj[colName] = '';
                }
                const api = getCore().getDB();
                if (window.toastr) window.toastr.info('正在插入新行...');
                let ok = false;
                try {
                    if (api && typeof api.insertRow === 'function') {
                        const result = await api.insertRow(tableName, newRowObj);
                        ok = (result !== false && result !== -1 && result !== null && result !== undefined);
                    }
                } catch (e) { console.warn('[ACU-API] insertRow 调用失败:', e); ok = false; }
                // 兜底：旧版 DB 无 insertRow 或调用失败时退回全量保存，但绝不伪造 row_id。
                // 位置语义对齐 DB insertRow（始终表尾 push）：兜底也 push 到表尾，而非菜单所在行后。
                if (!ok) {
                    const newRow = headers.map(() => '');
                    sheet.content.push(newRow);
                    await saveDataToDatabase(rawData, false, true);
                } else {
                    // 成功路径：让 DB 的更新回调驱动刷新，无需手动 render。
                }
            }
        });

        menu.find('#act-edit-card').click(() => {
            closeAll();
            const rawData = getTableData();
            if (rawData && rawData[tableKey]) {
                const headers = rawData[tableKey].content[0];
                const row = rawData[tableKey].content[rowIdx + 1];
                if (row) {
                    showCardEditModal(row, headers, tableName, rowIdx, tableKey);
                }
            }
        });
    };

    const showCardEditModal = (row, headers, tableName, rowIndex, tableKey) => {
        const { $ } = getCore();
        const config = getConfig();
        const rawData = getTableData();
        let displayRow = row;
        if (rawData && rawData[tableKey] && rawData[tableKey].content[rowIndex + 1]) {
            displayRow = rawData[tableKey].content[rowIndex + 1];
        }

        const inputsHtml = displayRow.map((cell, idx) => {
            if (idx === 0) return '';
            const headerName = headers[idx] || `Column ${idx}`;
            const val = cell || '';
            return `
                <div class="acu-card-edit-field">
                    <label class="acu-card-edit-label">${headerName}</label>
                    <textarea class="acu-card-edit-input" data-col="${idx}" spellcheck="false">${val}</textarea>
                </div>`;
        }).join('');

        const dialog = $(`
            <div class="acu-edit-overlay${overlayThemeClass(config.theme)}">
                <div class="acu-edit-dialog acu-theme-${config.theme}">
                    <div class="acu-edit-title">整体编辑 (#${rowIndex + 1})</div>
                    <div class="acu-settings-content" style="flex:1; overflow-y:auto;">
                        ${inputsHtml}
                    </div>
                     <div class="acu-dialog-btns">
                        <button class="acu-dialog-btn" id="dlg-card-cancel"><i class="fa-solid fa-times"></i> 取消</button>
                        <button class="acu-dialog-btn acu-btn-confirm" id="dlg-card-save" style="color:var(--acu-highlight)"><i class="fa-solid fa-check"></i> 保存</button>
                    </div>
                </div>
            </div>
        `);
        $('body').append(dialog); bindScrollFade(dialog.find('.acu-card-edit-input'));

        dialog.find('textarea').each(function () {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight + 2) + 'px';
        }).on('input', function () {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight + 2) + 'px';
        });

        const closeDialog = () => dialog.remove();
        dialog.find('#dlg-card-cancel').click(closeDialog);

        dialog.find('#dlg-card-save').click(async () => {
            const currentData = getTableData(); 
            if (currentData && currentData[tableKey]) {
                const currentRow = currentData[tableKey].content[rowIndex + 1];
                let hasChanges = false;
                let updateObj = {};
                dialog.find('textarea').each(function () {
                    const colIdx = parseInt($(this).data('col'));
                    const newVal = $(this).val();
                    if (String(currentRow[colIdx]) !== String(newVal)) {
                        hasChanges = true;
                        currentRow[colIdx] = newVal;
                        if (headers[colIdx]) updateObj[headers[colIdx]] = newVal;
                    }
                });
                if (hasChanges) {
                    await saveDataToDatabase(currentData, false, false, {
                        type: 'row_edit',
                        tableName: tableName,
                        rowIndex: rowIndex,
                        updateObj: updateObj
                    });
                }
            }
            closeDialog();
        });
        dialog.on('click', function(e) { if ($(e.target).hasClass('acu-edit-overlay')) closeDialog(); });
    };

    const showEditDialog = (content, onSave) => {
        const { $ } = getCore();
        const config = getConfig();
        const dialog = $(`
            <div class="acu-edit-overlay${overlayThemeClass(config.theme)}">
                <div class="acu-edit-dialog acu-theme-${config.theme}">
                    <div class="acu-edit-title">编辑单元格内容</div>
                    <textarea class="acu-edit-textarea">${content}</textarea>
                     <div class="acu-dialog-btns">
                        <button class="acu-dialog-btn" id="dlg-cancel"><i class="fa-solid fa-times"></i> 取消</button>
                        <button class="acu-dialog-btn acu-btn-confirm" id="dlg-save"><i class="fa-solid fa-check"></i> 保存</button>
                    </div>
                </div>
            </div>
        `);
        $('body').append(dialog); bindScrollFade(dialog.find('.acu-edit-textarea'));

        const closeDialog = () => dialog.remove();
        dialog.find('#dlg-cancel').click(closeDialog);
        dialog.find('#dlg-save').click(() => { onSave(dialog.find('textarea').val()); closeDialog(); });
        dialog.on('click', function(e) { if ($(e.target).hasClass('acu-edit-overlay')) closeDialog(); });
    };

    
    
    const showDashSlotSettings = (slotId) => {
        const { $ } = getCore();
        const config = getConfig();
        const currentDashCfg = getDashConfig() || {};

        const defaults = {
            'slot_1_1': {isEmpty:true}, 'slot_1_2': {isEmpty:true}, 
            'slot_2_1': {isEmpty:true}, 'slot_2_2': {isEmpty:true}, 
            'slot_3_1': {isEmpty:true}, 'slot_3_2': {isEmpty:true}, 
            'slot_4_1': {isEmpty:true}, 'slot_4_2': {isEmpty:true}, 
            'slot_5_1': {isEmpty:true}, 'slot_5_2': {isEmpty:true}, 
            'slot_6_1': {isEmpty:true}, 'slot_6_2': {isEmpty:true}
        };
        const currentSlotCfg = { ...defaults[slotId], ...(currentDashCfg[slotId] || {}) };

        const rawData = getTableData();
        const processedTables = rawData ? processJsonData(rawData) : {};
        const tableNames = Object.keys(processedTables);

        let activeTableName = currentSlotCfg.text;
        if (!tableNames.includes(activeTableName)) {
            const fuzzyMatch = tableNames.find(k => k.includes(activeTableName));
            if (fuzzyMatch) activeTableName = fuzzyMatch;
            else activeTableName = '';
        }

        const dialog = $(`
            <div class="acu-edit-overlay${overlayThemeClass(config.theme)}">
                <div class="acu-edit-dialog acu-theme-${config.theme}" style="max-width: 400px; height: auto; max-height: 90vh; overflow: hidden;">
                    <div class="acu-edit-title" style="display:flex; justify-content:space-between; align-items:center; padding:15px;">
                        <button id="dlg-slot-reset" style="background:transparent; border:none; color:var(--acu-text-sub); cursor:pointer; font-size:12px; display:flex; align-items:center; gap:4px; padding:5px; border-radius:4px; transition:background 0.2s;">
                            <i class="fa-solid fa-undo"></i> 重置
                        </button>
                        <span style="font-weight:bold;">配置</span>
                        <div style="width:40px;"></div>
                    </div>
                    <div class="acu-settings-content" style="padding: 20px; display: flex; flex-direction: column; gap: 15px; overflow-y:auto;">

                        <div>
                            <label style="font-weight:bold; display:block; margin-bottom:5px;">显示标题</label>
                            <input type="text" id="slot-title" value="${currentSlotCfg.title || ''}" class="acu-card-edit-input">
                        </div>

                        <div>
                            <label style="font-weight:bold; display:block; margin-bottom:5px;">绑定表格</label>
                            <select id="slot-table" class="acu-nice-select" style="width:100%">
                                <option value="" ${!activeTableName ? "selected" : ""}>-- 请选择 --</option>
                                ${tableNames.map(n => `<option value="${n}" ${n === activeTableName ? 'selected' : ''}>${n}</option>`).join('')}
                            </select>
                        </div>

                        <div>
                            <label style="font-weight:bold; display:block; margin-bottom:5px;">展示规则</label>
                            <select id="slot-rule" class="acu-nice-select" style="width:100%">
                                <!-- 2. 重命名列表模式为卡片展示，胶囊模式为表格总览 -->
                                <option value="kv" ${currentSlotCfg.rule === 'kv' ? 'selected' : ''}>卡片展示</option>
                                <option value="capsule" ${currentSlotCfg.rule === 'capsule' ? 'selected' : ''}>表格总览</option>
                            </select>
                        </div>

                        <!-- 3. 卡片展示自定义设置 -->
                        <div id="set-kv-area" style="display:none; flex-direction:column; gap:15px;">
                            <div>
                                <label style="font-weight:bold; display:block; margin-bottom:5px;">选择卡片</label>
                                <select id="slot-kv-card" class="acu-nice-select" style="width:100%"></select>
                            </div>
                            <div>
                                <label style="font-weight:bold; display:block; margin-bottom:5px;">选择展示列 (多选)</label>
                                <div id="slot-kv-cols" style="display:flex; flex-direction:column; gap:5px; max-height:150px; overflow-y:auto; background:var(--acu-input-bg); padding:5px; border-radius:4px; border:1px solid var(--acu-border);"></div>
                            </div>
                        </div>

                        <!-- 4. 表格总览自定义设置 -->
                        <div id="set-cap-area" style="display:none; flex-direction:column; gap:15px;">
                            <div>
                                <label style="font-weight:bold; display:block; margin-bottom:5px;">选择展示列</label>
                                <select id="slot-cap-col" class="acu-nice-select" style="width:100%"></select>
                            </div>
                            <div>
                                <label style="font-weight:bold; display:block; margin-bottom:5px;">卡槽列数</label>
                                <select id="slot-cap-cols-count" class="acu-nice-select" style="width:100%">
                                    <option value="0">自动</option>
                                    <option value="2">2列 (带图标)</option>
                                    <option value="3">3列</option>
                                    <option value="4">4列</option>
                                </select>
                            </div>
                        </div>

                    </div>
                    <div class="acu-dialog-btns">
                        <button class="acu-dialog-btn" id="dlg-slot-cancel"><i class="fa-solid fa-times"></i> 取消</button>
                        <button class="acu-dialog-btn acu-btn-confirm" id="dlg-slot-save"><i class="fa-solid fa-check"></i> 保存</button>
                    </div>
                </div>
            </div>
        `);
        $('body').append(dialog);

        const refreshOptions = () => {
            const tableName = dialog.find('#slot-table').val();
            const rule = dialog.find('#slot-rule').val();

            if (!tableName) {
                dialog.find('#slot-kv-card').empty();
                dialog.find('#slot-kv-cols').empty();
                dialog.find('#slot-cap-col').empty();
                dialog.find('#set-kv-area').hide();
                dialog.find('#set-cap-area').hide();
                return;
            }

            

            const table = processedTables[tableName];
            if (!table) return;

            const $cardSel = dialog.find('#slot-kv-card');
            const $colsDiv = dialog.find('#slot-kv-cols');
            $cardSel.empty();
            $colsDiv.empty();

            
            if (table.rows) {
                table.rows.forEach(r => {
                    const txt = r[1] || '未命名';
                    const sel = (currentSlotCfg.card === txt) ? 'selected' : '';
                    $cardSel.append(`<option value="${txt}" ${sel}>${txt}</option>`);
                });
            }

            if (table.headers) {
                table.headers.forEach((h, idx) => {
                    if (idx === 0) return;

                    const finalChecked = (currentSlotCfg.showCols === undefined || (currentSlotCfg.showCols && currentSlotCfg.showCols.includes(idx))) ? 'checked' : '';
                    $colsDiv.append(`
                        <label style="display:flex; align-items:center; gap:8px; font-size:12px;">
                            <input type="checkbox" class="acu-kv-col-check" value="${idx}" ${finalChecked}>
                            <span>${h}</span>
                        </label>
                    `);
                });
            }

            const $capColSel = dialog.find('#slot-cap-col');
            $capColSel.empty();
            dialog.find('#slot-cap-cols-count').val(currentSlotCfg.capCols || 0);
            if (table.headers) {
                table.headers.forEach((h, idx) => {
                    if (idx === 0) return;
                    const isSel = (currentSlotCfg.capCol == idx) ? 'selected' : (idx === 1 && currentSlotCfg.capCol === undefined ? 'selected' : '');
                    $capColSel.append(`<option value="${idx}" ${isSel}>${h}</option>`);
                });
            }

            if (rule === 'kv') {
                dialog.find('#set-kv-area').show();
                dialog.find('#set-cap-area').hide();
            } else {
                dialog.find('#set-kv-area').hide();
                dialog.find('#set-cap-area').show();
            }
        };

        dialog.find('#slot-table').on('change', function() { 
            refreshOptions();
            const val = $(this).val();
            if (val) {
                let t = val;
                if (t.endsWith('表')) t = t.slice(0, -1);
                dialog.find('#slot-title').val(t);
            }
        });
        dialog.find('#slot-rule').on('change', refreshOptions);
        refreshOptions();

        const close = () => dialog.remove();
        dialog.find('#dlg-slot-reset').click(() => {
            if(confirm('确定要重置此卡槽吗？')) {
                currentDashCfg[slotId] = { isEmpty: true };
                saveDashConfig(currentDashCfg);
                renderInterface(false);
                close();
            }
        }).hover(function(){$(this).css('background','var(--acu-btn-hover)')}, function(){$(this).css('background','transparent')});

        dialog.find('#dlg-slot-cancel').click(close);

        dialog.find('#dlg-slot-save').click(() => {
            const newTitle = dialog.find('#slot-title').val();
            const newText = dialog.find('#slot-table').val();
            const newRule = dialog.find('#slot-rule').val();

            if (!currentDashCfg[slotId]) currentDashCfg[slotId] = {};
            currentDashCfg[slotId].isEmpty = false;
            currentDashCfg[slotId].title = newTitle;
            currentDashCfg[slotId].text = newText;
            currentDashCfg[slotId].rule = newRule;

            if (newRule === 'kv') {
                currentDashCfg[slotId].card = dialog.find('#slot-kv-card').val();
                const selectedCols = [];
                dialog.find('.acu-kv-col-check:checked').each(function() {
                    selectedCols.push(parseInt($(this).val()));
                });
                currentDashCfg[slotId].showCols = selectedCols;
                delete currentDashCfg[slotId].capCol;
            } else {
                currentDashCfg[slotId].capCol = parseInt(dialog.find('#slot-cap-col').val());
                currentDashCfg[slotId].capCols = parseInt(dialog.find('#slot-cap-cols-count').val());
                 delete currentDashCfg[slotId].card;
                 delete currentDashCfg[slotId].showCols;
            }

            saveDashConfig(currentDashCfg);

            renderInterface(false);
            close();
        });
        dialog.on('click', function(e) { if ($(e.target).hasClass('acu-edit-overlay')) close(); });
    };

    const init = () => {
        if (isInitialized) return;
        addStyles();
        applyConfigStyles(getConfig());

        // 填表结束后前端"及时刷新"兜底：以"填表开始"信号驱动稳定轮询。
        // DB 在填表开始时调 _notifyTableFillStart；轮询每 ~2s 比较 exportTableAsJson 指纹，
        // 变化则刷新并重置稳定计数，连续 N 次无变化判定填表结束停止轮询。
        // 不依赖固定延迟——填表 3 秒或 30 秒都能捕捉最终态；DB 主动 _notifyTableUpdate 仍即时刷新。
        const POLL_INTERVAL_MS = 2000;
        const POLL_STABLE_THRESHOLD = 3;   // 连续 3 次无变化 = 结束
        const POLL_MAX_MS = 5 * 60 * 1000; // 5 分钟硬上限
        let fillPollTimer = null;
        let fillPollStable = 0;
        let fillPollStartedAt = 0;
        let fillPollLastFingerprint = null;

        // 轻量指纹/inEditingContext 复用顶层定义（见 IIFE 顶层），避免兄弟闭包重复定义。
        const stopFillPoll = () => { if (fillPollTimer) { clearInterval(fillPollTimer); fillPollTimer = null; } };

        const startFillPoll = () => {
            // 追平轮询在跑时不要再起填表轮询：两者各自 1.5s / 2s 独立触发
            // renderInterface(true)，叠起来接近每秒 1.2 次全量重建，正好砸在
            // 系统最忙的时候。追平结束本身就会强制刷新一次，不会漏数据。
            if (catchupTimer) return;
            stopFillPoll();
            fillPollStable = 0;
            fillPollStartedAt = Date.now();
            fillPollLastFingerprint = null;
            const api = getCore().getDB();
            // 首 tick 前先同步采样基线，避免把"填表刚开始还没写"误判为稳定而提前结束
            try {
                if (api && typeof api.exportTableAsJson === 'function') {
                    fillPollLastFingerprint = lightFingerprint(api.exportTableAsJson());
                }
            } catch (_) { /* 采样失败，下一 tick 补基线 */ }
            fillPollTimer = setInterval(() => {
                // 硬上限必须排在编辑态之前判：反过来的话，用户开着单元格菜单/详情弹窗
                // 走开，inEditingContext 会一直 return，POLL_MAX_MS 永远评估不到，
                // 这个 interval 就每 2s 空转到天荒地老（追平轮询那边顺序是对的）。
                if (Date.now() - fillPollStartedAt > POLL_MAX_MS) { stopFillPoll(); return; }
                if (inEditingContext()) return; // 用户编辑中不打扰
                if (!api || typeof api.exportTableAsJson !== 'function') { stopFillPoll(); return; }
                // 先取轻量指纹判断是否变化；只有变化才 clone 全表（避免每次都深拷贝）
                let rawRef = null;
                try { rawRef = api.exportTableAsJson(); } catch (_) { rawRef = null; }
                const fp = lightFingerprint(rawRef);
                if (fillPollLastFingerprint !== null && fp !== fillPollLastFingerprint) {
                    // 数据变了：填表仍在进行或有新写入 → 失效引用缓存并强制刷新。
                    // 不在此 clone：renderInterface(true) 内部 getTableData(true) 会统一 clone 一次，
                    // 避免轮询 clone + 渲染 clone 双份全表深拷贝。
                    fillPollStable = 0;
                    cachedTableData = null;
                    lastRawTableRef = null;
                    lastTableSetFingerprint = '';
                    lastTableDataRefreshed = true;
                    renderInterface(true);
                } else {
                    fillPollStable++;
                    if (fillPollStable >= POLL_STABLE_THRESHOLD) {
                        // 填表结束：把当前态存为新基线快照，让 diffMap 在下次刷新时不再把
                        // 已追平的行标记为"变化"高亮（否则会一直亮到下次填表或手动刷新）。
                        try { if (rawRef) saveSnapshot(cloneTableData(rawRef)); } catch (_) {}
                        stopFillPoll();
                        return;
                    }
                }
                fillPollLastFingerprint = fp;
            }, POLL_INTERVAL_MS);
        };

        const loop = () => {
             const { $ } = getCore();
             if (getCore().getDB()?.exportTableAsJson && $) {
                  renderInterface(true);
                 const api = getCore().getDB();
                 if (api.registerTableUpdateCallback) {
                     api.registerTableUpdateCallback(UpdateController.handleUpdate);
                     if (api.registerTableFillStartCallback) {
                         // 填表开始：存一份快照 + 启动稳定轮询（填表跑完自动兜底刷新）
                         api.registerTableFillStartCallback(() => {
                             try { const c = api.exportTableAsJson(); if (c) saveSnapshot(c); } catch (_) {}
                             startFillPoll();
                         });
                     }
                 }
                 isInitialized = true;
                 // 修复串表：cachedTableData 是前端侧的深拷贝缓存，DB 内部 currentJsonTableData_ACU
                 // 在切换聊天时会被替换为新聊天的数据，但前端缓存不会自动失效；renderInterface(false)
                 // 走缓存路径，会把旧聊天的表显示到新聊天里。
                 // 订阅 ST 的 CHAT_CHANGED 事件，命中时清缓存 + 丢快照 + 强制刷新，杜绝跨聊天串表。
                 try {
                     const w = window.parent || window;
                     const ST = w.SillyTavern || window.SillyTavern;
                     const evSrc = ST && ST.eventSource;
                     const evTypes = ST && ST.eventTypes;
                     if (evSrc && typeof evSrc.on === 'function' && evTypes && evTypes.CHAT_CHANGED) {
                         evSrc.on(evTypes.CHAT_CHANGED, () => {
                             stopFillPoll();
                             stopCatchupPoll(); // 切聊天停掉旧追平轮询，防跨聊天误刷新/误 toast
                             cachedTableData = null;
                             lastRawTableRef = null;
                             lastTableSetFingerprint = '';
                             memorySnapshot_ACU = null;
                             try { localStorage.removeItem(STORAGE_KEY_LAST_SNAPSHOT); } catch (_) {}
                             currentDiffMap.clear();
                             currentPage = 1;
                             if (!isEditingOrder) renderInterface(true);
                         });
                     }
                 } catch (e) { console.warn('[ACU-UI] 订阅 CHAT_CHANGED 失败，串表保护未启用:', e); }
             } else setTimeout(loop, 1000);
        };
        loop();
    };
    const { $ } = getCore();
    if ($) $(document).ready(init); else window.addEventListener('load', init);
})();
