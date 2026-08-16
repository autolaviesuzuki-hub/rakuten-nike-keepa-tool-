const APPLICATION_ID = "a38ecc5b-5a90-4eb9-b4f8-e714ba84eefd";
const ACCESS_KEY = "pk_oRPj9UEOAjvjnUtRwKwaje85mgY98Nzo7rzvGf7sQRj";
const BASE_URL = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701";

// TODO: 自分の Keepa API Key に差し替え
const KEEPA_API_KEY = "YOUR_KEEPA_KEY";

const statusEl = document.getElementById("status");
const tbodyEl = document.querySelector("#result-table tbody");

document.getElementById("start").addEventListener("click", async () => {
  statusEl.textContent = "楽天APIでナイキ検索を開始します…";

  const allItems = [];

  for (let page = 1; page <= 200; page++) {
    statusEl.textContent = `楽天API取得中… ページ ${page} / 200`;

    const items = await fetchRakutenPage("NIKE ナイキ", 10, page);
    if (!items) continue;

    const parsed = parseItems(items);
    allItems.push(...parsed);

    await sleep(200);
  }

  statusEl.textContent = `楽天取得完了。${allItems.length}件。Keepa 照合を開始します…`;

  for (const item of allItems) {
    item.asin = extractAsinFromUrl(item.url);
  }

  const withKeepa = await attachKeepaData(allItems);

  renderTable(withKeepa);

  statusEl.textContent = "全処理完了。Excel 出力ボタンからダウンロードできます。";
});

document.getElementById("export").addEventListener("click", () => {
  exportToExcel();
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchRakutenPage(keyword, hits, page) {
  const params = new URLSearchParams({
    applicationId: APPLICATION_ID,
    accessKey: ACCESS_KEY,
    keyword,
    hits,
    page,
    formatVersion: 1
  });

  const res = await fetch(`${BASE_URL}?${params.toString()}`);
  const data = await res.json();

  if (data.errors) {
    console.warn("Rakuten API Error:", data.errors);
    return null;
  }

  if (!data.Items) return null;
  return data.Items;
}

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

function extractAsinFromUrl(url) {
  const m = url.match(/\/dp\/([A-Z0-9]{10})/);
  return m ? m[1] : null;
}

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

function renderTable(items) {
  tbodyEl.innerHTML = "";

  for (const item of items) {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${item.price}</td>
      <td>${item.shop}</td>
      <td><a href="${item.url}" target="_blank">リンク</a></td>
      <td>${item.asin || ""}</td>
      <td>${item.keepaLowest || ""}</td>
    `;

    tbodyEl.appendChild(tr);
  }
}

function exportToExcel() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.table_to_sheet(document.getElementById("result-table"));
  XLSX.utils.book_append_sheet(wb, ws, "NIKE_RAKUTEN_KEEPA");
  XLSX.writeFile(wb, "nike_rakuten_keepa.xlsx");
}
