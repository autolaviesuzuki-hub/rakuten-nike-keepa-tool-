// =========================================================
// app.js（openapi.rakuten.co.jp 版 / 高速・CORS不要）
// =========================================================

// ---- 楽天API設定 ----
const APPLICATION_ID = "a38ecc5b-5a90-4eb9-b4f8-e714ba84eefd";
const ACCESS_KEY = "pk_oRPj9UEOAjvjnUtRwKwaje85mgY98Nzo7rzvGf7sQRj";
const BASE_URL = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701";

// ---- DOM ----
const statusEl = document.getElementById("status");
const tbodyEl = document.querySelector("#result-table tbody");

// ---- スリープ ----
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =========================================================
// 楽天API（openapi / GET / CORS許可 / 高速）
// =========================================================
async function fetchRakutenPage(keyword, page) {
  const params = new URLSearchParams({
    applicationId: APPLICATION_ID,
    accessKey: ACCESS_KEY,
    keyword,
    hits: 30,
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
function parseItems(items) {
  const parsed = [];
  for (const entry of items) {
    const item = entry.Item;
    if (!item) continue;

    parsed.push({
      name: item.itemName,
      price: item.itemPrice,
      url: item.itemUrl,
      shop: item.shopName
    });
  }
  return parsed;
}

// =========================================================
// Keepa CSV 読み込み
// =========================================================
async function loadKeepaCsvFromLocal() {
  const fileInput = document.getElementById("keepaCsv");
  const file = fileInput.files[0];
  if (!file) return null;

  const text = await file.text();

  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true
  });

  const keepaList = [];

  for (const row of parsed.data) {
    const asin = row["ASIN"];
    const part = row["商品コード: PartNumber"];
    const buybox = parseFloat(row["Buy Box: 現在価格"]);
    const fbaMin = parseFloat(row["新しい、第三者FBA: 現在価格"]);
    const fbaFee = parseFloat(row["FBA Pick&Pack 料金"]);
    const rate = parseFloat(row["紹介料％"]);

    if (!part) continue;

    keepaList.push({
      asin,
      partNumber: part.toUpperCase(),
      price: buybox || fbaMin || null,
      fbaFee,
      rate
    });
  }

  return keepaList;
}

// =========================================================
// レーベンシュタイン距離
// =========================================================
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i-1][j] + 1,
        dp[i][j-1] + 1,
        dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

// =========================================================
// 型番曖昧照合
// =========================================================
function matchKeepaModel(name, keepaList) {
  const cleanName = name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

  for (const k of keepaList) {
    const pn = k.partNumber;
    const pnClean = pn.replace(/[^A-Za-z0-9]/g, "");

    if (name.toUpperCase().includes(pn)) return k;
    if (cleanName.includes(pnClean)) return k;
    if (levenshtein(cleanName, pnClean) <= 2) return k;
  }

  return null;
}

// =========================================================
// 楽天 × Keepa 照合
// =========================================================
function filterByKeepa(items, keepaList) {
  return items.map(item => {
    const matched = matchKeepaModel(item.name, keepaList);
    if (!matched) return null;

    const price = matched.price;
    const income =
      price - matched.fbaFee - (price * matched.rate);

    return {
      ...item,
      model: matched.partNumber,
      asin: matched.asin,
      amazonUrl: `https://www.amazon.co.jp/dp/${matched.asin}`,
      keepaPrice: price,
      incomePerUnit: Math.round(income)
    };
  }).filter(Boolean);
}

// =========================================================
// テーブル描画
// =========================================================
function renderTable(items) {
  tbodyEl.innerHTML = "";

  for (const item of items) {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>${item.shop}</td>
      <td>${item.name}</td>
      <td>${item.model}</td>
      <td><a href="${item.url}" target="_blank">楽天</a></td>
      <td>${item.price}</td>

      <td>${item.asin}</td>
      <td><a href="${item.amazonUrl}" target="_blank">Amazon</a></td>
      <td>${item.keepaPrice}</td>
      <td>${item.incomePerUnit}</td>
    `;

    tbodyEl.appendChild(tr);
  }
}

// =========================================================
// Excel 出力
// =========================================================
function exportToExcel() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.table_to_sheet(document.getElementById("result-table"));
  XLSX.utils.book_append_sheet(wb, ws, "RAKUTEN_KEEPA");
  XLSX.writeFile(wb, "rakuten_keepa.xlsx");
}

// =========================================================
// メイン処理
// =========================================================
document.getElementById("start").addEventListener("click", async () => {
  const keyword = document.getElementById("keyword").value.trim();
  if (!keyword) {
    alert("検索ワードを入力してください");
    return;
  }

  statusEl.textContent = `${keyword} の楽天検索を開始します…`;

  const allItems = [];

  for (let page = 1; page <= 110; page++) {
    statusEl.textContent = `楽天API取得中… ページ ${page} / 110`;

    const items = await fetchRakutenPage(keyword, page);
    if (items) {
      const parsed = parseItems(items);
      allItems.push(...parsed);
    }

    await sleep(1400);
  }

  statusEl.textContent = `楽天取得完了。${allItems.length}件。Keepa CSV を読み込みます…`;

  const keepaList = await loadKeepaCsvFromLocal();
  if (!keepaList) {
    alert("Keepa CSV を選択してください");
    return;
  }

  const matchedItems = filterByKeepa(allItems, keepaList);

  statusEl.textContent = `型番一致 ${matchedItems.length}件。Excel 出力可能です。`;

  renderTable(matchedItems);
});

document.getElementById("export").addEventListener("click", () => {
  exportToExcel();
});
