// ==============================
// 楽天 × Keepa 照合ツール app.js
// （openapi版 ＋ Amazonロジック統合版）
// ==============================

// 固定値（必要なら HTML 側から入力に変更してもOK）
const APPLICATION_ID = "a38ecc5b-5a90-4eb9-b4f8-e714ba84eefd";
const ACCESS_KEY     = "pk_oRPj9UEOAjvjnUtRwKwaje85mgY98Nzo7rzvGf7sQRj";
const BASE_URL       = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701";

document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("status");
  const tbodyEl  = document.querySelector("#result-table tbody");
  const logEl    = document.getElementById("log");

  const startBtn  = document.getElementById("start");
  const exportBtn = document.getElementById("export");

  function log(message) {
    if (!logEl) return;
    const time = new Date().toTimeString().split(" ")[0];
    logEl.value += `[${time}] ${message}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==============================
  // 楽天API 1ページ取得（openapi版）
  // ==============================
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
      try {
        const res  = await fetch(`${BASE_URL}?${params.toString()}`);
        const data = await res.json();

        if (data.errors) {
          log(`楽天APIエラー page=${page} errors=${JSON.stringify(data.errors)}`);
          return null;
        }

        if (data.statusCode === 429) {
          log(`楽天API 429 Too Many Requests page=${page} → リトライ`);
          await sleep(1000);
          continue;
        }

        if (data.Items) {
          log(`楽天API page=${page} 取得件数=${data.Items.length}`);
          return data.Items;
        }

        log(`楽天API page=${page} Itemsなし`);
        return null;
      } catch (e) {
        log(`楽天API例外 page=${page} error=${e}`);
        return null;
      }
    }
  }

  // ==============================
  // 楽天 Items パース
  // ==============================
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

  // ==============================
  // Keepa CSV 読み込み（PapaParse）
  // ==============================
  async function loadKeepaCsvFromLocal() {
    const fileInput = document.getElementById("keepaCsv");
    const file = fileInput ? fileInput.files[0] : null;
    if (!file) return null;

    const text = await file.text();

    const parsed = Papa.parse(text, {
      header: true,
      skipEmptyLines: true
    });

    // そのまま行データを返す（Amazonロジックでフル活用）
    return parsed.data;
  }

  // ==============================
  // レーベンシュタイン距離
  // ==============================
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

  // ==============================
  // 型番曖昧照合（楽天商品名 × Keepa PartNumber）
  // ==============================
  function matchKeepaModel(name, keepaRows) {
    const cleanName = name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

    for (const row of keepaRows) {
      const pnRaw = row["商品コード: PartNumber"];
      if (!pnRaw) continue;

      const pn      = String(pnRaw).toUpperCase();
      const pnClean = pn.replace(/[^A-Za-z0-9]/g, "");

      if (name.toUpperCase().includes(pn)) return row;
      if (cleanName.includes(pnClean))     return row;
      if (levenshtein(cleanName, pnClean) <= 2) return row;
    }

    return null;
  }

  // ==============================
  // Amazonロジック（Keepa行 → 価格・入金予定）
  // ==============================
  function getKeepaInfo(row) {
    const asin = row["ASIN"];
    const part = row["商品コード: PartNumber"];

    // --- 価格の読み取り（カンマ除去 → 数値化） ---
    const buyBoxRaw = row["Buy Box: 現在価格"];
    const fbaRaw    = row["新しい、第三者FBA: 現在価格"];

    const buyBox = buyBoxRaw ? Number(String(buyBoxRaw).replace(/,/g, "")) : null;
    const fbaMin = fbaRaw    ? Number(String(fbaRaw).replace(/,/g, ""))    : null;

    // --- 出品価格の優先順位 ---
    let price = null;
    if (buyBox && buyBox > 0) price = buyBox;
    else if (fbaMin && fbaMin > 0) price = fbaMin;
    else return null;  // 価格が取れない商品は照合対象外

    // --- FBA Pick&Pack 料金 ---
    const fbaFeeRaw = row["FBA Pick&Pack 料金"];
    const fbaFee    = fbaFeeRaw ? Number(String(fbaFeeRaw).replace(/,/g, "")) : 0;

    // --- 紹介料％（例: "12.40%"） ---
    const rateRaw = row["紹介料％"];
    let referralRate = 0;
    if (rateRaw) {
      referralRate = parseFloat(String(rateRaw).replace("%", "")) / 100;
    }

    // --- 入金予定（重量手数料は今は無視） ---
    const referralFee = price * referralRate;
    const net = Math.round(price - referralFee - fbaFee);

    return {
      asin,
      part,
      price,
      netPerUnit: net
    };
  }

  // ==============================
  // 楽天 × Keepa 照合
  // ==============================
  function filterByKeepa(items, keepaRows) {
    return items
      .map(item => {
        const matchedRow = matchKeepaModel(item.name, keepaRows);
        if (!matchedRow) return null;

        const info = getKeepaInfo(matchedRow);
        if (!info) return null;

        return {
          ...item,
          model: info.part,
          asin: info.asin,
          amazonUrl: info.asin ? `https://www.amazon.co.jp/dp/${info.asin}` : "",
          keepaPrice: info.price,
          incomePerUnit: info.netPerUnit
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

        <td>${item.asin}</td>
        <td>${item.amazonUrl ? `<a href="${item.amazonUrl}" target="_blank">Amazon</a>` : ""}</td>
        <td>${item.keepaPrice}</td>
        <td>${item.incomePerUnit}</td>
      `;

      tbodyEl.appendChild(tr);
    }
  }

  // ==============================
  // Excel 出力
  // ==============================
  function exportToExcel() {
    const tableEl = document.getElementById("result-table");
    if (!tableEl) {
      alert("結果テーブルが見つかりません");
      return;
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.table_to_sheet(tableEl);

    XLSX.utils.book_append_sheet(wb, ws, "RAKUTEN_KEEPA");
    XLSX.writeFile(wb, "rakuten_keepa.xlsx");
  }

  // ==============================
  // イベントハンドラ
  // ==============================
  if (startBtn) {
    startBtn.addEventListener("click", async () => {
      const keywordInput = document.getElementById("keyword");
      const hitsInput    = document.getElementById("hits");
      const maxPageInput = document.getElementById("maxPage");

      const keyword = keywordInput ? keywordInput.value.trim() : "";
      if (!keyword) {
        alert("検索ワードを入力してください");
        return;
      }

      const hits    = hitsInput    ? Number(hitsInput.value)    || 30  : 30;
      const maxPage = maxPageInput ? Number(maxPageInput.value) || 100 : 100;

      if (statusEl) statusEl.textContent = `${keyword} の楽天検索を開始します…`;
      log(`楽天API開始 keyword=${keyword} hits=${hits} maxPage=${maxPage}`);

      const allItems = [];

      for (let page = 1; page <= maxPage; page++) {
        if (statusEl) statusEl.textContent = `楽天API取得中… ページ ${page} / ${maxPage}`;

        const items = await fetchRakutenPage(keyword, page, hits);
        if (items && items.length > 0) {
          const parsed = parseItems(items);
          allItems.push(...parsed);
        }

        await sleep(1400); // レート制限対策
      }

      log(`楽天API完了 total=${allItems.length}`);
      if (statusEl) statusEl.textContent = `楽天取得完了。${allItems.length}件。Keepa CSV を読み込みます…`;

      const keepaRows = await loadKeepaCsvFromLocal();
      if (!keepaRows) {
        alert("Keepa CSV を選択してください");
        return;
      }
      log(`Keepa CSV読込完了 rows=${keepaRows.length}`);

      const matchedItems = filterByKeepa(allItems, keepaRows);

      if (statusEl) statusEl.textContent = `型番一致 ${matchedItems.length}件。Excel 出力可能です。`;
      log(`型番一致: ${matchedItems.length}件`);

      renderTable(matchedItems);
    });
  }

  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      exportToExcel();
    });
  }
});
