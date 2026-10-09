'use strict';

// ================= الثوابت والإعدادات الافتراضية =================
// المتصفح يحفظ الإعدادات والتسعير فقط. الزبائن والحوالات مصدرها Google Sheets.
const STORAGE = {
    config: 'fastpay_v8_config',
    countries: 'fastpay_v8_countries',
    // عمليات لم تصل للشيت بعد (انقطاع إنترنت مثلاً)، تُحذف فور وصولها
    outbox: 'fastpay_v9_outbox',
    // نسخة من شعارات التجار { رقم التاجر: صورة } حتى لا تضيع إن لم يحفظها الشيت
    traderLogos: 'fastpay_v9_trader_logos'
};

// مفاتيح قديمة كانت تحفظ الزبائن والحوالات داخل المتصفح، تُمسح عند الفتح
const LEGACY_DATA_KEYS = ['fastpay_v8_customers', 'fastpay_v8_ledger', 'fastpay_v8_sync_queue'];

const DEFAULT_WEBHOOK = 'https://script.google.com/macros/s/AKfycbwzexyVRnAVWFHHzlzwR5BFiCZOFZ0bvUCkEVClSJtVS_77Wj65N3pLrRpPp6EK23q37Q/exec';
const RATE_API = 'https://open.er-api.com/v6/latest/USD';
const RATE_REFRESH_MS = 10 * 60 * 1000;

const STATUSES = ['قيد الإنتظار', 'فحص', 'مكتمل', 'ملغي'];
const CANCELLED = 'ملغي';
const PAYOUTS = ['محفظة', 'بنكي', 'كاش'];
// الجهات المتاحة لكل طريقة استلام
const PAYOUT_PROVIDERS = {
    'محفظة': ['جوال باي', 'بال باي'],
    'بنكي': ['بنك فلسطين'],
    'كاش': []
};

const DEFAULT_CONFIG = {
    screenRate: 3.70,
    marketRate: null,
    screenRateLastUpdated: '',
    rateMode: 'auto',          // auto: يتحدث من السوق | manual: مثبّت يدوياً
    costPct: 5.0,
    profitPct: 5.0,
    minusIls: 1.0,
    driveWebhook: DEFAULT_WEBHOOK,
    syncToken: '',
    // سعر البيع والشراء: فرق شبه ثابت عن سعر الشاشة (للعرض فقط)
    sellOffset: -0.01,
    buyOffset: 0.03,
    // بيانات الشركة للفاتورة
    companyName: 'فاست باي',
    companySubtitle: 'FAST PAY SYSTEM',
    companyLogo: '',
    receiptFooter: 'شكراً لتعاملكم معنا',
    // الحالات المخفية في سجل الحوالات (أزرار تشغيل/إيقاف تبقى محفوظة)
    hiddenStatuses: []
};

const DEFAULT_COUNTRIES = [
    { name: '🇶🇦 قطر', type: 'div', factor: 4.03 },
    { name: '🇦🇪 الامارات', type: 'div', factor: 3.76 },
    { name: '🇲🇦 المغرب', type: 'div', factor: 10.5 },
    { name: '🇹🇳 تونس', type: 'div', factor: 3.7 },
    { name: '🇩🇿 الجزائر', type: 'div', factor: 273 },
    { name: '🇮🇶 العراق', type: 'div', factor: 1660 },
    { name: '🇯🇴 الاردن', type: 'mul', factor: 1.365 },
    { name: '🇰🇼 الكويت', type: 'mul', factor: 3.06 },
    { name: '🇧🇭 البحرين', type: 'mul', factor: 2.49 },
    { name: '🇴🇲 سلطنة عمان', type: 'mul', factor: 2.50 },
    { name: '🇾🇪 اليمن', type: 'direct_percent', factor: 6 },
    { name: '🇱🇧 لبنان', type: 'direct_percent', factor: 6 },
    { name: '🇪🇬 جنيه مصري', type: 'div', factor: 50 },
    { name: '🟡 ويسترن يونيون', type: 'mul', factor: 1 },
    { name: '🅿️ باي بال', type: 'mul', factor: 1 },
    { name: '₮ USDT', type: 'mul', factor: 1 },
    { name: '🎵 سحب تيك توك', type: 'mul', factor: 1 }
];

// خيار "أخرى": يكتب المستخدم نوع المعاملة ونسبة الخصم بنفسه
const OTHER_SOURCE = { name: 'أخرى', type: 'direct_percent', factor: 0, other: true };

// مصادر أُضيفت لاحقاً: تُضاف مرة واحدة لقوائم التسعير المحفوظة سابقاً
const ADDED_SOURCES_V2 = ['🇪🇬 جنيه مصري', '🟡 ويسترن يونيون', '🅿️ باي بال', '₮ USDT'];
const ADDED_SOURCES_V3 = ['🎵 سحب تيك توك'];

const DEFAULT_EXPENSE_CATEGORIES = ['كهرباء', 'إيجار', 'مكالمات', 'ضيافة', 'إنترنت', 'أخرى'];

const TYPE_SYMBOL = { div: '÷', mul: '×', direct_percent: '%' };
const TYPE_LABEL = { div: 'تقسيم', mul: 'ضرب', direct_percent: 'نسبة' };

// ================= أدوات مساعدة =================
const $ = (id) => document.getElementById(id);

// يحوّل لرقم، ويستخدم البديل فقط إذا لم يكن رقماً صالحاً (الصفر قيمة مقبولة)
function toNum(value, fallback = 0) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

function fmt(n, digits = 2) {
    return toNum(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// تاريخ اليوم بالتوقيت المحلي (وليس UTC)
function localDateStr(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function nowTimeLabel() {
    return new Date().toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const normPhone = (p) => String(p ?? '').replace(/[\s-]/g, '');
const normName = (n) => String(n ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// رقم الواتساب بصيغة دولية (أرقام فقط بدون + أو 00)
function whatsappDigits(phone) {
    let d = String(phone ?? '').replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    return d;
}
const hasWhatsapp = (c) => whatsappDigits(c?.phone).length >= 10 && !whatsappDigits(c?.phone).startsWith('0');

const newCustomerId = () => 'c' + Date.now() + Math.floor(Math.random() * 1000);

function payoutBadgeClass(payout) {
    if (payout === 'بنكي') return 'bg-purple-50 text-purple-700';
    if (payout === 'كاش') return 'bg-sky-50 text-sky-700';
    return 'bg-emerald-50 text-emerald-700';
}

function statusSelectClass(st) {
    if (st === 'مكتمل') return 'bg-emerald-50 text-emerald-700 border-emerald-200 font-bold';
    if (st === 'قيد الإنتظار') return 'bg-amber-50 text-amber-700 border-amber-200 font-bold';
    if (st === CANCELLED) return 'bg-red-50 text-red-700 border-red-200 font-bold';
    return 'bg-slate-50 text-slate-700 border-slate-200 font-bold';
}

function downloadBlob(content, mime, filename) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ================= تحميل البيانات وترحيلها =================
function loadJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        const value = JSON.parse(raw);
        return value ?? fallback;
    } catch (e) {
        return fallback;
    }
}

function loadArray(key, fallback) {
    const value = loadJSON(key, fallback);
    return Array.isArray(value) ? value : fallback;
}

let globalConfig = { ...DEFAULT_CONFIG, ...loadJSON(STORAGE.config, {}) };
delete globalConfig.syncCustomers;
delete globalConfig.rateOffset; // أُلغي هامش الشاشة: سعر الشاشة = سعر السوق، والفروق في البيع والشراء
let countries = loadArray(STORAGE.countries, DEFAULT_COUNTRIES.map(c => ({ ...c })))
    .map(normalizeCountry).filter(c => c.name);
let outbox = loadArray(STORAGE.outbox, []);

if (!globalConfig.sourcesV2Added) {
    ADDED_SOURCES_V2.forEach(name => {
        const def = DEFAULT_COUNTRIES.find(c => c.name === name);
        if (def && !countries.some(c => c.name === name)) countries.push({ ...def });
    });
    globalConfig.sourcesV2Added = true;
}
if (!globalConfig.sourcesV3Added) {
    ADDED_SOURCES_V3.forEach(name => {
        const def = DEFAULT_COUNTRIES.find(c => c.name === name);
        if (def && !countries.some(c => c.name === name)) countries.push({ ...def });
    });
    globalConfig.sourcesV3Added = true;
}

countries.forEach((c, i) => { if (!Number.isFinite(c.order)) c.order = i; });

// تبدأ فارغة وتُملأ من Google Sheets
let customers = [];
let ledger = [];
let expenses = [];
let sheetSupportsExpenses = true; // يصبح false إذا كان سكربت الشيت قديماً
let sheetSupportsCountries = false; // تسعير الدول في الشيت (السكربت الجديد)، وإلا يبقى في المتصفح
let dataState = 'loading'; // loading | ready | error

LEGACY_DATA_KEYS.forEach(key => {
    try { localStorage.removeItem(key); } catch (e) { /* التخزين محظور */ }
});

// الشيت قد يحوّل 0599xxxxxx إلى رقم فيضيع الصفر الأول
function fixPhone(value) {
    const p = String(value ?? '').trim();
    return /^5\d{8}$/.test(p) ? '0' + p : p;
}

// لكل دولة تكلفتها (نسبة % أو مبلغ ثابت بالدولار) ونسبة ربحها
// يُستدعى أثناء تحميل الملف (قبل تعريف المتغيرات اللاحقة)، فالعدّاد خاصية على الدالة نفسها
function newCountryId() {
    newCountryId.seq = (newCountryId.seq || 0) + 1;
    return 'k' + Date.now().toString(36) + newCountryId.seq.toString(36);
}

// id ثابت حتى لو تغيّر الاسم، وorder لترتيب القائمة كما هي في الشيت
function normalizeCountry(c) {
    return {
        id: String(c?.id ?? '').trim() || newCountryId(),
        order: toNum(c?.order, NaN),
        name: String(c?.name ?? '').trim(),
        type: TYPE_SYMBOL[c?.type] ? c.type : 'div',
        factor: toNum(c?.factor, 1),
        costMode: c?.costMode === 'fixed' ? 'fixed' : 'pct',
        costValue: Math.max(0, toNum(c?.costValue, globalConfig.costPct)),
        profitPct: Math.max(0, toNum(c?.profitPct, globalConfig.profitPct))
    };
}

function costLabel(mode, value) {
    if (!toNum(value)) return 'بدون تكلفة';
    return mode === 'fixed' ? `$${fmt(value, value % 1 ? 2 : 0)} ثابت` : `${value}%`;
}

function normalizeProvider(payout, provider) {
    const p = String(provider ?? '').trim();
    if (p) return p;
    // الحوالات القديمة بدون جهة: المحفظة الافتراضية جوال باي، والبنك بنك فلسطين
    return (PAYOUT_PROVIDERS[payout] || [])[0] || '';
}

function normalizeCustomer(c) {
    return {
        id: String(c?.id ?? '').trim(),
        phone: String(c?.phone ?? '').trim(),
        name: String(c?.name ?? '').trim(),
        payout: PAYOUTS.includes(c?.payout) ? c.payout : 'محفظة',
        provider: normalizeProvider(c?.payout, c?.provider),
        account: String(c?.account ?? '').trim(),
        createdAt: String(c?.createdAt ?? '').slice(0, 10)
    };
}

function normalizeExpense(e) {
    return {
        id: toNum(e?.id, 0),
        date: String(e?.date ?? '').slice(0, 10),
        category: String(e?.category ?? '').trim(),
        amount: toNum(e?.amount, 0),
        note: String(e?.note ?? '').trim()
    };
}

// الصفوف القديمة في الشيت قد لا تحتوي نوع المعادلة والنسب، فنكملها هنا
function normalizeTx(t) {
    const country = countries.find(c => c.name === t?.country);
    const phone = fixPhone(t?.phone);
    return {
        id: toNum(t?.id, 0),
        date: String(t?.date ?? '').slice(0, 10),
        recipient: String(t?.recipient ?? '').trim(),
        phone: phone === '-' ? '' : phone,
        customerId: String(t?.customerId ?? '').trim(),
        account: String(t?.account ?? '').trim(),
        payout: PAYOUTS.includes(t?.payout) ? t.payout : 'محفظة',
        provider: normalizeProvider(t?.payout, t?.provider),
        currency: t?.currency === 'USD' ? 'USD' : 'ILS',
        country: String(t?.country ?? ''),
        type: TYPE_SYMBOL[t?.type] ? t.type : (country ? country.type : 'div'),
        orig: toNum(t?.orig, 0),
        factor: toNum(t?.factor, country ? country.factor : 1),
        costPct: toNum(t?.costPct, globalConfig.costPct),
        costMode: t?.costMode === 'fixed' ? 'fixed' : 'pct',
        costFixed: toNum(t?.costFixed, 0),
        profitPct: toNum(t?.profitPct, globalConfig.profitPct),
        minusIls: toNum(t?.minusIls, globalConfig.minusIls),
        screenRate: toNum(t?.screenRate, globalConfig.screenRate),
        clientIls: toNum(t?.clientIls, 0),
        clientUsd: toNum(t?.clientUsd, 0),
        costIls: toNum(t?.costIls, 0),
        profitIls: toNum(t?.profitIls, 0),
        status: STATUSES.includes(t?.status) ? t.status : STATUSES[0]
    };
}

// يحفظ في المتصفح الإعدادات والتسعير والعمليات المعلقة فقط
function saveAll() {
    try {
        localStorage.setItem(STORAGE.config, JSON.stringify(globalConfig));
        localStorage.setItem(STORAGE.countries, JSON.stringify(countries));
        localStorage.setItem(STORAGE.outbox, JSON.stringify(outbox));
    } catch (e) {
        console.error('Storage error:', e);
        showToast('تعذر الحفظ في المتصفح', 'التخزين محظور، والعمليات غير المُرسلة قد تضيع عند إغلاق الصفحة', 'error');
    }
    updateReportsData();
    updateSyncPendingBar();
}

// ================= الإشعارات المنبثقة (Toast) =================
const TOAST_STYLES = {
    success: { border: 'border-emerald-200', badge: 'bg-emerald-50 text-emerald-600', icon: '✓' },
    info: { border: 'border-blue-200', badge: 'bg-blue-50 text-blue-600', icon: 'ℹ' },
    warning: { border: 'border-amber-200', badge: 'bg-amber-50 text-amber-600', icon: '!' },
    error: { border: 'border-rose-200', badge: 'bg-rose-50 text-rose-600', icon: '✕' }
};

function showToast(title, message = '', type = 'success') {
    const style = TOAST_STYLES[type] || TOAST_STYLES.success;
    const toast = document.createElement('div');
    toast.className = `toast-item flex items-center gap-3 p-3.5 rounded-xl border shadow-lg w-80 max-w-full text-xs bg-white text-slate-800 ${style.border}`;
    toast.innerHTML = `
        <div class="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm shrink-0 ${style.badge}">${style.icon}</div>
        <div class="flex-1 min-w-0">
            <p class="font-bold text-slate-900 leading-tight" data-role="title"></p>
            <p class="text-[11px] text-slate-400 mt-0.5 hidden" data-role="message"></p>
        </div>
        <button type="button" class="text-slate-300 hover:text-slate-500 font-bold p-1" data-role="close">✕</button>
    `;
    // textContent يمنع تنفيذ أي HTML داخل الأسماء
    toast.querySelector('[data-role="title"]').textContent = title;
    if (message) {
        const msg = toast.querySelector('[data-role="message"]');
        msg.textContent = message;
        msg.classList.remove('hidden');
    }
    toast.querySelector('[data-role="close"]').addEventListener('click', () => toast.remove());

    $('toastContainer').appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 20);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, type === 'error' ? 6000 : 3500);
}

// ================= التبديل بين التبويبات =================
const TABS = ['calculator', 'reports', 'transactions', 'expenses', 'traders', 'customers', 'countries', 'settings'];
const TITLES = {
    calculator: 'حاسبة وصرافة الحوالات',
    reports: 'التقرير المالي والأرباح',
    transactions: 'سجل الحوالات والبحث المتقدم',
    expenses: 'المصاريف التشغيلية',
    traders: 'حسابات التجار',
    customers: 'إدارة الزبائن',
    countries: 'تسعير ومعاملات الدول',
    settings: 'الإعدادات العامة والربط السحابي'
};

// كل صفحة تُرسم فقط وهي ظاهرة، وعند فتحها تُرسم بآخر البيانات (switchTab)
function pageHidden(tab) {
    return !$('page-' + tab) || $('page-' + tab).classList.contains('hidden');
}

function switchTab(tab) {
    if (!TABS.includes(tab)) return;
    TABS.forEach(t => {
        $('page-' + t).classList.toggle('hidden', t !== tab);
        $('nav-' + t)?.classList.toggle('active', t === tab);
        $('mnav-' + t)?.classList.toggle('active', t === tab);
    });
    $('page-title').textContent = TITLES[tab] || 'فاست باي';
    window.scrollTo({ top: 0 });

    if (tab === 'reports') {
        updateReportsData();
        renderMonthlyAnalysis({ replay: true });
    }
    if (tab === 'calculator') {
        replayCalcEntrance();
        renderRecentTx();
    }
    updateMobileResultBar();
    if (tab === 'transactions') renderLedgerTable();
    if (tab === 'expenses') renderExpenses();
    if (tab === 'traders') renderTraders();
    if (tab === 'customers') renderCustomersTable();
    if (tab === 'countries') renderCountriesTable();
    if (tab === 'settings') loadSettingsPage();
}

// ================= سعر دولار الشاشة =================
// يصبح true عندما يكتب المستخدم سعراً خاصاً في الحاسبة، حتى لا يمسحه التحديث التلقائي
let calcRateTouched = false;

// حالة الاتصال بسعر السوق: loading | ok | manual | error
let rateStatus = 'loading';
let lastRateFetchMs = 0;

async function fetchLiveDollarRate({ manual = false } = {}) {
    // في الوضع اليدوي لا يتغير السعر إلا بطلب صريح من المستخدم
    if (globalConfig.rateMode === 'manual' && !manual) {
        rateStatus = 'manual';
        applyScreenRateToUI();
        return;
    }
    rateStatus = 'loading';
    lastRateFetchMs = Date.now();
    applyScreenRateToUI();

    try {
        const response = await fetch(RATE_API);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        const market = toNum(data?.rates?.ILS, NaN);
        if (!(market > 0)) throw new Error('لم يتم استلام سعر صحيح');

        // ربما ثبّت المستخدم سعراً يدوياً أثناء انتظار الرد
        if (!manual && globalConfig.rateMode === 'manual') return;

        // سعر الشاشة = سعر السوق كما هو، وفرق البيع والشراء يُحسب منه
        globalConfig.marketRate = round3(market);
        globalConfig.screenRate = round3(market);
        globalConfig.rateMode = 'auto';
        globalConfig.screenRateLastUpdated = nowTimeLabel();
        rateStatus = 'ok';
        lastUpdateAt = nowTimeLabel();
        if (manual) calcRateTouched = false;

        saveAll();
        applyScreenRateToUI();
        runLiveCalc();

        if (manual) showToast('تم تحديث سعر الشاشة', `${globalConfig.screenRate} ₪ من السوق (التحديث التلقائي مفعّل)`);
    } catch (err) {
        console.warn('Could not fetch live rate, keeping current rate:', err);
        rateStatus = globalConfig.rateMode === 'manual' ? 'manual' : 'error';
        applyScreenRateToUI();
        if (manual) showToast('تنبيه الاتصال', 'تعذر جلب سعر السوق حالياً، تم الإبقاء على السعر المعتمد', 'warning');
    }
}

function pinScreenRateManual() {
    const input = $('set_screen_rate');
    const val = toNum(input.value, NaN);
    if (!(val > 0)) return showToast('تنبيه', 'الرجاء إدخال سعر دولار رقمي صحيح', 'warning');

    globalConfig.screenRate = round3(val);
    globalConfig.rateMode = 'manual';
    globalConfig.screenRateLastUpdated = nowTimeLabel();
    rateStatus = 'manual';
    calcRateTouched = false;

    saveAll();
    input.blur();
    applyScreenRateToUI();
    runLiveCalc();
    showToast('تم تثبيت السعر يدوياً', `سعر الشاشة ${globalConfig.screenRate} ₪ ولن يتغير تلقائياً حتى تضغط "جلب السعر من السوق"`);
}

function applyScreenRateToUI() {
    const rate = toNum(globalConfig.screenRate);
    const updated = globalConfig.screenRateLastUpdated;
    const isManual = globalConfig.rateMode === 'manual';
    if (isManual && rateStatus !== 'loading') rateStatus = 'manual';

    // البطاقة الحيّة في الشريط العلوي: الرقم يتحرك نحو السعر الجديد عند تغيّره
    animateNumber($('top-screen-display'), rate, (v) => fmt(v, 2), 700);
    $('live-lock').classList.toggle('hidden', !isManual);
    updateLiveCard();

    if (!calcRateTouched) $('calc_screen_rate').value = rate;

    // الإعدادات
    $('set_current_rate').textContent = fmt(rate, 3) + ' ₪';
    // حقل الإعدادات يتبع السعر المعتمد حتى لا يعيد "حفظ الإعدادات" سعراً قديماً
    if (document.activeElement !== $('set_screen_rate')) $('set_screen_rate').value = rate;
    $('set_market_rate').textContent = globalConfig.marketRate ? fmt(globalConfig.marketRate, 3) : '—';
    const badge = $('rate-mode-badge');
    badge.textContent = isManual ? '🔒 يدوي مثبّت' : (rateStatus === 'error' ? 'تلقائي · غير متصل' : 'تلقائي من السوق');
    badge.className = 'badge ' + (isManual ? 'bg-amber-50 text-amber-700' : rateStatus === 'error' ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700');
    $('screen-update-time').textContent = rateStatus === 'loading' ? 'جاري جلب السعر...' : (updated ? `آخر تحديث: ${updated}` : 'لم يُحدَّث بعد');

    renderSellBuyRates();
}

// سعر البيع والشراء = سعر الشاشة + فرق ثابت (للعرض والمتابعة فقط)
function sellBuyRates(screen = globalConfig.screenRate, sellOffset = globalConfig.sellOffset, buyOffset = globalConfig.buyOffset) {
    return {
        sell: round3(toNum(screen) + toNum(sellOffset, 0)),
        buy: round3(toNum(screen) + toNum(buyOffset, 0))
    };
}

function renderSellBuyRates() {
    const { sell, buy } = sellBuyRates();
    $('rate-sell-val').textContent = sell.toFixed(3);
    $('rate-buy-val').textContent = buy.toFixed(3);
    $('res_rate_screen').textContent = toNum(globalConfig.screenRate).toFixed(3);
    $('res_rate_sell').textContent = sell.toFixed(3);
    $('res_rate_buy').textContent = buy.toFixed(3);
    updateSellBuyPreview();
}

// معاينة فورية في الإعدادات أثناء الكتابة
function updateSellBuyPreview() {
    const screen = toNum($('set_screen_rate').value, globalConfig.screenRate);
    const { sell, buy } = sellBuyRates(screen, toNum($('set_sell_offset').value, globalConfig.sellOffset), toNum($('set_buy_offset').value, globalConfig.buyOffset));
    $('set_sell_preview').textContent = sell.toFixed(3) + ' ₪';
    $('set_buy_preview').textContent = buy.toFixed(3) + ' ₪';
}

// ================= هوية الشركة (القائمة الجانبية والفاتورة) =================
function logoHtml() {
    return globalConfig.companyLogo
        ? `<img src="${escapeHtml(globalConfig.companyLogo)}" alt="" class="w-full h-full object-contain bg-white">`
        : '<span>⚡</span>';
}

// شعار واحد لكل المنصة: القائمة الجانبية، رأس الجوال، الإعدادات، أيقونة المتصفح، والفاتورة
function applyBranding() {
    const name = globalConfig.companyName || 'فاست باي';
    ['brand-logo', 'hdr-logo', 'set_logo_preview'].forEach(id => { $(id).innerHTML = logoHtml(); });
    $('brand-name').textContent = name;
    $('brand-subtitle').textContent = globalConfig.companySubtitle || '';
    if (globalConfig.companyLogo) $('app-favicon').href = globalConfig.companyLogo;
    document.title = name;
}

// يصغّر صورة إلى max بكسل كحد أقصى ويعيدها كـ dataURL
// maxChars: حد لطول النص (خلية الشيت تتسع لـ 50 ألف حرف)، فنجرّب صيغاً أصغر عند الحاجة
function resizeImageFile(file, max, onDone, maxChars = Infinity) {
    if (!file || !file.type.startsWith('image/')) return showToast('ملف غير صالح', 'اختر صورة (PNG أو JPG أو SVG)', 'warning');
    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, max / Math.max(img.width || max, img.height || max));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round((img.width || max) * scale));
            canvas.height = Math.max(1, Math.round((img.height || max) * scale));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            let url = canvas.toDataURL('image/png');
            if (url.length > maxChars) url = canvas.toDataURL('image/webp', 0.85);
            if (url.length > maxChars) {
                // JPG لا يدعم الشفافية، فنضع خلفية بيضاء
                ctx.globalCompositeOperation = 'destination-over';
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                url = canvas.toDataURL('image/jpeg', 0.8);
            }
            if (url.length > maxChars) return showToast('الصورة كبيرة', 'جرّب صورة أبسط أو أصغر', 'warning');
            onDone(url);
        };
        img.onerror = () => showToast('تعذر قراءة الصورة', '', 'error');
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
}

// يصغّر الشعار إلى 256 بكسل كحد أقصى قبل حفظه في المتصفح
function handleLogoFile(file) {
    resizeImageFile(file, 256, (url) => {
        globalConfig.companyLogo = url;
        saveAll();
        applyBranding();
        showToast('تم حفظ الشعار', 'سيظهر في القائمة الجانبية وفي كل فاتورة');
    });
}

// ================= معادلة الحساب (مصدر واحد لكل الشاشات) =================
// currency: ILS يُسلَّم بالشيكل (مع الخصم الإضافي) | USD يُسلَّم بالدولار مباشرة (بدون خصم الشيكل)
function computeTransfer({ orig, type, factor, costPct, profitPct, screenRate, minusIls, currency = 'ILS', costMode = 'pct', costFixed = 0 }) {
    let baseUsd;
    if (type === 'div') baseUsd = factor > 0 ? orig / factor : 0;
    else if (type === 'mul') baseUsd = orig * factor;
    else baseUsd = orig * (1 - factor / 100);
    baseUsd = Math.max(0, baseUsd);

    // التكلفة: نسبة من المبلغ، أو مبلغ ثابت بالدولار لا يتجاوز المبلغ نفسه
    const costUsd = costMode === 'fixed' ? Math.min(Math.max(0, costFixed), baseUsd) : baseUsd * (costPct / 100);
    const profitUsd = baseUsd * (profitPct / 100);
    const clientUsd = Math.max(0, baseUsd - costUsd - profitUsd);
    const grossIls = clientUsd * screenRate;
    // الخصم الإضافي لا يتجاوز المبلغ نفسه، ويذهب للربح (للتسليم بالشيكل فقط)
    const appliedMinus = currency === 'USD' ? 0 : (grossIls > 0 ? Math.min(Math.max(0, minusIls), grossIls) : 0);

    return {
        baseUsd, costUsd, profitUsd, clientUsd, grossIls, appliedMinus,
        clientIls: currency === 'USD' ? 0 : grossIls - appliedMinus,
        // الربح والتكلفة دائماً بالشيكل حتى تبقى التقارير بعملة واحدة
        profitIls: profitUsd * screenRate + appliedMinus,
        costIls: costUsd * screenRate
    };
}

function countryOptionsHtml(list) {
    return list.map(c => `
        <option data-name="${escapeHtml(c.name)}" data-type="${escapeHtml(c.type)}" data-factor="${escapeHtml(c.factor)}">
            ${escapeHtml(c.name)} (${TYPE_SYMBOL[c.type] || '÷'} ${escapeHtml(c.factor)})
        </option>
    `).join('');
}

function selectedCountry(select) {
    const opt = select.options[select.selectedIndex];
    if (!opt) return null;
    return { name: opt.dataset.name, type: opt.dataset.type, factor: toNum(opt.dataset.factor, 1) };
}

function factorLabel(c) {
    return c.type === 'direct_percent' ? `خصم ${c.factor}%` : `${TYPE_SYMBOL[c.type]} ${c.factor}`;
}

// ---------- اختيار المصدر (شبكة الدول والمنصات) ----------
let calcSource = null; // { name, type, factor }

function renderSourceGrid() {
    const query = ($('source-search').value || '').trim().toLowerCase();
    if (!calcSource || (!calcSource.other && !countries.some(c => c.name === calcSource.name))) {
        calcSource = countries[0] ? { ...countries[0] } : { ...OTHER_SOURCE };
        applySourceToInputs();
    }
    const list = countries.filter(c => !query || c.name.toLowerCase().includes(query));
    const otherActive = !!calcSource?.other;
    const otherChip = `
        <button type="button" data-action="select-source" data-name="${escapeHtml(OTHER_SOURCE.name)}" data-other="1" role="radio" aria-checked="${otherActive}"
            class="source-chip source-chip-other${otherActive ? ' active' : ''}">
            <span class="source-chip-name">✏️ أخرى</span>
            <span class="source-chip-rate">تكتب النوع والنسبة</span>
        </button>`;
    $('source-grid').innerHTML = list.map(c => {
            const active = calcSource && !calcSource.other && c.name === calcSource.name;
            return `
                <button type="button" data-action="select-source" data-name="${escapeHtml(c.name)}" role="radio" aria-checked="${active}"
                    class="source-chip${active ? ' active' : ''}">
                    <span class="source-chip-name">${escapeHtml(c.name)}</span>
                    <span class="source-chip-rate">${escapeHtml(factorLabel(c))}</span>
                    <span class="source-chip-cost">${escapeHtml(costLabel(c.costMode, c.costValue))} · ربح ${escapeHtml(c.profitPct)}%</span>
                </button>`;
        }).join('') + otherChip;
}

function applySourceToInputs() {
    const isOther = !!calcSource?.other;
    const isPercent = calcSource?.type === 'direct_percent';
    $('calc_factor').value = isOther ? '' : (calcSource ? calcSource.factor : '');
    $('calc_factor').placeholder = isOther ? '0' : '';
    $('calc_op_symbol').textContent = TYPE_SYMBOL[calcSource?.type] || '÷';
    $('calc_factor_label').textContent = isPercent ? 'النسبة %' : 'المعامل';
    const inUsd = isPercent || (calcSource && calcSource.type === 'mul' && calcSource.factor === 1);
    $('calc_amount_hint').textContent = inUsd ? '(بالدولار)' : '(بالعملة الأصلية)';
    $('other-fields').classList.toggle('hidden', !isOther);
    applySourceRates();
    updateSourceBadge();
}

// تعبئة التكلفة والربح من تسعير الدولة المختارة (أو الافتراضي لخيار "أخرى")
function applySourceRates() {
    const src = calcSource && !calcSource.other ? calcSource : null;
    setCostMode(src ? src.costMode : 'pct', false);
    $('calc_cost_pct').value = src ? src.costValue : globalConfig.costPct;
    $('calc_profit_pct').value = src ? src.profitPct : globalConfig.profitPct;
}

function setCostMode(mode, recalc = true) {
    mode = mode === 'fixed' ? 'fixed' : 'pct';
    $('calc_cost_mode').value = mode;
    document.querySelectorAll('[data-action="set-cost-mode"]').forEach(b => {
        const on = b.dataset.mode === mode;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on);
    });
    $('calc_cost_pct').step = mode === 'fixed' ? '0.5' : '0.1';
    if (recalc) runLiveCalc();
}

function otherSourceName() {
    const typed = $('calc_other_name').value.trim();
    return typed ? `أخرى - ${typed}` : '';
}

function updateSourceBadge() {
    $('res_source_badge').textContent = calcSource?.other ? (otherSourceName() || 'أخرى') : (calcSource?.name || '');
}

function selectSource(name, isOther = false) {
    if (isOther) {
        calcSource = { ...OTHER_SOURCE };
    } else {
        const c = countries.find(x => x.name === name);
        if (!c) return;
        calcSource = { ...c };
    }
    applySourceToInputs();
    renderSourceGrid();
    runLiveCalc();
    (isOther ? $('calc_other_name') : $('calc_orig_amount')).focus();
}

// ---------- طريقة الاستلام والجهة والعملة ----------
function providerOptions(payout) {
    return PAYOUT_PROVIDERS[payout] || [];
}

function setPayout(payout, provider) {
    if (!PAYOUTS.includes(payout)) payout = 'محفظة';
    const options = providerOptions(payout);
    if (!options.includes(provider)) provider = options[0] || '';
    $('calc_payout_type').value = payout;
    $('calc_provider').value = provider;

    document.querySelectorAll('[data-action="set-payout"]').forEach(b => {
        const on = b.dataset.payout === payout;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on);
    });
    $('provider-row').innerHTML = options.map(p => `
        <button type="button" data-action="set-provider" data-provider="${escapeHtml(p)}" class="provider-chip${p === provider ? ' active' : ''}">${escapeHtml(p)}</button>
    `).join('');
    $('payout-details').classList.toggle('hidden', payout === 'كاش');
    $('payout-cash-note').classList.toggle('hidden', payout !== 'كاش');
    $('calc_account_label').textContent = payout === 'بنكي' ? 'رقم الحساب البنكي' : 'رقم المحفظة';
    $('calc_account').placeholder = payout === 'بنكي' ? 'رقم الحساب في ' + (provider || 'البنك') : 'رقم محفظة ' + (provider || 'الزبون');
}

function setProvider(provider) {
    setPayout($('calc_payout_type').value, provider);
}

function setCurrency(currency) {
    currency = currency === 'USD' ? 'USD' : 'ILS';
    $('calc_currency').value = currency;
    document.querySelectorAll('[data-action="set-currency"]').forEach(b => {
        const on = b.dataset.currency === currency;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on);
    });
    runLiveCalc();
}

function readCalcInputs() {
    return {
        country: calcSource?.other ? otherSourceName() : (calcSource?.name || ''),
        isOther: !!calcSource?.other,
        type: calcSource?.type || 'div',
        orig: toNum($('calc_orig_amount').value, 0),
        factor: toNum($('calc_factor').value, 0),
        costMode: $('calc_cost_mode').value === 'fixed' ? 'fixed' : 'pct',
        costPct: $('calc_cost_mode').value === 'fixed' ? 0 : toNum($('calc_cost_pct').value, 0),
        costFixed: $('calc_cost_mode').value === 'fixed' ? toNum($('calc_cost_pct').value, 0) : 0,
        profitPct: toNum($('calc_profit_pct').value, 0),
        screenRate: toNum($('calc_screen_rate').value, globalConfig.screenRate),
        minusIls: toNum(globalConfig.minusIls, 0),
        currency: $('calc_currency').value === 'USD' ? 'USD' : 'ILS'
    };
}

let lastResultValue = null;

function runLiveCalc() {
    const input = readCalcInputs();
    const r = computeTransfer(input);
    const isUsd = input.currency === 'USD';
    const payoutAmount = isUsd ? r.clientUsd : r.clientIls;
    const fast = (v) => fmt(v);

    // الرقم الكبير يتحرك بسرعة نحو القيمة الجديدة، مع نبضة خفيفة عند التغيير
    const big = $('res_client_ils');
    animateNumber(big, payoutAmount, fast, 350);
    if (lastResultValue !== null && Math.abs(lastResultValue - payoutAmount) > 0.004 && !REDUCED_MOTION) {
        big.classList.remove('bump');
        void big.offsetWidth;
        big.classList.add('bump');
    }
    lastResultValue = payoutAmount;

    $('res_currency_lbl').textContent = isUsd ? '$ دولار' : '₪ شيكل';
    $('mrb-amount').textContent = fmt(payoutAmount);
    $('mrb-currency').textContent = isUsd ? '$' : '₪';
    $('mrb-profit').textContent = fmt(r.profitIls);
    resultInputReady = input.orig > 0;
    updateMobileResultBar();
    $('res_hint').textContent = input.orig <= 0
        ? 'أدخل المبلغ لعرض النتيجة'
        : isUsd
            ? 'يُسلَّم بالدولار، شامل خصم التكلفة وربحك'
            : 'شامل خصم التكلفة وربحك';

    animateNumber($('res_profit_ils'), r.profitIls, (v) => '+' + fmt(v), 350);
    $('res_profit_usd').textContent = fmt(r.profitUsd) + ' $';
    animateNumber($('res_cost_ils'), r.costIls, fast, 350);
    $('res_cost_usd').textContent = fmt(r.costUsd) + ' $';

    // شريط التوزيع
    const total = r.baseUsd || 1;
    $('split-client').style.width = (r.baseUsd ? (r.clientUsd / total) * 100 : 0) + '%';
    $('split-cost').style.width = (r.baseUsd ? (r.costUsd / total) * 100 : 0) + '%';
    $('split-profit').style.width = (r.baseUsd ? (r.profitUsd / total) * 100 : 0) + '%';

    $('step_base_usd').textContent = fmt(r.baseUsd) + ' $';
    $('step_cost_pct_lbl').textContent = input.costMode === 'fixed' ? `$${input.costFixed} ثابت` : input.costPct + '%';
    $('step_profit_pct_lbl').textContent = input.profitPct + '%';
    $('step_cost_usd').textContent = '-' + fmt(r.costUsd) + ' $';
    $('step_profit_usd').textContent = '-' + fmt(r.profitUsd) + ' $';
    $('step_client_usd').textContent = fmt(r.clientUsd) + ' $';
    $('step_screen_lbl').textContent = input.screenRate;
    $('step_gross_ils').textContent = fmt(r.grossIls) + ' ₪';
    $('step_final_ils').textContent = fmt(r.clientIls) + ' ₪';
    $('step_final_usd').textContent = fmt(r.clientUsd) + ' $';
    $('step-row-gross').classList.toggle('hidden', isUsd);
    $('step-row-final').classList.toggle('hidden', isUsd);
    $('step-row-usd').classList.toggle('hidden', !isUsd);
}

function payoutLabel(t) {
    const base = t.payout === 'بنكي' ? 'بنك' : t.payout;
    return t.provider ? `${base} · ${t.provider}` : base;
}

function deliveredHtml(t) {
    return t.currency === 'USD'
        ? `<bdi class="ltr-num">$ ${fmt(t.clientUsd)}</bdi>`
        : `${fmt(t.clientIls)} ₪`;
}

// ---------- آخر الحوالات في الواجهة الرئيسية ----------
let highlightTxId = null;

function renderRecentTx() {
    const box = $('recent-tx');
    if (!box || pageHidden('calculator')) return;
    const recent = [...ledger].sort((a, b) => b.id - a.id).slice(0, 5);
    box.innerHTML = recent.length === 0
        ? `<li class="text-xs text-slate-400 py-3 text-center">${emptyMessage(0, '', 'لا توجد حوالات بعد')}</li>`
        : recent.map(t => `
            <li class="recent-item${t.id === highlightTxId ? ' new' : ''}">
                <div class="min-w-0">
                    <span class="block font-bold text-slate-800 truncate">${escapeHtml(t.recipient)}</span>
                    <span class="block text-[10px] text-slate-400 truncate">${escapeHtml(t.country)} · ${escapeHtml(payoutLabel(t))}</span>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                    <div class="text-left">
                        <span class="block font-black text-slate-900 num">${deliveredHtml(t)}</span>
                        <span class="block text-[10px] text-emerald-600 font-bold num">+${fmt(t.profitIls)} ₪</span>
                    </div>
                    <button data-action="open-receipt" data-id="${t.id}" class="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-[11px] font-bold text-slate-700 transition">فاتورة</button>
                </div>
            </li>
        `).join('');
    highlightTxId = null;
}

function resetCalcForm() {
    $('calc_recipient').value = '';
    $('calc_customer_id').value = '';
    $('calc_account').value = '';
    $('calc_orig_amount').value = '';
    $('calc_status').value = STATUSES[0];
    $('calc_date').value = localDateStr();
    setCustomerStatus(false, 'عميل جديد');
    setPayout('محفظة');
    setCurrency('ILS');
    calcRateTouched = false;
    applyScreenRateToUI();
    $('calc_other_name').value = '';
    updateSourceBadge();
    if (calcSource && !calcSource.other) $('calc_factor').value = calcSource.factor;
    applySourceRates();
    runLiveCalc();
}

// ---------- شريط النتيجة السريع على الجوال ----------
let resultInputReady = false;
let resultCardVisible = true;

function updateMobileResultBar() {
    const bar = $('mobile-result-bar');
    const onCalc = !$('page-calculator').classList.contains('hidden');
    const show = onCalc && resultInputReady && !resultCardVisible;
    bar.classList.toggle('show', show);
    bar.setAttribute('aria-hidden', String(!show));
}

function watchResultCard() {
    const card = document.querySelector('.calc-result');
    if (!card || !('IntersectionObserver' in window)) return;
    new IntersectionObserver(([entry]) => {
        resultCardVisible = entry.isIntersecting;
        updateMobileResultBar();
    }, { threshold: 0.35 }).observe(card);
}

// يعيد حركة دخول بطاقات الحاسبة عند فتح الصفحة
function replayCalcEntrance() {
    document.querySelectorAll('#page-calculator .calc-step').forEach(el => {
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = '';
    });
}

// ================= البحث الذكي عن الزبون =================
function setCustomerStatus(isExisting, text) {
    const el = $('cust-auto-status');
    el.textContent = text;
    el.className = isExisting
        ? 'text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200'
        : 'text-[11px] font-bold text-blue-600 bg-blue-50 px-2.5 py-0.5 rounded-full border border-blue-100';
}

// قائمة الزبائن: تفتح بالضغط على الخانة، وتتفلتر أثناء الكتابة
let pickerIndex = -1;

function customerLastDates() {
    const last = {};
    ledger.forEach(t => {
        const key = t.customerId || 'n:' + normName(t.recipient);
        if (t.date && (!last[key] || t.date > last[key])) last[key] = t.date;
    });
    return last;
}

function onCustomerSearchInput() {
    const input = $('calc_recipient');
    const query = normName(input.value);
    const dropdown = $('customer-search-dropdown');

    // كتابة اسم مختلف تلغي ربط الزبون المختار سابقاً
    const linked = customers.find(c => c.id === $('calc_customer_id').value);
    if (linked && normName(linked.name) !== query) $('calc_customer_id').value = '';
    const exact = customers.find(c => normName(c.name) === query);
    if (!$('calc_customer_id').value) {
        setCustomerStatus(!!exact, exact ? '✓ زبون مسجل' : (query ? '+ زبون جديد' : 'عميل جديد'));
    }

    const last = customerLastDates();
    const lastOf = (c) => last[c.id] || last['n:' + normName(c.name)] || c.createdAt || '';
    const matches = customers
        .filter(c => !query || normName(c.name).includes(query) || normPhone(c.account).includes(normPhone(query)))
        .sort((a, b) => {
            // الأسماء التي تبدأ بما تكتبه أولاً، ثم الأحدث تعاملاً
            const as = normName(a.name).startsWith(query) ? 0 : 1;
            const bs = normName(b.name).startsWith(query) ? 0 : 1;
            return as - bs || lastOf(b).localeCompare(lastOf(a));
        })
        .slice(0, 50);

    pickerIndex = -1;
    if (matches.length === 0) {
        dropdown.innerHTML = customers.length
            ? `<div class="p-3 text-xs text-slate-500 text-center">لا يوجد زبون بهذا الاسم — سيُحفظ "${escapeHtml(input.value.trim())}" كزبون جديد</div>`
            : '<div class="p-3 text-xs text-slate-400 text-center">لا يوجد زبائن بعد — اكتب اسم الزبون الجديد</div>';
    } else {
        dropdown.innerHTML = matches.map(c => `
            <div data-action="select-customer" data-id="${escapeHtml(c.id)}" role="option" class="cust-option">
                <span class="cust-avatar">${escapeHtml(c.name.trim().charAt(0) || '؟')}</span>
                <span class="min-w-0 flex-1">
                    <span class="font-bold text-slate-800 block truncate">${highlightMatch(c.name, input.value.trim())}</span>
                    <span class="text-[11px] text-slate-400 truncate block">${escapeHtml(payoutLabel(c))}${c.account ? ` · <bdi class="ltr-num font-mono">${escapeHtml(c.account)}</bdi>` : ''}</span>
                </span>
                ${lastOf(c) ? `<span class="text-[10px] text-slate-400 shrink-0">${relativeDays(lastOf(c))}</span>` : ''}
            </div>
        `).join('');
    }
    dropdown.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
}

function highlightMatch(name, query) {
    const safe = escapeHtml(name);
    if (!query) return safe;
    const i = name.toLowerCase().indexOf(query.toLowerCase());
    if (i < 0) return safe;
    return escapeHtml(name.slice(0, i)) + '<mark class="cust-mark">' + escapeHtml(name.slice(i, i + query.length)) + '</mark>' + escapeHtml(name.slice(i + query.length));
}

function closeCustomerPicker() {
    $('customer-search-dropdown').classList.add('hidden');
    $('calc_recipient').setAttribute('aria-expanded', 'false');
}

// الأسهم و Enter للتنقل في القائمة
function onCustomerPickerKey(e) {
    const dropdown = $('customer-search-dropdown');
    const options = [...dropdown.querySelectorAll('.cust-option')];
    if (dropdown.classList.contains('hidden') || !options.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        pickerIndex = (pickerIndex + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options.forEach((o, i) => o.classList.toggle('active', i === pickerIndex));
        options[pickerIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && pickerIndex >= 0) {
        e.preventDefault();
        selectCustomerFromSearch(options[pickerIndex].dataset.id);
    } else if (e.key === 'Escape') {
        closeCustomerPicker();
    }
}

function fillCustomerIntoCalc(c) {
    $('calc_recipient').value = c.name;
    $('calc_customer_id').value = c.id || '';
    setPayout(c.payout || 'محفظة', c.provider);
    $('calc_account').value = c.account || '';
    setCustomerStatus(true, '✓ زبون مسجل');
}

function selectCustomerFromSearch(id) {
    const c = customers.find(x => x.id === id);
    if (!c) return;
    fillCustomerIntoCalc(c);
    closeCustomerPicker();
    $('calc_orig_amount').focus();
}


// ================= التحليل الشهري (رسم بياني متحرك ومباشر) =================
const MONTH_NAMES = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const LIVE_REFRESH_MS = 2 * 60 * 1000;

let analysisMonth = '';   // الشهر المختار YYYY-MM
let analysisFollowsCurrent = true; // يتبع الشهر الحالي تلقائياً (ينتقل للشهر الجديد عند بدايته)
let analysisRange = 6;    // عدد الأشهر في الرسم
let analysisSignature = { chart: '', cats: '', insights: '' };
let analysisChartData = [];

const monthKeyOf = (date) => String(date || '').slice(0, 7);
const currentMonthKey = () => localDateStr().slice(0, 7);

function monthLabel(key, withYear = true) {
    const [y, m] = key.split('-');
    return MONTH_NAMES[Number(m) - 1] + (withYear ? ' ' + y : '');
}

function shiftMonth(key, delta) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function emptyMonth(month) {
    return { month, profit: 0, payout: 0, count: 0, expenses: 0, net: 0, byCategory: {}, byCountry: {} };
}

function monthlyStats() {
    const map = {};
    const get = (k) => (map[k] ??= emptyMonth(k));
    ledger.forEach(t => {
        if (t.status === CANCELLED || !t.date) return;
        const s = get(monthKeyOf(t.date));
        s.profit += t.profitIls;
        s.payout += t.clientIls;
        s.count++;
        const country = t.country || 'غير محدد';
        s.byCountry[country] = (s.byCountry[country] || 0) + t.profitIls;
    });
    expenses.forEach(e => {
        if (!e.date) return;
        const s = get(monthKeyOf(e.date));
        s.expenses += e.amount;
        s.byCategory[e.category] = (s.byCategory[e.category] || 0) + e.amount;
    });
    Object.values(map).forEach(s => { s.net = s.profit - s.expenses; });
    return map;
}

// عدّاد متحرك: ينتقل الرقم من قيمته السابقة إلى الجديدة
function animateNumber(el, to, format = (v) => fmt(v, 0), duration = 900) {
    const from = toNum(el.dataset.value, 0);
    el.dataset.value = to;
    cancelAnimationFrame(el._raf);
    // بدون حركة: عند تفضيل تقليل الحركة، أو إذا كانت الصفحة مخفية (المتصفح يوقف الحركة فيها)
    if (REDUCED_MOTION || from === to || document.hidden) {
        el.textContent = format(to);
        return;
    }
    const start = performance.now();
    const step = (now) => {
        const p = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = format(from + (to - from) * eased);
        if (p < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
}

// رقم بالشيكل يحافظ على إشارة السالب في مكانها داخل النص العربي
const moneyHtml = (v, digits = 0) => `<bdi class="ltr-num">${fmt(v, digits)}</bdi> ₪`;

function compactNumber(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(Math.round(v));
}

function setDelta(el, cur, prev, prevKey, upIsGood) {
    if (!prev) {
        el.textContent = 'لا توجد بيانات للشهر السابق';
        el.className = 'ana-delta flat';
        return;
    }
    const diff = cur - prev;
    if (Math.abs(diff) < 0.005) {
        el.textContent = `＝ نفس ${monthLabel(prevKey, false)}`;
        el.className = 'ana-delta flat';
        return;
    }
    const up = diff > 0;
    const amount = prev !== 0 ? fmt(Math.abs(diff / Math.abs(prev)) * 100, 0) + '%' : fmt(Math.abs(diff), 0) + ' ₪';
    el.textContent = `${up ? '▲' : '▼'} ${amount} ${up ? 'أعلى' : 'أقل'} من ${monthLabel(prevKey, false)}`;
    el.className = 'ana-delta ' + (up === upIsGood ? 'good' : 'bad');
}

function niceTicks(min, max, count = 5) {
    const span = max - min || 1;
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => st >= raw) || 10 * mag;
    const start = Math.floor(min / step) * step;
    const end = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
}

// عمود بزوايا علوية دائرية 4px وقاعدة مربعة على خط الصفر
function barPath(x, yTop, w, yBase) {
    const h = yBase - yTop;
    if (h <= 0.5) return '';
    const r = Math.min(4, w / 2, h);
    return `M${x},${yBase}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yBase}Z`;
}

function renderMonthlyChart(data) {
    // الرسم بعرض الحاوية الفعلي حتى يبقى حجم الخط ثابتاً على الجوال والكمبيوتر
    const W = Math.max(300, Math.round($('ana-chart').clientWidth || 720));
    const H = W < 500 ? 240 : 300, padT = 16, padB = 40, padR = 44, padL = 4;
    const values = data.flatMap(d => [d.profit, d.expenses, d.net]);
    let max = Math.max(0, ...values);
    let min = Math.min(0, ...values);
    if (max === min) max = 100;
    const ticks = niceTicks(min, max, 4);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const plotW = W - padR - padL, plotH = H - padT - padB;
    const y = (v) => padT + ((y1 - v) / (y1 - y0)) * plotH;
    const band = plotW / data.length;
    // من اليمين لليسار: أقدم شهر على اليمين وأحدث شهر على اليسار
    const cx = (i) => W - padR - band * (i + 0.5);
    const barW = Math.max(6, Math.min(24, band * 0.28));
    const base = y(0);

    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`;

    // شبكة أفقية خفيفة وأرقام المحور
    ticks.forEach(t => {
        const ty = y(t);
        svg += `<line x1="${padL}" x2="${W - padR}" y1="${ty}" y2="${ty}" stroke="${t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}" stroke-width="1"/>`;
        svg += `<text x="${W - padR + 8}" y="${ty + 4}" font-size="11" fill="var(--chart-muted)" text-anchor="start" direction="ltr">${compactNumber(t)}</text>`;
    });

    // مناطق التفاعل لكل شهر (أكبر من الأعمدة)
    data.forEach((d, i) => {
        const selected = d.month === analysisMonth ? ' selected' : '';
        svg += `<rect class="ana-band${selected}" data-index="${i}" x="${cx(i) - band / 2}" y="${padT}" width="${band}" height="${plotH}" rx="6"/>`;
    });

    // الأعمدة: ربح الحوالات يمين، المصاريف يسار، بينهما فراغ 2px
    data.forEach((d, i) => {
        const delay = `--d:${i * 70}ms`;
        const pBar = barPath(cx(i) + 1, y(d.profit), barW, base);
        const eBar = barPath(cx(i) - 1 - barW, y(d.expenses), barW, base);
        if (pBar) svg += `<path class="ana-bar" style="${delay}" d="${pBar}" fill="var(--series-profit)" pointer-events="none"/>`;
        if (eBar) svg += `<path class="ana-bar" style="${delay}" d="${eBar}" fill="var(--series-expense)" pointer-events="none"/>`;
    });

    // خط صافي الربح مع نقاط بحلقة بلون الخلفية
    const pts = data.map((d, i) => [cx(i), y(d.net)]);
    svg += `<path class="ana-line" pathLength="1" d="M${pts.map(p => p.join(',')).join('L')}" fill="none" stroke="var(--series-net)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" pointer-events="none"/>`;
    pts.forEach(([px, py], i) => {
        svg += `<circle class="ana-dot" style="--d:${500 + i * 90}ms" cx="${px}" cy="${py}" r="4.5" fill="var(--series-net)" stroke="var(--chart-surface)" stroke-width="2" pointer-events="none"/>`;
    });

    // تسمية واحدة فقط: قيمة صافي الربح للشهر المختار
    const selIdx = data.findIndex(d => d.month === analysisMonth);
    if (selIdx >= 0) {
        const [sx, sy] = pts[selIdx];
        svg += `<text class="ana-dot" style="--d:900ms" x="${sx}" y="${sy - 12}" font-size="11" font-weight="700" fill="#0b0b0b" text-anchor="middle" direction="ltr" pointer-events="none">${compactNumber(data[selIdx].net)} ₪</text>`;
    }

    // أسماء الأشهر
    data.forEach((d, i) => {
        const [yr, mo] = d.month.split('-');
        const showYear = i === 0 || mo === '01';
        const weight = d.month === analysisMonth ? '700' : '500';
        const name = MONTH_NAMES[Number(mo) - 1];
        const label = band < 46 ? name.slice(0, 3) : name;
        svg += `<text x="${cx(i)}" y="${H - padB + 18}" font-size="11" font-weight="${weight}" fill="var(--chart-text)" text-anchor="middle" pointer-events="none">${label}</text>`;
        if (showYear) svg += `<text x="${cx(i)}" y="${H - padB + 32}" font-size="10" fill="var(--chart-muted)" text-anchor="middle" pointer-events="none">${yr}</text>`;
    });

    svg += '</svg>';

    const chart = $('ana-chart');
    chart.classList.remove('in');
    chart.innerHTML = svg;
    analysisChartData = data;
    // إعادة تشغيل الحركة: الأعمدة تنمو والخط يُرسم
    void chart.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => chart.classList.add('in')));
}

function showChartTooltip(index) {
    const d = analysisChartData[index];
    const band = $('ana-chart').querySelector(`.ana-band[data-index="${index}"]`);
    if (!d || !band) return;
    const tip = $('ana-tooltip');
    const wrap = $('ana-chart-wrap').getBoundingClientRect();
    const r = band.getBoundingClientRect();
    tip.innerHTML = `
        <div class="font-bold text-slate-900 mb-1">${monthLabel(d.month)}</div>
        <div class="ana-tooltip-row"><span class="inline-flex items-center gap-1.5 text-slate-600"><span class="ana-key" style="background:var(--series-profit)"></span>ربح الحوالات</span><b class="num text-slate-900">${fmt(d.profit)} ₪</b></div>
        <div class="ana-tooltip-row"><span class="inline-flex items-center gap-1.5 text-slate-600"><span class="ana-key" style="background:var(--series-expense)"></span>المصاريف</span><b class="num text-slate-900">${fmt(d.expenses)} ₪</b></div>
        <div class="ana-tooltip-row border-t border-slate-100 mt-1 pt-1"><span class="inline-flex items-center gap-1.5 text-slate-600"><span class="ana-key ana-key-line" style="background:var(--series-net)"></span>صافي الربح</span><b class="num text-slate-900">${moneyHtml(d.net, 2)}</b></div>
        <div class="text-[10px] text-slate-400 mt-1">${d.count} حوالة</div>
    `;
    tip.classList.remove('hidden');
    const tipW = tip.offsetWidth;
    let left = r.left - wrap.left + r.width / 2;
    left = Math.max(tipW / 2, Math.min(wrap.width - tipW / 2, left));
    tip.style.left = left + 'px';
    tip.style.top = '4px';
}

function hideChartTooltip() {
    $('ana-tooltip').classList.add('hidden');
}

function renderCategoryBars(sel) {
    $('ana-cat-month').textContent = monthLabel(sel.month, false);
    const entries = Object.entries(sel.byCategory).sort((a, b) => b[1] - a[1]);
    const signature = JSON.stringify(entries);
    if (signature === analysisSignature.cats) return;
    analysisSignature.cats = signature;

    const box = $('ana-categories');
    if (!entries.length) {
        box.innerHTML = '<div class="text-xs text-slate-400 py-4 text-center">لا توجد مصاريف في هذا الشهر</div>';
        return;
    }
    const max = entries[0][1];
    const total = entries.reduce((s, [, v]) => s + v, 0);
    box.innerHTML = entries.map(([cat, sum], i) => `
        <div>
            <div class="flex justify-between text-xs mb-1">
                <span class="font-bold text-slate-700">${escapeHtml(cat)}</span>
                <span class="text-slate-600"><b class="num text-slate-900">${fmt(sum, 0)} ₪</b> · ${Math.round(sum / total * 100)}%</span>
            </div>
            <div class="ana-cat-track"><div class="ana-cat-fill" style="--d:${i * 80}ms" data-width="${(sum / max) * 100}"></div></div>
        </div>
    `).join('');
    requestAnimationFrame(() => requestAnimationFrame(() => {
        box.querySelectorAll('.ana-cat-fill').forEach(el => { el.style.width = el.dataset.width + '%'; });
    }));
}

function buildInsights(sel, prev, rangeData, isCurrent) {
    const items = [];
    const prevKey = shiftMonth(sel.month, -1);

    if (!sel.count && !sel.expenses) {
        return [{ icon: 'ℹ', text: `لا توجد حوالات أو مصاريف مسجلة في ${monthLabel(sel.month)}.` }];
    }

    // صافي الربح مقارنة بالشهر السابق
    if (prev.count || prev.expenses) {
        const diff = sel.net - prev.net;
        const pct = prev.net !== 0 ? Math.abs(diff / Math.abs(prev.net)) * 100 : null;
        items.push(diff >= 0
            ? { icon: '📈', text: `صافي الربح ${isCurrent ? 'حتى الآن ' : ''}أعلى من ${monthLabel(prevKey, false)} بـ <b>${fmt(Math.abs(diff), 0)} ₪</b>${pct !== null ? ` (${fmt(pct, 0)}%)` : ''}.` }
            : { icon: '📉', text: `صافي الربح ${isCurrent ? 'حتى الآن ' : ''}أقل من ${monthLabel(prevKey, false)} بـ <b>${fmt(Math.abs(diff), 0)} ₪</b>${pct !== null ? ` (${fmt(pct, 0)}%)` : ''}.` });
    }

    // توقع نهاية الشهر الحالي بناءً على المعدل اليومي
    if (isCurrent && sel.count) {
        const today = new Date();
        const day = today.getDate();
        const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
        if (day < daysInMonth) {
            const projectedProfit = (sel.profit / day) * daysInMonth;
            const projectedNet = projectedProfit - sel.expenses;
            items.push({ icon: '🔮', text: `بمعدل ربح يومي <b>${fmt(sel.profit / day, 0)} ₪</b>، صافي الربح المتوقع لنهاية الشهر حوالي <b>${moneyHtml(projectedNet)}</b> (إذا لم تُضف مصاريف جديدة).` });
        }
    }

    // نسبة المصاريف من الربح
    if (sel.profit > 0 && sel.expenses > 0) {
        const ratio = (sel.expenses / sel.profit) * 100;
        items.push({
            icon: ratio > 60 ? '⚠️' : '💡',
            text: `المصاريف تستهلك <b>${fmt(ratio, 0)}%</b> من ربح الحوالات${ratio > 100 ? ' — الشهر بخسارة' : ratio > 60 ? ' — نسبة مرتفعة' : ''}.`
        });
    } else if (sel.expenses > 0 && sel.profit <= 0) {
        items.push({ icon: '⚠️', text: `يوجد <b>${fmt(sel.expenses, 0)} ₪</b> مصاريف بدون أرباح حوالات في هذا الشهر.` });
    }

    // أكبر بند مصاريف
    const topCat = Object.entries(sel.byCategory).sort((a, b) => b[1] - a[1])[0];
    if (topCat && sel.expenses > 0) {
        items.push({ icon: '🧾', text: `أكبر بند مصاريف: <b>${escapeHtml(topCat[0])}</b> بقيمة ${fmt(topCat[1], 0)} ₪ (${Math.round(topCat[1] / sel.expenses * 100)}% من المصاريف).` });
    }

    // أفضل دولة ربحاً
    const topCountry = Object.entries(sel.byCountry).sort((a, b) => b[1] - a[1])[0];
    if (topCountry && sel.profit > 0) {
        items.push({ icon: '🌍', text: `أكثر مصدر ربحاً: <b>${escapeHtml(topCountry[0])}</b> بـ ${fmt(topCountry[1], 0)} ₪ (${Math.round(topCountry[1] / sel.profit * 100)}% من الربح).` });
    }

    // متوسط الربح لكل حوالة
    if (sel.count) {
        items.push({ icon: '💱', text: `${sel.count} حوالة بمتوسط ربح <b>${fmt(sel.profit / sel.count, 1)} ₪</b> للحوالة.` });
    }

    // أفضل شهر في الفترة
    const withData = rangeData.filter(d => d.count || d.expenses);
    if (withData.length > 1) {
        const best = withData.reduce((a, b) => (b.net > a.net ? b : a));
        items.push({ icon: '🏆', text: best.month === sel.month
            ? `هذا أفضل شهر في آخر ${rangeData.length} أشهر من حيث صافي الربح.`
            : `أفضل شهر في الفترة: <b>${monthLabel(best.month)}</b> بصافي ربح ${moneyHtml(best.net)}.` });
    }

    return items;
}

function renderInsights(items) {
    const signature = JSON.stringify(items);
    if (signature === analysisSignature.insights) return;
    analysisSignature.insights = signature;
    $('ana-insights').innerHTML = items.map((it, i) => `
        <li class="ana-insight" style="--d:${i * 90}ms">
            <span class="ana-insight-icon" aria-hidden="true">${it.icon}</span>
            <span>${it.text}</span>
        </li>
    `).join('');
}

function renderMonthlyTable(rangeData) {
    $('ana-table-body').innerHTML = [...rangeData].reverse().map(d => {
        const margin = d.profit > 0 ? Math.round((d.net / d.profit) * 100) + '%' : '—';
        return `
            <tr class="${d.month === analysisMonth ? 'selected' : ''} cursor-pointer hover:bg-slate-50" data-action="ana-pick-month" data-month="${d.month}">
                <td class="p-3 font-bold text-slate-900 whitespace-nowrap">${monthLabel(d.month)}</td>
                <td class="p-3 num text-slate-800">${fmt(d.profit)} ₪</td>
                <td class="p-3 num text-slate-800">${fmt(d.expenses)} ₪</td>
                <td class="p-3 num font-black ${d.net < 0 ? 'text-rose-700' : 'text-slate-900'}">${moneyHtml(d.net, 2)}</td>
                <td class="p-3 num text-slate-600"><bdi class="ltr-num">${margin}</bdi></td>
                <td class="p-3 num text-center text-slate-600">${d.count}</td>
            </tr>
        `;
    }).join('');
}

function renderMonthSelect(stats) {
    const current = currentMonthKey();
    const keys = Object.keys(stats).filter(k => /^\d{4}-\d{2}$/.test(k));
    let earliest = keys.length ? keys.sort()[0] : current;
    if (earliest > current) earliest = current;
    const options = [];
    for (let k = current; k >= earliest; k = shiftMonth(k, -1)) {
        options.push(k);
        if (options.length > 60) break;
    }
    const sel = $('ana_month');
    sel.innerHTML = options.map(k => `<option value="${k}">${monthLabel(k)}</option>`).join('');
    sel.value = analysisMonth;
}

function renderMonthlyAnalysis({ replay = false } = {}) {
    if ($('page-reports').classList.contains('hidden')) return;

    const stats = monthlyStats();
    const current = currentMonthKey();
    if (!analysisMonth || analysisMonth > current || analysisFollowsCurrent) analysisMonth = current;

    renderMonthSelect(stats);
    document.querySelectorAll('.ana-range-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.range) === analysisRange));

    const sel = stats[analysisMonth] || emptyMonth(analysisMonth);
    const prevKey = shiftMonth(analysisMonth, -1);
    const prev = stats[prevKey] || emptyMonth(prevKey);
    const hasPrev = !!(prev.count || prev.expenses);

    const money = (v) => fmt(v, 0);
    animateNumber($('ana-profit'), sel.profit, money);
    animateNumber($('ana-expenses'), sel.expenses, money);
    animateNumber($('ana-net'), sel.net, money);
    setDelta($('ana-profit-delta'), sel.profit, hasPrev ? prev.profit : null, prevKey, true);
    setDelta($('ana-expenses-delta'), sel.expenses, hasPrev ? prev.expenses : null, prevKey, false);
    setDelta($('ana-net-delta'), sel.net, hasPrev ? prev.net : null, prevKey, true);

    // آخر N أشهر تنتهي بالشهر المختار (الأقدم أولاً)
    const rangeData = [];
    for (let i = analysisRange - 1; i >= 0; i--) {
        const k = shiftMonth(analysisMonth, -i);
        rangeData.push(stats[k] || emptyMonth(k));
    }

    // الرسم يُعاد (مع الحركة) فقط عند تغيّر البيانات أو الاختيار أو عرض الشاشة
    const chartSig = JSON.stringify([analysisMonth, $('ana-chart').clientWidth, rangeData.map(d => [d.month, d.profit, d.expenses, d.count])]);
    if (replay || chartSig !== analysisSignature.chart) {
        analysisSignature.chart = chartSig;
        hideChartTooltip();
        renderMonthlyChart(rangeData);
    }
    if (replay) analysisSignature.cats = analysisSignature.insights = '';

    renderCategoryBars(sel);
    renderInsights(buildInsights(sel, prev, rangeData, analysisMonth === current));
    renderMonthlyTable(rangeData);
}

function setAnalysisMonth(key) {
    if (!/^\d{4}-\d{2}$/.test(key || '')) return;
    analysisMonth = key > currentMonthKey() ? currentMonthKey() : key;
    analysisFollowsCurrent = analysisMonth === currentMonthKey();
    renderMonthlyAnalysis();
}

function setLiveIndicator(ok) {
    $('ana-live-dot').classList.toggle('off', !ok);
    $('ana-live-text').textContent = ok ? `مباشر · ${nowTimeLabel()}` : 'غير متصل';
}

// ================= التقارير =================
function updateReportsData() {
    if (pageHidden('reports')) return;
    const todayStr = localDateStr();
    const currentMonth = todayStr.slice(0, 7);

    let profitToday = 0, countToday = 0, profitMonth = 0, countMonth = 0, payoutMonth = 0, profitTotal = 0;
    const byCountry = {};

    ledger.forEach(t => {
        if (t.status === CANCELLED) return;
        profitTotal += t.profitIls;

        const key = t.country || 'غير محدد';
        byCountry[key] ??= { count: 0, profit: 0, payout: 0 };
        byCountry[key].count++;
        byCountry[key].profit += t.profitIls;
        byCountry[key].payout += t.clientIls;

        if (t.date === todayStr) {
            profitToday += t.profitIls;
            countToday++;
        }
        if (t.date.startsWith(currentMonth)) {
            profitMonth += t.profitIls;
            countMonth++;
            payoutMonth += t.clientIls;
        }
    });

    $('rep-profit-today').textContent = '+' + fmt(profitToday, 1) + ' ₪';
    $('rep-count-today').textContent = countToday;
    $('rep-profit-month').textContent = '+' + fmt(profitMonth, 1) + ' ₪';
    $('rep-count-month').textContent = countMonth;
    const payoutMonthUsd = ledger
        .filter(t => t.status !== CANCELLED && t.currency === 'USD' && t.date.startsWith(currentMonth))
        .reduce((sum, t) => sum + t.clientUsd, 0);
    $('rep-payout-month').textContent = fmt(payoutMonth, 1) + ' ₪' + (payoutMonthUsd ? ` + $${fmt(payoutMonthUsd, 0)}` : '');
    $('rep-profit-total').textContent = '+' + fmt(profitTotal, 1) + ' ₪';

    renderMonthlyAnalysis();

    const entries = Object.entries(byCountry).sort((a, b) => b[1].profit - a[1].profit);
    $('reports-countries-grid').innerHTML = entries.length === 0
        ? '<div class="col-span-full text-slate-400 text-xs py-4 text-center">لا توجد عمليات مسجلة بعد</div>'
        : entries.map(([country, d]) => `
            <div class="p-3.5 bg-slate-50 border border-slate-200/80 rounded-xl space-y-1 text-xs">
                <div class="flex justify-between items-center font-bold text-slate-800">
                    <span>${escapeHtml(country)}</span>
                    <span class="text-[11px] text-slate-400 font-normal">${d.count} عملية</span>
                </div>
                <div class="flex justify-between pt-1">
                    <span class="text-slate-500">المسلّم للزبائن:</span>
                    <span class="font-mono font-bold text-slate-700">${fmt(d.payout, 1)} ₪</span>
                </div>
                <div class="flex justify-between">
                    <span class="text-slate-500">صافي الربح:</span>
                    <span class="font-mono font-black text-emerald-600">+${fmt(d.profit, 1)} ₪</span>
                </div>
            </div>
        `).join('');
}

// ================= Google Sheets: القراءة والمزامنة =================
// يُرسل الطلب كنص عادي (بدون preflight) حتى نستطيع قراءة رد السكربت والتأكد من الوصول.
// الحالات: ok | unconfirmed (أُرسل ولا يمكن قراءة الرد) | failed | disabled
async function postToSheets(payload) {
    const url = (globalConfig.driveWebhook || '').trim();
    if (!url) return { status: 'disabled' };
    if (navigator.onLine === false) return { status: 'failed', error: 'offline' };

    const body = JSON.stringify(globalConfig.syncToken ? { ...payload, token: globalConfig.syncToken } : payload);
    try {
        const res = await fetch(url, { method: 'POST', body });
        if (!res.ok) return { status: 'failed', error: 'HTTP ' + res.status };
        let data = null;
        try { data = JSON.parse(await res.text()); } catch (_) { /* السكربت القديم لا يرد بـ JSON */ }
        if (data && data.ok === false) return { status: 'failed', error: data.error || 'rejected' };
        return { status: 'ok', data };
    } catch (e) {
        // غالباً وصل الطلب لكن السكربت لا يسمح بقراءة الرد (CORS)، فلا نعيد الإرسال لتجنب التكرار
        return { status: 'unconfirmed' };
    }
}

// ---------- قراءة الزبائن والحوالات من الشيت ----------
function setDataStatus(state, message = '') {
    dataState = state;
    if (state === 'error') sheetReadFailed = true;
    $('data-status-bar').classList.toggle('hidden', state === 'ready');
    $('data-status-bar').classList.toggle('!border-rose-200', state === 'error');
    $('data-status-text').textContent = message;
    $('data-status-text').className = 'font-bold ' + (state === 'error' ? 'text-rose-700' : 'text-slate-600');
    $('data-status-retry').classList.toggle('hidden', state !== 'error');
    // أثناء التحميل نمنع الحفظ حتى لا تختلط البيانات القديمة بالجديدة
    $('save-tx-btn').disabled = state === 'loading';
}

function renderDataViews() {
    renderTraders();
    renderLedgerTable();
    renderRecentTx();
    renderCustomersTable();
    renderExpenses();
    updateReportsData();
    updateSyncPendingBar();
}

function sortLedger() {
    ledger.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

let loadSeq = 0;

// التحديث السريع: بعد أول تحميل كامل نطلب فقط ما تغيّر منذ آخر قراءة (since)،
// ونعيد التحميل الكامل كل 30 دقيقة أو عند الضغط على "تحديث من الشيت" كاحتياط
const FULL_RELOAD_MS = 30 * 60 * 1000;
let syncCursor = null;
let lastFullLoadMs = 0;

const COLLECTION_NORMALIZERS = {
    ledger: { get: () => ledger, set: (v) => { ledger = v; }, norm: (r) => normalizeTx(r), ok: (x) => x.id },
    customers: { get: () => customers, set: (v) => { customers = v; }, norm: (r) => normalizeCustomer(r), ok: (x) => x.id && x.name },
    expenses: { get: () => expenses, set: (v) => { expenses = v; }, norm: (r) => normalizeExpense(r), ok: (x) => x.id },
    traders: { get: () => traders, set: (v) => { traders = v; }, norm: (r) => normalizeTrader(r), ok: (x) => x.id && x.name },
    traderMoves: { get: () => traderMoves, set: (v) => { traderMoves = v; }, norm: (r) => normalizeTmove(r), ok: (x) => x.id && x.traderId },
    countries: { get: () => countries, set: (v) => { countries = v; }, norm: (r) => normalizeCountry(r), ok: (x) => x.name }
};

// ---------- تسعير الدول من الشيت ----------
// الشيت هو المصدر، والمتصفح يحتفظ بنسخة حتى تعمل الحاسبة فوراً عند الفتح.
// أول مرة يكون فيها جدول التسعير في الشيت فارغاً نرفع له التسعير المحفوظ في المتصفح.
function applySheetCountries(rows) {
    sheetSupportsCountries = true;
    const list = rows.map(normalizeCountry).filter(c => c.name);
    if (list.length) {
        countries = list;
    } else if (!globalConfig.countriesSeeded && countries.length && !outbox.some(op => op.action === 'upsert_country')) {
        queueOps(...countries.map(c => ({ action: 'upsert_country', country: c })));
        flushOutbox();
    }
    if (!globalConfig.countriesSeeded) {
        globalConfig.countriesSeeded = true;
        saveAll(); // نحفظ أرقام الدول حتى لا تتكرر إن أُعيد الرفع
    }
}

// بعد أي تغيير في التسعير من الشيت: ترتيب، حفظ النسخة، وتحديث الحاسبة والجدول
function afterCountriesChanged(before) {
    countries.forEach((c, i) => { if (!Number.isFinite(c.order)) c.order = i; });
    countries.sort((a, b) => a.order - b.order);
    if (JSON.stringify(countries) === before) return;
    saveAll();
    const current = calcSource && !calcSource.other ? countries.find(c => c.name === calcSource.name) : null;
    if (current && ['type', 'factor', 'costMode', 'costValue', 'profitPct'].some(k => current[k] !== calcSource[k])) {
        calcSource = { ...current };
        applySourceToInputs();
        runLiveCalc();
    }
    renderSourceGrid();
    if (!pageHidden('countries')) renderCountriesTable();
}

// يدمج الصفوف المتغيرة والمحذوفة في البيانات الموجودة
function mergeIncremental(data) {
    Object.entries(COLLECTION_NORMALIZERS).forEach(([name, c]) => {
        const changed = (Array.isArray(data[name]) ? data[name] : []).map(c.norm).filter(c.ok);
        const removed = new Set((data.deleted || []).filter(d => d.c === name).map(d => String(d.id)));
        if (!changed.length && !removed.size) return;
        const byId = new Map(changed.map(x => [String(x.id), x]));
        const list = c.get().filter(x => !removed.has(String(x.id)) && !byId.has(String(x.id)));
        // الشعار لا يأتي مع التاجر، فنحتفظ بالمعروض حتى نتحقق من بصمته
        if (name === 'traders') changed.forEach(t => { t.logo = traders.find(x => x.id === t.id)?.logo || ''; });
        c.set(list.concat(changed.filter(x => !removed.has(String(x.id)))));
    });
}

async function loadFromSheets({ manual = false, silent = false } = {}) {
    if (!globalConfig.driveWebhook) {
        setLiveIndicator(false);
        setDataStatus('error', 'لا يوجد رابط Google Sheets. أضفه من الإعدادات لقراءة الزبائن والحوالات.');
        renderDataViews();
        return;
    }

    const seq = ++loadSeq;
    if (!silent) {
        setDataStatus('loading', 'جاري تحميل الزبائن والحوالات من Google Sheets...');
        renderDataViews();
    }
    sheetReading = true;
    updateLiveCard();

    // نرسل العمليات المعلقة أولاً حتى تكون القراءة محدّثة
    await flushOutbox();
    const quick = !manual && silent && syncCursor && dataState === 'ready' && Date.now() - lastFullLoadMs < FULL_RELOAD_MS;
    const result = await postToSheets(quick ? { action: 'list', since: syncCursor } : { action: 'list' });
    if (seq !== loadSeq) return; // وصل طلب تحميل أحدث
    sheetReading = false;

    const data = result.data;
    if (result.status !== 'ok' || !data || !Array.isArray(data.ledger)) {
        const reason = result.error === 'unauthorized' ? 'مفتاح الحماية غير صحيح، راجع الإعدادات.'
            : result.error === 'offline' ? 'لا يوجد اتصال بالإنترنت.'
            : 'تأكد من نشر السكربت الجديد (google-apps-script.gs) ومن صحة الرابط.';
        sheetReadFailed = true;
        setLiveIndicator(false);
        // التحديث الصامت لا يمسح البيانات المعروضة عند الفشل
        if (silent) {
            if (manual) showToast('تعذرت المزامنة', reason, 'error');
            return;
        }
        setDataStatus('error', 'تعذر قراءة البيانات من Google Sheets. ' + reason);
        renderDataViews();
        return;
    }

    const changedCount = data.incremental
        ? ['ledger', 'customers', 'expenses', 'traders', 'traderMoves'].reduce((n, k) => n + (data[k]?.length || 0), 0) + (data.deleted?.length || 0)
        : -1;
    const countriesBefore = JSON.stringify(countries);
    if (data.incremental) {
        mergeIncremental(data);
    } else {
        if (Array.isArray(data.countries)) applySheetCountries(data.countries);
        else sheetSupportsCountries = false;
        const previousLogos = new Map(traders.map(t => [t.id, t.logo]));
        ledger = data.ledger.map(normalizeTx).filter(t => t.id);
        customers = (Array.isArray(data.customers) ? data.customers : []).map(normalizeCustomer).filter(c => c.id && c.name);
        sheetSupportsExpenses = Array.isArray(data.expenses);
        expenses = (data.expenses || []).map(normalizeExpense).filter(e => e.id);
        sheetSupportsTraders = Array.isArray(data.traders);
        traders = (data.traders || []).map(normalizeTrader).filter(t => t.id && t.name);
        traders.forEach(t => { if (!t.logo && previousLogos.get(t.id)) t.logo = previousLogos.get(t.id); });
        traderMoves = (data.traderMoves || []).map(normalizeTmove).filter(m => m.id && m.traderId);
        lastFullLoadMs = Date.now();
    }
    // السكربت القديم لا يرسل serverTime، فيبقى التحميل كاملاً في كل مرة
    syncCursor = data.serverTime || null;
    syncTraderLogos(data.traders || []);
    afterCountriesChanged(countriesBefore);
    if (panelTraderId && !$('traderPanel').classList.contains('hidden')) renderTraderPanel();
    // التغييرات التي لم تصل للشيت بعد تبقى ظاهرة
    outbox.forEach(applyOpLocally);
    sortLedger();

    sheetReadFailed = false;
    lastUpdateAt = nowTimeLabel();
    setDataStatus('ready');
    setLiveIndicator(true);
    // التحديث السريع بدون تغييرات لا يعيد رسم الصفحة
    if (changedCount !== 0 || !silent) renderDataViews();
    if (manual) showToast('تم التحديث من الشيت', `${ledger.length} حوالة، ${customers.length} زبون، ${expenses.length} مصروف`, 'info');
}

// ---------- الكتابة: صندوق العمليات المعلقة (Outbox) ----------
// كل تعديل يُضاف هنا ويُرسل بالترتيب. يبقى محفوظاً في المتصفح فقط حتى يصل للشيت.
let flushing = null;
let lastFlushFailed = false;

function applyOpLocally(op) {
    if (op.action === 'upsert') {
        const tx = normalizeTx(op);
        const i = ledger.findIndex(x => x.id === tx.id);
        if (i >= 0) ledger[i] = tx; else ledger.unshift(tx);
    } else if (op.action === 'delete') {
        ledger = ledger.filter(x => x.id !== toNum(op.id, NaN));
    } else if (op.action === 'upsert_customer') {
        const c = normalizeCustomer(op.customer);
        const i = customers.findIndex(x => x.id === c.id);
        if (i >= 0) customers[i] = c; else customers.unshift(c);
    } else if (op.action === 'delete_customer') {
        customers = customers.filter(x => x.id !== op.id);
    } else if (op.action === 'upsert_expense') {
        const e = normalizeExpense(op.expense);
        const i = expenses.findIndex(x => x.id === e.id);
        if (i >= 0) expenses[i] = e; else expenses.unshift(e);
    } else if (op.action === 'upsert_trader') {
        const t = normalizeTrader(op.trader);
        const i = traders.findIndex(x => x.id === t.id);
        if (!('logo' in (op.trader || {})) && i >= 0) t.logo = traders[i].logo;
        if (i >= 0) traders[i] = t; else traders.unshift(t);
    } else if (op.action === 'delete_trader') {
        traders = traders.filter(x => x.id !== op.id);
    } else if (op.action === 'upsert_tmove') {
        const m = normalizeTmove(op.move);
        const i = traderMoves.findIndex(x => x.id === m.id);
        if (i >= 0) traderMoves[i] = m; else traderMoves.push(m);
    } else if (op.action === 'delete_tmove') {
        traderMoves = traderMoves.filter(x => x.id !== toNum(op.id, NaN));
    } else if (op.action === 'upsert_country') {
        const c = normalizeCountry(op.country);
        const i = countries.findIndex(x => x.id === c.id);
        if (i >= 0) countries[i] = c; else countries.push(c);
    } else if (op.action === 'delete_country') {
        countries = countries.filter(x => x.id !== op.id);
    } else if (op.action === 'delete_expense') {
        expenses = expenses.filter(x => x.id !== toNum(op.id, NaN));
    }
}

function queueOps(...ops) {
    outbox.push(...ops.map(op => JSON.parse(JSON.stringify(op))));
    saveAll();
}

function flushOutbox() {
    // إن كان إرسال سابق جارياً ننتظره ثم نرسل ما أُضيف بعده
    if (flushing) return flushing.then(() => flushOutbox());

    flushing = (async () => {
        let status = outbox.length ? 'ok' : 'idle';
        renderLedgerTable();
        updateLiveCard();
        while (outbox.length) {
            if (!globalConfig.driveWebhook) { status = 'disabled'; break; }
            const r = await postToSheets(outbox[0]);
            if (r.status === 'failed') { status = 'failed'; break; }
            if (r.status === 'unconfirmed') status = 'unconfirmed';
            outbox.shift();
            saveAll();
        }
        lastFlushFailed = status === 'failed' || status === 'disabled';
        if (status === 'ok' || status === 'unconfirmed') lastUpdateAt = nowTimeLabel();
        return status;
    })().finally(() => {
        flushing = null;
        saveAll();
        renderLedgerTable();
    });
    return flushing;
}

function txSyncState(id) {
    const pending = outbox.some(op => op.action === 'upsert' && toNum(op.id, NaN) === id);
    if (!pending) return null;
    return flushing || !lastFlushFailed ? 'pending' : 'failed';
}

function syncResultMessage(status) {
    if (status === 'ok' || status === 'idle') return 'تمت المزامنة مع Google Sheets';
    if (status === 'unconfirmed') return 'أُرسلت لـ Google Sheets دون تأكيد الاستلام';
    if (status === 'disabled') return 'لم تُرسل: لا يوجد رابط Google Sheets في الإعدادات';
    return 'لم تصل لـ Google Sheets بعد، ستُعاد المحاولة تلقائياً';
}

function syncToastType(status) {
    if (status === 'failed' || status === 'disabled') return 'error';
    return status === 'unconfirmed' ? 'info' : 'success';
}

function updateSyncPendingBar() {
    const show = outbox.length > 0 && lastFlushFailed && !flushing;
    $('sync-pending-bar').classList.toggle('hidden', !show);
    $('sync-pending-count').textContent = outbox.length;
    updateLiveCard();
}

// ---------- البطاقة الحيّة: سعر الشاشة + المزامنة في وقت واحد ----------
let sheetReading = false;
let sheetReadFailed = false;
let lastUpdateAt = '';
let liveCycleRunning = false;

// الحالة الإجمالية: أسوأ حالة بين المزامنة وسعر السوق
function liveCardState() {
    if (flushing || sheetReading || rateStatus === 'loading' || liveCycleRunning) return 'syncing';
    if (globalConfig.driveWebhook && outbox.length && lastFlushFailed) return 'pending';
    if (globalConfig.driveWebhook && sheetReadFailed) return 'error';
    if (rateStatus === 'error') return 'rate-error';
    if (!globalConfig.driveWebhook) return 'disabled';
    return lastUpdateAt ? 'ok' : 'syncing';
}

const LIVE_CARD = {
    ok: { icon: '✓', text: 'كل شيء محدّث', title: 'سعر الشاشة والبيانات محدّثة، وتتحدث تلقائياً كل دقيقتين' },
    syncing: { icon: '⟳', text: 'جاري التحديث', title: 'جاري تحديث سعر الشاشة والمزامنة مع Google Sheets' },
    pending: { icon: '!', text: 'لم تتم المزامنة', title: 'عمليات لم تصل للشيت بعد — اضغط لإعادة المحاولة' },
    error: { icon: '!', text: 'الشيت غير متصل', title: 'تعذرت القراءة من Google Sheets — اضغط لإعادة المحاولة' },
    'rate-error': { icon: '!', text: 'سعر السوق غير متصل', title: 'تعذر جلب سعر السوق، السعر المعروض هو آخر سعر معروف — اضغط لإعادة المحاولة' },
    disabled: { icon: '–', text: 'المزامنة متوقفة', title: 'أضف رابط Google Sheets من الإعدادات' }
};

function updateLiveCard() {
    const card = $('live-card');
    if (!card) return;
    const state = liveCardState();
    const info = LIVE_CARD[state];
    const prev = card.dataset.state;
    card.dataset.state = state;
    card.title = info.title + (globalConfig.rateMode === 'manual' ? ' (سعر الشاشة مثبّت يدوياً)' : '');
    $('live-dot').className = 'live-dot ' + ({ ok: '', syncing: 'busy', 'rate-error': 'manual', disabled: 'off' }[state] ?? 'off');
    $('live-icon').textContent = info.icon;
    $('live-text').textContent = state === 'pending' ? `${info.text} (${outbox.length})` : info.text;
    $('live-time').textContent = state === 'syncing' ? '' : (lastUpdateAt ? `آخر تحديث ${lastUpdateAt}` : '');
    // ومضة خفيفة عند انتهاء تحديث ناجح
    if (prev === 'syncing' && state === 'ok' && !REDUCED_MOTION) {
        card.classList.remove('just-updated');
        void card.offsetWidth;
        card.classList.add('just-updated');
    }
}

// دورة تحديث واحدة: سعر الشاشة + المزامنة مع الشيت معاً
// إذا بقي البرنامج مفتوحاً بعد منتصف الليل: تواريخ النماذج والتقارير تنتقل لليوم الجديد
let lastSeenDay = '';
function handleDayRollover() {
    const today = localDateStr();
    if (!lastSeenDay) { lastSeenDay = today; return; }
    if (today === lastSeenDay) return;
    ['calc_date', 'exp_date'].forEach(id => { if ($(id).value === lastSeenDay) $(id).value = today; });
    if ($('exp_month_filter').value === lastSeenDay.slice(0, 7)) $('exp_month_filter').value = today.slice(0, 7);
    lastSeenDay = today;
    updateReportsData();
    renderExpenses();
}

async function liveCycle({ manual = false } = {}) {
    handleDayRollover();
    if (liveCycleRunning || (!manual && document.hidden)) return;
    liveCycleRunning = true;
    updateLiveCard();
    try {
        // موقع سعر السوق يحدّث سعره مرة يومياً، فنطلبه كل 10 دقائق على الأكثر
        const rateDue = manual || Date.now() - lastRateFetchMs >= RATE_REFRESH_MS;
        const tasks = [];
        if (rateDue) tasks.push(fetchLiveDollarRate());
        if (globalConfig.driveWebhook && dataState !== 'loading') {
            tasks.push((async () => {
                if (outbox.length) await flushOutbox();
                await loadFromSheets({ silent: dataState === 'ready' });
            })());
        }
        await Promise.all(tasks);
        if (!rateDue && rateStatus !== 'error' && !sheetReadFailed) lastUpdateAt = nowTimeLabel();
    } finally {
        liveCycleRunning = false;
        updateLiveCard();
    }
    if (manual) {
        const state = liveCardState();
        showToast(LIVE_CARD[state].text, state === 'ok' ? `سعر الشاشة ${fmt(globalConfig.screenRate, 3)} ₪ · ${ledger.length} حوالة` : LIVE_CARD[state].title, state === 'ok' ? 'success' : 'warning');
    }
}

async function retryFailedSync() {
    const status = await flushOutbox();
    if (status === 'failed' || status === 'disabled') {
        showToast('ما زالت عمليات معلقة', `${outbox.length} عملية لم تصل، تحقق من الاتصال أو رابط السكربت`, 'warning');
    } else {
        showToast('تمت المزامنة', 'كل العمليات المعلقة وصلت إلى Google Sheets');
    }
}

// ================= حفظ حوالة جديدة =================
function newTxId() {
    // معرّف مبني على الوقت: لا يتكرر حتى لو مُسحت بيانات المتصفح وبقيت الصفوف في الشيت
    const maxId = ledger.reduce((m, t) => Math.max(m, t.id), 0);
    return Math.max(Date.now(), maxId + 1);
}

let lastSavedTxId = null;

async function saveNewTransaction() {
    const input = readCalcInputs();
    if (input.orig <= 0) return showToast('تنبيه', 'الرجاء إدخال المبلغ أولاً', 'warning');
    if (input.isOther && !input.country) {
        $('calc_other_name').focus();
        return showToast('تنبيه', 'اكتب نوع المعاملة في خانة "نوع المعاملة"', 'warning');
    }
    if (!input.country) return showToast('تنبيه', 'الرجاء اختيار الدولة أو المصدر', 'warning');
    if (input.screenRate <= 0) return showToast('تنبيه', 'سعر الشاشة غير صحيح', 'warning');

    const recipient = $('calc_recipient').value.trim();
    if (!recipient) return showToast('تنبيه', 'الرجاء كتابة اسم العميل', 'warning');

    const payout = $('calc_payout_type').value;
    const provider = payout === 'كاش' ? '' : $('calc_provider').value;
    const account = payout === 'كاش' ? '' : $('calc_account').value.trim();
    if (payout !== 'كاش' && !account) {
        $('calc_account').focus();
        return showToast('تنبيه', payout === 'بنكي' ? 'اكتب رقم الحساب البنكي' : 'اكتب رقم المحفظة', 'warning');
    }
    const date = $('calc_date').value || localDateStr();
    const status = $('calc_status').value;

    const btn = $('save-tx-btn');
    const label = btn.querySelector('.save-btn-label');
    btn.disabled = true;
    btn.classList.add('saving');
    label.textContent = 'جاري الحفظ...';
    let saved = false;

    try {
        // 1. ربط الحوالة بالزبون (المختار من القائمة أو بنفس الاسم)، أو إنشاء زبون جديد
        let customer = customers.find(c => c.id === $('calc_customer_id').value)
            || customers.find(c => normName(c.name) === normName(recipient));
        if (customer) {
            Object.assign(customer, { name: recipient, payout, provider, account: account || customer.account });
        } else {
            customer = { id: newCustomerId(), name: recipient, phone: '', payout, provider, account, createdAt: date };
            customers.unshift(customer);
        }
        const customerChanged = customer;

        // 2. الحساب من الأرقام مباشرة (وليس من النص المعروض) ثم التقريب لقرشين
        const r = computeTransfer(input);
        const tx = {
            id: newTxId(),
            date, customerId: customer.id, recipient, phone: '', account, payout, provider,
            currency: input.currency,
            country: input.country,
            type: input.type,
            orig: input.orig,
            factor: input.factor,
            costPct: input.costPct,
            costMode: input.costMode,
            costFixed: input.costFixed,
            profitPct: input.profitPct,
            minusIls: input.minusIls,
            screenRate: input.screenRate,
            clientIls: round2(r.clientIls),
            clientUsd: round2(r.clientUsd),
            costIls: round2(r.costIls),
            profitIls: round2(r.profitIls),
            status
        };

        ledger.unshift(tx);
        highlightTxId = tx.id;
        const ops = [];
        if (customerChanged) ops.push({ action: 'upsert_customer', customer: customerChanged });
        ops.push({ action: 'upsert', ...tx });
        queueOps(...ops);
        renderLedgerTable();
        renderCustomersTable();
        renderRecentTx();

        const syncStatus = await flushOutbox();
        saved = true;
        const amountText = tx.currency === 'USD' ? `$${fmt(tx.clientUsd)}` : `${fmt(tx.clientIls)} ₪`;
        showToast('تم حفظ الحوالة', `${recipient} — ${amountText} بسعر شاشة ${tx.screenRate}. ${syncResultMessage(syncStatus)}`, syncToastType(syncStatus));

        lastSavedTxId = tx.id;
        $('last-receipt-btn').classList.remove('hidden');
        // تفريغ النموذج للحوالة التالية (المصدر المختار يبقى كما هو)
        resetCalcForm();
        $('calc_recipient').focus();
    } finally {
        btn.classList.remove('saving');
        if (saved) {
            btn.classList.add('done');
            label.textContent = '✓ تم الحفظ';
            setTimeout(() => {
                btn.classList.remove('done');
                label.textContent = 'حفظ الحوالة';
                btn.disabled = dataState === 'loading';
            }, 1300);
        } else {
            label.textContent = 'حفظ الحوالة';
            btn.disabled = dataState === 'loading';
        }
    }
}

// ================= سجل الحوالات =================
function emptyMessage(total, noMatch, noData) {
    if (dataState === 'loading') return 'جاري التحميل من Google Sheets...';
    if (dataState === 'error' && !total) return 'تعذر قراءة البيانات من Google Sheets';
    return total ? noMatch : noData;
}

const SYNC_TITLES = {
    pending: 'جاري الإرسال إلى Google Sheets',
    failed: 'لم تصل إلى Google Sheets بعد'
};

function hiddenStatuses() {
    return Array.isArray(globalConfig.hiddenStatuses) ? globalConfig.hiddenStatuses : [];
}

// أزرار الحالات: كل حالة تشتغل أو تطفي، مع عدد الحوالات فيها
function renderStatusToggles() {
    const hidden = hiddenStatuses();
    const counts = {};
    ledger.forEach(t => { counts[t.status] = (counts[t.status] || 0) + 1; });
    $('tx_status_toggles').innerHTML = STATUSES.map(s => {
        const on = !hidden.includes(s);
        return `<button type="button" data-action="toggle-status" data-status="${s}" class="status-toggle${on ? ' on' : ''}" style="--c:${STATUS_TOGGLE_COLORS[s]}" aria-pressed="${on}">
            <span class="sw"></span>${s}<span class="cnt">${counts[s] || 0}</span>
        </button>`;
    }).join('');
}

const STATUS_TOGGLE_COLORS = { 'قيد الإنتظار': '#f59e0b', 'فحص': '#64748b', 'مكتمل': '#10b981', 'ملغي': '#f43f5e' };

function toggleStatusFilter(status) {
    const hidden = hiddenStatuses();
    globalConfig.hiddenStatuses = hidden.includes(status) ? hidden.filter(s => s !== status) : [...hidden, status];
    saveAll();
    resetLedgerAndRender();
}

// الجدول يعرض أول 200 حوالة من نتيجة البحث، وزر "عرض المزيد" يضيف 200
const LEDGER_PAGE = 200;
let ledgerLimit = LEDGER_PAGE;

// عند تغيير البحث أو الفلاتر نرجع لأول 200
function resetLedgerAndRender() {
    ledgerLimit = LEDGER_PAGE;
    renderLedgerTable();
}

function renderLedgerTable() {
    if (pageHidden('transactions')) return;
    renderStatusToggles();
    const search = ($('tx_search').value || '').trim().toLowerCase();
    const searchPhone = normPhone(search);
    const hidden = hiddenStatuses();
    const monthFilter = $('tx_month_filter').value || '';
    const dateFilter = $('tx_date_filter').value || '';

    const filtered = ledger.filter(t => {
        const matchSearch = !search ||
            t.recipient.toLowerCase().includes(search) ||
            (searchPhone && normPhone(t.account).includes(searchPhone));
        const matchStatus = !hidden.includes(t.status);
        const matchMonth = !monthFilter || t.date.startsWith(monthFilter);
        const matchDate = !dateFilter || t.date === dateFilter;
        return matchSearch && matchStatus && matchMonth && matchDate;
    });

    if (filtered.length === 0) {
        $('ledger-body').innerHTML = `<tr><td colspan="12" class="p-6 text-center text-xs text-slate-400">${emptyMessage(ledger.length, 'لا توجد نتائج مطابقة للفلترة', 'لا توجد حوالات في الشيت بعد')}</td></tr>`;
        return;
    }

    const shown = filtered.slice(0, ledgerLimit);
    const rest = filtered.length - shown.length;
    $('ledger-body').innerHTML = shown.map(t => {
        const cancelled = t.status === CANCELLED;
        const syncState = txSyncState(t.id);
        const syncDot = syncState ? `<span class="sync-dot ${syncState}" title="${SYNC_TITLES[syncState]}"></span>` : '';
        return `
            <tr class="hover:bg-slate-50">
                <td class="p-3.5 text-center text-[10px] text-slate-400 font-mono whitespace-nowrap">${syncDot} #${t.id}</td>
                <td class="p-3.5 whitespace-nowrap text-slate-500 text-xs num">${escapeHtml(t.date)}</td>
                <td class="p-3.5"><button data-action="open-customer" data-id="${escapeHtml(t.customerId)}" data-name="${escapeHtml(t.recipient)}" class="font-bold text-slate-900 hover:text-blue-700 hover:underline text-right whitespace-nowrap" title="ملف الزبون">${escapeHtml(t.recipient)}</button></td>
                <td class="p-3.5 font-mono text-xs text-slate-600 select-all">${escapeHtml(t.account || '-')}</td>
                <td class="p-3.5 whitespace-nowrap"><span class="badge ${payoutBadgeClass(t.payout)}">${escapeHtml(payoutLabel(t))}</span></td>
                <td class="p-3.5 whitespace-nowrap"><span class="badge bg-slate-100 text-slate-700">${escapeHtml(t.country)}</span></td>
                <td class="p-3.5 font-mono font-semibold num text-slate-800">${fmt(t.orig, 2)}</td>
                <td class="p-3.5 font-mono text-left font-black text-slate-900 num whitespace-nowrap">${deliveredHtml(t)}</td>
                <td class="p-3.5 font-mono text-left font-black ${cancelled ? 'text-slate-400 line-through' : 'text-emerald-600'} num whitespace-nowrap">+${fmt(t.profitIls)} ₪</td>
                <td class="p-3.5 text-center font-mono text-xs font-bold text-slate-500">${fmt(t.screenRate, 3)} ₪</td>
                <td class="p-3.5 text-center whitespace-nowrap">
                    <span class="inline-flex items-center gap-1.5">
                        <select data-action="change-status" data-id="${t.id}" class="text-xs rounded-lg px-2.5 py-1 border outline-none cursor-pointer ${statusSelectClass(t.status)}">
                            ${STATUSES.map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>
                        ${whatsappButton(customerOfTx(t), { compact: true })}
                    </span>
                </td>
                <td class="p-3.5 text-center whitespace-nowrap">
                    <button data-action="open-receipt" data-id="${t.id}" class="text-slate-700 hover:text-slate-900 font-bold text-xs px-2.5 py-1 bg-slate-100 rounded-lg">فاتورة</button>
                    <button data-action="edit-tx" data-id="${t.id}" class="text-blue-600 hover:text-blue-800 font-bold text-xs px-2.5 py-1 bg-blue-50 rounded-lg mr-1">تعديل</button>
                    <button data-action="delete-tx" data-id="${t.id}" class="text-slate-400 hover:text-red-600 p-1 font-bold" title="حذف من السجل ومن الإكسل">✕</button>
                </td>
            </tr>
        `;
    }).join('') + (rest > 0 ? `
        <tr><td colspan="12" class="p-3 text-center">
            <button data-action="ledger-more" class="text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 px-4 py-2 rounded-lg transition">عرض ${Math.min(rest, LEDGER_PAGE)} حوالة أخرى</button>
            <span class="text-[11px] text-slate-400 mr-2">معروض ${shown.length} من ${filtered.length}</span>
        </td></tr>` : '');
}

function clearTxFilters() {
    $('tx_search').value = '';
    $('tx_date_filter').value = '';
    $('tx_month_filter').value = '';
    resetLedgerAndRender();
}

async function changeOrderStatus(id, newStatus) {
    const tx = ledger.find(x => x.id === id);
    if (!tx || !STATUSES.includes(newStatus)) return;
    tx.status = newStatus;
    queueOps({ action: 'upsert', ...tx });
    renderLedgerTable();
    const syncStatus = await flushOutbox();
    showToast('تم تغيير الحالة', `حالة المعاملة #${id}: ${newStatus} — ${syncResultMessage(syncStatus)}`, syncStatus === 'ok' ? 'info' : syncToastType(syncStatus));
}

function deleteTxPrompt(id) {
    showAppConfirm('تأكيد حذف الحوالة', 'هل أنت متأكد من حذف هذه المعاملة؟ سيتم حذفها نهائياً من السجل ومن جدول Google Sheets.', async () => {
        ledger = ledger.filter(x => x.id !== id);
        queueOps({ action: 'delete', id });
        renderLedgerTable();
        renderCustomersTable();
        const syncStatus = await flushOutbox();
        showToast('تم الحذف', `المعاملة #${id} — ${syncResultMessage(syncStatus)}`, syncToastType(syncStatus));
    });
}

// ================= تعديل الحوالة =================
let editType = 'div';

function openEditTxModal(id) {
    const tx = ledger.find(x => x.id === id);
    if (!tx) return;

    $('editModalTitle').textContent = `تعديل بيانات الحوالة #${tx.id}`;
    $('edit_tx_id').value = tx.id;
    $('edit_tx_date').value = tx.date;
    $('edit_tx_recipient').value = tx.recipient;
    $('edit_tx_payout').value = tx.payout;
    fillProviderSelect($('edit_tx_provider'), tx.payout, tx.provider);
    $('edit_tx_currency').value = tx.currency;
    $('edit_tx_account').value = tx.account;
    $('edit_tx_status').value = tx.status;
    $('edit_tx_orig').value = tx.orig;
    $('edit_tx_factor').value = tx.factor;
    $('edit_tx_cost_mode').value = tx.costMode;
    $('edit_tx_cost_pct').value = tx.costMode === 'fixed' ? tx.costFixed : tx.costPct;
    $('edit_tx_profit_pct').value = tx.profitPct;
    $('edit_tx_minus').value = tx.minusIls;
    $('edit_tx_screen').value = tx.screenRate;

    // نعرض دولة الحوالة حتى لو حُذفت من جدول التسعير، مع نوع معادلتها الأصلي
    const list = [...countries];
    let idx = list.findIndex(c => c.name === tx.country && c.type === tx.type);
    if (idx === -1) {
        list.unshift({ name: tx.country, type: tx.type, factor: tx.factor });
        idx = 0;
    }
    const select = $('edit_tx_country');
    select.innerHTML = countryOptionsHtml(list);
    select.selectedIndex = idx;
    editType = tx.type;
    $('edit_op_symbol').textContent = TYPE_SYMBOL[editType];

    recalcEditModal();
    openModal('editTxModal');
}

function onEditCountrySelect() {
    const c = selectedCountry($('edit_tx_country'));
    if (!c) return;
    editType = c.type;
    $('edit_tx_factor').value = c.factor;
    $('edit_op_symbol').textContent = TYPE_SYMBOL[editType];
    // تكلفة وربح الدولة الجديدة
    const src = countries.find(x => x.name === c.name);
    if (src) {
        $('edit_tx_cost_mode').value = src.costMode;
        $('edit_tx_cost_pct').value = src.costValue;
        $('edit_tx_profit_pct').value = src.profitPct;
    }
    recalcEditModal();
}

function readEditInputs() {
    return {
        orig: toNum($('edit_tx_orig').value, 0),
        type: editType,
        factor: toNum($('edit_tx_factor').value, 0),
        costMode: $('edit_tx_cost_mode').value === 'fixed' ? 'fixed' : 'pct',
        costPct: $('edit_tx_cost_mode').value === 'fixed' ? 0 : toNum($('edit_tx_cost_pct').value, 0),
        costFixed: $('edit_tx_cost_mode').value === 'fixed' ? toNum($('edit_tx_cost_pct').value, 0) : 0,
        profitPct: toNum($('edit_tx_profit_pct').value, 0),
        minusIls: toNum($('edit_tx_minus').value, 0),
        screenRate: toNum($('edit_tx_screen').value, globalConfig.screenRate),
        currency: $('edit_tx_currency').value === 'USD' ? 'USD' : 'ILS'
    };
}

function recalcEditModal() {
    const input = readEditInputs();
    const r = computeTransfer(input);
    $('edit_preview_client_ils').textContent = input.currency === 'USD' ? `$ ${fmt(r.clientUsd)}` : fmt(r.clientIls) + ' ₪';
    $('edit_preview_profit_ils').textContent = '+' + fmt(r.profitIls) + ' ₪';
}

async function saveEditedTransaction(e) {
    e.preventDefault();
    const id = toNum($('edit_tx_id').value, NaN);
    const tx = ledger.find(x => x.id === id);
    if (!tx) return;

    const input = readEditInputs();
    if (input.orig <= 0) return showToast('تنبيه', 'المبلغ الأصلي يجب أن يكون أكبر من صفر', 'warning');
    if (input.screenRate <= 0) return showToast('تنبيه', 'سعر الشاشة غير صحيح', 'warning');

    const r = computeTransfer(input);
    Object.assign(tx, {
        date: $('edit_tx_date').value,
        recipient: $('edit_tx_recipient').value.trim(),
        payout: $('edit_tx_payout').value,
        provider: $('edit_tx_payout').value === 'كاش' ? '' : $('edit_tx_provider').value,
        account: $('edit_tx_account').value.trim(),
        status: $('edit_tx_status').value,
        country: selectedCountry($('edit_tx_country'))?.name || tx.country,
        ...input,
        clientIls: round2(r.clientIls),
        clientUsd: round2(r.clientUsd),
        costIls: round2(r.costIls),
        profitIls: round2(r.profitIls)
    });

    queueOps({ action: 'upsert', ...tx });
    closeModal('editTxModal');
    renderLedgerTable();
    const syncStatus = await flushOutbox();
    showToast('تم تحديث المعاملة', `المعاملة #${id} — ${syncResultMessage(syncStatus)}`, syncToastType(syncStatus));
}


// ================= الفاتورة (عرض + تحميل PDF و PNG) =================
// المكتبات تُحمَّل عند أول تحميل فقط حتى تبقى الصفحة خفيفة
// html-to-image يرسم بمحرك المتصفح نفسه، فلا ينزاح النص العربي عن مكانه (مشكلة html2canvas)
const RECEIPT_LIBS = {
    htmlToImage: 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js',
    jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
};
const loadedScripts = {};

function loadScript(url) {
    return loadedScripts[url] ??= new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = url;
        el.onload = resolve;
        el.onerror = () => {
            delete loadedScripts[url];
            el.remove();
            reject(new Error('script load failed: ' + url));
        };
        document.head.appendChild(el);
    });
}

// يحوّل عنصراً إلى canvas، والعناصر التي عليها data-export-ignore لا تظهر في الصورة
async function captureElement(el, pixelRatio) {
    await loadScript(RECEIPT_LIBS.htmlToImage);
    if (document.fonts?.ready) await document.fonts.ready;
    // الهامش الخارجي للعنصر (مثل space-y) يزيح المحتوى داخل الصورة فيُقص أسفلها، لذلك نلغيه ونثبّت المقاس
    const opts = {
        pixelRatio, backgroundColor: '#ffffff',
        width: el.offsetWidth, height: el.offsetHeight,
        style: { margin: '0', animation: 'none', transform: 'none' },
        filter: (n) => !n.dataset?.exportIgnore
    };
    // سفاري لا يرسم الخطوط والصور في المحاولة الأولى أحياناً، فنسخّنه بمحاولة مسبقة
    if (/^((?!chrome|android).)*safari/i.test(navigator.userAgent)) await window.htmlToImage.toCanvas(el, opts);
    return window.htmlToImage.toCanvas(el, opts);
}

// format: png | pdf — صفحة الـ PDF بنفس مقاس العنصر على الشاشة
async function exportElement(el, format, filename, pixelRatio = 3) {
    const canvas = await captureElement(el, pixelRatio);
    const safeName = filename.replace(/[\\/:*?"<>|]/g, '');
    if (format === 'pdf') {
        await loadScript(RECEIPT_LIBS.jspdf);
        const w = canvas.width / pixelRatio * 0.75, h = canvas.height / pixelRatio * 0.75;
        const pdf = new window.jspdf.jsPDF({ orientation: w > h ? 'l' : 'p', unit: 'pt', format: [w, h], compress: true });
        pdf.addImage(canvas, 'PNG', 0, 0, w, h);
        downloadBlob(pdf.output('blob'), 'application/pdf', safeName + '.pdf');
    } else {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        downloadBlob(blob, 'image/png', safeName + '.png');
    }
}

const RECEIPT_STATUS_STYLE = {
    'مكتمل': 'background:#d1fae5;color:#047857',
    'قيد الإنتظار': 'background:#fef3c7;color:#b45309',
    'فحص': 'background:#e2e8f0;color:#334155',
    'ملغي': 'background:#ffe4e6;color:#be123c'
};

let receiptTxId = null;

function renderReceipt(t) {
    const amount = t.currency === 'USD' ? `$ ${fmt(t.clientUsd)}` : `${fmt(t.clientIls)} ₪`;
    const rows = [
        ['اسم المستلم', escapeHtml(t.recipient)],
        ['طريقة الاستلام', escapeHtml(payoutLabel(t))]
    ];
    if (t.payout !== 'كاش' && t.account) rows.push([t.payout === 'بنكي' ? 'رقم الحساب' : 'رقم المحفظة', `<bdi class="ltr-num">${escapeHtml(t.account)}</bdi>`]);
    rows.push(['مصدر الحوالة', escapeHtml(t.country)]);
    rows.push(['المبلغ المرسل', `<bdi class="ltr-num">${fmt(t.orig)}</bdi>`]);
    if (t.currency !== 'USD') rows.push(['سعر الدولار', `<bdi class="ltr-num">${fmt(t.screenRate, 3)}</bdi> ₪`]);
    rows.push(['عملة التسليم', t.currency === 'USD' ? 'دولار أمريكي' : 'شيكل']);
    rows.push(['الحالة', `<span class="rc-status" style="${RECEIPT_STATUS_STYLE[t.status] || ''}">${escapeHtml(t.status)}</span>`]);

    const now = new Date();
    const issued = `${localDateStr(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    $('receipt-paper').innerHTML = `
        <div class="rc-head">
            <div class="rc-logo">${logoHtml()}</div>
            <div class="min-w-0">
                <div class="rc-company">${escapeHtml(globalConfig.companyName || 'فاست باي')}</div>
                ${globalConfig.companySubtitle ? `<div class="rc-sub">${escapeHtml(globalConfig.companySubtitle)}</div>` : ''}
            </div>
        </div>
        <div class="rc-title-row">
            <div>
                <div class="rc-title">إيصال تسليم حوالة</div>
                <div>رقم الإيصال: <bdi class="ltr-num">#${t.id}</bdi></div>
            </div>
            <div style="text-align:left">
                <div>تاريخ الحوالة</div>
                <div style="font-weight:800;color:#0f172a"><bdi class="ltr-num">${escapeHtml(t.date)}</bdi></div>
            </div>
        </div>
        <div class="rc-amount">
            <div class="rc-amount-label">المبلغ المسلّم للزبون</div>
            <div class="rc-amount-value">${amount}</div>
        </div>
        <div class="rc-rows">
            ${rows.map(([label, value]) => `<div class="rc-row"><span>${label}</span><span>${value}</span></div>`).join('')}
        </div>
        <div class="rc-foot">
            <div>
                <div>${escapeHtml(globalConfig.receiptFooter || '')}</div>
                <div style="margin-top:0.25rem">أُصدرت: <bdi class="ltr-num">${escapeHtml(issued)}</bdi></div>
            </div>
            <div class="rc-sign">توقيع المستلم</div>
        </div>
    `;
}

function openReceipt(id) {
    const t = ledger.find(x => x.id === id);
    if (!t) return showToast('الحوالة غير موجودة', '', 'warning');
    receiptTxId = id;
    renderReceipt(t);
    openModal('receiptModal');
}

async function exportReceipt(format) {
    const t = ledger.find(x => x.id === receiptTxId);
    if (!t) return;
    const buttons = document.querySelectorAll('[data-action^="receipt-"]');
    buttons.forEach(b => { b.disabled = true; });
    try {
        await exportElement($('receipt-paper'), format, `فاتورة_${t.recipient}_${t.id}`);
        showToast('تم تحميل الفاتورة', format === 'pdf' ? 'ملف PDF' : 'صورة PNG', 'info');
    } catch (err) {
        console.error('Receipt export failed:', err);
        showToast('تعذر إنشاء الفاتورة', 'تأكد من الاتصال بالإنترنت ثم حاول مجدداً', 'error');
    } finally {
        buttons.forEach(b => { b.disabled = false; });
    }
}

// ================= إدارة الزبائن =================
// ---------- إحصائيات الزبائن (تُحسب مرة واحدة لكل الحوالات) ----------
// الحوالة تتبع الزبون برقمه الداخلي، والحوالات بدون رقم تتبعه بالاسم
const txCustomerKey = (t) => (t.customerId ? 'c:' + t.customerId : 'n:' + normName(t.recipient));

function emptyCustomerStats() {
    return { all: [], count: 0, activeCount: 0, cancelled: 0, receivedIls: 0, receivedUsd: 0, profit: 0, first: '', last: '', sources: {}, months: {} };
}

function buildCustomerStatsIndex() {
    const index = new Map();
    ledger.forEach(t => {
        const key = txCustomerKey(t);
        if (!index.has(key)) index.set(key, emptyCustomerStats());
        const s = index.get(key);
        s.all.push(t);
        s.count++;
        if (t.date && (!s.first || t.date < s.first)) s.first = t.date;
        if (t.date && (!s.last || t.date > s.last)) s.last = t.date;
        if (t.status === CANCELLED) { s.cancelled++; return; }
        s.activeCount++;
        if (t.currency === 'USD') s.receivedUsd += t.clientUsd; else s.receivedIls += t.clientIls;
        s.profit += t.profitIls;
        s.sources[t.country] = (s.sources[t.country] || 0) + 1;
        const m = monthKeyOf(t.date);
        if (m) s.months[m] = (s.months[m] || 0) + t.profitIls;
    });
    return index;
}

// حوالات الزبون: برقم جواله، أو باسمه إذا كانت الحوالة بدون جوال
function customerStats(c, index = buildCustomerStatsIndex()) {
    const byId = (c.id && index.get('c:' + c.id)) || emptyCustomerStats();
    const byName = index.get('n:' + normName(c.name));
    if (!byName) return byId;
    const merged = emptyCustomerStats();
    [byId, byName].forEach(s => {
        merged.all.push(...s.all);
        ['count', 'activeCount', 'cancelled', 'receivedIls', 'receivedUsd', 'profit'].forEach(k => { merged[k] += s[k]; });
        if (s.first && (!merged.first || s.first < merged.first)) merged.first = s.first;
        if (s.last && (!merged.last || s.last > merged.last)) merged.last = s.last;
        Object.entries(s.sources).forEach(([k, v]) => { merged.sources[k] = (merged.sources[k] || 0) + v; });
        Object.entries(s.months).forEach(([k, v]) => { merged.months[k] = (merged.months[k] || 0) + v; });
    });
    return merged;
}

function daysSince(dateStr) {
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    const then = new Date(y, m - 1, d);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((today - then) / 86400000);
}

// العدد مع التمييز الصحيح: شهر، شهرين، 3 أشهر، 11 شهراً
function arabicCount(n, one, two, few, many) {
    if (n === 1) return one;
    if (n === 2) return two;
    if (n >= 3 && n <= 10) return `${n} ${few}`;
    return `${n} ${many}`;
}

function relativeDays(dateStr) {
    const n = daysSince(dateStr);
    if (n === null) return '';
    if (n <= 0) return 'اليوم';
    if (n === 1) return 'أمس';
    if (n < 30) return 'منذ ' + arabicCount(n, 'يوم', 'يومين', 'أيام', 'يوماً');
    if (n < 365) return 'منذ ' + arabicCount(Math.max(1, Math.round(n / 30)), 'شهر', 'شهرين', 'أشهر', 'شهراً');
    const years = Math.round(n / 365);
    return 'منذ ' + arabicCount(Math.max(1, years), 'سنة', 'سنتين', 'سنوات', 'سنة');
}

function receivedHtml(s) {
    if (!s.receivedIls && !s.receivedUsd) return '<span class="text-slate-400">—</span>';
    const parts = [];
    if (s.receivedIls || !s.receivedUsd) parts.push(`${fmt(s.receivedIls, 0)} ₪`);
    if (s.receivedUsd) parts.push(`<bdi class="ltr-num">$${fmt(s.receivedUsd, 0)}</bdi>`);
    return parts.join(' + ');
}

function renderCustomersTable() {
    if (pageHidden('customers')) return;
    const search = ($('cust_search').value || '').trim().toLowerCase();
    const searchDigits = normPhone(search);
    const sort = $('cust_sort').value || 'recent';
    const index = buildCustomerStatsIndex();

    const rows = customers
        .filter(c => !search || c.name.toLowerCase().includes(search) || (searchDigits && (whatsappDigits(c.phone).includes(searchDigits) || normPhone(c.account).includes(searchDigits))))
        .map(c => ({ c, s: customerStats(c, index) }));

    const sorters = {
        recent: (a, b) => (b.s.last || b.c.createdAt || '').localeCompare(a.s.last || a.c.createdAt || ''),
        count: (a, b) => b.s.count - a.s.count,
        profit: (a, b) => b.s.profit - a.s.profit,
        received: (a, b) => (b.s.receivedIls + b.s.receivedUsd * globalConfig.screenRate) - (a.s.receivedIls + a.s.receivedUsd * globalConfig.screenRate),
        name: (a, b) => a.c.name.localeCompare(b.c.name, 'ar')
    };
    rows.sort(sorters[sort] || sorters.recent);

    if (rows.length === 0) {
        $('customers-body').innerHTML = `<tr><td colspan="8" class="p-6 text-center text-xs text-slate-400">${emptyMessage(customers.length, 'لا توجد نتائج مطابقة', 'لا يوجد زبائن في الشيت بعد')}</td></tr>`;
        return;
    }

    $('customers-body').innerHTML = rows.map(({ c, s }) => `
        <tr class="hover:bg-slate-50 cursor-pointer" data-action="open-customer" data-id="${escapeHtml(c.id)}" title="فتح ملف الزبون">
            <td class="p-3.5">
                <span class="flex items-center gap-2.5">
                    <span class="cust-avatar">${escapeHtml(c.name.trim().charAt(0) || '؟')}</span>
                    <span class="font-bold text-slate-900 whitespace-nowrap">${escapeHtml(c.name)}</span>
                </span>
            </td>
            <td class="p-3.5 whitespace-nowrap">${whatsappButton(c)}</td>
            <td class="p-3.5"><span class="badge ${payoutBadgeClass(c.payout)}">${escapeHtml(payoutLabel(c))}</span></td>
            <td class="p-3.5 text-center"><span class="cust-count-pill">${s.count} حوالة</span></td>
            <td class="p-3.5 font-bold text-slate-800 num whitespace-nowrap">${receivedHtml(s)}</td>
            <td class="p-3.5 font-black text-emerald-700 num whitespace-nowrap">${s.profit ? '+' + fmt(s.profit, 0) + ' ₪' : '<span class="text-slate-400 font-medium">—</span>'}</td>
            <td class="p-3.5 text-xs text-slate-500 whitespace-nowrap">${s.last ? `${escapeHtml(s.last)}<span class="block text-[10px] text-slate-400">${relativeDays(s.last)}</span>` : 'لم يتعامل بعد'}</td>
            <td class="p-3.5 text-center whitespace-nowrap">
                <button data-action="edit-customer" data-id="${escapeHtml(c.id)}" class="text-blue-600 hover:text-blue-800 font-bold text-xs px-2.5 py-1 bg-blue-50 rounded-lg mr-1">تعديل</button>
                <button data-action="delete-customer" data-id="${escapeHtml(c.id)}" class="text-slate-400 hover:text-red-600 p-1 font-bold">✕</button>
            </td>
        </tr>
    `).join('');
}

// ---------- واتساب ----------
function customerOfTx(t) {
    return customers.find(c => t.customerId && c.id === t.customerId)
        || customers.find(c => normName(c.name) === normName(t.recipient));
}

// زر فتح المحادثة: أخضر إذا كان للزبون رقم واتساب، ورمادي يفتح تعديل الزبون لإضافة الرقم
function whatsappButton(c, { compact = false } = {}) {
    if (!c) return '';
    if (hasWhatsapp(c)) {
        return `<button data-action="open-whatsapp" data-id="${escapeHtml(c.id)}" class="wa-btn" title="فتح محادثة واتساب مع ${escapeHtml(c.name)}">
            ${WA_ICON}${compact ? '' : `<bdi class="ltr-num">+${escapeHtml(whatsappDigits(c.phone))}</bdi>`}</button>`;
    }
    return `<button data-action="edit-customer" data-id="${escapeHtml(c.id)}" class="wa-btn wa-missing" title="أضف رقم الواتساب لـ ${escapeHtml(c.name)}">
        ${WA_ICON}${compact ? '' : 'أضف الرقم'}</button>`;
}

const WA_ICON = '<svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.75-.86-2.02-.96-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.25-.46-2.38-1.47-.88-.79-1.47-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.08c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.7.63.71.22 1.36.19 1.87.12.57-.09 1.75-.72 2-1.41.25-.69.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35M12.05 21.79h-.01a9.87 9.87 0 01-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 01-1.51-5.26c0-5.45 4.44-9.88 9.89-9.88 2.64 0 5.12 1.03 6.99 2.9a9.82 9.82 0 012.89 6.99c0 5.45-4.44 9.88-9.89 9.88m8.41-18.29A11.82 11.82 0 0012.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.94L.06 24l6.31-1.65a11.88 11.88 0 005.68 1.45h.01c6.55 0 11.89-5.34 11.89-11.89 0-3.18-1.24-6.16-3.49-8.41"/></svg>';

function openWhatsapp(id) {
    const c = customers.find(x => x.id === id);
    if (!c) return;
    if (!hasWhatsapp(c)) {
        showToast('لا يوجد رقم واتساب', 'أضف الرقم مع المقدمة من إدارة الزبائن', 'warning');
        return openCustomerModal(c);
    }
    window.open(`https://wa.me/${whatsappDigits(c.phone)}`, '_blank', 'noopener');
}

// ---------- ملف الزبون ----------
let profileCustomer = null;

// يقبل زبوناً غير مسجل (من حوالة قديمة) فيبني له ملفاً من بيانات الحوالة
function openCustomerProfile(id, fallbackName = '') {
    let c = customers.find(x => id && x.id === id) || customers.find(x => fallbackName && normName(x.name) === normName(fallbackName));
    if (!c) {
        const tx = ledger.find(t => normName(t.recipient) === normName(fallbackName));
        if (!tx) return;
        c = normalizeCustomer({ id: '', name: tx.recipient, payout: tx.payout, provider: tx.provider, account: tx.account });
    }
    profileCustomer = c;
    renderCustomerProfile(c);
    openModal('customerModal');
    $('customer-profile').scrollTop = 0;
}

function renderCustomerProfile(c) {
    const s = customerStats(c);
    const txs = [...s.all].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    const topSource = Object.entries(s.sources).sort((a, b) => b[1] - a[1])[0];
    const avgProfit = s.activeCount ? s.profit / s.activeCount : 0;
    const sinceFirst = s.first ? relativeDays(s.first).replace('منذ ', '') : '';
    const registered = customers.some(x => x.id && x.id === c.id);

    // ربحنا منه شهرياً: آخر 12 شهراً
    const current = currentMonthKey();
    const months = [];
    for (let i = 11; i >= 0; i--) {
        const k = shiftMonth(current, -i);
        months.push({ k, v: s.months[k] || 0 });
    }
    const maxMonth = Math.max(...months.map(m => m.v), 1);
    const activeMonths = months.filter(m => m.v > 0).length;

    const statusDot = { 'مكتمل': '#10b981', 'قيد الإنتظار': '#f59e0b', 'فحص': '#94a3b8', 'ملغي': '#e11d48' };
    const shown = txs.slice(0, 50);

    $('customer-profile').innerHTML = `
        <div class="cp-head">
            <button data-action="close-modal" data-modal="customerModal" class="cp-close" aria-label="إغلاق">✕</button>
            <div class="flex items-center gap-3.5">
                <div class="cp-avatar">${escapeHtml(c.name.trim().charAt(0) || '؟')}</div>
                <div class="min-w-0">
                    <h3 class="text-lg font-black text-white truncate">${escapeHtml(c.name)}</h3>
                    <div class="text-xs text-slate-300 mt-0.5 flex flex-wrap gap-x-2">
                        <span>${escapeHtml(payoutLabel(c))}</span>
                        ${c.account ? `<span>·</span><bdi class="ltr-num font-mono">${escapeHtml(c.account)}</bdi>` : ''}
                    </div>
                </div>
            </div>
            ${registered ? `<div class="mt-3">${whatsappButton(c)}</div>` : ''}
            <div class="flex flex-wrap gap-1.5 mt-4 text-[11px] font-bold">
                ${s.first ? `<span class="cp-chip">🗓️ زبون منذ ${escapeHtml(s.first)}${sinceFirst ? ` (${sinceFirst})` : ''}</span>` : '<span class="cp-chip">لم يتعامل بعد</span>'}
                ${s.last ? `<span class="cp-chip">⏱️ آخر تعامل ${relativeDays(s.last)}</span>` : ''}
                ${!registered ? '<span class="cp-chip">غير مسجل في الزبائن</span>' : ''}
            </div>
        </div>

        <div class="p-4 sm:p-5 space-y-5">
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div class="cp-tile" style="--d:0ms">
                    <span class="cp-tile-label">عدد الحوالات</span>
                    <span class="cp-tile-value num" data-count="${s.count}">0</span>
                    <span class="cp-tile-sub">${s.activeCount} فعّالة${s.cancelled ? ` · ${s.cancelled} ملغاة` : ''}</span>
                </div>
                <div class="cp-tile" style="--d:60ms">
                    <span class="cp-tile-label">إجمالي ما استلمه</span>
                    <span class="cp-tile-value num"><span data-money="${s.receivedIls}">0</span> <small>₪</small></span>
                    <span class="cp-tile-sub">${s.receivedUsd ? `+ <bdi class="ltr-num">$${fmt(s.receivedUsd, 0)}</bdi> بالدولار` : 'بدون الملغاة'}</span>
                </div>
                <div class="cp-tile cp-tile-hero" style="--d:120ms">
                    <span class="cp-tile-label">صافي ربحنا منه</span>
                    <span class="cp-tile-value num"><span data-money="${s.profit}">0</span> <small>₪</small></span>
                    <span class="cp-tile-sub">متوسط ${fmt(avgProfit, 1)} ₪ للحوالة</span>
                </div>
                <div class="cp-tile" style="--d:180ms">
                    <span class="cp-tile-label">أكثر مصدر</span>
                    <span class="cp-tile-value cp-tile-text">${topSource ? escapeHtml(topSource[0]) : '—'}</span>
                    <span class="cp-tile-sub">${topSource ? `${topSource[1]} حوالة` : ''}</span>
                </div>
            </div>

            <div class="bg-slate-50 border border-slate-200/80 rounded-xl p-4">
                <div class="flex justify-between items-baseline mb-3">
                    <h4 class="text-xs font-bold text-slate-800">ربحنا منه شهرياً</h4>
                    <span class="text-[11px] text-slate-500">آخر 12 شهراً · تعامل في ${activeMonths ? arabicCount(activeMonths, 'شهر واحد', 'شهرين', 'أشهر', 'شهراً') : 'لا شيء'}</span>
                </div>
                <div class="cp-bars" aria-label="ربحنا من الزبون لكل شهر">
                    ${months.map((m, i) => `
                        <div class="cp-bar-col" title="${monthLabel(m.k)}: ${fmt(m.v, 1)} ₪">
                            <div class="cp-bar${m.k === current ? ' current' : ''}" style="--h:${(m.v / maxMonth) * 100}%;--d:${i * 40}ms"></div>
                            <span class="cp-bar-label">${i % 3 === 2 || i === 11 ? MONTH_NAMES[Number(m.k.slice(5)) - 1] : ''}</span>
                        </div>
                    `).join('')}
                </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button data-action="cust-new-tx" class="cp-action bg-slate-900 text-white">+ حوالة جديدة له</button>
                <button data-action="cust-show-ledger" class="cp-action bg-slate-100 text-slate-800">عرض في سجل الحوالات</button>
                ${registered ? `<button data-action="edit-customer" data-id="${escapeHtml(c.id)}" class="cp-action bg-slate-100 text-slate-800">تعديل البيانات</button>` : ''}
            </div>

            <div>
                <h4 class="text-xs font-bold text-slate-800 mb-2">كل الحركات من أول تعامل <span class="text-slate-400 font-medium">(${s.count})</span></h4>
                ${txs.length === 0 ? '<div class="text-xs text-slate-400 py-6 text-center bg-slate-50 rounded-xl">لا توجد حوالات لهذا الزبون بعد</div>' : `
                <ul class="cp-timeline">
                    ${shown.map((t, i) => `
                        <li class="cp-tx${t.status === CANCELLED ? ' cancelled' : ''}" style="--d:${Math.min(i, 12) * 45}ms">
                            <span class="cp-tx-dot" style="background:${statusDot[t.status] || '#94a3b8'}"></span>
                            <div class="min-w-0 flex-1">
                                <div class="flex justify-between items-baseline gap-2">
                                    <b class="num text-slate-900 cp-tx-amount">${deliveredHtml(t)}</b>
                                    <span class="num text-xs font-bold ${t.status === CANCELLED ? 'text-slate-400 line-through' : 'text-emerald-600'}">+${fmt(t.profitIls)} ₪</span>
                                </div>
                                <div class="text-[11px] text-slate-500 mt-0.5 truncate">
                                    <bdi class="ltr-num">${escapeHtml(t.date)}</bdi> · ${escapeHtml(t.country)} · ${escapeHtml(payoutLabel(t))} · <span class="font-bold">${escapeHtml(t.status)}</span>
                                </div>
                            </div>
                            <button data-action="open-receipt" data-id="${t.id}" class="cp-tx-receipt">فاتورة</button>
                        </li>
                    `).join('')}
                </ul>
                ${txs.length > shown.length ? `<button data-action="cust-show-ledger" class="w-full mt-2 text-xs font-bold text-blue-600 py-2 hover:underline">عرض كل الحركات (${txs.length}) في السجل ←</button>` : ''}`}
            </div>
        </div>
    `;

    // الأرقام تعدّ من الصفر، والأعمدة تنمو
    const root = $('customer-profile');
    root.querySelectorAll('[data-count]').forEach(el => { el.dataset.value = 0; animateNumber(el, toNum(el.dataset.count), (v) => fmt(v, 0), 700); });
    root.querySelectorAll('[data-money]').forEach(el => { el.dataset.value = 0; animateNumber(el, toNum(el.dataset.money), (v) => fmt(v, 0), 900); });
    root.classList.remove('cp-in');
    // setTimeout بدل requestAnimationFrame حتى تنمو الأعمدة حتى لو كانت النافذة في الخلفية
    setTimeout(() => root.classList.add('cp-in'), 40);
}

function customerNewTransaction() {
    const c = profileCustomer;
    if (!c) return;
    closeModal('customerModal');
    switchTab('calculator');
    resetCalcForm();
    fillCustomerIntoCalc(c);
    // نختار المصدر الذي يتعامل منه الزبون عادةً
    const top = Object.entries(customerStats(c).sources).sort((a, b) => b[1] - a[1])[0];
    if (top && countries.some(x => x.name === top[0])) selectSource(top[0]);
    else $('calc_orig_amount').focus();
}

function customerShowLedger() {
    const c = profileCustomer;
    if (!c) return;
    closeModal('customerModal');
    clearTxFilters();
    $('tx_search').value = c.name;
    switchTab('transactions');
}

function fillProviderSelect(select, payout, current) {
    const options = providerOptions(payout);
    select.innerHTML = options.length
        ? options.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')
        : '<option value="">—</option>';
    select.disabled = options.length === 0;
    select.value = options.includes(current) ? current : (options[0] || '');
}

function openCustomerModal(c = null) {
    $('custModalTitle').textContent = c ? 'تعديل بيانات الزبون: ' + c.name : 'إضافة زبون جديد';
    $('cust_edit_id').value = c ? c.id : '';
    $('m_cust_name').value = c ? c.name : '';
    $('m_cust_phone').value = c ? c.phone : '';
    $('m_cust_payout').value = c ? c.payout : 'محفظة';
    fillProviderSelect($('m_cust_provider'), $('m_cust_payout').value, c?.provider);
    $('m_cust_account').value = c ? c.account : '';
    openModal('custModal');
    (c && !c.phone ? $('m_cust_phone') : $('m_cust_name')).focus();
}

async function saveCustomerManual(e) {
    e.preventDefault();
    const editId = $('cust_edit_id').value;
    const data = normalizeCustomer({
        id: editId || newCustomerId(),
        phone: $('m_cust_phone').value,
        name: $('m_cust_name').value,
        payout: $('m_cust_payout').value,
        provider: $('m_cust_provider').value,
        account: $('m_cust_account').value
    });
    if (!data.name) return showToast('تنبيه', 'اسم الزبون مطلوب', 'warning');
    if (data.phone && !hasWhatsapp(data)) {
        return showToast('رقم الواتساب غير مكتمل', 'اكتبه مع المقدمة، مثل 970599123456', 'warning');
    }
    const sameName = customers.find(x => normName(x.name) === normName(data.name) && x.id !== editId);
    if (sameName) return showToast('تنبيه', `يوجد زبون بنفس الاسم "${sameName.name}". أضف ما يميّزه (مثل اسم العائلة).`, 'warning');
    const samePhone = data.phone && customers.find(x => whatsappDigits(x.phone) === whatsappDigits(data.phone) && x.id !== editId);
    if (samePhone) return showToast('تنبيه', `رقم الواتساب مسجل مسبقاً للزبون ${samePhone.name}`, 'warning');

    const existing = editId && customers.find(x => x.id === editId);
    if (existing) {
        Object.assign(existing, { name: data.name, phone: data.phone, payout: data.payout, provider: data.provider, account: data.account });
        queueOps({ action: 'upsert_customer', customer: existing });
    } else {
        const created = { ...data, createdAt: localDateStr() };
        customers.unshift(created);
        queueOps({ action: 'upsert_customer', customer: created });
    }

    closeModal('custModal');
    renderCustomersTable();
    renderLedgerTable();
    if (!$('customerModal').classList.contains('hidden') && profileCustomer) openCustomerProfile(profileCustomer.id || editId, data.name);
    const syncStatus = await flushOutbox();
    showToast('تم حفظ الزبون', `${data.name} — ${syncResultMessage(syncStatus)}`, syncToastType(syncStatus));
}

function deleteCustomerPrompt(id) {
    showAppConfirm('تأكيد حذف الزبون', 'هل أنت متأكد من حذف هذا الزبون من الشيت؟ حوالاته السابقة تبقى في السجل.', async () => {
        customers = customers.filter(x => x.id !== id);
        queueOps({ action: 'delete_customer', id });
        renderCustomersTable();
        const syncStatus = await flushOutbox();
        showToast('تم حذف الزبون', syncResultMessage(syncStatus), syncToastType(syncStatus));
    });
}

// ================= إدارة الدول =================
function renderCountriesTable() {
    $('countries-table-body').innerHTML = countries.length === 0
        ? '<tr><td colspan="6" class="p-6 text-center text-xs text-slate-400">لا توجد دول، أضف دولة للبدء</td></tr>'
        : countries.map((c, i) => `
            <tr class="hover:bg-slate-50">
                <td class="p-3.5 font-bold text-slate-900">${escapeHtml(c.name)}</td>
                <td class="p-3.5 text-slate-500">${TYPE_LABEL[c.type]}</td>
                <td class="p-3.5 font-mono font-bold text-slate-900 num">${escapeHtml(c.factor)}</td>
                <td class="p-3.5 text-slate-700 font-bold whitespace-nowrap">${escapeHtml(costLabel(c.costMode, c.costValue))}</td>
                <td class="p-3.5 text-emerald-700 font-bold num">${escapeHtml(c.profitPct)}%</td>
                <td class="p-3.5 text-center whitespace-nowrap">
                    <button data-action="edit-country" data-index="${i}" class="text-blue-600 hover:text-blue-800 font-bold text-xs px-2.5 py-1 bg-blue-50 rounded-lg ml-1">تعديل</button>
                    <button data-action="delete-country" data-index="${i}" class="text-slate-400 hover:text-red-600 font-bold text-xs p-1">حذف</button>
                </td>
            </tr>
        `).join('');
}

function openCountryModal(idx = -1) {
    const c = countries[idx];
    $('c_index').value = c ? idx : -1;
    $('countryModalTitle').textContent = c ? `تعديل ${c.name}` : 'إضافة دولة / مصدر جديد';
    $('countrySaveBtn').textContent = c ? 'حفظ التعديل' : 'حفظ';
    $('c_name').value = c ? c.name : '';
    $('c_factor').value = c ? c.factor : '';
    $('c_type').value = c ? c.type : 'div';
    $('c_cost_mode').value = c ? c.costMode : 'pct';
    $('c_cost_value').value = c ? c.costValue : globalConfig.costPct;
    $('c_profit_pct').value = c ? c.profitPct : globalConfig.profitPct;
    openModal('countryModal');
    (c ? $('c_factor') : $('c_name')).focus();
}

async function saveCountry(e) {
    e.preventDefault();
    const idx = toNum($('c_index').value, -1);
    const editing = countries[idx];
    const country = normalizeCountry({
        id: editing?.id,
        order: editing ? editing.order : countries.reduce((m, c) => Math.max(m, c.order), -1) + 1,
        name: $('c_name').value, type: $('c_type').value, factor: $('c_factor').value,
        costMode: $('c_cost_mode').value, costValue: $('c_cost_value').value, profitPct: $('c_profit_pct').value
    });
    if (country.costMode === 'pct' && country.costValue + country.profitPct >= 100) {
        return showToast('تنبيه', 'مجموع التكلفة والربح يجب أن يكون أقل من 100%', 'warning');
    }
    if (!country.name) return showToast('تنبيه', 'اكتب اسم الدولة أو المصدر', 'warning');
    if (!(country.factor > 0)) return showToast('تنبيه', 'المعامل يجب أن يكون أكبر من صفر', 'warning');
    if (countries.some((c, i) => c.name === country.name && i !== idx)) return showToast('تنبيه', 'هذا الاسم موجود مسبقاً', 'warning');

    if (editing) {
        // إذا كان هذا المصدر مختاراً في الحاسبة نحدّث معامله فوراً
        if (calcSource && calcSource.name === editing.name) {
            calcSource = { ...country };
            applySourceToInputs();
            runLiveCalc();
        }
        countries[idx] = country;
    } else {
        countries.push(country);
    }
    saveAll();
    closeModal('countryModal');
    renderCountriesTable();
    renderSourceGrid();
    const msg = `${country.name}: ${factorLabel(country)} · تكلفة ${costLabel(country.costMode, country.costValue)} · ربح ${country.profitPct}%. الحوالات السابقة لا تتأثر.`;
    if (!sheetSupportsCountries) return showToast(editing ? 'تم تعديل التسعير' : 'تمت الإضافة', msg + ' (محفوظ في هذا المتصفح فقط)');
    queueOps({ action: 'upsert_country', country });
    const status = await flushOutbox();
    showToast(editing ? 'تم تعديل التسعير' : 'تمت الإضافة', `${msg} — ${syncResultMessage(status)}`, syncToastType(status));
}

function deleteCountryPrompt(idx) {
    const c = countries[idx];
    if (!c) return;
    showAppConfirm('تأكيد حذف الدولة', `هل أنت متأكد من حذف ${c.name} من قائمة التسعير؟ الحوالات السابقة لن تتأثر.`, async () => {
        countries.splice(idx, 1);
        saveAll();
        renderCountriesTable();
        renderSourceGrid();
        if (!sheetSupportsCountries) return showToast('تم الحذف بنجاح', 'تم حذف الدولة من قائمة التسعير');
        queueOps({ action: 'delete_country', id: c.id });
        const status = await flushOutbox();
        showToast('تم الحذف بنجاح', syncResultMessage(status), syncToastType(status));
    });
}

// ================= التجار (حساب جارٍ بين تاجر وتاجر) =================
// الرصيد الموجب = لنا عنده، والسالب = له عندنا. لكل عملة رصيد مستقل.
const TRADE_CURRENCIES = {
    USD: { sym: '$', name: 'دولار' },
    EUR: { sym: '€', name: 'يورو' },
    JOD: { sym: 'د.أ', name: 'دينار' },
    ILS: { sym: '₪', name: 'شيكل' }
};

// sign: اتجاه الأثر على الرصيد (+ لنا عنده، - له عندنا)، feeOp: العمولة تُخصم (-1) أو تُضاف (+1)
// النسبة تبدأ دائماً من صفر وتُكتب يدوياً لكل حركة، وتُخصم من مبلغ الحركة
// legacy: أنواع قديمة تبقى لقراءة الحركات السابقة فقط ولا تظهر كأزرار
// settle: التصفير، واتجاهه (he_paid / i_paid) يُحدَّد تلقائياً حسب الرصيد
const TMOVE_KINDS = {
    for_us: { label: 'لنا', hint: 'مبلغ لنا عنده، وتُخصم العمولة منه إن وُجدت', sign: 1, feeOp: -1 },
    for_him: { label: 'له', hint: 'مبلغ له عندنا، وتُخصم العمولة منه إن وُجدت', sign: -1, feeOp: -1 },
    he_paid: { label: 'تصفير (دفع لنا)', hint: 'دفع لنا دفعة لتسديد الرصيد، وتُخصم العمولة منها إن وُجدت', sign: -1, feeOp: -1, settle: true },
    i_paid: { label: 'تصفير (دفعنا له)', hint: 'دفعنا له دفعة لتسديد الرصيد، وتُخصم العمولة منها إن وُجدت', sign: 1, feeOp: -1, settle: true },
    recv_for_me: { label: 'استلم لنا', hint: 'استلم مبلغاً لحسابنا، وتُخصم عمولته', sign: 1, feeOp: -1, legacy: true },
    paid_for_me: { label: 'أرسل عنا', hint: 'أرسل مبلغاً لصالحنا، وتُضاف عمولته', sign: -1, feeOp: 1, legacy: true },
    recv_for_him: { label: 'استلمنا له', hint: 'استلمنا مبلغاً لحسابه، وتُخصم عمولتنا', sign: -1, feeOp: -1, legacy: true },
    paid_for_him: { label: 'أرسلنا عنه', hint: 'أرسلنا مبلغاً لصالحه، وتُضاف عمولتنا', sign: 1, feeOp: 1, legacy: true }
};

let traders = [];
let traderMoves = [];
let sheetSupportsTraders = true;

function normalizeTrader(t) {
    return {
        id: String(t?.id ?? '').trim(),
        name: String(t?.name ?? '').trim(),
        phone: String(t?.phone ?? '').trim(),
        commissionPct: Math.max(0, toNum(t?.commissionPct, 0)),
        myCommissionPct: Math.max(0, toNum(t?.myCommissionPct, 0)),
        note: String(t?.note ?? '').trim(),
        logo: /^data:image\//.test(String(t?.logo ?? '')) ? String(t.logo) : '',
        createdAt: String(t?.createdAt ?? '').slice(0, 10)
    };
}

// ---------- نسخة الشعارات في المتصفح ----------
function loadTraderLogos() {
    const v = loadJSON(STORAGE.traderLogos, {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function saveTraderLogo(id, logo) {
    const logos = loadTraderLogos();
    if (logo) logos[id] = logo; else delete logos[id];
    try {
        localStorage.setItem(STORAGE.traderLogos, JSON.stringify(logos));
    } catch (e) {
        console.error('Logo storage error:', e);
        showToast('تعذر حفظ نسخة الشعار', 'مساحة المتصفح ممتلئة', 'warning');
    }
}

// بصمة الشعار: نفس طريقة السكربت (طوله + آخر حروفه)
function logoSig(logo) {
    const v = String(logo || '');
    return v ? v.length + ':' + v.slice(-16) : '';
}

// الشيت يرسل بصمة الشعار فقط (logoSig)، فنعرض النسخة المحفوظة عندنا ونطلب من الشيت فقط الشعار الذي تغيّر.
// السكربت الأقدم يرسل الشعار كاملاً (logo) أو لا يرسله أبداً (بلا عمود) فنعرض النسخة المحفوظة.
// شعار محفوظ عندنا وناقص في الشيت يُرفع له مرة واحدة.
async function syncTraderLogos(rawTraders) {
    const cache = loadTraderLogos();
    const need = [];
    const backfill = [];
    const pending = (id) => outbox.some(op => op.action === 'upsert_trader' && op.trader?.id === id);
    rawTraders.forEach(r => {
        const t = traders.find(x => x.id === String(r?.id ?? '').trim());
        if (!t || pending(t.id)) return;
        const cached = cache[t.id] || '';
        if ('logoSig' in r || 'logo' in r) {
            const sig = 'logoSig' in r ? String(r.logoSig || '') : logoSig(r.logo);
            if (!sig) {
                t.logo = cached;
                if (cached) backfill.push({ action: 'upsert_trader', trader: { ...t } });
            } else if (logoSig(cached) === sig) {
                t.logo = cached;
            } else if ('logo' in r) {
                t.logo = String(r.logo);
                saveTraderLogo(t.id, t.logo);
            } else if (logoSig(t.logo) === sig) {
                saveTraderLogo(t.id, t.logo);
            } else {
                need.push(t.id);
            }
        } else if (!t.logo) {
            t.logo = cached;
        }
    });
    if (backfill.length) { queueOps(...backfill); flushOutbox(); }
    if (!need.length) return;
    const res = await postToSheets({ action: 'logos', ids: need });
    const logos = res.status === 'ok' ? res.data?.logos : null;
    if (!logos) return;
    Object.entries(logos).forEach(([id, logo]) => {
        const t = traders.find(x => x.id === id);
        if (!t) return;
        t.logo = /^data:image\//.test(logo) ? logo : '';
        saveTraderLogo(id, t.logo);
    });
    renderTraders();
    if (panelTraderId && !$('traderPanel').classList.contains('hidden')) renderTraderPanel();
}

// شعار التاجر أو أول حرف من اسمه
function traderAvatar(t) {
    return t.logo
        ? `<img src="${escapeHtml(t.logo)}" alt="" class="w-full h-full object-contain bg-white">`
        : escapeHtml(t.name.charAt(0) || '؟');
}

function moveEffect(kind, amount, pct) {
    const k = TMOVE_KINDS[kind] || TMOVE_KINDS.for_us;
    const commission = amount * (pct / 100);
    return { commission, effect: k.sign * (amount + k.feeOp * commission) };
}

function normalizeTmove(m) {
    const kind = TMOVE_KINDS[m?.kind] ? m.kind : 'for_us';
    const amount = Math.max(0, toNum(m?.amount, 0));
    const pct = Math.max(0, toNum(m?.commissionPct, 0));
    const { commission, effect } = moveEffect(kind, amount, pct);
    return {
        id: toNum(m?.id, 0),
        date: String(m?.date ?? '').slice(0, 10),
        traderId: String(m?.traderId ?? '').trim(),
        traderName: String(m?.traderName ?? '').trim(),
        kind,
        currency: TRADE_CURRENCIES[m?.currency] ? m.currency : 'USD',
        amount,
        commissionPct: pct,
        commission: round2(commission),
        effect: round2(effect),
        note: String(m?.note ?? '').trim()
    };
}

const curSym = (c) => TRADE_CURRENCIES[c]?.sym || c;
const tradeMoney = (v, c, digits = 2) => `<bdi class="ltr-num">${fmt(Math.abs(v), digits)} ${curSym(c)}</bdi>`;
const isZero = (v) => Math.abs(v) < 0.005;
// المبلغ مع إشارته داخل نفس الاتجاه (حتى لا تنقلب الإشارة في الصفحة العربية)
const signedMoney = (v, c) => `<bdi class="ltr-num">${isZero(v) ? '' : v > 0 ? '+' : '−'}${fmt(Math.abs(v))} ${curSym(c)}</bdi>`;

function traderMovesOf(id, currency) {
    return traderMoves
        .filter(m => m.traderId === id && (!currency || m.currency === currency))
        .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
}

function traderBalances(id) {
    const bal = {};
    traderMoves.forEach(m => {
        if (m.traderId !== id) return;
        bal[m.currency] = round2((bal[m.currency] || 0) + m.effect);
    });
    return bal;
}

function balanceText(v) {
    if (isZero(v)) return 'متصفّر';
    return v > 0 ? 'لنا عنده' : 'له عندنا';
}

function balanceChip(cur, v, big = false) {
    const cls = isZero(v) ? 'zero' : (v > 0 ? 'mine' : 'his');
    return `<span class="bal-chip ${cls}${big ? ' big' : ''}">
        <span class="bal-chip-label">${balanceText(v)}</span>
        <b>${tradeMoney(v, cur)}</b>
    </span>`;
}

function traderWhatsapp(t) {
    if (!hasWhatsapp(t)) return '';
    return `<button data-action="open-wa-trader" data-id="${escapeHtml(t.id)}" class="wa-btn" title="فتح محادثة واتساب">${WA_ICON}<bdi class="ltr-num">+${escapeHtml(whatsappDigits(t.phone))}</bdi></button>`;
}

// ---------- صفحة التجار ----------
function renderTraders() {
    if (pageHidden('traders')) return;
    $('traders-unsupported').classList.toggle('hidden', sheetSupportsTraders || dataState !== 'ready');

    // المجموع لكل عملة: كم لنا عند التجار وكم لهم عندنا
    const totals = {};
    traders.forEach(t => Object.entries(traderBalances(t.id)).forEach(([c, v]) => {
        totals[c] ??= { mine: 0, his: 0 };
        if (v > 0) totals[c].mine += v; else totals[c].his += -v;
    }));
    const curs = Object.keys(totals);
    $('traders-totals').innerHTML = curs.length === 0 ? '' : curs.map((c, i) => `
        <div class="ana-tile" style="--d:${i * 60}ms">
            <span class="ana-tile-label">${TRADE_CURRENCIES[c].name}</span>
            <span class="text-xs text-emerald-700 font-bold">لنا عند التجار: ${tradeMoney(totals[c].mine, c)}</span>
            <span class="text-xs text-rose-700 font-bold">للتجار عندنا: ${tradeMoney(totals[c].his, c)}</span>
            <span class="text-[11px] text-slate-500">الصافي: ${balanceText(totals[c].mine - totals[c].his)} ${tradeMoney(totals[c].mine - totals[c].his, c)}</span>
        </div>
    `).join('');

    const q = normName($('trader_search').value);
    const list = traders.filter(t => !q || normName(t.name).includes(q));
    if (!list.length) {
        $('traders-grid').innerHTML = `<div class="col-span-full section-card p-8 text-center text-sm text-slate-400">${emptyMessage(traders.length, 'لا يوجد تاجر بهذا الاسم', 'لا يوجد تجار بعد. أضف أول تاجر للبدء.')}</div>`;
        return;
    }
    $('traders-grid').innerHTML = list.map((t, i) => {
        const bal = traderBalances(t.id);
        const moves = traderMovesOf(t.id);
        const last = moves[moves.length - 1];
        const chips = Object.entries(bal).map(([c, v]) => balanceChip(c, v)).join('') || '<span class="text-xs text-slate-400">لا توجد حركات بعد</span>';
        return `
            <div class="trader-card" data-action="open-trader" data-id="${escapeHtml(t.id)}" style="--d:${i * 50}ms">
                <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <span class="cust-avatar overflow-hidden">${traderAvatar(t)}</span>
                        <div class="min-w-0">
                            <div class="font-black text-slate-900 truncate">${escapeHtml(t.name)}</div>
                            <div class="text-[11px] text-slate-400">نسبته ${t.commissionPct}% · نسبتي ${t.myCommissionPct}%${t.note ? ' · ' + escapeHtml(t.note) : ''}</div>
                        </div>
                    </div>
                    <button data-action="new-tmove" data-id="${escapeHtml(t.id)}" class="shrink-0 text-xs font-bold bg-slate-900 text-white px-3 py-1.5 rounded-lg">+ حركة</button>
                </div>
                <div class="flex flex-wrap gap-1.5 mt-3">${chips}</div>
                <div class="text-[11px] text-slate-400 mt-2">${last ? `آخر حركة ${relativeDays(last.date)} · ${moves.length} حركة` : ''}</div>
            </div>`;
    }).join('');
}

function openTraderModal(t = null) {
    $('traderModalTitle').textContent = t ? 'تعديل التاجر: ' + t.name : 'تاجر جديد';
    $('tr_id').value = t ? t.id : '';
    $('tr_name').value = t ? t.name : '';
    $('tr_phone').value = t ? t.phone : '';
    $('tr_commission').value = t ? t.commissionPct : 7;
    $('tr_my_commission').value = t ? t.myCommissionPct : 0;
    $('tr_note').value = t ? t.note : '';
    setTraderLogo(t ? t.logo : '');
    traderFormLogoInitial = traderFormLogo;
    openModal('traderModal');
    $('tr_name').focus();
}

// الشعار المختار في نموذج التاجر (يُحفظ مع التاجر في الشيت)
let traderFormLogo = '';
let traderFormLogoInitial = '';
function setTraderLogo(url) {
    traderFormLogo = url || '';
    $('tr_logo_preview').innerHTML = traderFormLogo
        ? `<img src="${escapeHtml(traderFormLogo)}" alt="" class="w-full h-full object-contain bg-white">`
        : (escapeHtml($('tr_name').value.trim().charAt(0)) || '🏪');
    $('tr_logo_remove').classList.toggle('hidden', !traderFormLogo);
}

async function saveTrader(e) {
    e.preventDefault();
    if (!sheetSupportsTraders) return showToast('حدّث السكربت أولاً', 'سكربت Google Sheets الحالي لا يدعم التجار', 'warning');
    const editId = $('tr_id').value;
    const t = normalizeTrader({
        id: editId || 't' + Date.now(),
        name: $('tr_name').value, phone: $('tr_phone').value,
        commissionPct: $('tr_commission').value, myCommissionPct: $('tr_my_commission').value,
        note: $('tr_note').value, logo: traderFormLogo
    });
    if (!t.name) return showToast('تنبيه', 'اسم التاجر مطلوب', 'warning');
    if (t.phone && !hasWhatsapp(t)) return showToast('رقم الواتساب غير مكتمل', 'اكتبه مع المقدمة، مثل 970599123456', 'warning');
    if (traders.some(x => normName(x.name) === normName(t.name) && x.id !== editId)) return showToast('تنبيه', 'يوجد تاجر بنفس الاسم', 'warning');

    const existing = traders.find(x => x.id === editId);
    // الشعار يُرسل للشيت فقط إن تغيّر، حتى لا نمسحه إن لم يكن قد وصل بعد
    const logoChanged = traderFormLogo !== traderFormLogoInitial;
    if (logoChanged) saveTraderLogo(t.id, t.logo);
    if (existing) Object.assign(existing, { ...t, createdAt: existing.createdAt });
    else traders.unshift({ ...t, createdAt: localDateStr() });
    const payload = { ...(existing || traders[0]) };
    if (!logoChanged) delete payload.logo;
    queueOps({ action: 'upsert_trader', trader: payload });
    closeModal('traderModal');
    renderTraders();
    if (panelTraderId === t.id) renderTraderPanel();
    const status = await flushOutbox();
    showToast('تم حفظ التاجر', `${t.name} — ${syncResultMessage(status)}`, syncToastType(status));
}

function deleteTraderPrompt(id) {
    const t = traders.find(x => x.id === id);
    if (!t) return;
    const count = traderMoves.filter(m => m.traderId === id).length;
    showAppConfirm('حذف التاجر', `سيُحذف "${t.name}"${count ? ` و${count} حركة على حسابه` : ''} من الشيت. متابعة؟`, async () => {
        const ops = traderMoves.filter(m => m.traderId === id).map(m => ({ action: 'delete_tmove', id: m.id }));
        traderMoves = traderMoves.filter(m => m.traderId !== id);
        traders = traders.filter(x => x.id !== id);
        saveTraderLogo(id, '');
        queueOps(...ops, { action: 'delete_trader', id });
        closeModal('traderPanel');
        renderTraders();
        const status = await flushOutbox();
        showToast('تم حذف التاجر', syncResultMessage(status), syncToastType(status));
    });
}

// ---------- حساب التاجر (كشف الحساب) ----------
let panelTraderId = null;
let panelCurrency = 'USD';
let panelPeriod = 'since_zero';

const PERIODS = {
    since_zero: 'منذ آخر تصفير',
    today: 'اليوم',
    week: 'آخر 7 أيام',
    month: 'هذا الشهر',
    all: 'كل الحركات'
};

function openTraderPanel(id, currency) {
    const t = traders.find(x => x.id === id);
    if (!t) return;
    panelTraderId = id;
    const bal = traderBalances(id);
    const used = Object.keys(bal);
    panelCurrency = currency || (used.find(c => !isZero(bal[c])) || used[0] || 'USD');
    panelPeriod = 'since_zero';
    renderTraderPanel();
    openModal('traderPanel');
    $('trader-profile').scrollTop = 0;
}

// حركات الفترة مع الرصيد الجاري قبل وبعد كل حركة
function statementFor(id, currency, period) {
    const all = traderMovesOf(id, currency);
    let running = 0;
    const rows = all.map(m => {
        const before = running;
        running = round2(running + m.effect);
        return { m, before, after: running };
    });

    let start = 0;
    if (period === 'since_zero') {
        // آخر نقطة صار فيها الرصيد صفراً (قبل آخر حركة)، فيظهر الحساب الحالي من بدايته
        for (let i = rows.length - 2; i >= 0; i--) {
            if (isZero(rows[i].after)) { start = i + 1; break; }
        }
    }
    const today = localDateStr();
    const weekAgo = localDateStr(new Date(Date.now() - 6 * 86400000));
    const shown = rows.slice(start).filter(r =>
        period === 'today' ? r.m.date === today
        : period === 'week' ? r.m.date >= weekAgo
        : period === 'month' ? r.m.date.startsWith(today.slice(0, 7))
        : true
    );
    const opening = shown.length ? shown[0].before : running;
    return { rows: shown, opening, closing: running, total: rows.length };
}

function renderTraderPanel() {
    const t = traders.find(x => x.id === panelTraderId);
    if (!t) return;
    const bal = traderBalances(t.id);
    const curList = [...new Set([...Object.keys(bal), panelCurrency])];
    const st = statementFor(t.id, panelCurrency, panelPeriod);
    const current = bal[panelCurrency] || 0;

    // تجميع الحركات حسب اليوم
    const days = [];
    st.rows.forEach(r => {
        let d = days[days.length - 1];
        if (!d || d.date !== r.m.date) { d = { date: r.m.date, rows: [], net: 0 }; days.push(d); }
        d.rows.push(r);
        d.net = round2(d.net + r.m.effect);
    });
    const effClass = (v) => (isZero(v) ? 'text-slate-400' : v > 0 ? 'text-emerald-700' : 'text-rose-700');

    $('trader-profile').innerHTML = `
        <div class="cp-head">
            <button data-action="close-modal" data-modal="traderPanel" class="cp-close" aria-label="إغلاق">✕</button>
            <div class="flex items-center gap-3.5">
                <div class="cp-avatar overflow-hidden">${traderAvatar(t)}</div>
                <div class="min-w-0">
                    <h3 class="text-lg font-black text-white truncate">${escapeHtml(t.name)}</h3>
                    <div class="text-xs text-slate-300 mt-0.5">نسبته ${t.commissionPct}% · نسبتي ${t.myCommissionPct}%${t.note ? ' · ' + escapeHtml(t.note) : ''}</div>
                </div>
            </div>
            <div class="flex flex-wrap items-center gap-2 mt-3">
                ${traderWhatsapp(t)}
                <button data-action="edit-trader" data-id="${escapeHtml(t.id)}" class="cp-chip hover:bg-white/20">تعديل</button>
                <button data-action="delete-trader" data-id="${escapeHtml(t.id)}" class="cp-chip hover:bg-white/20">حذف</button>
            </div>
        </div>

        <div class="p-4 sm:p-5 space-y-4">
            <!-- الأرصدة: اضغط على عملة لعرض كشفها -->
            <div class="flex flex-wrap gap-2">
                ${curList.map(c => `
                    <button data-action="trader-currency" data-cur="${c}" class="cur-tab${c === panelCurrency ? ' active' : ''}">
                        <span class="text-[11px] text-slate-500 block">${TRADE_CURRENCIES[c].name}</span>
                        ${balanceChip(c, bal[c] || 0, true)}
                    </button>`).join('')}
                <select id="tp_add_currency" class="cur-add" aria-label="إضافة عملة">
                    <option value="">+ عملة</option>
                    ${Object.keys(TRADE_CURRENCIES).filter(c => !curList.includes(c)).map(c => `<option value="${c}">${TRADE_CURRENCIES[c].name}</option>`).join('')}
                </select>
            </div>

            <div class="grid grid-cols-2 gap-2">
                <button data-action="new-tmove" data-id="${escapeHtml(t.id)}" data-cur="${panelCurrency}" class="cp-action bg-slate-900 text-white">+ حركة جديدة</button>
                <button data-action="settle-trader" data-id="${escapeHtml(t.id)}" data-cur="${panelCurrency}" class="cp-action ${isZero(current) ? 'bg-slate-100 text-slate-400' : 'bg-emerald-600 text-white'}" ${isZero(current) ? 'disabled' : ''}>
                    ${isZero(current) ? 'الحساب متصفّر' : `تصفير الحساب (${tradeMoney(current, panelCurrency, 0)})`}
                </button>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="inline-flex bg-slate-100 rounded-lg p-0.5 text-xs" role="group" aria-label="الفترة">
                    ${Object.entries(PERIODS).map(([k, l]) => `<button data-action="trader-period" data-period="${k}" class="ana-range-btn px-2.5 py-1 rounded-md font-bold text-slate-500${k === panelPeriod ? ' active' : ''}">${l}</button>`).join('')}
                </div>
                <div class="flex gap-1.5">
                    <button data-action="statement-pdf" class="text-xs font-bold bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 rounded-lg">تحميل PDF</button>
                    <button data-action="statement-png" class="text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-800 px-3 py-1.5 rounded-lg">صورة PNG</button>
                </div>
            </div>

            <!-- الكشف (هذا الجزء يُحوَّل إلى صورة) -->
            <div id="trader-statement" class="statement-paper">
                <!-- الطرفان: شركتنا يميناً والتاجر يساراً -->
                <div class="st-head">
                    <div class="st-party">
                        <div class="st-logo">${logoHtml()}</div>
                        <div class="min-w-0">
                            <div class="font-black text-white text-sm truncate">${escapeHtml(globalConfig.companyName || 'فاست باي')}</div>
                            <div class="text-[11px] text-slate-400 truncate">${escapeHtml(globalConfig.companySubtitle || '')}</div>
                        </div>
                    </div>
                    <div class="st-party">
                        <div class="min-w-0 text-left">
                            <div class="font-black text-white text-sm truncate">${escapeHtml(t.name)}</div>
                            <div class="text-[11px] text-slate-400 truncate">${t.phone ? `<bdi class="ltr-num">${escapeHtml(t.phone)}</bdi>` : 'التاجر'}</div>
                        </div>
                        <div class="st-logo">${traderAvatar(t)}</div>
                    </div>
                </div>
                <div class="st-title">
                    <b>كشف حساب · ${TRADE_CURRENCIES[panelCurrency].name}</b>
                    <span>${PERIODS[panelPeriod]} · <bdi class="ltr-num">${localDateStr()}</bdi></span>
                </div>
                <div class="st-summary">
                    <div><span>رصيد أول الفترة</span><b class="${effClass(st.opening)}">${balanceText(st.opening)} ${tradeMoney(st.opening, panelCurrency)}</b></div>
                    <div><span>عدد الحركات</span><b>${st.rows.length}</b></div>
                    <div class="st-final"><span>الرصيد الحالي</span><b class="${effClass(st.closing)}">${balanceText(st.closing)} ${tradeMoney(st.closing, panelCurrency)}</b></div>
                </div>
                ${days.length === 0 ? '<div class="text-xs text-slate-400 text-center py-8">لا توجد حركات في هذه الفترة</div>' : days.map(d => `
                    <div class="st-day">
                        <div class="st-day-head"><bdi class="ltr-num">${escapeHtml(d.date)}</bdi><span class="${effClass(d.net)}">صافي اليوم ${signedMoney(d.net, panelCurrency)}</span></div>
                        ${d.rows.map(({ m, after }) => `
                            <div class="st-row">
                                <div class="min-w-0 flex-1">
                                    <div class="font-bold text-slate-800">${TMOVE_KINDS[m.kind].label}${m.note ? ` <span class="font-medium text-slate-400">· ${escapeHtml(m.note)}</span>` : ''}</div>
                                    <div class="text-[11px] text-slate-500">${tradeMoney(m.amount, m.currency)}${m.commission ? ` · عمولة ${m.commissionPct}% = ${tradeMoney(m.commission, m.currency)}` : ''}</div>
                                </div>
                                <div class="text-left shrink-0">
                                    <div class="font-black ${effClass(m.effect)}">${signedMoney(m.effect, m.currency)}</div>
                                    <div class="text-[10px] text-slate-400">الرصيد ${isZero(after) ? '0' : (after > 0 ? 'لنا ' : 'له ')}${isZero(after) ? '' : tradeMoney(after, m.currency)}</div>
                                </div>
                                <div class="st-row-actions" data-export-ignore="true">
                                    <button data-action="edit-tmove" data-id="${m.id}" title="تعديل">✎</button>
                                    <button data-action="delete-tmove" data-id="${m.id}" title="حذف">✕</button>
                                </div>
                            </div>`).join('')}
                    </div>`).join('')}
            </div>
        </div>
    `;
    $('tp_add_currency').addEventListener('change', (e) => {
        if (!e.target.value) return;
        panelCurrency = e.target.value;
        renderTraderPanel();
    });
}

// ---------- الحركات ----------
// أزرار: لنا / له / تصفير (+ زر النوع القديم عند تعديل حركة قديمة)
function renderTmoveKinds() {
    const current = $('tm_kind').value;
    const ck = TMOVE_KINDS[current];
    const btns = [
        { key: 'for_us', label: 'لنا', sub: 'يزيد ما لنا عنده', cls: 'mine', active: current === 'for_us' },
        { key: 'for_him', label: 'له', sub: 'يزيد ما له عندنا', cls: 'his', active: current === 'for_him' },
        { key: 'settle', label: 'تصفير', sub: ck.settle ? (current === 'he_paid' ? 'دفع لنا' : 'دفعنا له') : 'يقلّل الرصيد', cls: 'settle', active: !!ck.settle }
    ];
    if (ck.legacy) btns.push({ key: current, label: ck.label, sub: 'نوع قديم', cls: ck.sign > 0 ? 'mine' : 'his', active: true });
    $('tm_kinds').style.gridTemplateColumns = `repeat(${btns.length}, minmax(0, 1fr))`;
    $('tm_kinds').innerHTML = btns.map(b => `
        <button type="button" data-action="tmove-kind" data-kind="${b.key}" class="kind-btn${b.active ? ' active' : ''} ${b.cls}">
            ${b.label}<span>${b.sub}</span>
        </button>`).join('');
}

// اتجاه التصفير حسب الرصيد: لنا عنده → دفع لنا، له عندنا → دفعنا له
function settleKindFor() {
    const t = traders.find(x => x.id === $('tm_trader').value);
    const bal = ((t && traderBalances(t.id)[$('tm_currency').value]) || 0) - editingMoveEffect();
    return bal < 0 && !isZero(bal) ? 'i_paid' : 'he_paid';
}

function setTmoveKind(kind) {
    $('tm_kind').value = kind === 'settle' ? settleKindFor() : kind;
    renderTmoveKinds();
    updateTmovePreview();
}

function updateTmovePreview() {
    if (TMOVE_KINDS[$('tm_kind').value].settle && $('tm_kind').value !== settleKindFor()) {
        $('tm_kind').value = settleKindFor();
        renderTmoveKinds();
    }
    const kind = $('tm_kind').value;
    const k = TMOVE_KINDS[kind];
    const cur = $('tm_currency').value;
    const amount = toNum($('tm_amount').value, 0);
    const { commission, effect } = moveEffect(kind, amount, toNum($('tm_commission').value, 0));
    const t = traders.find(x => x.id === $('tm_trader').value);
    const after = round2(((t && traderBalances(t.id)[cur]) || 0) - editingMoveEffect() + effect);
    $('tm_preview').innerHTML = `
        <div class="text-[11px] text-slate-500 mb-1">${escapeHtml(k.hint)}</div>
        <div class="flex justify-between"><span>${commission ? `العمولة: ${tradeMoney(commission, cur)}` : 'بدون عمولة'}</span>
        <b class="${!k.settle ? (effect >= 0 ? 'text-emerald-700' : 'text-rose-700') : 'text-slate-800'}">${k.settle ? 'تسديد ' : effect >= 0 ? 'لنا عنده +' : 'له عندنا +'}${tradeMoney(effect, cur)}</b></div>
        <div class="flex justify-between text-[11px] mt-1"><span>الرصيد بعد الحركة</span><b>${balanceText(after)} ${tradeMoney(after, cur)}</b></div>`;
}

// عند التعديل: نطرح أثر الحركة القديمة من الرصيد في المعاينة
function editingMoveEffect() {
    const m = traderMoves.find(x => x.id === toNum($('tm_id').value, -1));
    return m && m.currency === $('tm_currency').value ? m.effect : 0;
}

function openTmoveModal({ traderId, kind = 'for_us', currency, amount = '', move = null } = {}) {
    if (!sheetSupportsTraders) return showToast('حدّث السكربت أولاً', 'سكربت Google Sheets الحالي لا يدعم التجار', 'warning');
    const t = traders.find(x => x.id === (move ? move.traderId : traderId));
    if (!t) return;
    $('tmoveModalTitle').textContent = (move ? 'تعديل حركة' : 'حركة جديدة') + ' — ' + t.name;
    $('tm_id').value = move ? move.id : '';
    $('tm_trader').value = t.id;
    $('tm_currency').value = move ? move.currency : (currency || panelCurrency || 'USD');
    $('tm_amount').value = move ? move.amount : amount;
    $('tm_date').value = move ? move.date : localDateStr();
    $('tm_note').value = move ? move.note : '';
    $('tm_commission').value = move ? move.commissionPct : 0;
    setTmoveKind(move ? move.kind : kind);
    updateTmovePreview();
    openModal('tmoveModal');
    $('tm_amount').focus();
}

// التصفير: حركة تسديد بقيمة الرصيد الحالي، ويمكن تعديل المبلغ لتسديد جزئي
function settleTrader(id, currency) {
    const v = traderBalances(id)[currency] || 0;
    if (isZero(v)) return;
    openTmoveModal({ traderId: id, currency, kind: 'settle', amount: Math.abs(v) });
    $('tm_note').value = 'تصفير الحساب';
}

async function saveTmove(e) {
    e.preventDefault();
    const t = traders.find(x => x.id === $('tm_trader').value);
    if (!t) return;
    const editId = toNum($('tm_id').value, 0);
    const move = normalizeTmove({
        id: editId || Math.max(Date.now(), traderMoves.reduce((m, x) => Math.max(m, x.id), 0) + 1),
        date: $('tm_date').value || localDateStr(),
        traderId: t.id, traderName: t.name,
        kind: $('tm_kind').value, currency: $('tm_currency').value,
        amount: $('tm_amount').value, commissionPct: $('tm_commission').value,
        note: $('tm_note').value
    });
    if (!(move.amount > 0)) return showToast('تنبيه', 'اكتب المبلغ', 'warning');

    const i = traderMoves.findIndex(x => x.id === move.id);
    if (i >= 0) traderMoves[i] = move; else traderMoves.push(move);
    queueOps({ action: 'upsert_tmove', move });
    closeModal('tmoveModal');
    panelCurrency = move.currency;
    renderTraders();
    if (!$('traderPanel').classList.contains('hidden')) renderTraderPanel();

    const bal = traderBalances(t.id)[move.currency] || 0;
    const status = await flushOutbox();
    showToast(isZero(bal) ? 'تم تصفير الحساب ✓' : 'تم حفظ الحركة',
        `${t.name}: ${balanceText(bal)} ${fmt(Math.abs(bal))} ${curSym(move.currency)} — ${syncResultMessage(status)}`, syncToastType(status));
}

function deleteTmovePrompt(id) {
    const m = traderMoves.find(x => x.id === id);
    if (!m) return;
    showAppConfirm('حذف الحركة', `حذف "${TMOVE_KINDS[m.kind].label}" بمبلغ ${fmt(m.amount)} ${curSym(m.currency)}؟`, async () => {
        traderMoves = traderMoves.filter(x => x.id !== id);
        queueOps({ action: 'delete_tmove', id });
        renderTraders();
        renderTraderPanel();
        const status = await flushOutbox();
        showToast('تم حذف الحركة', syncResultMessage(status), syncToastType(status));
    });
}

async function exportStatement(format) {
    const t = traders.find(x => x.id === panelTraderId);
    if (!t) return;
    const buttons = document.querySelectorAll('[data-action^="statement-"]');
    buttons.forEach(b => { b.disabled = true; });
    try {
        await exportElement($('trader-statement'), format, `كشف_${t.name}_${panelCurrency}_${localDateStr()}`, 2.5);
        showToast('تم تحميل الكشف', (format === 'pdf' ? 'ملف PDF' : 'صورة PNG') + ' — أرسله للتاجر على واتساب', 'info');
    } catch (err) {
        console.error('Statement export failed:', err);
        showToast('تعذر إنشاء الصورة', 'تأكد من الاتصال بالإنترنت ثم حاول مجدداً', 'error');
    } finally {
        buttons.forEach(b => { b.disabled = false; });
    }
}

// ================= المصاريف =================
function expenseCategories() {
    const used = expenses.map(e => e.category).filter(Boolean);
    return [...new Set([...DEFAULT_EXPENSE_CATEGORIES, ...used])];
}

function filteredExpenses() {
    const month = $('exp_month_filter').value || '';
    const category = $('exp_category_filter').value || 'ALL';
    return expenses
        .filter(e => (!month || e.date.startsWith(month)) && (category === 'ALL' || e.category === category))
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

function renderExpenses() {
    if (pageHidden('expenses')) return;
    const categories = expenseCategories();

    // اقتراحات البنود
    $('expense-categories').innerHTML = categories.map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
    $('expense-category-chips').innerHTML = categories.map(c =>
        `<button type="button" data-action="pick-category" data-category="${escapeHtml(c)}" class="px-2.5 py-1 rounded-full border border-slate-200 bg-slate-50 hover:bg-blue-50 hover:border-blue-200 text-[11px] font-bold text-slate-600 transition">${escapeHtml(c)}</button>`
    ).join('');

    const filterSelect = $('exp_category_filter');
    const currentFilter = filterSelect.value || 'ALL';
    filterSelect.innerHTML = '<option value="ALL">كل البنود</option>' +
        categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    filterSelect.value = categories.includes(currentFilter) ? currentFilter : 'ALL';

    $('expenses-unsupported').classList.toggle('hidden', sheetSupportsExpenses || dataState !== 'ready');
    $('expense-save-btn').disabled = dataState === 'loading' || !sheetSupportsExpenses;

    const list = filteredExpenses();

    // الملخص حسب البند (حسب الفلترة الحالية)
    const byCategory = {};
    let total = 0;
    list.forEach(e => {
        byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
        total += e.amount;
    });
    $('expenses-total').textContent = fmt(total) + ' ₪';
    const entries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    $('expenses-by-category').innerHTML = entries.length === 0
        ? '<div class="col-span-full text-slate-400 text-xs py-3 text-center">لا توجد مصاريف في هذه الفترة</div>'
        : entries.map(([cat, sum]) => `
            <div class="p-3 bg-slate-50 border border-slate-200/80 rounded-xl text-xs">
                <span class="block text-slate-500 font-bold">${escapeHtml(cat)}</span>
                <span class="block font-black text-rose-600 num text-base mt-0.5">${fmt(sum)} ₪</span>
                <span class="block text-[10px] text-slate-400">${total ? Math.round(sum / total * 100) : 0}% من الإجمالي</span>
            </div>
        `).join('');

    $('expenses-body').innerHTML = list.length === 0
        ? `<tr><td colspan="5" class="p-6 text-center text-xs text-slate-400">${emptyMessage(expenses.length, 'لا توجد مصاريف مطابقة للفلترة', 'لا توجد مصاريف مسجلة بعد')}</td></tr>`
        : list.map(e => `
            <tr class="hover:bg-slate-50">
                <td class="p-3.5 whitespace-nowrap text-slate-500 text-xs num">${escapeHtml(e.date)}</td>
                <td class="p-3.5"><span class="badge bg-rose-50 text-rose-700">${escapeHtml(e.category)}</span></td>
                <td class="p-3.5 font-mono font-black text-slate-900 num whitespace-nowrap">${fmt(e.amount)} ₪</td>
                <td class="p-3.5 text-slate-500 text-xs">${escapeHtml(e.note || '-')}</td>
                <td class="p-3.5 text-center whitespace-nowrap">
                    <button data-action="edit-expense" data-id="${e.id}" class="text-blue-600 hover:text-blue-800 font-bold text-xs px-2.5 py-1 bg-blue-50 rounded-lg mr-1">تعديل</button>
                    <button data-action="delete-expense" data-id="${e.id}" class="text-slate-400 hover:text-red-600 p-1 font-bold" title="حذف من السجل ومن الإكسل">✕</button>
                </td>
            </tr>
        `).join('');
}

function resetExpenseForm() {
    $('exp_id').value = '';
    $('exp_category').value = '';
    $('exp_amount').value = '';
    $('exp_note').value = '';
    $('exp_date').value = localDateStr();
    $('expenseFormTitle').textContent = 'إضافة مصروف';
    $('expense-save-btn').textContent = 'حفظ المصروف';
    $('expense-cancel-edit').classList.add('hidden');
}

function editExpense(id) {
    const e = expenses.find(x => x.id === id);
    if (!e) return;
    $('exp_id').value = e.id;
    $('exp_category').value = e.category;
    $('exp_amount').value = e.amount;
    $('exp_date').value = e.date;
    $('exp_note').value = e.note;
    $('expenseFormTitle').textContent = 'تعديل مصروف';
    $('expense-save-btn').textContent = 'حفظ التعديل';
    $('expense-cancel-edit').classList.remove('hidden');
    $('expenseForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('exp_amount').focus();
}

async function saveExpense(ev) {
    ev.preventDefault();
    if (!sheetSupportsExpenses) return showToast('حدّث السكربت أولاً', 'سكربت Google Sheets الحالي لا يدعم المصاريف', 'warning');

    const editingId = toNum($('exp_id').value, 0);
    const expense = normalizeExpense({
        id: editingId || Math.max(Date.now(), expenses.reduce((m, e) => Math.max(m, e.id), 0) + 1),
        date: $('exp_date').value || localDateStr(),
        category: $('exp_category').value,
        amount: $('exp_amount').value,
        note: $('exp_note').value
    });
    if (!expense.category) return showToast('تنبيه', 'اختر بند المصروف', 'warning');
    if (!(expense.amount > 0)) return showToast('تنبيه', 'المبلغ يجب أن يكون أكبر من صفر', 'warning');

    const i = expenses.findIndex(x => x.id === expense.id);
    if (i >= 0) expenses[i] = expense; else expenses.unshift(expense);
    queueOps({ action: 'upsert_expense', expense });
    resetExpenseForm();
    renderExpenses();
    updateReportsData();

    const syncStatus = await flushOutbox();
    showToast(editingId ? 'تم تعديل المصروف' : 'تم حفظ المصروف', `${expense.category} — ${fmt(expense.amount)} ₪. ${syncResultMessage(syncStatus)}`, syncToastType(syncStatus));
}

function deleteExpensePrompt(id) {
    const e = expenses.find(x => x.id === id);
    if (!e) return;
    showAppConfirm('تأكيد حذف المصروف', `هل أنت متأكد من حذف مصروف "${e.category}" بقيمة ${fmt(e.amount)} ₪؟ سيُحذف من الشيت أيضاً.`, async () => {
        expenses = expenses.filter(x => x.id !== id);
        queueOps({ action: 'delete_expense', id });
        if (toNum($('exp_id').value, 0) === id) resetExpenseForm();
        renderExpenses();
        updateReportsData();
        const syncStatus = await flushOutbox();
        showToast('تم حذف المصروف', syncResultMessage(syncStatus), syncToastType(syncStatus));
    });
}

function exportExpensesCSV() {
    const list = filteredExpenses();
    const header = ['التاريخ', 'البند', 'المبلغ ₪', 'ملاحظات'];
    const rows = list.map(e => [e.date, e.category, e.amount.toFixed(2), e.note]);
    const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
    downloadBlob('\uFEFF' + csv, 'text/csv;charset=utf-8;', `مصاريف_فاست_باي_${$('exp_month_filter').value || localDateStr()}.csv`);
    showToast('تم التصدير', `تم تنزيل ${list.length} مصروف`, 'info');
}

// ================= الإعدادات =================
function loadSettingsPage() {
    $('set_screen_rate').value = globalConfig.screenRate;
    $('set_market_rate').textContent = globalConfig.marketRate ? globalConfig.marketRate + ' ₪' : '—';
    $('set_cost_pct').value = globalConfig.costPct;
    $('set_profit_pct').value = globalConfig.profitPct;
    $('set_minus_ils').value = globalConfig.minusIls;
    $('set_drive_url').value = globalConfig.driveWebhook || '';
    $('set_sync_token').value = globalConfig.syncToken || '';
    $('set_sell_offset').value = globalConfig.sellOffset;
    $('set_buy_offset').value = globalConfig.buyOffset;
    $('set_company_name').value = globalConfig.companyName || '';
    $('set_company_subtitle').value = globalConfig.companySubtitle || '';
    $('set_receipt_footer').value = globalConfig.receiptFooter || '';
    updateSellBuyPreview();
}

function saveAllSettings() {
    const screenRate = toNum($('set_screen_rate').value, NaN);
    const costPct = toNum($('set_cost_pct').value, NaN);
    const profitPct = toNum($('set_profit_pct').value, NaN);
    const minusIls = toNum($('set_minus_ils').value, NaN);
    const webhook = $('set_drive_url').value.trim();

    if (!(screenRate > 0)) return showToast('تنبيه', 'سعر الشاشة يجب أن يكون أكبر من صفر', 'warning');
    if (!(costPct >= 0) || !(profitPct >= 0) || costPct + profitPct >= 100) {
        return showToast('تنبيه', 'نسب التكلفة والربح يجب أن تكون صفراً أو أكثر ومجموعها أقل من 100%', 'warning');
    }
    if (!(minusIls >= 0)) return showToast('تنبيه', 'الخصم الإضافي يجب أن يكون صفراً أو أكثر', 'warning');
    if (webhook && !/^https:\/\//i.test(webhook)) return showToast('تنبيه', 'رابط المزامنة يجب أن يبدأ بـ https://', 'warning');

    // تغيير السعر من الإعدادات يثبّته يدوياً
    if (round3(screenRate) !== round3(globalConfig.screenRate)) {
        globalConfig.screenRate = round3(screenRate);
        globalConfig.rateMode = 'manual';
        globalConfig.screenRateLastUpdated = nowTimeLabel();
        rateStatus = 'manual';
        calcRateTouched = false;
    }

    const syncToken = $('set_sync_token').value.trim();
    const connectionChanged = webhook !== globalConfig.driveWebhook || syncToken !== globalConfig.syncToken;
    Object.assign(globalConfig, {
        costPct, profitPct, minusIls, driveWebhook: webhook, syncToken,
        sellOffset: toNum($('set_sell_offset').value, globalConfig.sellOffset),
        buyOffset: toNum($('set_buy_offset').value, globalConfig.buyOffset),
        companyName: $('set_company_name').value.trim() || 'فاست باي',
        companySubtitle: $('set_company_subtitle').value.trim(),
        receiptFooter: $('set_receipt_footer').value.trim()
    });
    applyBranding();

    // النسب الافتراضية تُطبق على خيار "أخرى" والدول الجديدة فقط
    if (calcSource?.other) applySourceRates();

    saveAll();
    applyScreenRateToUI();
    loadSettingsPage();
    runLiveCalc();
    showToast('تم حفظ الإعدادات', 'تم تطبيق جميع الإعدادات بنجاح');
    // رابط أو مفتاح جديد: نقرأ البيانات من الشيت من جديد
    if (connectionChanged) loadFromSheets();
}

// ================= تصدير Excel (CSV) =================
function csvCell(value) {
    let s = String(value ?? '');
    // منع تنفيذ الصيغ عند فتح الملف في Excel
    if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
}

function exportToCSV() {
    const header = ['المعرف', 'التاريخ', 'المرسل إليه', 'رقم الحساب / المحفظة', 'طريقة التسليم', 'الجهة', 'الدولة', 'نوع المعادلة', 'المبلغ الأصلي', 'معامل التحويل', 'نسبة التكلفة %', 'تكلفة ثابتة $', 'نسبة الربح %', 'الخصم الإضافي', 'سعر الشاشة المعتمد', 'عملة التسليم', 'المسلّم بالشيكل', 'المسلّم بالدولار', 'التكلفة بالشيكل', 'صافي الربح بالشيكل', 'الحالة'];
    const rows = ledger.map(t => [
        t.id, t.date, t.recipient, t.account, t.payout, t.provider, t.country, TYPE_LABEL[t.type],
        t.orig, t.factor, t.costPct, t.costFixed, t.profitPct, t.minusIls, t.screenRate,
        t.currency === 'USD' ? 'دولار' : 'شيكل', t.clientIls.toFixed(2), t.clientUsd.toFixed(2),
        t.costIls.toFixed(2), t.profitIls.toFixed(2), t.status
    ]);
    const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
    downloadBlob('\uFEFF' + csv, 'text/csv;charset=utf-8;', `سجل_حوالات_فاست_باي_${localDateStr()}.csv`);
    showToast('تم التصدير', 'تم تنزيل ملف Excel بنجاح', 'info');
}

// ================= النوافذ المنبثقة =================
let confirmCallback = null;

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

function showAppConfirm(title, message, onConfirm) {
    $('confirmModalTitle').textContent = title;
    $('confirmModalMessage').textContent = message;
    confirmCallback = onConfirm;
    openModal('appConfirmModal');
}

function closeAppConfirm() {
    closeModal('appConfirmModal');
    confirmCallback = null;
}

// ================= ربط الأحداث =================
const CLICK_ACTIONS = {
    'switch-tab': (el) => switchTab(el.dataset.tab),
    'refresh-rate': () => fetchLiveDollarRate({ manual: true }),
    'pin-rate': pinScreenRateManual,
    'export-csv': exportToCSV,
    'save-tx': saveNewTransaction,
    'clear-tx-filters': clearTxFilters,
    'toggle-status': (el) => toggleStatusFilter(el.dataset.status),
    'ledger-more': () => { ledgerLimit += LEDGER_PAGE; renderLedgerTable(); },
    'retry-sync': retryFailedSync,
    'select-customer': (el) => selectCustomerFromSearch(el.dataset.id),
    'edit-tx': (el) => openEditTxModal(toNum(el.dataset.id, NaN)),
    'delete-tx': (el) => deleteTxPrompt(toNum(el.dataset.id, NaN)),
    'open-customer-modal': () => openCustomerModal(),
    'edit-customer': (el) => openCustomerModal(customers.find(c => c.id === el.dataset.id)),
    'delete-customer': (el) => deleteCustomerPrompt(el.dataset.id),
    'open-whatsapp': (el) => openWhatsapp(el.dataset.id),
    'open-trader-modal': () => openTraderModal(),
    'open-trader': (el) => openTraderPanel(el.dataset.id),
    'pick-trader-logo': () => $('tr_logo_input').click(),
    'remove-trader-logo': () => setTraderLogo(''),
    'edit-trader': (el) => openTraderModal(traders.find(t => t.id === el.dataset.id)),
    'delete-trader': (el) => deleteTraderPrompt(el.dataset.id),
    'new-tmove': (el) => openTmoveModal({ traderId: el.dataset.id, currency: el.dataset.cur }),
    'edit-tmove': (el) => openTmoveModal({ move: traderMoves.find(m => m.id === toNum(el.dataset.id, NaN)) }),
    'delete-tmove': (el) => deleteTmovePrompt(toNum(el.dataset.id, NaN)),
    'settle-trader': (el) => settleTrader(el.dataset.id, el.dataset.cur),
    'tmove-kind': (el) => setTmoveKind(el.dataset.kind),
    'trader-currency': (el) => { panelCurrency = el.dataset.cur; renderTraderPanel(); },
    'trader-period': (el) => { panelPeriod = el.dataset.period; renderTraderPanel(); },
    'statement-png': () => exportStatement('png'),
    'statement-pdf': () => exportStatement('pdf'),
    'open-wa-trader': (el) => {
        const t = traders.find(x => x.id === el.dataset.id);
        if (t && hasWhatsapp(t)) window.open(`https://wa.me/${whatsappDigits(t.phone)}`, '_blank', 'noopener');
    },
    'open-country-modal': openCountryModal,
    'delete-country': (el) => deleteCountryPrompt(toNum(el.dataset.index, -1)),
    'save-settings': saveAllSettings,
    'reload-sheets': () => loadFromSheets({ manual: true }),
    'sync-now': () => liveCycle({ manual: true }),
    'open-customer': (el) => openCustomerProfile(el.dataset.id, el.dataset.name),
    'cust-new-tx': customerNewTransaction,
    'cust-show-ledger': customerShowLedger,
    'select-source': (el) => selectSource(el.dataset.name, el.dataset.other === '1'),
    'open-receipt': (el) => openReceipt(toNum(el.dataset.id, NaN)),
    'open-last-receipt': () => lastSavedTxId && openReceipt(lastSavedTxId),
    'receipt-png': () => exportReceipt('png'),
    'receipt-pdf': () => exportReceipt('pdf'),
    'pick-logo': () => $('logo-file-input').click(),
    'remove-logo': () => { globalConfig.companyLogo = ''; saveAll(); applyBranding(); showToast('تمت إزالة الشعار', '', 'info'); },
    'set-payout': (el) => setPayout(el.dataset.payout),
    'set-provider': (el) => setProvider(el.dataset.provider),
    'set-currency': (el) => setCurrency(el.dataset.currency),
    'set-cost-mode': (el) => setCostMode(el.dataset.mode),
    'edit-country': (el) => openCountryModal(toNum(el.dataset.index, -1)),
    'pick-category': (el) => { $('exp_category').value = el.dataset.category; $('exp_amount').focus(); },
    'edit-expense': (el) => editExpense(toNum(el.dataset.id, NaN)),
    'delete-expense': (el) => deleteExpensePrompt(toNum(el.dataset.id, NaN)),
    'cancel-expense-edit': resetExpenseForm,
    'clear-expense-filters': () => { $('exp_month_filter').value = ''; $('exp_category_filter').value = 'ALL'; renderExpenses(); },
    'export-expenses-csv': exportExpensesCSV,
    'ana-month-step': (el) => setAnalysisMonth(shiftMonth(analysisMonth, toNum(el.dataset.step, 0))),
    'ana-range': (el) => { analysisRange = toNum(el.dataset.range, 6); renderMonthlyAnalysis(); },
    'ana-pick-month': (el) => setAnalysisMonth(el.dataset.month),
    'close-modal': (el) => closeModal(el.dataset.modal),
    'confirm-no': closeAppConfirm,
    'confirm-yes': () => {
        const cb = confirmCallback;
        closeAppConfirm();
        if (cb) cb();
    }
};

function bindEvents() {
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (el && el.tagName !== 'SELECT' && CLICK_ACTIONS[el.dataset.action]) {
            CLICK_ACTIONS[el.dataset.action](el);
        }

        // إغلاق قائمة اقتراحات الزبائن عند الضغط خارجها
        const dropdown = $('customer-search-dropdown');
        if (!dropdown.contains(e.target) && e.target !== $('calc_recipient')) {
            dropdown.classList.add('hidden');
        }

        // إغلاق النافذة عند الضغط على الخلفية
        if (e.target.classList.contains('modal')) {
            if (e.target.id === 'appConfirmModal') closeAppConfirm();
            else closeModal(e.target.id);
        }
    });

    document.addEventListener('change', (e) => {
        const el = e.target;
        if (el.dataset.action === 'change-status') changeOrderStatus(toNum(el.dataset.id, NaN), el.value);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        closeAppConfirm();
        // نغلق النافذة العليا فقط (مثلاً الفاتورة فوق ملف الزبون، أو الحركة فوق حساب التاجر)
        const top = ['receiptModal', 'tmoveModal', 'traderModal', 'custModal', 'editTxModal', 'countryModal', 'customerModal', 'traderPanel']
            .find(id => !$(id).classList.contains('hidden'));
        if (top) closeModal(top);
        $('customer-search-dropdown').classList.add('hidden');
    });

    // الحاسبة
    $('calc_recipient').addEventListener('input', onCustomerSearchInput);
    $('calc_recipient').addEventListener('focus', onCustomerSearchInput);
    $('calc_recipient').addEventListener('click', onCustomerSearchInput);
    $('calc_recipient').addEventListener('keydown', onCustomerPickerKey);
    $('source-search').addEventListener('input', renderSourceGrid);
    $('calc_other_name').addEventListener('input', updateSourceBadge);
    $('tr_logo_input').addEventListener('change', (e) => {
        resizeImageFile(e.target.files[0], 128, setTraderLogo, 40000);
        e.target.value = '';
    });
    $('tr_name').addEventListener('input', () => { if (!traderFormLogo) setTraderLogo(''); });
    $('logo-file-input').addEventListener('change', (e) => {
        handleLogoFile(e.target.files[0]);
        e.target.value = '';
    });
    ['set_screen_rate', 'set_sell_offset', 'set_buy_offset'].forEach(id => $(id).addEventListener('input', updateSellBuyPreview));
    $('m_cust_payout').addEventListener('change', () => fillProviderSelect($('m_cust_provider'), $('m_cust_payout').value));
    $('edit_tx_payout').addEventListener('change', () => fillProviderSelect($('edit_tx_provider'), $('edit_tx_payout').value));
    $('edit_tx_currency').addEventListener('change', recalcEditModal);
    $('edit_tx_cost_mode').addEventListener('change', recalcEditModal);
    ['calc_orig_amount', 'calc_factor', 'calc_cost_pct', 'calc_profit_pct'].forEach(id => $(id).addEventListener('input', runLiveCalc));
    $('calc_screen_rate').addEventListener('input', () => {
        calcRateTouched = true;
        runLiveCalc();
    });

    // السجل والزبائن
    $('tx_search').addEventListener('input', resetLedgerAndRender);
    ['tx_date_filter', 'tx_month_filter'].forEach(id => $(id).addEventListener('change', resetLedgerAndRender));
    $('cust_search').addEventListener('input', renderCustomersTable);
    $('cust_sort').addEventListener('change', renderCustomersTable);

    // النماذج
    $('custForm').addEventListener('submit', saveCustomerManual);
    $('countryForm').addEventListener('submit', saveCountry);
    $('editTxForm').addEventListener('submit', saveEditedTransaction);
    $('expenseForm').addEventListener('submit', saveExpense);
    $('traderForm').addEventListener('submit', saveTrader);
    $('tmoveForm').addEventListener('submit', saveTmove);
    $('trader_search').addEventListener('input', renderTraders);
    ['tm_amount', 'tm_commission'].forEach(id => $(id).addEventListener('input', updateTmovePreview));
    $('tm_currency').addEventListener('change', updateTmovePreview);
    ['exp_month_filter', 'exp_category_filter'].forEach(id => $(id).addEventListener('change', renderExpenses));

    // التحليل الشهري: اختيار الشهر، والتلميح عند المرور على الرسم
    $('ana_month').addEventListener('change', (e) => setAnalysisMonth(e.target.value));
    const chart = $('ana-chart');
    chart.addEventListener('pointermove', (e) => {
        const band = e.target.closest('.ana-band');
        if (band) showChartTooltip(toNum(band.dataset.index, -1)); else hideChartTooltip();
    });
    chart.addEventListener('pointerleave', hideChartTooltip);
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => renderMonthlyAnalysis(), 250);
    });
    chart.addEventListener('click', (e) => {
        const band = e.target.closest('.ana-band');
        const d = band && analysisChartData[toNum(band.dataset.index, -1)];
        if (d) setAnalysisMonth(d.month);
    });
    $('edit_tx_country').addEventListener('change', onEditCountrySelect);
    ['edit_tx_orig', 'edit_tx_factor', 'edit_tx_cost_pct', 'edit_tx_profit_pct', 'edit_tx_minus', 'edit_tx_screen']
        .forEach(id => $(id).addEventListener('input', recalcEditModal));
}

// ================= بدء التشغيل =================
function refreshAllViews() {
    applyScreenRateToUI();
    applyBranding();
    renderSourceGrid();
    setPayout($('calc_payout_type').value, $('calc_provider').value);
    setCurrency($('calc_currency').value);
    renderRecentTx();
    renderLedgerTable();
    renderCustomersTable();
    renderCountriesTable();
    updateReportsData();
    updateSyncPendingBar();
    loadSettingsPage();
}

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    watchResultCard();
    lastSeenDay = localDateStr();
    $('calc_date').value = localDateStr();
    $('exp_date').value = localDateStr();
    $('exp_month_filter').value = localDateStr().slice(0, 7);

    saveAll();
    refreshAllViews();

    // الزبائن والحوالات تُقرأ من Google Sheets عند كل فتح
    loadFromSheets();

    fetchLiveDollarRate();


    // إعادة إرسال العمليات المعلقة تلقائياً كل دقيقة وعند عودة الإنترنت
    setInterval(() => { if (outbox.length) flushOutbox(); }, 60 * 1000);
    window.addEventListener('online', () => { if (outbox.length) flushOutbox(); });

    // تحديث حيّ واحد كل دقيقتين (سعر الشاشة + الشيت معاً)، وعند الرجوع للصفحة
    setInterval(liveCycle, LIVE_REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) liveCycle(); });
});
