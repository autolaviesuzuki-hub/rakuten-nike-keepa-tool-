// =========================================================
// app.js（最終完全版）
// =========================================================

document.addEventListener("DOMContentLoaded", () => {

  // ---- DOM ----
  const rakutenAppIdInput     = document.getElementById("rakutenAppId");
  const rakutenAccessKeyInput = document.getElementById("rakutenAccessKey");
  const rakutenHitsInput      = document.getElementById("rakutenHits");
  const rakutenMaxPageInput   = document.getElementById("rakutenMaxPage");
  const searchKeywordInput    = document.getElementById("searchKeywordInput");

  const runRakutenApiBtn = document.getElementById("runRakutenApiBtn");
  const keepaCsvInput    = document.getElementById("keepaCsvInput");
  const clearKeepaBtn    = document.getElementById("clearKeepaBtn");
  const runMatchBtn      = document.getElementById("runMatchBtn");
  const exportExcelBtn   = document.getElementById("exportExcelBtn");
  const exportRawCsvBtn  = document.getElementById("exportRawCsvBtn");

  const rakutenStatus = document.getElementById("rakutenStatus");
  const keepaStatus   = document.getElementById("keepaStatus");
  const matchStatus   = document.getElementById("matchStatus");
  const matchSummary  = document.getElementById("matchSummary");

  const resultTableBody = document.querySelector("#resultTable tbody");
  const logArea         = document.getElementById("logArea");

  // ---- 状態 ----
  let rakutenRows = [];
  let keepaRows   = [];
  let resultRows  = [];

  // ---- ログ ----
  function log(msg) {
    const t = new Date().toLocaleTimeString();
    logArea.value += `[${t}] ${msg}\n`;
    logArea.scrollTop = logArea.scrollHeight;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // =========================================================
  // 楽天API（openapi版 / CORS不要 / 高速）
  // =========================================================
  async function fetchRakutenPage(keyword, page, hits, appId, accessKey) {
    const BASE_URL = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701";

    const params = new URLSearchParams({
      applicationId: appId,
      accessKey: accessKey,
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

  function parseRakutenItems(items) {
    return items.map(entry => {
      const item = entry.Item;
      return {
        shop: item.shopName,
        name: item.itemName,
        url:  item.itemUrl,
        price: item.itemPrice
      };
    });
  }

  async function runRakutenApi() {
    const appId     = rakutenAppIdInput.value.trim();
    const accessKey = rakutenAccessKeyInput.value.trim();
    const hits      = Number(rakutenHitsInput.value);
    const maxPage   = Number(rakutenMaxPageInput.value);
    const keyword   = searchKeywordInput.value.trim();

    rakutenRows = [];
    log(`楽天API開始 keyword=${keyword}`);

    for (let page = 1; page <= maxPage; page++) {
      rakutenStatus.textContent = `楽天API取得中… ${page}/${maxPage}`;

      const items = await fetchRakutenPage(keyword, page, hits, appId, accessKey);
      if (items) {
        rakutenRows.push(...parseRakutenItems(items));
      }

      await sleep(1200);
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
    keepaStatus.textContent = `Keepa CSV読込完了（${keepaRows.length}件）`;
    log(`Keepa CSV読込完了 rows=${keepaRows.length}`);

    updateButtons();
  }

  clearKeepaBtn.addEventListener("click", () => {
    keepaRows = [];
    keepaStatus.textContent = "Keepa CSV: 未読込";
    log("Keepa CSVクリア");
    updateButtons();
  });

  // =========================================================
  // Amazonロジック（価格・入金予定）
  // =========================================================
  function getKeepaInfo(row) {
    const asin = row["ASIN"];
    const part = row["商品コード: PartNumber"];

    const buyBoxRaw = row["Buy Box: 現在価格"];
    const fbaRaw    = row["新しい、第三者FBA: 現在価格"];

    const buyBox = buyBoxRaw ? Number(String(buyBoxRaw).replace(/,/g, "")) : null;
    const fbaMin = fbaRaw    ? Number(String(fbaRaw).replace(/,/g, ""))    : null;

    let price = null;
    if (buyBox && buyBox > 0) price = buyBox;
    else if (fbaMin && fbaMin > 0) price = fbaMin;
    else return null;

    const fbaFeeRaw = row["FBA Pick&Pack 料金"];
    const fbaFee    = fbaFeeRaw ? Number(String(fbaFeeRaw).replace(/,/g, "")) : 0;

    const rateRaw = row["紹介料％"];
    let referralRate = 0;
    if (rateRaw) referralRate = parseFloat(String(rateRaw).replace("%", "")) / 100;

    const referralFee = price * referralRate;
    const net = Math.round(price - referralFee - fbaFee);

    return {
      asin,
      part,
      price,
      netPerUnit: net
    };
  }

  // =========================================================
  // 型番照合
  // =========================================================
  function matchKeepaModel(name, keepaRows) {
    const cleanName = name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

    for (const row of keepaRows) {
      const pnRaw = row["商品コード: PartNumber"];
      if (!pnRaw) continue;

      const pn      = String(pnRaw).toUpperCase();
      const pnClean = pn.replace(/[^A-Za-z0-9]/g, "");

      if (name.toUpperCase().includes(pn)) return row;
      if (cleanName.includes(pnClean))     return row;
    }

    return null;
  }

  function runMatching() {
    resultRows = [];

    for (const r of rakutenRows) {
      const matchedRow = matchKeepaModel(r.name, keepaRows);
      if (!matchedRow) continue;

      const info = getKeepaInfo(matchedRow);
      if (!info) continue;

      resultRows.push({
        shop: r.shop,
        name: r.name,
        model: info.part,
        rakutenUrl: r.url,
        unitPrice: r.price,
        asin: info.asin,
        amazonUrl: info.asin ? `https://www.amazon.co.jp/dp/${info.asin}` : "",
        listingPrice: info.price,
        netPerUnit: info.netPerUnit
      });
    }

    renderResultTable();
    matchSummary.textContent = `型番一致: ${resultRows.length}件`;
    matchStatus.textContent = "照合完了";
    log(`照合完了 hit=${resultRows.length}`);

    updateButtons();
  }

  // =========================================================
  // テーブル描画
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
  // RAW CSV出力
  // =========================================================
  function exportRawCsv() {
    const header = [
      "ショップ","商品名","型番","楽天URL","単価",
      "ASIN","AmazonURL","出品価格","入金予定"
    ];

    const rows = resultRows.map(r => [
      r.shop, r.name, r.model, r.rakutenUrl, r.unitPrice,
      r.asin, r.amazonUrl, r.listingPrice, r.netPerUnit
    ]);

    const csv = Papa.unparse([header, ...rows]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "照合結果_raw.csv";
    a.click();
    URL.revokeObjectURL(url);

    log("RAW CSV出力完了");
  }

  // =========================================================
  // Excelテンプレート出力（数式行コピー対応）
  // =========================================================
  async function exportExcelTemplate() {

    // ① テンプレート読込
    const templateBuffer = await fetch("rakutenPointTemplate.xlsx").then(r => r.arrayBuffer());
    const wb = XLSX.read(templateBuffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];

    // ② 12行目の数式セルを取得
    const formulaRow = 12;

    // ③ 書き込み開始行
    let row = 13;

    for (const r of resultRows) {

      // --- 数式行コピー（12行目 → row） ---
      const range = XLSX.utils.decode_range(ws["!ref"]);
      for (let C = range.s.c; C <= range.e.c; C++) {
        const col = XLSX.utils.encode_col(C);
        const srcCell = ws[`${col}${formulaRow}`];
        if (srcCell && srcCell.f) {
          ws[`${col}${row}`] = { f: srcCell.f };
        }
      }

      // --- 楽天側（B〜F列） ---
      ws[`B${row}`] = { v: r.shop };
      ws[`C${row}`] = { v: r.name };
      ws[`D${row}`] = { v: r.model };
      ws[`E${row}`] = { v: r.rakutenUrl };
      ws[`F${row}`] = { v: r.unitPrice };

      // --- Amazon側（CK〜CN列） ---
      ws[`CK${row}`] = { v: r.asin };
      ws[`CL${row}`] = { v: r.amazonUrl };
      ws[`CM${row}`] = { v: r.listingPrice };
      ws[`CN${row}`] = { v: r.netPerUnit };

      row++;
    }

    // ④ Excel保存
    XLSX.writeFile(wb, "楽天ポイント集計_自動出力.xlsx");
    log("Excelテンプレート出力完了");
  }

  // =========================================================
  // ボタン制御
  // =========================================================
  function updateButtons() {
    runMatchBtn.disabled      = !(rakutenRows.length > 0 && keepaRows.length > 0);
    exportExcelBtn.disabled   = resultRows.length === 0;
    exportRawCsvBtn.disabled  = resultRows.length === 0;
  }

  // =========================================================
  // イベント登録（同期済み）
  // =========================================================
  runRakutenApiBtn.addEventListener("click", runRakutenApi);

  keepaCsvInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await loadKeepaCsv(file);
  });

  runMatchBtn.addEventListener("click", runMatching);
  exportExcelBtn.addEventListener("click", exportExcelTemplate);
  exportRawCsvBtn.addEventListener("click", exportRawCsv);

});
