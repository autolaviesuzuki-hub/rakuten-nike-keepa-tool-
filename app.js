// app.js Part 1/3

// ---- グローバル状態 ----
let rakutenRows = [];      // 楽天CSVの生データ行
let keepaRows = [];        // Keepa CSVの生データ行
let keepaHeader = [];      // Keepaヘッダー
let resultRows = [];       // 照合結果（Excel出力用）
let keepaByPart = new Map(); // PartNumber → Keepa行配列

// ---- DOM取得 ----
const rakutenInput = document.getElementById('rakutenCsvInput');
const keepaInput = document.getElementById('keepaCsvInput');
const matchButton = document.getElementById('matchButton');
const exportButton = document.getElementById('exportExcelButton');
const resultTableBody = document.getElementById('resultTableBody');
const statusArea = document.getElementById('statusArea');
const keywordInput = document.getElementById('searchKeyword');

// ---- ユーティリティ ----
function setStatus(message) {
  if (statusArea) statusArea.textContent = message;
}

function sanitizeNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  const s = String(value).replace(/,/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

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

// ---- 型番抽出ロジック ----
// 1. KeepaのPartNumber一覧から商品名に含まれるものを優先
// 2. 見つからなければ正規表現で英数字+ハイフン+数字を抽出
function extractModelCode(productName) {
  if (!productName) return '';

  const name = productName.toUpperCase();

  // 1. Keepa PartNumberから曖昧照合
  for (const part of keepaByPart.keys()) {
    const p = part.toUpperCase();
    if (p && name.includes(p)) {
      return part;
    }
  }

  // 2. 正規表現で拾う（例: HJ8485-001, FB2207-005, DV4023-003 など）
  const regex = /[A-Z0-9]{2,}-\d{3}/g;
  const matches = name.match(regex);
  if (matches && matches.length) {
    return matches[0];
  }

  // 3. NIKE FB2207-005 のような「NIKE + 型番」パターン
  const regexNike = /NIKE\s+([A-Z0-9]{2,}-\d{3})/i;
  const m2 = productName.match(regexNike);
  if (m2 && m2[1]) {
    return m2[1];
  }

  return '';
}

// ---- Keepa CSV読込（PapaParse） ----
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

// ---- 楽天 CSV読込（PapaParse） ----
function loadRakutenCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      encoding: 'UTF-8',
      skipEmptyLines: true,
      complete: (results) => {
        if (!results || !results.data || results.data.length < 2) {
          return reject(new Error('楽天CSVの内容が不正です'));
        }
        // 1行目はヘッダー想定
        const header = results.data[0];
        const rows = results.data.slice(1);

        // 必須列のインデックス
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

// ---- ファイル入力イベント ----
if (keepaInput) {
  keepaInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      setStatus('Keepa CSV 読込中...');
      await loadKeepaCsv(file);
      setStatus(`Keepa CSV 読込完了（${keepaRows.length}件）`);
    } catch (err) {
      console.error(err);
      setStatus('Keepa CSV 読込エラー');
    }
  });
}

if (rakutenInput) {
  rakutenInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      setStatus('楽天CSV 読込中...');
      await loadRakutenCsv(file);
      setStatus(`楽天CSV 読込完了（${rakutenRows.length}件）`);
    } catch (err) {
      console.error(err);
      setStatus('楽天CSV 読込エラー');
    }
  });
}
// app.js Part 2/3

// ---- Keepa行から価格・手数料・ASINを取得 ----
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

  // 出品価格：BuyBoxがあればそれ、なければFBA最安値
  let listingPrice = !isNaN(buyBox) && buyBox > 0 ? buyBox : (!isNaN(fbaLowest) && fbaLowest > 0 ? fbaLowest : NaN);

  if (isNaN(listingPrice)) {
    return {
      asin,
      part,
      listingPrice: NaN,
      netPerUnit: NaN
    };
  }

  const referralFee = !isNaN(referralPct) ? listingPrice * (referralPct / 100.0) : 0;
  const fba = !isNaN(fbaFee) ? fbaFee : 0;

  const netPerUnit = Math.round(listingPrice - referralFee - fba);

  return {
    asin,
    part,
    listingPrice,
    netPerUnit
  };
}

// ---- 楽天1行とKeepaの照合 ----
function matchRakutenRow(row) {
  const model = (row.model || '').trim();
  if (!model) return null;

  // 1. PartNumber完全一致
  const candidates = keepaByPart.get(model);
  if (candidates && candidates.length) {
    // サイズ違いなど複数ある場合は「入金予定」が最大のものを選ぶ
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

  // 2. モデル文字列を含むKeepa行をざっくり検索（保険）
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
      // 型番抽出できない or Keepa側に該当なし → ASIN等は空
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
}

// ---- 結果テーブル描画 ----
function renderResultTable() {
  if (!resultTableBody) return;
  resultTableBody.innerHTML = '';

  resultRows.forEach((r, idx) => {
    const tr = document.createElement('tr');

    const tdShop = document.createElement('td');
    tdShop.textContent = r.shop || '';
    tr.appendChild(tdShop);

    const tdName = document.createElement('td');
    tdName.textContent = r.name || '';
    tr.appendChild(tdName);

    const tdModel = document.createElement('td');
    tdModel.textContent = r.model || '';
    tr.appendChild(tdModel);

    const tdRakutenUrl = document.createElement('td');
    const aRakuten = document.createElement('a');
    aRakuten.href = r.rakutenUrl || '#';
    aRakuten.textContent = '楽天';
    aRakuten.target = '_blank';
    tdRakutenUrl.appendChild(aRakuten);
    tr.appendChild(tdRakutenUrl);

    const tdUnitPrice = document.createElement('td');
    tdUnitPrice.textContent = isNaN(r.unitPrice) ? '' : Math.round(r.unitPrice).toString();
    tr.appendChild(tdUnitPrice);

    const tdASIN = document.createElement('td');
    tdASIN.textContent = r.asin || '';
    tr.appendChild(tdASIN);

    const tdAmazonUrl = document.createElement('td');
    if (r.amazonUrl) {
      const aAmazon = document.createElement('a');
      aAmazon.href = r.amazonUrl;
      aAmazon.textContent = 'Amazon';
      aAmazon.target = '_blank';
      tdAmazonUrl.appendChild(aAmazon);
    }
    tr.appendChild(tdAmazonUrl);

    const tdListingPrice = document.createElement('td');
    tdListingPrice.textContent = isNaN(r.listingPrice) ? '' : Math.round(r.listingPrice).toString();
    tr.appendChild(tdListingPrice);

    const tdNet = document.createElement('td');
    tdNet.textContent = isNaN(r.netPerUnit) ? '' : Math.round(r.netPerUnit).toString();
    tr.appendChild(tdNet);

    resultTableBody.appendChild(tr);
  });
}

// ---- ボタンイベント ----
if (matchButton) {
  matchButton.addEventListener('click', () => {
    runMatching();
  });
}
// app.js Part 3/3

// ---- Excelテンプレ互換CSV出力 ----
// 「楽天ポイント集計Excel」の構造に合わせたヘッダーを持つCSVを生成し、
// 12行目以降に検索結果を流し込むイメージで作成する。
// 数式列はここでは空欄にしておき、テンプレ側の数式をコピペで流用できるようにする。
function exportToExcelTemplateCsv() {
  if (!resultRows.length) {
    setStatus('照合結果がありません');
    return;
  }

  // ヘッダー行（テンプレの列順に合わせる）
  const header = [
    '購入年月日',          // A
    '購入先',              // B
    '商品名',              // C
    '商品名(型番)',        // D
    'URL',                 // E
    '単価',                // F
    '個数',                // G
    '価格',                // H
    '値引',                // I
    '送料',                // J
    '請求額',              // K
    // ここからポイント条件列などはテンプレ側で数式を持つ想定なので空欄で出力
    '火・木 プレミアムカードデー',
    '5の日',
    'ワンダフル',
    '18日',
    'イーグルス等',
    'ママ割',
    'マイカー割',
    'リピート',
    '直前',
    '39ショップ',
    '店舗',
    '基本還元率',
    '楽天モバイル＋会員ランク特典',
    '楽天カード通常分',
    '楽天カード特典分',
    '楽天銀行＋楽天カード（引落）',
    'マラソン①',
    'マラソン②',
    'マラソン③',
    'ポイントアップ祭り',
    'イーグルス他',
    '39ショップ(ポイント)',
    '火・木 プレミアムカードデー(ポイント)',
    '5の日(ポイント)',
    'ワンダフル(ポイント)',
    '18日(ポイント)',
    '店舗(ポイント)',
    '合計ポイント',
    '実質購入金額',
    '実質購入単価',
    'ASIN',
    'Amazon等販売先URL',
    '出品価格',
    '入金予定[円/個]',
    '予定利益/個',
    '予定総利益',
    'SKU例'
  ];

  const rows = [];
  // 1〜11行目はテンプレ側で既に存在する前提なので、ここでは12行目以降のみ生成
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

    const row = [
      '',                 // 購入年月日（テンプレ側で入力）
      r.shop || '',
      r.name || '',
      r.model || '',
      r.rakutenUrl || '',
      price,
      qty,
      total,
      discount,
      shipping,
      billed,
      '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
      r.asin || '',
      r.amazonUrl || '',
      isNaN(r.listingPrice) ? '' : Math.round(r.listingPrice),
      isNaN(r.netPerUnit) ? '' : Math.round(r.netPerUnit),
      profitPer,
      profitTotal,
      sku
    ];

    rows.push(row);
  });

  // CSV文字列生成
  const all = [header, ...rows];
  const csv = Papa.unparse(all);

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '楽天ポイント集計用_照合結果.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  setStatus('Excelテンプレ用CSVを出力しました（12行目以降に貼り付けて使用してください）');
}

if (exportButton) {
  exportButton.addEventListener('click', () => {
    exportToExcelTemplateCsv();
  });
}
// app.js Part 4/4
// ---- UI連携・ログ・初期化 ----

// ログ出力
function log(message) {
  const area = document.getElementById('logArea');
  if (!area) return;
  const time = new Date().toLocaleTimeString();
  area.innerHTML += `\n[${time}] ${message}`;
  area.scrollTop = area.scrollHeight;
}

// CSV読込状態に応じてボタン制御
function updateButtons() {
  const ready = rakutenRows.length > 0 && keepaRows.length > 0;
  if (matchButton) matchButton.disabled = !ready;
  if (exportButton) exportButton.disabled = resultRows.length === 0;
  const rawBtn = document.getElementById('exportRawCsvBtn');
  if (rawBtn) rawBtn.disabled = resultRows.length === 0;
}

// 生データCSV出力（照合結果のみ）
function exportRawCsv() {
  if (!resultRows.length) {
    setStatus('照合結果がありません');
    return;
  }

  const header = [
    '購入先（ショップ名）',
    '商品名',
    '商品名（型番）',
    '楽天URL',
    '単価',
    'ASIN',
    'Amazon等販売先URL',
    '出品価格',
    '入金予定[円/個]'
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

  setStatus('照合結果（RAW）CSVを出力しました');
}

// 生データCSVボタン
const rawCsvBtn = document.getElementById('exportRawCsvBtn');
if (rawCsvBtn) {
  rawCsvBtn.addEventListener('click', () => {
    exportRawCsv();
  });
}

// 生データ表示切替
const toggleRawBtn = document.getElementById('toggleRawBtn');
if (toggleRawBtn) {
  toggleRawBtn.addEventListener('click', () => {
    const table = document.getElementById('resultTable');
    if (!table) return;
    table.classList.toggle('show-raw');
    log('生データ表示切替');
  });
}

// クリアボタン（楽天）
const clearRakutenBtn = document.getElementById('clearRakutenBtn');
if (clearRakutenBtn) {
  clearRakutenBtn.addEventListener('click', () => {
    rakutenRows = [];
    setStatus('楽天CSVをクリアしました');
    log('楽天CSVクリア');
    updateButtons();
  });
}

// クリアボタン（Keepa）
const clearKeepaBtn = document.getElementById('clearKeepaBtn');
if (clearKeepaBtn) {
  clearKeepaBtn.addEventListener('click', () => {
    keepaRows = [];
    keepaHeader = [];
    keepaByPart.clear();
    setStatus('Keepa CSVをクリアしました');
    log('Keepa CSVクリア');
    updateButtons();
  });
}

// 初期化ログ
log('app.js 初期化完了');
updateButtons();
