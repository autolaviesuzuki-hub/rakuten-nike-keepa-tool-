// =========================================================
// app.js  完全修正版（index.html と ID を完全一致）
// =========================================================

// ---- グローバル状態 ----
let rakutenRows = [];      // 楽天CSVの生データ行
let keepaRows = [];        // Keepa CSVの生データ行
let keepaHeader = [];      // Keepaヘッダー
let resultRows = [];       // 照合結果（Excel出力用）
let keepaByPart = new Map(); // PartNumber → Keepa行配列

// ---- DOM取得（index.html と完全一致） ----
const rakutenInput = document.getElementById('rakutenCsvInput');
const keepaInput = document.getElementById('keepaCsvInput');

const matchButton = document.getElementById('runMatchBtn');          // ★修正
const exportButton = document.getElementById('exportExcelBtn');      // ★修正
const rawCsvBtn = document.getElementById('exportRawCsvBtn');

const resultTableBody = document.querySelector('#resultTable tbody'); // ★修正
const statusArea = document.getElementById('matchStatus');            // ★修正
const keywordInput = document.getElementById('searchKeywordInput');   // ★修正

const logArea = document.getElementById('logArea');

// ---- ユーティリティ ----
function setStatus(message) {
  if (statusArea) statusArea.textContent = message;
}

function log(message) {
  if (!logArea) return;
  const time = new Date().toLocaleTimeString();
  logArea.innerHTML += `\n[${time}] ${message}`;
  logArea.scrollTop = logArea.scrollHeight;
}

function sanitizeNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  const s = String(value).replace(/,/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

// ---- Keepaインデックス作成 ----
function buildKeepaIndex() {
  keepaByPart.clear();
  if (!keepaRows.length || !keepaHeader.length) return;

  const idxPart = keepaHeader.indexOf('商品コード: PartNumber');
  if (idxPart === -1) return;

  keepaRows.forEach(row => {
    const part = (row[idxPart] || '').trim();
    if (!part) return;
    if (!keepaByPart.has(part)) {
      keepaByPart.set(part, []);
    }
    keepaByPart.get(part).push(row);
  });
}

// ---- 型番抽出 ----
function extractModelCode(productName) {
  if (!productName) return '';

  const name = productName.toUpperCase();

  // 1. Keepa PartNumber が商品名に含まれているか
  for (const part of keepaByPart.keys()) {
    const p = part.toUpperCase();
    if (p && name.includes(p)) {
      return part;
    }
  }

  // 2. 正規表現で抽出
  const regex = /[A-Z0-9]{2,}-\d{3}/g;
  const matches = name.match(regex);
  if (matches && matches.length) {
    return matches[0];
  }

  // 3. NIKE FB2207-005 のようなパターン
  const regexNike = /NIKE\s+([A-Z0-9]{2,}-\d{3})/i;
  const m2 = productName.match(regexNike);
  if (m2 && m2[1]) {
    return m2[1];
  }

  return '';
}

// ---- Keepa CSV読込 ----
function loadKeepaCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      encoding: 'UTF-8',
      skipEmptyLines: true,
      complete: (results) => {
        if (!results || !results.data || results.data.length < 2) {
          return reject(new Error('Keepa CSVの内容が不正です'));
        }
        keepaHeader = results.data[0];
        keepaRows = results.data.slice(1);
        buildKeepaIndex();
        resolve();
      },
      error: (err) => reject(err)
    });
  });
}

// ---- 楽天 CSV読込 ----
function loadRakutenCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      encoding: 'UTF-8',
      skipEmptyLines: true,
      complete: (results) => {
        if (!results || !results.data || results.data.length < 2) {
          return reject(new Error('楽天CSVの内容が不正です'));
        }

        const header = results.data[0];
        const rows = results.data.slice(1);

        const idxShop = header.indexOf('購入先（ショップ名）');
        const idxName = header.indexOf('商品名');
        const idxModelCol = header.indexOf('商品名（型番）');
        const idxUrl = header.indexOf('楽天URL');
        const idxPrice = header.indexOf('単価');

        if (idxShop === -1 || idxName === -1 || idxUrl === -1 || idxPrice === -1) {
          return reject(new Error('楽天CSVのヘッダーが想定と異なります'));
        }

        rakutenRows = rows.map(row => {
          const shop = row[idxShop] || '';
          const name = row[idxName] || '';
          const modelCell = idxModelCol !== -1 ? (row[idxModelCol] || '') : '';
          const url = row[idxUrl] || '';
          const price = sanitizeNumber(row[idxPrice]);

          const model = modelCell || extractModelCode(name);

          return {
            shop,
            name,
            model,
            url,
            price
          };
        });

        resolve();
      },
      error: (err) => reject(err)
    });
  });
}

// ---- Keepa価格情報 ----
function getKeepaPriceInfo(row) {
  if (!row || !keepaHeader.length) return null;

  const idxASIN = keepaHeader.indexOf('ASIN');
  const idxPart = keepaHeader.indexOf('商品コード: PartNumber');
  const idxBuyBox = keepaHeader.indexOf('Buy Box: 現在価格');
  const idxFbaLowest = keepaHeader.indexOf('新しい、第三者FBA: 現在価格');
  const idxFbaFee = keepaHeader.indexOf('FBA Pick&Pack 料金');
  const idxReferralPct = keepaHeader.indexOf('紹介料％');

  const asin = idxASIN !== -1 ? (row[idxASIN] || '').trim() : '';
  const part = idxPart !== -1 ? (row[idxPart] || '').trim() : '';

  const buyBox = idxBuyBox !== -1 ? sanitizeNumber(row[idxBuyBox]) : NaN;
  const fbaLowest = idxFbaLowest !== -1 ? sanitizeNumber(row[idxFbaLowest]) : NaN;
  const fbaFee = idxFbaFee !== -1 ? sanitizeNumber(row[idxFbaFee]) : NaN;
  const referralPct = idxReferralPct !== -1 ? sanitizeNumber(row[idxReferralPct]) : NaN;

  let listingPrice = !isNaN(buyBox) && buyBox > 0 ? buyBox :
                     (!isNaN(fbaLowest) && fbaLowest > 0 ? fbaLowest : NaN);

  if (isNaN(listingPrice)) {
    return { asin, part, listingPrice: NaN, netPerUnit: NaN };
  }

  const referralFee = !isNaN(referralPct) ? listingPrice * (referralPct / 100.0) : 0;
  const fba = !isNaN(fbaFee) ? fbaFee : 0;

  const netPerUnit = Math.round(listingPrice - referralFee - fba);

  return { asin, part, listingPrice, netPerUnit };
}

// ---- 楽天行とKeepa照合 ----
function matchRakutenRow(row) {
  const model = (row.model || '').trim();
  if (!model) return null;

  const candidates = keepaByPart.get(model);
  if (candidates && candidates.length) {
    let best = null;
    candidates.forEach(c => {
      const info = getKeepaPriceInfo(c);
      if (!info) return;
      if (!best || (info.netPerUnit || -999999) > (best.netPerUnit || -999999)) {
        best = { keepaRow: c, info };
      }
    });
    return best;
  }

  let fallback = null;
  const idxModel = keepaHeader.indexOf('モデル');
  const idxTitle = keepaHeader.indexOf('商品名');

  keepaRows.forEach(c => {
    const title = idxTitle !== -1 ? (c[idxTitle] || '') : '';
    const modelCell = idxModel !== -1 ? (c[idxModel] || '') : '';
    const text = (title + ' ' + modelCell).toUpperCase();
    if (text.includes(model.toUpperCase())) {
      const info = getKeepaPriceInfo(c);
      if (!info) return;
      if (!fallback || (info.netPerUnit || -999999) > (fallback.info.netPerUnit || -999999)) {
        fallback = { keepaRow: c, info };
      }
    }
  });

  return fallback;
}

// ---- 照合実行 ----
function runMatching() {
  if (!rakutenRows.length) {
    setStatus('楽天CSVが読み込まれていません');
    return;
  }
  if (!keepaRows.length) {
    setStatus('Keepa CSVが読み込まれていません');
    return;
  }

  const keyword = (keywordInput && keywordInput.value || '').trim();
  const filteredRakuten = keyword
    ? rakutenRows.filter(r => r.name.includes(keyword))
    : rakutenRows;

  resultRows = [];

  filteredRakuten.forEach((r, index) => {
    const match = matchRakutenRow(r);
    if (!match || !match.info) {
      resultRows.push({
        shop: r.shop,
        name: r.name,
        model: r.model || '',
        rakutenUrl: r.url,
        unitPrice: r.price,
        asin: '',
        amazonUrl: '',
        listingPrice: NaN,
        netPerUnit: NaN
      });
      return;
    }

    const info = match.info;
    const asin = info.asin || '';
    const amazonUrl = asin ? `https://www.amazon.co.jp/dp/${asin}` : '';

    resultRows.push({
      shop: r.shop,
      name: r.name,
      model: info.part || r.model || '',
      rakutenUrl: r.url,
      unitPrice: r.price,
      asin,
      amazonUrl,
      listingPrice: info.listingPrice,
      netPerUnit: info.netPerUnit
    });
  });

  renderResultTable();
  setStatus(`型番一致 ${resultRows.filter(r => r.asin).length}件。Excel 出力可能です。`);
  updateButtons();
}

// ---- テーブル描画 ----
function renderResultTable() {
  if (!resultTableBody) return;
  resultTableBody.innerHTML = '';

  resultRows.forEach((r, idx) => {
    const tr = document.createElement('tr');

    tr.innerHTML = `
      <td>${r.shop || ''}</td>
      <td>${r.name || ''}</td>
      <td>${r.model || ''}</td>
      <td><a href="${r.rakutenUrl || '#'}" target="_blank">楽天</a></td>
      <td>${isNaN(r.unitPrice) ? '' : Math.round(r.unitPrice)}</td>
      <td>${r.asin || ''}</td>
      <td>${r.amazonUrl ? `<a href="${r.amazonUrl}" target="_blank">Amazon</a>` : ''}</td>
      <td>${isNaN(r.listingPrice) ? '' : Math.round(r.listingPrice)}</td>
      <td>${isNaN(r.netPerUnit) ? '' : Math.round(r.netPerUnit)}</td>
    `;

    resultTableBody.appendChild(tr);
  });
}

// ---- ExcelテンプレCSV出力 ----
function exportToExcelTemplateCsv() {
  if (!resultRows.length) {
    setStatus('照合結果がありません');
    return;
  }

  const header = [
    '購入年月日','購入先','商品名','商品名(型番)','URL','単価','個数','価格','値引','送料','請求額',
    '火・木 プレミアムカードデー','5の日','ワンダフル','18日','イーグルス等','ママ割','マイカー割','リピート','直前','39ショップ','店舗',
    '基本還元率','楽天モバイル＋会員ランク特典','楽天カード通常分','楽天カード特典分','楽天銀行＋楽天カード（引落）',
    'マラソン①','マラソン②','マラソン③','ポイントアップ祭り','イーグルス他','39ショップ(ポイント)','火・木 プレミアムカードデー(ポイント)',
    '5の日(ポイント)','ワンダフル(ポイント)','18日(ポイント)','店舗(ポイント)','合計ポイント','実質購入金額','実質購入単価',
    'ASIN','Amazon等販売先URL','出品価格','入金予定[円/個]','予定利益/個','予定総利益','SKU例'
  ];

  const rows = [];

  resultRows.forEach((r, idx) => {
    const qty = 1;
    const price = isNaN(r.unitPrice) ? 0 : Math.round(r.unitPrice);
    const total = price * qty;
    const shipping = 0;
    const discount = 0;
    const billed = total + shipping - discount;
    const net = isNaN(r.netPerUnit) ? 0 : Math.round(r.netPerUnit);
    const profitPer = net - price;
    const profitTotal = profitPer * qty;
    const sku = `20260819_${idx}-0`;

    rows.push([
      '',
      r.shop,
      r.name,
      r.model,
      r.rakutenUrl,
      price,
      qty,
      total,
      discount,
      shipping,
      billed,
      '', '', '', '', '', '', '', '', '', '', '',
      '', '', '', '', '',
      '', '', '', '', '', '', '', '', '', '', '', '', '',
      r.asin,
      r.amazonUrl,
      isNaN(r.listingPrice) ? '' : Math.round(r.listingPrice),
      isNaN(r.netPerUnit) ? '' : Math.round(r.netPerUnit),
      profitPer,
      profitTotal,
      sku
    ]);
  });

  const csv = Papa.unparse([header, ...rows]);

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '楽天ポイント集計用_照合結果.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  setStatus('Excelテンプレ用CSVを出力しました');
}

// ---- RAW CSV出力 ----
function exportRawCsv() {
  if (!resultRows.length) {
    setStatus('照合結果がありません');
    return;
  }

  const header = [
    '購入先（ショップ名）','商品名','商品名（型番）','楽天URL','単価',
    'ASIN','Amazon等販売先URL','出品価格','入金予定[円/個]'
  ];

  const rows = resultRows.map(r => [
    r.shop,
    r.name,
    r.model,
    r.rakutenUrl,
    isNaN(r.unitPrice) ? '' : Math.round(r.unitPrice),
    r.asin,
    r.amazonUrl,
    isNaN(r.listingPrice) ? '' : Math.round(r.listingPrice),
    isNaN(r.netPerUnit) ? '' : Math.round(r.netPerUnit)
  ]);

  const csv = Papa.unparse([header, ...rows]);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = '照合結果_raw.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  setStatus('RAW CSVを出力しました');
}

// ---- ボタンイベント ----
if (matchButton) {
  matchButton.addEventListener('click', () => {
    runMatching();
  });
}

if (exportButton) {
  exportButton.addEventListener('click', () => {
    exportToExcelTemplateCsv();
  });
}

if (rawCsvBtn) {
  rawCsvBtn.addEventListener('click', () => {
    exportRawCsv();
  });
}

// ---- 初期化 ----
log('app.js 初期化完了');
updateButtons();

function updateButtons() {
  const ready = rakutenRows.length > 0 && keepaRows.length > 0;
  if (matchButton) matchButton.disabled = !ready;
  if (exportButton) exportButton.disabled = resultRows.length === 0;
  if (rawCsvBtn) rawCsvBtn.disabled = resultRows.length === 0;
}
