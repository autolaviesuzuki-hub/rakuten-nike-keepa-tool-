// =========================================================
// app.js（楽天API自動取得 → Keepa照合 → ExcelテンプレCSV出力）
// config.js の値を自動参照する完全版
// =========================================================

// ---- グローバル状態 ----
let rakutenRows = [];      // 楽天APIで取得した商品一覧
let keepaRows = [];        // Keepa CSVの生データ行
let keepaHeader = [];      // Keepaヘッダー
let keepaByPart = new Map(); // PartNumber → Keepa行配列
let resultRows = [];       // 照合結果

// ---- DOM取得 ----
const rakutenAppIdInput = document.getElementById("rakutenAppId");
const rakutenAffiliateIdInput = document.getElementById("rakutenAffiliateId");
const rakutenHitsInput = document.getElementById("rakutenHits");
const rakutenMaxPageInput = document.getElementById("rakutenMaxPage");
const searchKeywordInput = document.getElementById("searchKeywordInput");

const runRakutenApiBtn = document.getElementById("runRakutenApiBtn");
const keepaCsvInput = document.getElementById("keepaCsvInput");
const clearKeepaBtn = document.getElementById("clearKeepaBtn");

const runMatchBtn = document.getElementById("runMatchBtn");
const exportExcelBtn = document.getElementById("exportExcelBtn");
const exportRawCsvBtn = document.getElementById("exportRawCsvBtn");

const rakutenStatus = document.getElementById("rakutenStatus");
const keepaStatus = document.getElementById("keepaStatus");
const matchStatus = document.getElementById("matchStatus");
const matchSummary = document.getElementById("matchSummary");

const resultTableBody = document.querySelector("#resultTable tbody");
const logArea = document.getElementById("logArea");

// ---- ログ ----
function log(msg) {
  const t = new Date().toLocaleTimeString();
  logArea.value += `[${t}] ${msg}\n`;
  logArea.scrollTop = logArea.scrollHeight;
}

// ---- ステータス ----
function setStatus(el, msg) {
  if (el) el.textContent = msg;
}

// ---- 数値変換 ----
function sanitizeNumber(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  const s = String(v).replace(/,/g, "").trim();
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

// =========================================================
// Keepa CSV 読み込み
// =========================================================
function loadKeepaCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      encoding: "UTF-8",
      skipEmptyLines: true,
      complete: (results) => {
        if (!results || !results.data || results.data.length < 2) {
          return reject(new Error("Keepa CSVの内容が不正です"));
        }
        keepaHeader = results.data[0];
        keepaRows = results.data.slice(1);
        buildKeepaIndex();
        resolve();
      },
      error: (err) => reject(err),
    });
  });
}

function buildKeepaIndex() {
  keepaByPart.clear();
  const idxPart = keepaHeader.indexOf("商品コード: PartNumber");
  if (idxPart === -1) return;

  keepaRows.forEach((row) => {
    const part = (row[idxPart] || "").trim();
    if (!part) return;
    if (!keepaByPart.has(part)) keepaByPart.set(part, []);
    keepaByPart.get(part).push(row);
  });
}

// =========================================================
// 型番抽出
// =========================================================
function extractModelCode(name) {
  if (!name) return "";
  const upper = name.toUpperCase();

  // 1. Keepa PartNumber を含むか
  for (const part of keepaByPart.keys()) {
    const p = part.toUpperCase();
    if (upper.includes(p)) return part;
  }

  // 2. 正規表現
  const regex = /[A-Z0-9]{2,}-\d{3}/g;
  const m = upper.match(regex);
  if (m && m.length) return m[0];

  // 3. NIKE FB2207-005
  const regex2 = /NIKE\s+([A-Z0-9]{2,}-\d{3})/i;
  const m2 = name.match(regex2);
  if (m2 && m2[1]) return m2[1];

  return "";
}

// =========================================================
// Keepa価格情報
// =========================================================
function getKeepaPriceInfo(row) {
  const idxASIN = keepaHeader.indexOf("ASIN");
  const idxPart = keepaHeader.indexOf("商品コード: PartNumber");
  const idxBuyBox = keepaHeader.indexOf("Buy Box: 現在価格");
  const idxFbaLowest = keepaHeader.indexOf("新しい、第三者FBA: 現在価格");
  const idxFbaFee = keepaHeader.indexOf("FBA Pick&Pack 料金");
  const idxReferralPct = keepaHeader.indexOf("紹介料％");

  const asin = idxASIN !== -1 ? (row[idxASIN] || "").trim() : "";
  const part = idxPart !== -1 ? (row[idxPart] || "").trim() : "";

  const buyBox = sanitizeNumber(row[idxBuyBox]);
  const fbaLowest = sanitizeNumber(row[idxFbaLowest]);
  const fbaFee = sanitizeNumber(row[idxFbaFee]);
  const referralPct = sanitizeNumber(row[idxReferralPct]);

  let listingPrice = !isNaN(buyBox) && buyBox > 0 ? buyBox :
                     (!isNaN(fbaLowest) && fbaLowest > 0 ? fbaLowest : NaN);

  if (isNaN(listingPrice)) {
    return { asin, part, listingPrice: NaN, netPerUnit: NaN };
  }

  const referralFee = !isNaN(referralPct) ? listingPrice * (referralPct / 100) : 0;
  const netPerUnit = Math.round(listingPrice - referralFee - (fbaFee || 0));

  return { asin, part, listingPrice, netPerUnit };
}

// =========================================================
// 楽天APIで商品取得
// =========================================================
async function fetchRakutenPage(keyword, page, hits, appId, affiliateId) {
  const url = "https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601";

  const params = {
    applicationId: appId,
    affiliateId: affiliateId || "",
    keyword,
    hits,
    page,
    formatVersion: 2,
  };

  try {
    const res = await axios.get(url, { params });
    if (res.data && res.data.Items) {
      return res.data.Items;
    }
    return [];
  } catch (err) {
    log(`楽天APIエラー page=${page}`);
    return [];
  }
}

async function runRakutenApi() {
  // ★★★ ここが config.js を参照する部分 ★★★
  const appId = rakutenAppIdInput.value.trim() || CONFIG.RAKUTEN_APP_ID;
  const affiliateId = rakutenAffiliateIdInput.value.trim() || CONFIG.RAKUTEN_AFFILIATE_ID;

  const hits = Number(rakutenHitsInput.value) || CONFIG.DEFAULT_HITS;
  const maxPage = Number(rakutenMaxPageInput.value) || CONFIG.DEFAULT_MAX_PAGE;
  const keyword = searchKeywordInput.value.trim();

  if (!appId) {
    alert("楽天アプリIDを入力してください");
    return;
  }
  if (!keyword) {
    alert("検索キーワードを入力してください");
    return;
  }

  rakutenRows = [];
  setStatus(rakutenStatus, "楽天API取得中…");
  log(`楽天API開始 keyword=${keyword}`);

  for (let page = 1; page <= maxPage; page++) {
    setStatus(rakutenStatus, `楽天API取得中… ${page}/${maxPage}`);
    const items = await fetchRakutenPage(keyword, page, hits, appId, affiliateId);

    items.forEach((item) => {
      rakutenRows.push({
        shop: item.shopName || "",
        name: item.itemName || "",
        model: extractModelCode(item.itemName || ""),
        url: item.itemUrl || "",
        price: sanitizeNumber(item.itemPrice),
      });
    });

    await new Promise((r) => setTimeout(r, 1200)); // API制限対策
  }

  setStatus(rakutenStatus, `楽天検索結果: ${rakutenRows.length}件`);
  log(`楽天API完了 total=${rakutenRows.length}`);

  updateButtons();
}

// =========================================================
// 楽天 × Keepa 照合
// =========================================================
function matchRakutenRow(row) {
  const model = (row.model || "").trim();
  if (!model) return null;

  const candidates = keepaByPart.get(model);
  if (candidates && candidates.length) {
    let best = null;
    candidates.forEach((c) => {
      const info = getKeepaPriceInfo(c);
      if (!info) return;
      if (!best || info.netPerUnit > best.info.netPerUnit) {
        best = { keepaRow: c, info };
      }
    });
    return best;
  }

  return null;
}

function runMatching() {
  if (!rakutenRows.length) {
    alert("楽天検索結果がありません");
    return;
  }
  if (!keepaRows.length) {
    alert("Keepa CSVが読み込まれていません");
    return;
  }

  resultRows = [];

  rakutenRows.forEach((r) => {
    const match = matchRakutenRow(r);
    if (!match) {
      resultRows.push({
        shop: r.shop,
        name: r.name,
        model: r.model,
        rakutenUrl: r.url,
        unitPrice: r.price,
        asin: "",
        amazonUrl: "",
        listingPrice: NaN,
        netPerUnit: NaN,
      });
      return;
    }

    const info = match.info;
    const asin = info.asin;
    const amazonUrl = asin ? `https://www.amazon.co.jp/dp/${asin}` : "";

    resultRows.push({
      shop: r.shop,
      name: r.name,
      model: info.part,
      rakutenUrl: r.url,
      unitPrice: r.price,
      asin,
      amazonUrl,
      listingPrice: info.listingPrice,
      netPerUnit: info.netPerUnit,
    });
  });

  renderResultTable();
  const hit = resultRows.filter((r) => r.asin).length;
  setStatus(matchSummary, `型番一致: ${hit}件`);
  setStatus(matchStatus, "照合完了");
  log(`照合完了 hit=${hit}`);

  updateButtons();
}

// =========================================================
// 結果テーブル描画
// =========================================================
function renderResultTable() {
  resultTableBody.innerHTML = "";

  resultRows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.shop}</td>
      <td>${r.name}</td>
      <td>${r.model}</td>
      <td><a href="${r.rakutenUrl}" target="_blank">楽天</a></td>
      <td>${isNaN(r.unitPrice) ? "" : Math.round(r.unitPrice)}</td>
      <td>${r.asin}</td>
      <td>${r.amazonUrl ? `<a href="${r.amazonUrl}" target="_blank">Amazon</a>` : ""}</td>
      <td>${isNaN(r.listingPrice) ? "" : Math.round(r.listingPrice)}</td>
      <td>${isNaN(r.netPerUnit) ? "" : Math.round(r.netPerUnit)}</td>
    `;
    resultTableBody.appendChild(tr);
  });
}

// =========================================================
// ExcelテンプレCSV出力
// =========================================================
function exportExcelTemplateCsv() {
  if (!resultRows.length) {
    alert("照合結果がありません");
    return;
  }

  const header = [
    "購入年月日","購入先","商品名","商品名(型番)","URL","単価","個数","価格","値引","送料","請求額",
    "火・木 プレミアムカードデー","5の日","ワンダフル","18日","イーグルス等","ママ割","マイカー割","リピート","直前","39ショップ","店舗",
    "基本還元率","楽天モバイル＋会員ランク特典","楽天カード通常分","楽天カード特典分","楽天銀行＋楽天カード（引落）",
    "マラソン①","マラソン②","マラソン③","ポイントアップ祭り","イーグルス他","39ショップ(ポイント)","火・木 プレミアムカードデー(ポイント)",
    "5の日(ポイント)","ワンダフル(ポイント)","18日(ポイント)","店舗(ポイント)","合計ポイント","実質購入金額","実質購入単価",
    "ASIN","Amazon等販売先URL","出品価格","入金予定[円/個]","予定利益/個","予定総利益","SKU例"
  ];

  const rows = [];

  resultRows.forEach((r, idx) => {
    const qty = 1;
    const price = isNaN(r.unitPrice) ? 0 : Math.round(r.unitPrice);
    const total = price * qty;
    const billed = total;

    const net = isNaN(r.netPerUnit) ? 0 : Math.round(r.netPerUnit);
    const profitPer = net - price;
    const profitTotal = profitPer * qty;
    const sku = `20260819_${idx}-0`;

    rows.push([
      "",
      r.shop,
      r.name,
      r.model,
      r.rakutenUrl,
      price,
      qty,
      total,
      0,
      0,
      billed,
      "", "", "", "", "", "", "", "", "", "", "",
      "", "", "", "", "",
      "", "", "", "", "", "", "", "", "", "", "", "", "",
      r.asin,
      r.amazonUrl,
      isNaN(r.listingPrice) ? "" : Math.round(r.listingPrice),
      isNaN(r.netPerUnit) ? "" : Math.round(r.netPerUnit),
      profitPer,
      profitTotal,
      sku
    ]);
  });

  const csv = Papa.unparse([header, ...rows]);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "楽天ポイント集計用_照合結果.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
  log("ExcelテンプレCSV出力完了");
}

// =========================================================
// RAW CSV出力
// =========================================================
function exportRawCsv() {
  if (!resultRows.length) {
    alert("照合結果がありません");
    return;
  }

  const header = [
    "購入先（ショップ名）","商品名","商品名（型番）","楽天URL","単価",
    "ASIN","Amazon等販売先URL","出品価格","入金予定[円/個]"
  ];

  const rows = resultRows.map((r) => [
    r.shop,
    r.name,
    r.model,
    r.rakutenUrl,
    isNaN(r.unitPrice) ? "" : Math.round(r.unitPrice),
    r.asin,
    r.amazonUrl,
    isNaN(r.listingPrice) ? "" : Math.round(r.listingPrice),
    isNaN(r.netPerUnit) ? "" : Math.round(r.netPerUnit)
  ]);

  const csv = Papa.unparse([header, ...rows]);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "照合結果_raw.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
  log("RAW CSV出力完了");
}

// =========================================================
// ボタン制御
// =========================================================
function updateButtons() {
  const ready = rakutenRows.length > 0 && keepaRows.length > 0;
  runMatchBtn.disabled = !ready;
  exportExcelBtn.disabled = resultRows.length === 0;
  exportRawCsvBtn.disabled = resultRows.length === 0;
}

// =========================================================
// イベント
// =========================================================
runRakutenApiBtn.addEventListener("click", runRakutenApi);

keepaCsvInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if
