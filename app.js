// ==============================
// 楽天 × Keepa 照合ツール openapi版 app.js（完全版）
// ==============================

// --- 楽天API 固定値（必要なら index.html から取得する形にも変更可） ---
const APPLICATION_ID = "a38ecc5b-5a90-4eb9-b4f8-e714ba84eefd";
const ACCESS_KEY     = "pk_oRPj9UEOAjvjnUtRwKwaje85mgY98Nzo7rzvGf7sQRj";

// CORSを回避できていた「openapi」版エンドポイント
const BASE_URL = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701";

// --- DOM参照 ---
const statusEl = document.getElementById("status");
const tbodyEl  = document.querySelector("#result-table tbody");

// ==============================
// イベントハンドラ
// ==============================

document.getElementById("start").addEventListener("click", async () => {
  const keyword = document.getElementById("keyword").value.trim();
  if (!keyword) {
    alert("検索ワードを入力してください");
    return;
  }

  statusEl.textContent = `${keyword} の楽天検索を開始します…`;

  const allItems = [];

  // ここは以前うまく動いていた「ページを順に叩いていく」構成を踏襲
  const MAX_PAGE = 100;   // UIの「最大ページ数」と合わせる
  const HITS     = 30;    // 1ページあたり件数

  for (let page = 1; page <= MAX_PAGE; page++) {
    statusEl.textContent = `楽天API取得中… ページ ${page} / ${MAX_PAGE}`;

    const items = await fetchRakutenPage(keyword, page, HITS);
    if (items && items.length > 0) {
      const parsed = parseItems(items);
      allItems.push(...parsed);
    } else {
      // 途中でデータが返らなくなったら打ち切り
      break;
    }

    // openapi 版でもレートリミットを意識して少し待つ
    await sleep(1200);
  }

  statusEl.textContent = `楽天取得完了。${allItems.length}件。Keepa CSV を読み込みます…`;

  const keepaList = await loadKeepaCsvFromLocal();
  if (!keepaList) {
    alert("Keepa CSV を選択してください");
    statusEl.textContent = "Keepa CSV が未選択です。";
    return;
  }

  const matchedItems = filterByKeepa(allItems, keepaList);

  statusEl.textContent = `型番一致 ${matchedItems.length}件。Excel 出力可能です。`;

  renderTable(matchedItems);
});

document.getElementById("export").addEventListener("click", () => {
  exportToExcel();
});

// ==============================
// 共通ユーティリティ
// ==============================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ==============================
// 楽天API（openapi版）
// ==============================

async function fetchRakutenPage(keyword, page, hits) {
  const params = new URLSearchParams({
    applicationId: APPLICATION_ID,
    accessKey: ACCESS_KEY,
    keyword,
    hits: String(hits),
    page: String(page),
    formatVersion: "1"
  });

  while (true) {
    try {
      const res  = await fetch(`${BASE_URL}?${params.toString()}`);
      const data = await res.json();

      // エラーが返ってきたらこのページはスキップ
      if (data.errors) {
        console.warn("Rakuten API errors:", data.errors);
        return null;
      }

      // レートリミット
      if (data.statusCode === 429) {
        await sleep(1000);
        continue;
      }

      if (data.Items && Array.isArray(data.Items)) {
        return data.Items;
      }

      return null;
    } catch (e) {
      console.error("Rakuten API fetch error:", e);
      return null;
    }
  }
}

// 楽天 Items パース
function parseItems(items) {
  const parsed = [];
  for (const entry of items) {
    const item = entry.Item;
    if (!item) continue;

    parsed.push({
      name:  item.itemName,
      price: item.itemPrice,
      url:   item.itemUrl,
      shop:  item.shopName
    });
  }
  return parsed;
}

// ==============================
// Keepa CSV 読み込み（PapaParse）
// ==============================

async function loadKeepaCsvFromLocal() {
  const fileInput = document.getElementById("keepaCsv");
  const file      = fileInput.files[0];
  if (!file) return null;

  const text = await file.text();

  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true
  });

  const keepaList = [];

  for (const row of parsed.data) {
    const asin  = row["ASIN"];
    const part  = row["商品コード: PartNumber"];

    // --- 価格の取り方を修正 ---
    // 1. Buy Box があればそれを優先
    // 2. なければ「新しい、第三者FBA: 現在価格」
    const buyBoxRaw = row["Buy Box: 現在価格"];
    const fbaRaw    = row["新しい、第三者FBA: 現在価格"];

    const buyBox = toNumber(buyBoxRaw);
    const fbaMin = toNumber(fbaRaw);

    const price = buyBox != null ? buyBox : (fbaMin != null ? fbaMin : null);

    // FBA Pick&Pack 料金
    const fbaFeeRaw = row["FBA Pick&Pack 料金"];
    const fbaFee    = toNumber(fbaFeeRaw) || 0;

    // 紹介料％ は "12.40%" のような文字列なので、パーセントを小数に変換
    const rateRaw = row["紹介料％"];
    const rateNum = rateRaw ? parseFloat(String(rateRaw).replace("%", "")) : 0;
    const rate    = rateNum / 100;  // 12.40 → 0.124

    if (!part) continue;

    keepaList.push({
      asin,
      partNumber: String(part).toUpperCase(),
      price,
      fbaFee,
      rate
    });
  }

  return keepaList;
}

// ==============================
// レーベンシュタイン距離
// ==============================

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

// ==============================
// 型番曖昧照合
// ==============================

function matchKeepaModel(name, keepaList) {
  const cleanName = name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

  for (const k of keepaList) {
    const pn      = k.partNumber;
    const pnClean = pn.replace(/[^A-Za-z0-9]/g, "");

    if (name.toUpperCase().includes(pn)) return k;
    if (cleanName.includes(pnClean))     return k;
    if (levenshtein(cleanName, pnClean) <= 2) return k;
  }

  return null;
}

// ==============================
// 楽天 × Keepa 照合 ＋ 入金予定計算
// ==============================

function filterByKeepa(items, keepaList) {
  return items
    .map(item => {
      const matched = matchKeepaModel(item.name, keepaList);
      if (!matched || matched.price == null) return null;

      const price = matched.price;

      // FBA重量手数料は「今は気にしなくていい」とのことなので、
      // ここでは Pick&Pack と紹介料だけでシンプルに計算
      const income =
        price - matched.fbaFee - (price * matched.rate);

      return {
        ...item,
        model:        matched.partNumber,
        asin:         matched.asin,
        amazonUrl:    matched.asin ? `https://www.amazon.co.jp/dp/${matched.asin}` : "",
        keepaPrice:   price,
        incomePerUnit: Math.round(income)
      };
    })
    .filter(Boolean);
}

// ==============================
// テーブル描画
// ==============================

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

      <td>${item.asin || ""}</td>
      <td>${item.amazonUrl ? `<a href="${item.amazonUrl}" target="_blank">Amazon</a>` : ""}</td>
      <td>${item.keepaPrice}</td>
      <td>${item.incomePerUnit}</td>
    `;

    tbodyEl.appendChild(tr);
  }
}

// ==============================
// Excel 出力（テンプレートではなく「結果をそのまま表形式で」）
// ==============================
//
// ここは、
// ・テンプレートの数式を維持する方式もあり
// ・まずは「結果をそのまま xlsx にする」方がシンプルで扱いやすい
// という考えで、テーブル → シート → xlsx の形にしています。
// 必要になったら「12行目以降に流し込むテンプレートCSV」版も
// 別関数として用意できます。

function exportToExcel() {
  const table = document.getElementById("result-table");
  if (!table) {
    alert("結果テーブルが見つかりません");
    return;
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.table_to_sheet(table);

  XLSX.utils.book_append_sheet(wb, ws, "RAKUTEN_KEEPA");
  XLSX.writeFile(wb, "rakuten_keepa.xlsx");
}
