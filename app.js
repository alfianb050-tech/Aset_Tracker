/**
 * APP.JS - CENTRALIZED LOGIC COMMAND CENTER
 * Semua kalkulasi, filter, chart rendering, dan jembatan data Supabase berpusat di sini.
 */

// =========================================================================
// 1. CORE MATH & DATA PROCESSORS
// =========================================================================

// Helper Format Rupiah global
window.formatIDR = (number) => {
    return `Rp ${Math.round(number || 0).toLocaleString('id-ID')}`;
};

// Processor Utama: Membaca mentah data transaksi & memetakan struktur keuangan secara otomatis
window.calculateAssetSummary = (transactions) => {
    let summary = {
        totalInflow: 0,
        totalOutflow: 0,
        totalInvest: 0,
        totalCairBrankas: 0, // Menampung total aksi ambil duit dari brankas (Jual Aset / Tarik Dana Darurat)
        liquidCash: 0,       // Sisa uang cash murni
        reservedFund: 0,     // Total dana darurat teralokasi
        assetBase: 0,        // Total modal yang tertanam di aset produktif
        netWorth: 0,         // Total kekayaan bersih
        incomeSources: {},   // Untuk chart pendapatan
        allocations: {},     // Untuk list alokasi pengeluaran
        assetMap: {}         // Untuk halaman Brankas Aset & kalkulasi avg buy
    };

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    summary.monthlyCashflow = 0;

    let dynamicAssetModal = 0;

    if (transactions && transactions.length > 0) {
        
        // =========================================================================
        // BABAK 1: PROSES UTAMA (Pemasukan, Pengeluaran, Dana Darurat, & Beli Aset)
        // =========================================================================
        transactions.forEach(tx => {
            const amt = parseFloat(tx.amount) || 0;
            const cat = (tx.kategori || '').trim();
            const catLower = cat.toLowerCase();
            const type = (tx.type || '').toLowerCase().trim();
            const unitQty = parseFloat(tx.unitCount) || 0;

            // Ekstrak waktu transaksi untuk chart bulanan/tahunan
            const separator = tx.date.includes('/') ? '/' : '-';
            const parts = tx.date.split(separator);
            let txY = parts[0].length === 4 ? parseInt(parts[0]) : parseInt(parts[2]);
            let txM = parseInt(parts[1]);

            // 1. Klasifikasi Aliran Kas Murni
            if (type === 'pemasukan') {
                summary.totalInflow += amt;
                summary.incomeSources[cat] = (summary.incomeSources[cat] || 0) + amt;
            } else if (type === 'pengeluaran') {
                summary.totalOutflow += amt;
                summary.allocations[cat] = (summary.allocations[cat] || 0) + amt;
            }

            // 2. Hitung Arus Kas Khusus Bulan Berjalan Ini Saja (Beli (-) atau Jual (+))
            if (txY === currentYear && txM === currentMonth) {
                summary.monthlyCashflow += (type === 'pemasukan' || catLower.includes('jual')) ? amt : -amt;
            }

            // 3. Logika Simpan Dana Darurat (Outflow murni)
            if ((catLower.includes('darurat') || catLower === 'reserved fund') && type === 'pengeluaran') {
                summary.reservedFund += amt;
            }

            // 4. LOCKDOWN INVESTMENT BASE (HANYA MENERIMA SUNTIKAN MODAL MASUK / OUTFLOW)
            const isBeliAset = (type === 'investasi' || catLower.includes('beli') || catLower.includes('investasi')) && !catLower.includes('jual');
            const isNabungDarurat = (catLower.includes('darurat') || catLower === 'reserved fund') && type === 'pengeluaran';

            if (isBeliAset || isNabungDarurat) {
                
                summary.totalInvest += amt; // Kunci mutlak modal tersimpan!
                
                // Jika ini adalah aset produktif (bukan dana darurat biasa), catat log unitnya ke memori brankas aset
                if (isBeliAset && !catLower.includes('darurat')) {
                    const key = (tx.note || tx.keterangan || "ASET").toUpperCase().trim();
                    if (!summary.assetMap[key]) {
                        summary.assetMap[key] = { unit: 0, modal: 0, avgPrice: 0, type: tx.unitType || 'UNIT' };
                    }
                    summary.assetMap[key].unit += unitQty;
                    summary.assetMap[key].modal += amt;
                    if (summary.assetMap[key].unit > 0) {
                        summary.assetMap[key].avgPrice = summary.assetMap[key].modal / summary.assetMap[key].unit;
                    }
                    dynamicAssetModal += amt;
                }

                // Pastikan cash utama lo ikut terpotong seimbang jika belum terpotong di pengeluaran biasa
                if (type !== 'pengeluaran') {
                    summary.totalOutflow += amt;
                    summary.allocations[cat] = (summary.allocations[cat] || 0) + amt;
                }
            }
        });

        // =========================================================================
        // BABAK 2: PROSES EKSEKUSI JUAL ASET & PENARIKAN DANA DARURAT (VAULT LIQUIDATION)
        // =========================================================================
        transactions.forEach(tx => {
            const amt = parseFloat(tx.amount) || 0;
            const cat = (tx.kategori || '').trim();
            const catLower = cat.toLowerCase();
            const type = (tx.type || '').toLowerCase().trim();
            const unitQty = parseFloat(tx.unitCount) || 0;
            
            // Skenario 1: Aksi Jual Aset Produktif (Vault Liquidation)
            if (type === 'investasi' && catLower.includes('jual')){
                const key = (tx.note || tx.keterangan || "ASET").toUpperCase().trim();
                
                // Cegah double inflow jika tipe dasarnya pemasukan biasa
                if (type !== 'pemasukan' && catLower.includes('jual')) {
                    summary.totalInflow += amt;       
                }
                
                // Hanya hitung ke Vault Liquidation jika kategori murni aksi jual aset
                if (catLower.includes('jual')) {
                    summary.totalCairBrankas += amt;  
                }

                if (summary.assetMap[key]) {
                    const totalUnitSebelumJual = summary.assetMap[key].unit;
                    const totalModalSebelumJual = summary.assetMap[key].modal;

                    // Jual Sebagian Aset
                    if (totalUnitSebelumJual > 0 && unitQty > 0 && unitQty < totalUnitSebelumJual) {
                        const rasioPenjualan = unitQty / totalUnitSebelumJual;
                        const modalYangKeluar = totalModalSebelumJual * rasioPenjualan;

                        summary.assetMap[key].unit -= unitQty;
                        summary.assetMap[key].modal -= modalYangKeluar;
                        dynamicAssetModal -= modalYangKeluar;
                        
                        if (summary.assetMap[key].unit > 0) {
                            summary.assetMap[key].avgPrice = summary.assetMap[key].modal / summary.assetMap[key].unit;
                        }
                    } 
                    // Jual Habis All-In Aset
                    else {
                        dynamicAssetModal -= totalModalSebelumJual;
                        summary.assetMap[key].unit = 0;
                        summary.assetMap[key].modal = 0;
                        summary.assetMap[key].avgPrice = 0;
                    }
                }
            }

            // Skenario 2: Aksi Ambil Dana Darurat dari Brankas (Vault Liquidation - Masuk lewat Inflow)
            if ((catLower.includes('darurat') || catLower === 'reserved fund') && type === 'pemasukan') {
                summary.reservedFund -= amt;      
                summary.totalCairBrankas += amt;  // Masuk murni hanya ke Vault Liquidation!

                // Bersihkan dari chart donat pendapatan agar tidak merusak persentase income murni
                if (summary.incomeSources[cat]) {
                    summary.incomeSources[cat] -= amt;
                    if (summary.incomeSources[cat] <= 0) delete summary.incomeSources[cat];
                }
            }
        });
    }

    // Mengunci landasan modal akhir aset produktif ke sistem core berjalan
    summary.assetBase = dynamicAssetModal;

    // =========================================================================
    // RUMUS MATEMATIKA FINANSIAL UTAMA
    // =========================================================================
    summary.liquidCash = summary.totalInflow - summary.totalOutflow;
    summary.netWorth = summary.liquidCash + summary.reservedFund;

    if (summary.assetBase > 0) {
        summary.netWorth += summary.assetBase;
    }
    
    // Perhitungan Retention Rate
    const bebanKonsumsiMurni = summary.totalOutflow - summary.totalInvest - summary.reservedFund;
    summary.retentionRate = summary.totalInflow > 0 ? (((summary.totalInflow - bebanKonsumsiMurni) / summary.totalInflow) * 100).toFixed(1) : 0;

    return summary;
};


// =========================================================================
// 2. DASHBOARD PAGE LOGIC (index.html)
// =========================================================================
window.renderDashboardLogic = async () => {
    try {
        const transactions = await window.getTransactions();
        const data = window.calculateAssetSummary(transactions);

        // Inject Angka ke Scoreboard UI
        if(document.getElementById('savings-percent')) document.getElementById('savings-percent').innerText = `${data.retentionRate}%`;
        if(document.getElementById('net-worth')) document.getElementById('net-worth').innerText = window.formatIDR(data.netWorth);
        if(document.getElementById('liquid-cash')) document.getElementById('liquid-cash').innerText = window.formatIDR(data.liquidCash);
        if(document.getElementById('emergency-fund')) document.getElementById('emergency-fund').innerText = window.formatIDR(data.reservedFund);
        
        const cfEl = document.getElementById('cashflow');
        if (cfEl) {
            cfEl.innerText = `${data.monthlyCashflow >= 0 ? '+' : ''} ${window.formatIDR(data.monthlyCashflow)}`;
            cfEl.className = `text-xl lg:text-2xl font-black italic ${data.monthlyCashflow >= 0 ? 'text-green-400' : 'text-red-400'}`;
        }

                // =========================================================================
        // COMMAND ANALYSIS ENGINE
        // =========================================================================

        //let systemStatus = "";
        //let insights = [];

        // SYSTEM MODE DETECTOR
        //if (data.liquidCash < 0) {

            //systemStatus = "🔴 SYSTEM STATUS : CASHFLOW PRESSURE";

            //insights.push("Beban konsumsi mulai mendominasi arus kas utama.");
            //insights.push("Liquid Cash berada di bawah batas ideal.");
            //insights.push("Disarankan memperkuat cash reserve sebelum ekspansi aset baru.");

        //} 
        //else if (data.retentionRate >= 50 && data.assetBase > data.liquidCash) {

            //systemStatus = "🟣 SYSTEM STATUS : AGGRESSIVE ACCUMULATION";

            //insights.push("Sebagian besar income berhasil dikonversi menjadi Investment Base.");
            //insights.push("Retention Rate berada di atas standar aman.");
            //insights.push("Sistem mendeteksi pola akumulasi aset aktif.");

        //} 
        //else if (data.reservedFund > data.liquidCash) {

            //systemStatus = "🟠 SYSTEM STATUS : DEFENSIVE MODE";

            //insights.push("Dana darurat menjadi fondasi utama pertahanan finansial.");
            //insights.push("Sistem mendeteksi pola finansial defensif dan stabil.");
            //insights.push("Prioritaskan penguatan cash reserve sebelum ekspansi agresif.");

        //} 
        //else {

            //systemStatus = "🟢 SYSTEM STATUS : CAPITAL STABLE";

            //insights.push("Struktur finansial utama masih berada di zona aman.");
            //insights.push("Asset accumulation berjalan lebih dominan dibanding konsumsi murni.");
            //insights.push("Liquid Cash masih mampu menopang operasional utama.");
        //}

        // RENDER INSIGHT
       //const insightEl = document.getElementById('all-time-insight');

//if (insightEl) {

    //insightEl.innerHTML = `
    
        //<div class="text-[11px] font-black tracking-[0.2em] text-white italic">
            //${systemStatus}
        //</div>

        //<div class="space-y-3">

            //${insights.map(item => `
                //<div class="text-[11px] text-slate-400 font-semibold italic leading-relaxed">
                    //• ${item}
                //</div>
            //`).join('')}

        //</div>
    //`;
//}

 //const insightEl = document.getElementById('all-time-insight');
//if (insightEl) {
    //const totalOut = data.totalOutflow || 0;
    //const totalIn = data.totalInflow || 0; // Inflow tetep eksis
    
    // Daftar kategori lu
    ////const categories = ['Makan & Minum', 'Modal Trading (Deposit)', 'Rokok', 'Ortu', 'Lifestyle', 'Dana Darurat', 'Aset'];
    
    // Sortir berdasarkan nilai
    //const sortedAlloc = categories
        //.map(cat => [cat, data.allocations[cat] || 0])
        //.sort((a, b) => b[1] - a[1]);

    // Deteksi "Tersangka Utama"
    //const konsumtifList = ['Makan & Minum', 'Rokok', 'Lifestyle' , 'Modal Trading (Deposit)'];
    //const topCategory = sortedAlloc[0];
    //const isRedAlert = konsumtifList.includes(topCategory[0]);

    //insightEl.innerHTML = `
        //<div class="p-4 border ${isRedAlert ? 'border-red-900 bg-red-950/20' : 'border-slate-700 bg-slate-900/30'} rounded-xl italic font-serif">
            //<h4 class="text-[10px] font-black tracking-widest ${isRedAlert ? 'text-red-500' : 'text-emerald-500'} mb-2 uppercase text-center">>> Laporan Audit Alokasi</h4>
            
            //<div class="text-center mb-4 pb-3 border-b border-slate-700">
                //<p class="text-[9px] text-slate-500 uppercase tracking-widest">Total Income Masuk</p>
                //<p class="text-[16px] text-white font-black">${window.formatIDR(totalIn)}</p>
            //</div>
            
            //<div class="space-y-2">
                //${sortedAlloc.map(([name, val]) => {
                    //const pct = totalOut > 0 ? ((val / totalOut) * 100).toFixed(0) : 0;
                    //return `
                        //<div class="flex justify-between items-center text-[11px]">
                            //<span class="text-slate-400">• ${name}</span>
                            //<div class="flex items-center gap-2">
                                //<span class="text-slate-600 text-[9px]">${window.formatIDR(val)}</span>
                                //<span class="text-white font-bold w-8 text-right">${pct}%</span>
                            //</div>
                        //</div>
                    //`;
                //}).join('')}
            //</div>

            //<div class="mt-4 pt-3 border-t border-slate-700 text-[10px] ${isRedAlert ? 'text-red-400' : 'text-emerald-400'} font-bold uppercase tracking-wider text-center">
                //${isRedAlert 
                    //? `Perhatian: Dominasi ${topCategory[0]} menekan efisiensi.` 
                    //: `Sistem terkendali: ${topCategory[0]} memegang kendali utama.`}
            //</div>
        //</div>
    //`;
//}

// ==============================
// ALL TIME INSIGHT ENGINE
// ==============================

const insightEl = document.getElementById('all-time-insight');

if (insightEl) {

   // ==============================
    // SAFE DATA
    // ==============================

    const allocations = data.allocations || {};

    const totalOut = data.totalOutflow || 0;
    const totalIn = data.totalInflow || 0;

    // ==============================
    // ALLOCATION ANALYSIS (PINDAH KE SINI DULUAN)
    // ==============================

    const asetTotal = allocations['Beli Aset'] || allocations['Aset'] || 0;
    const danaDaruratTotal = allocations['Dana Darurat'] || 0;
    
    // INI RUMUS BARU LIQUID CASH LU:
    const liquidTotal = totalIn - totalOut; 

    const konsumtifTotal =
        (allocations['Makan & Minum'] || 0) +
        (allocations['Lifestyle'] || 0) +
        (allocations['Rokok'] || 0) +
        (allocations['Modal Trading (Deposit)'] || 0);

    // ==============================
    // CATEGORY CONFIG
    // ==============================

    const categories = [
        'Makan & Minum',
        'Modal Trading (Deposit)',
        'Rokok',
        'Orang Tua',
        'Lifestyle',
        'Dana Darurat',
        'Liquid Cash',
        'Beli Aset'
    ];

    // ==============================
    // SORT ALLOCATION (SUDAH DI-INJECT LOGIC BARU)
    // ==============================

    const sortedAlloc = categories
        .map(cat => {
            // Kita kasih tahu JS: "Woi, khusus Liquid Cash & Beli Aset ambil dari variabel atas ya!"
            if (cat === 'Liquid Cash') return [cat, liquidTotal];
            if (cat === 'Beli Aset') return [cat, asetTotal];
            
            // Sisanya ambil dari database normal
            return [cat, allocations[cat] || 0];
        })
        .sort((a, b) => b[1] - a[1]);

    // ==============================
    // KONSUMTIF DETECTOR
    // ==============================

    const konsumtifList = [
        'Makan & Minum',
        'Rokok',
        'Lifestyle',
        'Modal Trading (Deposit)'
    ];

    const topCategory =
        sortedAlloc[0] || ['Tidak Ada', 0];

    const isRedAlert =
        konsumtifList.includes(topCategory[0]);

    // ==============================
    // PERCENTAGE
    // ==============================

    const pctAset =
        totalIn > 0
        ? ((asetTotal / totalIn) * 100).toFixed(0)
        : 0;

    const pctDanaDarurat =
        totalIn > 0
        ? ((danaDaruratTotal / totalIn) * 100).toFixed(0)
        : 0;

    const pctLiquid =
        totalIn > 0
        ? ((liquidTotal / totalIn) * 100).toFixed(0)
        : 0;

    const pctKonsumtif =
        totalIn > 0
        ? ((konsumtifTotal / totalIn) * 100).toFixed(0)
        : 0;

    // ==============================
    // SMART INSIGHT
    // ==============================

    let allocationInsight = '';

    if (pctKonsumtif >= 50) {

        allocationInsight =
        '⚠️ Sebagian besar income masih terserap ke pengeluaran konsumtif dan lifestyle.';

    }
    else if (pctAset >= 30) {

        allocationInsight =
        '📈 Distribusi income sangat produktif dengan dominasi pembangunan aset.';

    }
    else if (pctDanaDarurat >= 20) {

        allocationInsight =
        '🛡️ Sistem keuangan menunjukkan fokus kuat terhadap keamanan finansial.';

    }
    else {

        allocationInsight =
        '📊 Struktur distribusi income relatif stabil dan terkendali.';
    }

   // ==========================================
// TRADING PERFORMANCE INSIGHT
// ==========================================

// 1. Ambil data Modal Deposit dari Allocations (Outflow)
const tradingDeposit = data.allocations['Modal Trading (Deposit)'] || 0;

// 2. Tembak langsung nama 'wd profit trading' (dilengkapi jaring pengaman huruf besar/kecil)
const tradingWD = 
    data.incomeSources['wd profit trading'] || 
    data.incomeSources['WD Profit Trading'] || 
    data.incomeSources['WD PROFIT TRADING'] || 
    data.incomeSources['Wd Profit Trading'] || 0;

// 3. Hitung Selisih Bersih (Net Profit/Loss Trading)
const netTrading = tradingWD - tradingDeposit;

// ... (lanjutkan ke kodingan persentase dan UI yang sebelumnya) ...

// 4. Hitung Persentase Performa
// Jika deposit > 0, hitung berapa persen ROI-nya
const tradingROI = tradingDeposit > 0 
    ? ((netTrading / tradingDeposit) * 100).toFixed(0) 
    : 0;

// 5. Nentuin status: Untung, Rugi, atau Baru Tanam Modal
let tradingStatusHTML = "";
let tradingAnalysisText = "";

if (tradingDeposit === 0 && tradingWD === 0) {
    tradingStatusHTML = `<span class="text-slate-500 font-bold">💤 NO TRADING ACTIVITY</span>`;
    tradingAnalysisText = "Belum ada catatan aktivitas deposit atau withdrawal trading untuk periode ini.";
} else if (netTrading > 0) {
    tradingStatusHTML = `<span class="text-emerald-400 font-bold">🟢 PROFITABLE (+${tradingROI}%)</span>`;
    tradingAnalysisText = `Strategi lu berjalan baik. Lu berhasil menarik profit sebesar <b>${window.formatIDR(netTrading)}</b> lebih besar dari modal yang lu masukkan bulan ini. Maintain terus psikologi tradingnya!`;
} else if (netTrading === 0) {
    tradingStatusHTML = `<span class="text-cyan-400 font-bold">🟡 BREAK EVEN (0%)</span>`;
    tradingAnalysisText = `Posisi kas trading seimbang. Total WD lu sama persis dengan modal deposit sebesar <b>${window.formatIDR(tradingDeposit)}</b>. Lu berhasil mengamankan modal utama.`;
} else {
    tradingStatusHTML = `<span class="text-rose-400 font-bold">🔴 UNPROFITABLE (${tradingROI}%)</span>`;
    tradingAnalysisText = `Kas trading mengalami defisit sebesar <b>${window.formatIDR(Math.abs(netTrading))}</b>. Pengeluaran modal lebih besar daripada hasil WD. Evaluasi kembali *trading plan* atau kurangi risiko ukuran lot lu.`;
}

    // ==============================
    // RENDER HTML
    // ==============================

    insightEl.innerHTML = `

        <div class="p-5 border ${isRedAlert ? 'border-red-900 bg-red-950/20' : 'border-slate-700 bg-slate-900/30'} rounded-[1.5rem] italic font-serif">

            <!-- TITLE -->
            <h4 class="text-[10px] font-black tracking-[0.25em] ${isRedAlert ? 'text-red-500' : 'text-emerald-500'} mb-4 uppercase text-center">

                >>> Financial Allocation Audit

            </h4>

            <!-- TOTAL INCOME -->
            <div class="text-center mb-5 pb-4 border-b border-slate-700">

                <p class="text-[9px] text-slate-500 uppercase tracking-[0.25em]">
                    Total Income Masuk
                </p>

                <p class="text-[18px] text-white font-black mt-1">
                    ${window.formatIDR(totalIn)}
                </p>

            </div>

            <!-- ALLOCATION GRID -->
            <div class="grid grid-cols-2 gap-3 mb-5">

                <!-- ASET -->
                <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">

                    <p class="text-[8px] text-slate-500 uppercase tracking-widest mb-1">
                        Aset
                    </p>

                    <h3 class="text-emerald-400 font-black text-xl">
                        ${pctAset}%
                    </h3>

                </div>

                <!-- DANA DARURAT -->
                <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">

                    <p class="text-[8px] text-slate-500 uppercase tracking-widest mb-1">
                        Dana Darurat
                    </p>

                    <h3 class="text-orange-400 font-black text-xl">
                        ${pctDanaDarurat}%
                    </h3>

                </div>

                <!-- LIQUID -->
                <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">

                    <p class="text-[8px] text-slate-500 uppercase tracking-widest mb-1">
                        Liquid Cash
                    </p>

                    <h3 class="text-cyan-400 font-black text-xl">
                        ${pctLiquid}%
                    </h3>

                </div>

                <!-- KONSUMTIF -->
                <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">

                    <p class="text-[8px] text-slate-500 uppercase tracking-widest mb-1">
                        Konsumtif
                    </p>

                    <h3 class="text-rose-400 font-black text-xl">
                        ${pctKonsumtif}%
                    </h3>

                </div>

            </div>

            <!-- DETAIL ALLOCATION -->
            <div class="space-y-2">

                ${sortedAlloc.map(([name, val]) => {

                    const pct =
                        totalOut > 0
                        ? ((val / totalOut) * 100).toFixed(0)
                        : 0;

                    return `

                        <div class="flex justify-between items-center text-[11px]">

                            <span class="text-slate-400">
                                • ${name}
                            </span>

                            <div class="flex items-center gap-2">

                                <span class="text-slate-600 text-[9px]">
                                    ${window.formatIDR(val)}
                                </span>

                                <span class="text-white font-bold w-8 text-right">
                                    ${pct}%
                                </span>

                            </div>

                        </div>

                    `;

                }).join('')}

            </div>

            <!-- AI INSIGHT -->
            <div class="mt-5 pt-4 border-t border-slate-700">

                <div class="bg-slate-950/50 border border-slate-800 rounded-xl p-4">

                    <p class="text-[9px] uppercase tracking-[0.2em] text-slate-500 mb-2">
                        Allocation Insight
                    </p>

                    <p class="text-[11px] leading-relaxed ${isRedAlert ? 'text-red-400' : 'text-emerald-400'} font-bold">

                        ${allocationInsight}

                    </p>

                </div>

            </div>

        </div>

       <div class="bg-slate-800/40 p-6 rounded-[2rem] border border-slate-800 shadow-xl font-sans text-left mt-6 mb-24"> <div class="flex justify-between items-center mb-6">
        <h4 class="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 italic">Trading Performance</h4>
        <div id="trading-status-badge">${tradingStatusHTML}</div>
    </div>

    <div class="grid grid-cols-2 gap-4 border-b border-slate-800/60 pb-4 mb-4 font-serif">
        <div>
            <p class="text-[10px] font-sans uppercase tracking-wider text-slate-500 mb-1">Total Deposit (Modal)</p>
            <p class="text-sm text-slate-300 font-bold">${window.formatIDR(tradingDeposit)}</p>
        </div>
        <div>
            <p class="text-[10px] font-sans uppercase tracking-wider text-slate-500 mb-1">Total Withdraw (Hasil)</p>
            <p class="text-sm text-slate-300 font-bold">${window.formatIDR(tradingWD)}</p>
        </div>
    </div>

    <div class="text-xs text-slate-400 leading-relaxed">
        <p id="trading-insight-analysis">
            ${tradingAnalysisText}
        </p>
    </div>
</div>
    `;
}

// =========================================================================
        // MoM (MONTH-OVER-MONTH) VELOCITY LOGIC (ULTIMATE VERSION)
        // =========================================================================
        const now = new Date();
        const currentMonth = now.getMonth() + 1;
        const currentYear = now.getFullYear();

        // Mundur ke bulan lalu buat nyari data pembanding
        const lastMonthTransactions = transactions.filter(tx => {
            const separator = tx.date.includes('/') ? '/' : '-';
            const parts = tx.date.split(separator);
            let txYear = parts[0].length === 4 ? parseInt(parts[0]) : parseInt(parts[2]);
            let txMonth = parseInt(parts[1]);

            if (txYear < currentYear) return true;
            if (txYear === currentYear && txMonth < currentMonth) return true;
            return false;
        });

        // Bongkar semua data bulan lalu
        const lastMonthSummary = window.calculateAssetSummary(lastMonthTransactions);

        // FUNGSI PABRIK PANAH (Biar kodingan lu gak berulang)
        const generateMoMHTML = (currentVal, lastMonthVal) => {
            if (lastMonthVal > 0) {
                const momPct = ((currentVal - lastMonthVal) / lastMonthVal) * 100;
                const isUp = momPct >= 0;
                const colorClass = isUp ? 'text-emerald-400' : 'text-rose-400';
                const arrow = isUp ? '▲' : '▼';
                return `
                    <span class="${colorClass} text-sm font-black italic tracking-wider shadow-sm">
                        ${arrow} ${Math.abs(momPct).toFixed(1)}%
                    </span> 
                    <span class="text-[8px] text-slate-500 font-bold uppercase tracking-widest ml-1">vs Last Month</span>
                `;
            } else {
                return `<span class="text-[8px] text-slate-500 font-bold uppercase tracking-widest ml-1">No Prior Data</span>`;
            }
        };

        // TEMBAK KE SEMUA KARTU DI DASBOR LU
        // 1. Net Worth (Udah ada dari tadi)
        if (document.getElementById('mom-velocity')) {
            document.getElementById('mom-velocity').innerHTML = generateMoMHTML(data.netWorth, lastMonthSummary.netWorth);
        }

        // 2. Liquid Cash
        if (document.getElementById('mom-liquid-velocity')) {
            document.getElementById('mom-liquid-velocity').innerHTML = generateMoMHTML(data.liquidCash, lastMonthSummary.liquidCash);
        }

        // 3. Dana Darurat
        if (document.getElementById('mom-emergency-velocity')) {
            document.getElementById('mom-emergency-velocity').innerHTML = generateMoMHTML(data.reservedFund, lastMonthSummary.reservedFund);
        }

        //================
        // Render List Alokasi Strategis
        //const list = document.getElementById('allocation-list');
        //if (list) {
            //list.innerHTML = '';
            //const totalAlloc = Object.values(data.allocations).reduce((a, b) => a + b, 0);
            //Object.entries(data.allocations).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([name, val]) => {
                //const pct = totalAlloc > 0 ? ((val / totalAlloc) * 100).toFixed(0) : 0;
                //let barColor = 'bg-rose-600', textColor = 'text-rose-400';
                //const nameLower = name.toLowerCase();
                
                //if (nameLower.includes('tua') || nameLower.includes('ortu')) { barColor = 'bg-blue-500'; textColor = 'text-blue-400'; }
                //else if (nameLower.includes('beli') || nameLower.includes('aset') || nameLower.includes('investasi')) { barColor = 'bg-emerald-500'; textColor = 'text-emerald-400'; }
                //else if (nameLower.includes('darurat')) { barColor = 'bg-orange-500'; textColor = 'text-orange-400'; }

                //list.innerHTML += `
                    //<div>
                        //<div class="flex justify-between text-[9px] mb-2 uppercase font-black ${textColor} italic"><span>${name}</span><span>${pct}%</span></div>
                        //<div class="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden shadow-inner">
                            //<div class="${barColor} h-full transition-all duration-1000" style="width: ${pct}%"></div>
                        //</div>
                    //</div>`;
            //});
        //}

        // ================
        // Render List Alokasi Strategis (FIXED)
        // ================
        const list = document.getElementById('allocation-list');
        if (list) {
            list.innerHTML = '';
            
            // 1. Hitung sisa uang buat Liquid Cash
            const liquidTotal = data.totalInflow - data.totalOutflow;

            // 2. Duplikat data allocations dari database, lalu "inject" Liquid Cash ke dalamnya
            const extendedAllocations = { 
                ...data.allocations, 
                'Liquid Cash': liquidTotal >= 0 ? liquidTotal : 0 
            };

            // 3. Karena pembaginya adalah total income, kita pakai data.totalInflow
            const totalAlloc = data.totalInflow > 0 ? data.totalInflow : 1;

            // 4. Loop data baru yang sudah ada Liquid Cash-nya
            Object.entries(extendedAllocations).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([name, val]) => {
                const pct = ((val / totalAlloc) * 100).toFixed(0);
                
                // Set warna bawaan (konsumtif)
                let barColor = 'bg-rose-600', textColor = 'text-rose-400';
                const nameLower = name.toLowerCase();
                
                // Kondisi penentu warna bar kodingan lu
                if (nameLower.includes('tua') || nameLower.includes('ortu')) { barColor = 'bg-blue-500'; textColor = 'text-blue-400'; }
                else if (nameLower.includes('beli') || nameLower.includes('aset') || nameLower.includes('investasi')) { barColor = 'bg-emerald-500'; textColor = 'text-emerald-400'; }
                else if (nameLower.includes('darurat')) { barColor = 'bg-orange-500'; textColor = 'text-orange-400'; }
                else if (nameLower.includes('liquid')) { barColor = 'bg-cyan-500'; textColor = 'text-cyan-400'; } // <--- WARNA BAR LIQUID CASH BIAR SINKRON!

                list.innerHTML += `
                    <div>
                        <div class="flex justify-between text-[9px] mb-2 uppercase font-black ${textColor} italic"><span>${name}</span><span>${pct}%</span></div>
                        <div class="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden shadow-inner">
                            <div class="${barColor} h-full transition-all duration-1000" style="width: ${pct}%"></div>
                        </div>
                    </div>`;
            });
        }

        // Render Chart Donat Income Breakdown
        const chartEl = document.getElementById('dashboardChart');
        if (chartEl) {
            const ctx = chartEl.getContext('2d');
            if (window.myDashboardChart) window.myDashboardChart.destroy();
            
            const labelsWithPct = Object.entries(data.incomeSources).map(([label, val]) => {
                const pct = data.totalInflow > 0 ? ((val / data.totalInflow) * 100).toFixed(1) : 0;
                return `${label} (${pct}%)`;
            });

            window.myDashboardChart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: labelsWithPct.length ? labelsWithPct : ['Belum Ada Data'],
                    datasets: [{
                        data: Object.values(data.incomeSources).length ? Object.values(data.incomeSources) : [1],
backgroundColor: labelsWithPct.length ? [
   '#C2410C', // 1. Rust / Bara Api (Untuk Gaji)
    '#0D9488', // 2. Deep Teal / Hijau Zamrud Kebiruan (Untuk WD Profit Trading)
    '#CA8A04', // 3. Dark Gold / Kuning Emas Tua (Untuk Bonus)
    '#6366F1'  // 4. Indigo / Ungu Misterius (Untuk Lain-lain / Rejeki Nomplok)
] : ['#0f172a'], // Slate 900 (Warna kosong yang super gelap nyaris tembus pandang)
borderWidth: 0,
                        //data: Object.values(data.incomeSources).length ? Object.values(data.incomeSources) : [1],
                        //backgroundColor: labelsWithPct.length ? ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'] : ['#1e293b'],
                        //borderWidth: 0
                    }]
                },
                options: { cutout: '75%', plugins: { legend: { position: 'bottom', labels: { color: '#64748b', font: { size: 10, weight: 'bold' }, padding: 20 } } } }
            });
        }
    } catch (err) { console.error("Error Dashboard Logic:", err); }
};


// =========================================================================
// 3. HISTORY TABLE LOGIC (history.html)
// =========================================================================
window.renderHistoryLogic = async () => {
    const historyBody = document.getElementById('historyBody');
    if (!historyBody) return;

    const targetMonth = parseInt(document.getElementById('filter-month').value);
    const targetYear = parseInt(document.getElementById('select-year').value);
    
    if (document.getElementById('display-period')) {
        document.getElementById('display-period').innerText = `Period: ${targetMonth}/${targetYear}`;
    }
    historyBody.innerHTML = '<tr><td colspan="5" class="p-20 text-center text-[9px] text-slate-500 uppercase tracking-widest animate-pulse italic font-black">Syncing...</td></tr>';

    try {
        const transactions = await window.getTransactions(); 
        if (!transactions) return;

        let filtered = transactions.filter(tx => {
            const separator = tx.date.includes('/') ? '/' : '-';
            const parts = tx.date.split(separator);
            let txYear = parts[0].length === 4 ? parseInt(parts[0]) : parseInt(parts[2]);
            let txMonth = parseInt(parts[1]);
            return txMonth === targetMonth && txYear === targetYear;
        });

        historyBody.innerHTML = '';
        if (filtered.length === 0) {
            historyBody.innerHTML = '<tr><td colspan="5" class="p-20 text-center text-[10px] text-slate-600 italic uppercase font-black">No Records Found.</td></tr>';
            return;
        }

        filtered.sort((a,b) => new Date(b.date) - new Date(a.date)).forEach((tx) => {
            const catLower = (tx.kategori || '').toLowerCase();
            const isNegative = tx.type === 'pengeluaran' || (tx.type === 'investasi' && !catLower.includes('jual'));
            const row = document.createElement('tr');
            row.className = "hover:bg-slate-900/40 transition-all group border-b border-slate-800/30";
            row.innerHTML = `
                <td class="p-6 text-[10px] font-mono text-slate-500 font-bold italic pl-8">${tx.date}</td>
                <td class="p-6">
                    <span class="text-[8px] font-black px-2 py-1 rounded-lg border uppercase italic ${tx.type === 'investasi' ? 'text-purple-400 border-purple-500/20' : tx.type === 'pemasukan' ? 'text-blue-400 border-blue-500/20' : 'text-red-400 border-red-500/20'}">${tx.kategori}</span>
                </td>
                <td class="p-6 text-xs font-bold text-slate-300 italic">${tx.note || tx.keterangan || '-'}</td>
                <td class="p-6 text-right font-black ${isNegative ? 'text-red-400' : 'text-green-400'} text-xs italic">${isNegative ? '-' : '+'} Rp ${parseFloat(tx.amount).toLocaleString('id-ID')}</td>
                <td class="p-6 text-center pr-8"><button onclick="triggerDelete(${tx.id})" class="opacity-0 group-hover:opacity-100 text-red-500/70 hover:text-red-500 transition-all text-[9px] font-black uppercase italic bg-red-500/10 px-3 py-1.5 rounded-xl border border-red-500/20">Delete</button></td>
            `;
            historyBody.appendChild(row);
        });
    } catch (err) { console.error("Error History Logic:", err); }
};


// =========================================================================
// 4. MONTHLY REPORT LOGIC (bulanan.html)
// =========================================================================
window.renderMonthlyLogic = async () => {
    const monthEl = document.getElementById('select-month');
    const yearEl = document.getElementById('select-year');
    if (!monthEl || !yearEl || !monthEl.value || !yearEl.value) return;

    const targetMonth = parseInt(monthEl.value);
    const targetYear = parseInt(yearEl.value);
    
    const dummyDate = new Date(targetYear, targetMonth - 1);
    if(document.getElementById('display-month')) {
        document.getElementById('display-month').innerText = dummyDate.toLocaleString('id-ID', { month: 'long', year: 'numeric' }).toUpperCase();
    }

    try {
        const txs = await window.getTransactions();
        if (!txs) return;

        const monthlyTransactions = txs.filter(tx => {
            const separator = tx.date.includes('/') ? '/' : '-';
            const parts = tx.date.split(separator);
            let txYear = parts[0].length === 4 ? parseInt(parts[0]) : parseInt(parts[2]);
            let txMonth = parseInt(parts[1]);
            return txMonth === targetMonth && txYear === targetYear;
        });

        const data = window.calculateAssetSummary(monthlyTransactions);

        if(document.getElementById('total-inflow')) document.getElementById('total-inflow').innerText = window.formatIDR(data.totalInflow);
        if(document.getElementById('total-outflow')) document.getElementById('total-outflow').innerText = window.formatIDR(data.totalOutflow);
        if(document.getElementById('total-invest')) document.getElementById('total-invest').innerText = window.formatIDR(data.totalInvest);
        if(document.getElementById('total-cair-brankas')) document.getElementById('total-cair-brankas').innerText = window.formatIDR(data.totalCairBrankas); 

        //const net = data.totalInflow - data.totalOutflow;
        //const insightText = document.getElementById('insight-text');
        //if (insightText) {
            //if (data.totalInflow > 0 || data.totalOutflow > 0) {
                //let kUtama = `Sisa saldo bersih kamu periode ini terhitung sebesar <b>${window.formatIDR(net)}</b>.`;
                //let kAnalisis = "", kSaran = "";

                //if (net >= 0) {
                    //kAnalisis = ` 🔥 <b>Cashflow Positif.</b> Kamu berhasil mempertahankan <b>${data.retentionRate}%</b> dari total pemasukan bulan ini untuk dialokasikan ke tingkat keamanan finansial.`;
                    //kSaran = parseFloat(data.retentionRate) >= 50 
                        //? ` Sistem mendeteksi Retention Rate di atas standar premium (50%). Sisa dana ini sangat ideal jika langsung di-scale up ke instrumen investasi aktif atau mempertebal Dana Darurat kamu.`
                        //: ` Struktur pengeluaran tergolong stabil, namun alokasi ke aset masih bisa ditingkatkan lagi di periode berikutnya. Batasi belanja impulsif harian/lifestyle.`;
                //} else {
                    //kAnalisis = ` ⚠️ <b>Cashflow Negatif Defisit.</b> Pengeluaran konsumsi kamu membengkak melampaui kapasitas pendapatan bulan ini.`;
                    //kSaran = ` Tunda konsumsi tidak mendesak, utamakan pengisian tangki Liquid Cash dan potong pengeluaran lifestyle minimal 20% untuk memulihkan modal kamu.`;
                //}
                
                //if (data.totalCairBrankas > 0) {
                    //kSaran += `<br><br>🛡️ <b>Strategic Activation Notice:</b> Terdeteksi total pencairan cadangan sebesar <b>${window.formatIDR(data.totalCairBrankas)}</b> di bulan ini sebagai benteng pertahanan kas utama atau eksekusi ambil profit.`;
                //}
                
                //insightText.innerHTML = `${kUtama}<br><br>${kAnalisis}<br><br>${kSaran}`;
            //} else {
                //insightText.innerText = "Tidak ada catatan log aktivitas keuangan terdeteksi pada periode bulan ini.";
            //}
        //}

        const net = data.totalInflow - data.totalOutflow;
const insightText = document.getElementById('insight-text');

if (!insightText) return;

if (data.totalInflow <= 0 && data.totalOutflow <= 0) {
    insightText.innerHTML = `
        <div class="text-slate-400">
            Tidak ada aktivitas keuangan bulan ini.
        </div>
    `;
    return;
}

let status = "";
let analysis = "";
let recommendation = "";

const healthyOutflow =
    data.totalAset +
    data.totalDanaDarurat +
    data.totalModalTrading;

const healthyRatio =
    (healthyOutflow / data.totalOutflow) * 100;

if (net >= 0) {

    status = `
        <div class="text-emerald-400 font-bold text-lg">
            🟢 CASHFLOW POSITIVE
        </div>
    `;

    analysis = `
        Saldo bersih bulan ini sebesar
        <b>${window.formatIDR(net)}</b>.
        <br><br>
        Retention Rate berada di level
        <b>${data.retentionRate}%</b>.
    `;

    recommendation =
        healthyRatio >= 50
        ? `Sebagian besar outflow dialokasikan ke aktivitas produktif dan pembangunan aset.`
        : `Cashflow stabil, namun alokasi ke aset masih bisa ditingkatkan.`;

} else {

    status = `
        <div class="text-red-400 font-bold text-lg">
            🔴 CASHFLOW DEFICIT
        </div>
    `;

    analysis = `
        Defisit bulan ini sebesar
        <b>${window.formatIDR(Math.abs(net))}</b>.
        <br><br>
        Pengeluaran melampaui kapasitas pemasukan bulanan.
    `;

    recommendation =
        healthyRatio >= 50
        ? `Walaupun cashflow negatif, sebagian besar outflow masih dialokasikan ke aset dan proteksi finansial.`
        : `Kurangi pengeluaran lifestyle dan prioritaskan liquid cash.`;
}

let strategicNotice = "";

if (data.totalCairBrankas > 0) {
    strategicNotice = `
        <div class="mt-4 text-orange-300 text-sm">
            🛡️ Strategic Notice:
            Terdeteksi pencairan cadangan sebesar
            <b>${window.formatIDR(data.totalCairBrankas)}</b>.
        </div>
    `;
}

insightText.innerHTML = `
    <div class="space-y-4">

        ${status}

        <div class="text-slate-300 leading-relaxed">
            ${analysis}
        </div>

        <div class="bg-slate-800/50 border border-slate-700 rounded-2xl p-4 text-slate-200">
            💡 ${recommendation}
        </div>

        ${strategicNotice}

    </div>
`;

        //window.renderDoughnutChart('chartInflow', data.incomeSources, '#3b82f6', window.chartIn, (c) => window.chartIn = c);
        //window.renderDoughnutChart('chartOutflow', data.allocations, '#ef4444', window.chartOut, (c) => window.chartOut = c);
        // ==========================================
     // ==========================================
        // 1. RENDER CHART INFLOW (GRADASI BIRU MONOKROM)
        // ==========================================
        const chartInEl = document.getElementById('chartInflow');
        if (chartInEl) {
            const ctxIn = chartInEl.getContext('2d');
            if (window.chartIn) window.chartIn.destroy();
            
            const labelsIn = Object.keys(data.incomeSources);
            const valuesIn = Object.values(data.incomeSources);
            
            // Palet gradasi biru (dari cerah ke gelap elegan)
            const bluePalette = [
                '#3B82F6', // Blue 500 (Biru Terang)
                '#2563EB', // Blue 600
                '#1D4ED8', // Blue 700
                '#1E40AF', // Blue 800
                '#1E3A8A'  // Blue 900 (Biru Sangat Gelap)
            ];

            // Bikin warnanya otomatis ngambil dari palet berurutan
            const inflowColors = labelsIn.map((label, index) => {
                return bluePalette[index % bluePalette.length];
            });

            window.chartIn = new Chart(ctxIn, {
                type: 'doughnut',
                data: {
                    labels: labelsIn.length ? labelsIn : ['Belum Ada Data'],
                    datasets: [{
                        data: valuesIn.length ? valuesIn : [1],
                        backgroundColor: labelsIn.length ? inflowColors : ['#0f172a'],
                        borderWidth: 0,
                        hoverOffset: 4
                    }]
                },
                options: { 
                    cutout: '75%', 
                    maintainAspectRatio: false, 
                    plugins: { 
                        legend: { 
                            display: true, 
                            position: 'bottom',
                            labels: { 
                                color: '#94a3b8', 
                                font: { size: 9, weight: 'normal' }, 
                                padding: 10,
                                usePointStyle: true, 
                                boxWidth: 6,
                                boxHeight: 6
                            } 
                        } 
                    } 
                }
            });
        }

        // ==========================================
        // 2. RENDER CHART OUTFLOW (GRADASI WARNA & LEGEND)
        // ==========================================
        const chartOutEl = document.getElementById('chartOutflow');
        if (chartOutEl) {
            const ctxOut = chartOutEl.getContext('2d');
            if (window.chartOut) window.chartOut.destroy();
            
            const labelsOut = Object.keys(data.allocations);
            const valuesOut = Object.values(data.allocations);
            
            // Siapkan palet warna merah (dari terang ke gelap) untuk konsumtif
            const redPalette = [
                '#F43F5E', // Rose 500 (Merah Terang)
                '#E11D48', // Rose 600 (Merah Standar)
                '#BE123C', // Rose 700 (Merah Gelap)
                '#9F1239'  // Rose 800 (Merah Sangat Gelap)
            ];
            let redIndex = 0; // Penghitung urutan warna merah

            // Racik warna dinamis sesuai kategori
            const outflowColors = labelsOut.map(label => {
                const nameLower = label.toLowerCase();
                
                if (nameLower.includes('aset') || nameLower.includes('investasi') || nameLower.includes('beli')) {
                    return '#10B981'; // Hijau (Emerald)
                } 
                else if (nameLower.includes('darurat')) {
                    return '#F59E0B'; // Emas (Amber)
                } 
                else if (nameLower.includes('ortu') || nameLower.includes('tua')) {
                    return '#3B82F6'; // Biru (Blue)
                } 
                else {
                    // Ambil warna merah secara berurutan biar ketebalannya beda-beda
                    const selectedRed = redPalette[redIndex % redPalette.length];
                    redIndex++; // Geser ke merah berikutnya
                    return selectedRed;
                }
            });

            window.chartOut = new Chart(ctxOut, {
                type: 'doughnut',
                data: {
                    labels: labelsOut.length ? labelsOut : ['Belum Ada Data'],
                    datasets: [{
                        data: valuesOut.length ? valuesOut : [1],
                        backgroundColor: labelsOut.length ? outflowColors : ['#0f172a'],
                        borderWidth: 0,
                        hoverOffset: 4
                    }]
                },
                options: { 
                    cutout: '75%', 
                    maintainAspectRatio: false, // Tambahin ini biar dia lebih fleksibel
                    plugins: { 
                        legend: { 
                            display: true, 
                            position: 'bottom',
                            labels: { 
                                color: '#94a3b8', 
                                font: { 
                                    size: 9, // Font dikecilin dari 10 ke 9
                                    weight: 'normal' // Dibuat normal aja biar ngga terlalu padat
                                }, 
                                padding: 10, // Jarak antar tulisan dirapatkan
                                usePointStyle: true,
                                boxWidth: 6, // Mengecilkan ukuran buletan warna
                                boxHeight: 6
                            } 
                        } 
                    } 
                }
            });
        }


    } catch (err) { console.error("Error Monthly Logic:", err); }
};


// =========================================================================
// 5. YEARLY REPORT LOGIC (tahunan.html)
// =========================================================================
window.renderYearlyLogic = async () => {
    const selectEl = document.getElementById('select-year');
    if (!selectEl || !selectEl.value) return;
    const targetYear = parseInt(selectEl.value);
    
    if(document.getElementById('display-year')) {
        document.getElementById('display-year').innerText = `ANNUAL PERFORMANCE // TAHUN ${targetYear}`;
    }

    try {
        const txs = await window.getTransactions();
        if (!txs) return;

        const inflowData = new Array(12).fill(0), outflowData = new Array(12).fill(0);
        const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MEI', 'JUN', 'JUL', 'AGU', 'SEP', 'OKT', 'NOV', 'DES'];

        for (let m = 1; m <= 12; m++) {
            const monthlyTx = txs.filter(tx => {
                const separator = tx.date.includes('/') ? '/' : '-';
                const parts = tx.date.split(separator);
                let txYear = parts[0].length === 4 ? parseInt(parts[0]) : parseInt(parts[2]);
                let txMonth = parseInt(parts[1]);
                return txYear === targetYear && txMonth === m;
            });

            const summaryBulan = window.calculateAssetSummary(monthlyTx);
            inflowData[m - 1] = summaryBulan.totalInflow;
            outflowData[m - 1] = summaryBulan.totalOutflow;
        }

        const yearlyTransactions = txs.filter(tx => {
            const separator = tx.date.includes('/') ? '/' : '-';
            const parts = tx.date.split(separator);
            let txYear = parts[0].length === 4 ? parseInt(parts[0]) : parseInt(parts[2]);
            return txYear === targetYear;
        });

        const dataTahunan = window.calculateAssetSummary(yearlyTransactions);

        if(document.getElementById('annual-inflow')) document.getElementById('annual-inflow').innerText = window.formatIDR(dataTahunan.totalInflow);
        if(document.getElementById('annual-outflow')) document.getElementById('annual-outflow').innerText = window.formatIDR(dataTahunan.totalOutflow);
        if(document.getElementById('annual-invest')) document.getElementById('annual-invest').innerText = window.formatIDR(dataTahunan.totalInvest);
        if(document.getElementById('annual-cair')) document.getElementById('annual-cair').innerText = window.formatIDR(dataTahunan.totalCairBrankas);
        if(document.getElementById('annual-net')) document.getElementById('annual-net').innerText = window.formatIDR(dataTahunan.liquidCash);

        const insightText = document.getElementById('insight-text');
        if (insightText) {
            if (dataTahunan.totalInflow > 0 || dataTahunan.totalOutflow > 0) {
                const annualInvestmentRate = dataTahunan.totalInflow > 0 ? ((dataTahunan.totalInvest / dataTahunan.totalInflow) * 100) : 0;
                let kUtama = `Evaluasi makro performa finansial Bayu di Tahun ${targetYear} mencatatkan sisa Liquid Cash berjalan sebesar <b>${window.formatIDR(dataTahunan.liquidCash)}</b>.`;
                let kAnalisis = "", kSaran = "";

                if (dataTahunan.liquidCash >= 0) {
                    kAnalisis = ` 🔥 <b>Sistem Berjalan Optimal.</b> Sepanjang tahun ini, kamu sukses mempertahankan <b>${dataTahunan.retentionRate}%</b> pendapatan lo bebas dari konsumsi murni, di mana sebesar <b>${annualInvestmentRate.toFixed(1)}%</b> sukses dikonversi menjadi modal aman (Investment Base).`;
                    kSaran = annualInvestmentRate >= 30 
                        ? ` Tingkat ketahanan tahunan lo berada di zona prima. Manajemen psikologi trading dan efisiensi budgeting lo membuahkan hasil nyata. Pertahankan stamina!`
                        : ` Aliran kas tahunan surplus, namun porsi alokasi ke Investment Base masih bisa di-scale up lagi di tahun depan. Batasi bocor alus pengeluaran lifestyle.`;
                } else {
                    kAnalisis = ` ⚠️ <b>Krisis Defisit Kas Makro.</b> Rekam jejak menunjukkan akumulasi beban pengeluaran tahunan kamu membengkak parah melampaui batas income arus kas masuk.`;
                    kSaran = ` Segera lakukan audit forensik pada jurnal keuangan lo! Terapkan rem darurat pengeluaran non-prioritas secara disiplin dan fokuslah membangun fondasi Liquid Cash kembali.`;
                }
                
                if (dataTahunan.totalCairBrankas > 0) {
                    kSaran += `<br><br>📊 <b>Annual Liquid Report:</b> Sepanjang tahun ini, kamu tercatat telah me-likuidasi/mencairkan total dana dari pos brankas sebesar <b>${window.formatIDR(dataTahunan.totalCairBrankas)}</b> untuk pengaman cadangan atau realisasi ambil profit.`;
                }

                insightText.innerHTML = `${kUtama}<br><br>${kAnalisis}<br><br>${kSaran}`;
            } else {
                insightText.innerText = `Belum ada rekaman log transaksi makro yang terdata di cloud sepanjang periode Tahun ${targetYear}.`;
            }
        }

        const chartEl = document.getElementById('yearlyChart');
        if (chartEl) {
            const ctx = chartEl.getContext('2d');
            if (window.myYearlyChart) window.myYearlyChart.destroy();
            window.myYearlyChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: monthNames,
                    datasets: [
                        { label: 'Inflow', data: inflowData, backgroundColor: '#3b82f6', borderRadius: 8 },
                        { label: 'Outflow', data: outflowData, backgroundColor: '#ef4444', borderRadius: 8 }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { labels: { color: '#64748b', font: { size: 10, weight: 'bold' } } } },
                    scales: {
                        y: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#64748b', font: { size: 9, weight: 'bold' } } },
                        x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 9, weight: 'bold' } } }
                    }
                }
            });
        }
    } catch (err) { console.error("Error Yearly Logic:", err); }
};


// =========================================================================
// 6. ASSET PORTFOLIO LOGIC (aset.html) - EMERGENCIED LINE BACKUP
// =========================================================================
window.renderAssetLogic = async () => {
    try {
        const transactions = await window.getTransactions();
        const data = window.calculateAssetSummary(transactions);
        const portfolioBody = document.getElementById('portfolioBody') || document.getElementById('active-portfolio-list');
        
        if (portfolioBody) {
            portfolioBody.innerHTML = '';
            const assets = Object.entries(data.assetMap).filter(([_, asset]) => asset.unit > 0);
            
            if (assets.length === 0) {
                portfolioBody.innerHTML = `<div class="p-8 text-center text-[10px] text-slate-500 italic uppercase font-black tracking-widest">KAS MURNI BERJALAN // BELUM ADA PORTFOLIO ASET TERDATA</div>`;
                return;
            }

            assets.forEach(([name, asset]) => {
                portfolioBody.innerHTML += `
                    <div class="flex justify-between items-center bg-slate-900/60 p-4 rounded-2xl border border-slate-800/40 mb-3 hover:border-blue-500/20 transition-all">
                        <div>
                            <p class="text-[10px] font-black text-white uppercase tracking-wider italic">${name}</p>
                            <p class="text-[9px] font-bold text-slate-500 mt-0.5">AVG BUY: ${window.formatIDR(asset.avgPrice)}</p>
                        </div>
                        <div class="text-right">
                            <p class="text-xs font-black text-blue-400 italic">${asset.unit.toLocaleString('id-ID')} ${asset.type}</p>
                            <p class="text-[9px] font-bold text-slate-400 mt-0.5">${window.formatIDR(asset.modal)}</p>
                        </div>
                    </div>`;
            });
        }
    } catch (err) { console.error("Error Asset Logic Core:", err); }
};


// =========================================================================
// RE-USABLE INTERACTION HELPERS
// =========================================================================

// Global Helper untuk Chart Donut Laporan Bulanan
//window.renderDoughnutChart = (canvasId, dataMap, primaryColor, existingChart, saveInstanceCallback) => {
    //const chartEl = document.getElementById(canvasId);
    //if (!chartEl) return;
    //const ctx = chartEl.getContext('2d');
    //const labels = Object.keys(dataMap);
    //const values = Object.values(dataMap);
    
    //if (existingChart) existingChart.destroy();

    //const colors = primaryColor === '#3b82f6'
        //? ['#3b82f6', '#60a5fa', '#2563eb', '#93c5fd'] 
        //: ['#ef4444', '#f87171', '#dc2626', '#fca5a5', '#1e293b'];

    //const newChart = new Chart(ctx, {
        //type: 'doughnut',
        //data: {
            //labels: labels.length ? labels : ['Belum Ada Data'],
            //datasets: [{
                //data: values.length ? values : [1],
                //backgroundColor: labels.length ? colors : ['#1e293b'],
                //borderWidth: 0
            //}]
        //},
        //options: {
            //plugins: { legend: { position: 'bottom', labels: { color: '#64748b', font: { size: 9, weight: 'bold' } } } },
            //cutout: '75%', responsive: true, maintainAspectRatio: false
        //}
    //});
    //saveInstanceCallback(newChart);
//};

// Global Moving Window Dropdown Generator (Anti-Stuck)
window.generateYearOptions = (selectedYear) => {
    const selectYear = document.getElementById('select-year');
    if (!selectYear) return;
    
    const currentSelected = parseInt(selectedYear);
    let startYear = currentSelected - 1;
    let endYear = currentSelected + 1; 
    
    if (startYear < 2024) { startYear = 2024; endYear = 2026; }

    selectYear.innerHTML = ''; 
    for (let y = startYear; y <= endYear; y++) {
        const opt = document.createElement('option');
        opt.value = y; opt.text = `TAHUN ${y}`;
        if (y === currentSelected) opt.selected = true;
        selectYear.appendChild(opt);
    }
};

// JAM DIGITAL SISTEM PUSAT REALTIME
if (typeof window.startClock !== 'function') {
    window.startClock = () => {
        const display = document.getElementById('current-date-display');
        if (!display) return;
        setInterval(() => {
            const now = new Date();
            const options = { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' };
            const dateStr = now.toLocaleDateString('id-ID', options).toUpperCase();
            const timeStr = now.toLocaleTimeString('en-GB', { hour12: false });
            display.innerText = `${dateStr} // ${timeStr}`;
        }, 1000);
    };
}
