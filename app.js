const APPLICATION_ID = "a38ecc5b-5a90-4eb9-b4f8-e714ba84eefd";
const ACCESS_KEY = "pk_oRPj9UEOAjvjnUtRwKwaje85mgY98Nzo7rzvGf7sQRj";
const BASE_URL = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701";

// Keepa API（必要なら）
const KEEPA_API_KEY = "YOUR_KEEPA_KEY";

const statusEl = document.getElementById("status");
const tbodyEl = document.querySelector("#result-table tbody");

document.getElementById("start").addEventListener("click", async () => {
  const keyword = document.getElementById("keyword").value.trim();

  if (!keyword) {
    alert("検索ワードを入力してください");
    return;
  }

  statusEl.textContent = `${keyword} の楽天検索を開始します…`;

  const allItems = [];

  // ★ 110ページ × hits=30（最大件数）
  for (let page = 1; page <= 110; page++) {
    statusEl.textContent = `楽天API取得中… ページ ${page} / 110`;

    const items = await fetchRakutenPage(keyword, page);
    if (items) {
      const parsed = parseItems(items);
      allItems.push(...parsed);
    }

    // ★ hit30 の最適ウェイト（1.4秒）
    await sleep(1400);
  }

  statusEl.textContent = `楽天取得完了。${allItems.length}件。Keepa CSV を読み込みます…`;

  // ★ ローカル Keepa CSV 読み込み
  const keepaMap = await loadKeepaCsvFromLocal();
  if (!keepaMap) {
    alert("Keepa CSV を選択してください");
    return;
  }

  // ★ 型番曖昧照合フィルタ
  const filteredItems = filterByKeepa(allItems, keepaMap);

  statusEl.textContent = `型番一致 ${filteredItems.length}件。Keepa照合を開始します…`;

  // ASIN抽出
  for (const item of filteredItems) {
    item.asin = extractAsinFromUrl(item.url);
  }

  const withKeepa = await attachKeepaData(filteredItems);

  renderTable(withKeepa);

  statusEl.textContent = "全処理完了。Excel 出力ボタンからダウンロードできます。";
});

document.getElementById("export").addEventListener("click", () => {
  exportToExcel();
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

//
// ======================================================
// 楽天API（429自動リトライ＋hits=30）
// ======================================================
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

    if (data.errors) {
      console.warn("Rakuten API Error:", data.errors);
      return null;
    }

    if (data.statusCode === 429) {
      console.warn(`429: 再試行します (page=${page})`);
      await sleep(1000);
      continue;
    }

    if (data.Items) return data.Items;

    return null;
  }
}

//
// ======================================================
// Items パース
// ======================================================
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

//
// ======================================================
// URLからASIN抽出
// ======================================================
function extractAsinFromUrl(url) {
  const m = url.match(/\/dp\/([A-Z0-9]{10})/);
  return m ? m[1] : null;
}

//
// ======================================================
// Keepa CSV（ローカル）読み込み
// ======================================================
async function loadKeepaCsvFromLocal() {
  const fileInput = document.getElementById("keepaCsv");
  const file = fileInput.files[0];
  if (!file) return null;

  const text = await file.text();
  const lines = text.split("\n");

  const keepaMap = new Map();

  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const partNumber = cols[1]?.trim(); // PartNumber
    if (partNumber) keepaMap.set(partNumber.toUpperCase(), true);
  }

  return keepaMap;
}

//
// ======================================================
// レーベンシュタイン距離（曖昧一致）
// ======================================================
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

//
// ======================================================
// 型番曖昧照合（完全一致 → ハイフン除去 → レーベン距離）
// ======================================================
function matchModelFromKeepa(name, keepaMap) {
  const cleanName = name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

  for (const partNumber of keepaMap.keys()) {
    const pn = partNumber.toUpperCase();
    const pnClean = pn.replace(/[^A-Za-z0-9]/g, "");

    // ① 完全一致
    if (name.toUpperCase().includes(pn)) return pn;

    // ② ハイフン除去一致
    if (cleanName.includes(pnClean)) return pn;

    // ③ レーベンシュタイン距離（曖昧一致）
    if (levenshtein(cleanName, pnClean) <= 2) return pn;
  }

  return null;
}

//
// ======================================================
// Keepa CSV と照合して一致した商品だけ残す
// ======================================================
function filterByKeepa(items, keepaMap) {
  return items.filter(item => {
    const matched = matchModelFromKeepa(item.name, keepaMap);
    if (matched) {
      item.model = matched; // 一致した型番を保存
      return true;
    }
    return false;
  });
}

//
// ======================================================
// Keepa API
// ======================================================
async function attachKeepaData(items) {
  const result = [];

  for (const item of items) {
    if (!item.asin) {
      result.push({ ...item, keepaLowest: null });
      continue;
    }

    const keepaData = await fetchKeepa(item.asin);
    const lowest = keepaData ? keepaData.lowestPrice : null;

    result.push({ ...item, keepaLowest: lowest });

    await sleep(300);
  }

  return result;
}

async function fetchKeepa(asin) {
  const url = `https://api.keepa.com/product?key=${KEEPA_API_KEY}&domain=JP&asin=${asin}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.products || !data.products.length) return null;

  const product = data.products[0];
  return {
    lowestPrice: product.stats ? product.stats.minPrice : null
  };
}

//
// ======================================================
// テーブル描画
// ======================================================
function renderTable(items) {
  tbodyEl.innerHTML = "";

  for (const item of items) {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${item.price}</td>
      <td>${item.shop}</td>
      <td><a href="${item.url}" target="_blank">リンク</a></td>
      <td>${item.model || ""}</td>
      <td>${item.asin || ""}</td>
      <td>${item.keepaLowest || ""}</td>
    `;

    tbodyEl.appendChild(tr);
  }
}

//
// ======================================================
// Excel 出力
// ======================================================
function exportToExcel() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.table_to_sheet(document.getElementById("result-table"));
  XLSX.utils.book_append_sheet(wb, ws, "RAKUTEN_KEEPA");
  XLSX.writeFile(wb, "rakuten_keepa.xlsx");
}
