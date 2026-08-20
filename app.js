// =========================================================
// app.js（openapi.rakuten.co.jp 版 / 高速・CORS不要 / GitHub Pages対応）
// =========================================================

// ---- 楽天API設定 ----
const APPLICATION_ID = "a38ecc5b-5a90-4eb9-b4f8-e714ba84eefd";
const ACCESS_KEY = "pk_oRPj9UEOAjvjnUtRwKwaje85mgY98Nzo7rzvGf7sQRj";
const BASE_URL = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701";

// ---- DOM ----
const rakutenAppIdInput = document.getElementById("rakutenAppId");
const rakutenAccessKeyInput = document.getElementById("rakutenAccessKey");
const rakutenAffiliateIdInput = document.getElementById("rakutenAffiliateId");
const rakutenHitsInput = document.getElementById("rakutenHits");
const rakutenMaxPageInput = document.getElementById("rakutenMaxPage");
const searchKeywordInput = document.getElementById("searchKeywordInput");

const rakutenStatus = document.getElementById("rakutenStatus");
const keepaStatus = document.getElementById("keepaStatus");
const matchStatus = document.getElementById("matchStatus");
const matchSummary = document.getElementById("matchSummary");

const resultTableBody = document.querySelector("#resultTable tbody");
const logArea = document.getElementById("logArea");

// ---- 状態 ----
let rakutenRows = [];
let keepaRows = [];
let keepaHeader = [];
let keepaByPart = new Map();
let resultRows = [];

// ---- ログ ----
function log(msg) {
  const t = new Date().toLocaleTimeString();
  logArea.value += `[${t}] ${msg}\n`;
  logArea.scrollTop = logArea.scrollHeight;
}

// ---- スリープ ----
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =========================================================
// ★ 楽天API（openapi / GET / CORS許可 / 高速）
// =========================================================
async function fetchRakutenPage(keyword, page, hits) {
  const params = new URLSearchParams({
    applicationId: APPLICATION_ID,
    accessKey: ACCESS_KEY,
    keyword,
    hits,
    page,
    formatVersion: 1
  });

  while (true) {
    const res = await fetch(`${BASE_URL}?${params.toString()}`);
    const data = await res.json();

    if (data.errors) return null;

    if (data.statusCode === 429) {
      await sleep(1000);
      continue;
    }

    if (data.Items) return data.Items;

    return null;
  }
}

// =========================================================
// 楽天 Items パース
// =========================================================
function parseRakutenItems(items) {
  const parsed = [];
  for (const entry of items) {
    const item = entry.Item;
    if (!item) continue;

    parsed.push({
      shop: item.shopName,
      name: item.itemName,
      url: item.itemUrl,
      price: item.itemPrice,
      model: "" // 後で抽出
    });
  }
  return parsed;
}

// =========================================================
// 楽天API実行（UI連動）
// =========================================================
async function runRakutenApi() {
  const keyword = searchKeywordInput.value.trim();
  const hits = Number(rakutenHitsInput.value);
  const maxPage = Number(rakutenMaxPageInput.value);

  if (!keyword) {
    alert("検索キーワードを入力してください");
    return;
  }

  rakutenRows = [];
  log(`楽天API開始 keyword=${keyword}`);

  for (let page = 1; page <= maxPage; page++) {
    rakutenStatus.textContent = `楽天API取得中… ${page}/${maxPage}`;

    const items = await fetchRakutenPage(keyword, page, hits);
    if (items) {
      const parsed = parseRakutenItems(items);
      rakutenRows.push(...parsed);
    }

    await sleep(1400);
  }

  rakutenStatus.textContent = `楽天検索結果: ${rakutenRows.length}件`;
  log(`楽天API完了 total=${rakutenRows.length}`);

  updateButtons();
}

// =========================================================
// Keepa CSV 読み込み
// =========================================================
async function loadKeepaCsv(file) {
  const text = await file.text();
  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true
  });

  keepaRows = parsed.data;
  keepaHeader = parsed.meta.fields;

  keepaByPart.clear();
  for (const row of keepaRows) {
    const part = (row["商品コード: PartNumber"] || "").trim().toUpperCase();
    if (!part) continue;
    if (!keepaByPart.has(part)) keepaByPart.set(part, []);
    keepaByPart.get(part).push(row);
  }

  keepaStatus.textContent = `Keepa CSV読込完了（${keepaRows.length}件）`;
  log(`Keepa CSV読込完了 rows=${keepaRows.length}`);

  updateButtons();
}

// =========================================================
// 型番抽出（曖昧照合）
// =========================================================
function extractModel(name) {
  const clean = name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

  for (const part of keepaByPart.keys()) {
    const pClean = part.replace(/[^A-Za-z0-9]/g, "");
    if (name.toUpperCase().includes(part)) return part;
    if (clean.includes(pClean)) return part;
  }

  return "";
}

// =========================================================
// Keepa価格情報
// =========================================================
function getKeepaInfo(row) {
  const asin = row["ASIN"];
  const part = row["商品コード: PartNumber"];
  const buybox = parseFloat(row["Buy Box: 現在価格"]);
  const fbaMin = parseFloat(row["新しい、第三者FBA: 現在価格"]);
  const fbaFee = parseFloat(row["FBA Pick&Pack 料金"]);
  const rate = parseFloat(row["紹介料％"]);

  const price = buybox || fbaMin || null;
  if (!price) return null;

  const income = price - fbaFee - (price * rate);

  return {
    asin,
    part,
    price,
    incomePerUnit: Math.round(income)
  };
}

// =========================================================
// 楽天 × Keepa 照合
// =========================================================
function runMatching() {
  resultRows = [];

  for (const r of rakutenRows) {
    const model = extractModel(r.name);
    if (!model) continue;

    const keepaCandidates = keepaByPart.get(model);
    if (!keepaCandidates) continue;

    let best = null;
    for (const row of keepaCandidates) {
      const info = getKeepaInfo(row);
      if (!info) continue;
      if (!best || info.incomePerUnit > best.incomePerUnit) {
        best = info;
      }
    }

    if (!best) continue;

    resultRows.push({
      shop: r.shop,
      name: r.name,
      model: best.part,
      rakutenUrl: r.url,
      unitPrice: r.price,
      asin: best.asin,
      amazonUrl: `https://www.amazon.co.jp/dp/${best.asin}`,
      listingPrice: best.price,
      netPerUnit: best.incomePerUnit
    });
  }

  renderResultTable();
  matchSummary.textContent = `型番一致: ${resultRows.length}件`;
  matchStatus.textContent = "照合完了";
  log(`照合完了 hit=${resultRows.length}`);

  updateButtons();
}

// =========================================================
// 結果テーブル描画
// =========================================================
function renderResultTable() {
  resultTableBody.innerHTML = "";

  for (const r of resultRows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.shop}</td>
      <td>${r.name}</td>
      <td>${r.model}</td>
      <td><a href="${r.rakutenUrl}" target="_blank">楽天</a></td>
      <td>${r.unitPrice}</td>
      <td>${r.asin}</td>
      <td><a href="${r.amazonUrl}" target="_blank">Amazon</a></td>
      <td>${r.listingPrice}</td>
      <td>${r.netPerUnit}</td>
    `;
    resultTableBody.appendChild(tr);
  }
}

// =========================================================
// ボタン制御
// =========================================================
function updateButtons() {
  const ready = rakutenRows.length > 0 && keepaRows.length > 0;
  document.getElementById("runMatchBtn").disabled = !ready;
  document.getElementById("exportExcelBtn").disabled = resultRows.length === 0;
  document.getElementById("exportRawCsvBtn").disabled = resultRows.length === 0;
}

// =========================================================
// イベント
// =========================================================
document.getElementById("runRakutenApiBtn").addEventListener("click", runRakutenApi);

document.getElementById("keepaCsvInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await loadKeepaCsv(file);
});

document.getElementById("runMatchBtn").addEventListener("click", runMatching);
