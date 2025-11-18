#!/usr/bin/env node

/**
 * Recompute Rolling Averages Script
 *
 * This script reads the existing CSV file and recalculates all rolling
 * averages for each row based on the historical data up to that point.
 * It creates a backup of the original file before modifying it.
 */

const fs = require("fs");
const path = require("path");
const { parseCsvLine, computeRollingWindows } = require("./utils.cjs");
const { CONFIG } = require("./config.cjs");

function parseCsvLineForRecompute(line) {
  const parts = line.split(",");

  // Parse all fields we need
  return {
    timestamp: parts[0] || "",
    provider: parts[1] || "",
    vpn: parts[2] || "",
    online: parts[3] || "",

    // Router ping
    router_avg_ms: parts[4] || "",
    router_jitter_ms: parts[5] || "",
    router_loss_pct: parts[6] || "",

    // Google ping
    google_avg_ms: parts[7] || "",
    google_jitter_ms: parts[8] || "",
    google_loss_pct: parts[9] || "",

    // Cloudflare ping
    cloudflare_avg_ms: parts[10] || "",
    cloudflare_jitter_ms: parts[11] || "",
    cloudflare_loss_pct: parts[12] || "",

    // Speedtest
    speed_download_mbps: parts[13] || "",
    speed_upload_mbps: parts[14] || "",
    speed_ping_ms: parts[15] || "",

    // Speedtest jitter
    speedtest_idle_jitter_ms: parts[16] || "",
    speedtest_download_jitter_ms: parts[17] || "",
    speedtest_upload_jitter_ms: parts[18] || "",
    speedtest_packet_loss_pct: parts[19] || "",

    // Stability
    stability_score: parts[20] || "",

    // DNS
    dns_cloudflare_ms: parts[21] || "",
    dns_google_ms: parts[22] || "",

    // HTTP
    http_ttfb_cloudflare_ms: parts[23] || "",

    // Rolling averages (to be replaced)
    cloudflare_avg_1h: parts[24] || "",
    cloudflare_avg_24h: parts[25] || "",
    cloudflare_jitter_1h: parts[26] || "",
    cloudflare_jitter_24h: parts[27] || "",
    cloudflare_loss_1h: parts[28] || "",
    cloudflare_loss_24h: parts[29] || "",
    download_1h: parts[30] || "",
    download_24h: parts[31] || "",
    upload_1h: parts[32] || "",
    upload_24h: parts[33] || "",
    stability_1h: parts[34] || "",
    stability_24h: parts[35] || "",

    // Summary fields
    trace_score: parts[36] || "",
    health_grade: parts[37] || "",
    health_issue_count: parts[38] || "",
    stability_label: parts[39] || "",
  };
}

function reconstructCsvLine(row) {
  return [
    row.timestamp,
    row.provider,
    row.vpn,
    row.online,

    row.router_avg_ms,
    row.router_jitter_ms,
    row.router_loss_pct,

    row.google_avg_ms,
    row.google_jitter_ms,
    row.google_loss_pct,

    row.cloudflare_avg_ms,
    row.cloudflare_jitter_ms,
    row.cloudflare_loss_pct,

    row.speed_download_mbps,
    row.speed_upload_mbps,
    row.speed_ping_ms,

    row.speedtest_idle_jitter_ms,
    row.speedtest_download_jitter_ms,
    row.speedtest_upload_jitter_ms,
    row.speedtest_packet_loss_pct,

    row.stability_score,

    row.dns_cloudflare_ms,
    row.dns_google_ms,

    row.http_ttfb_cloudflare_ms,

    // Rolling averages
    row.cloudflare_avg_1h,
    row.cloudflare_avg_24h,
    row.cloudflare_jitter_1h,
    row.cloudflare_jitter_24h,
    row.cloudflare_loss_1h,
    row.cloudflare_loss_24h,
    row.download_1h,
    row.download_24h,
    row.upload_1h,
    row.upload_24h,
    row.stability_1h,
    row.stability_24h,

    row.trace_score,
    row.health_grade,
    row.health_issue_count,
    row.stability_label,
  ].join(",");
}

function main() {
  const logFile = CONFIG.LOG_FILE;

  if (!fs.existsSync(logFile)) {
    console.error(`❌ Log file not found: ${logFile}`);
    process.exit(1);
  }

  console.log(`📂 Reading CSV file: ${logFile}`);

  const content = fs.readFileSync(logFile, "utf8");
  const lines = content.trim().split("\n");

  if (lines.length < 2) {
    console.error("❌ CSV file is empty or has no data rows");
    process.exit(1);
  }

  const header = lines[0];
  const dataLines = lines.slice(1);

  console.log(`📊 Found ${dataLines.length} data rows`);

  // Create backup
  const backupFile = logFile.replace(".csv", `.backup.${Date.now()}.csv`);
  fs.copyFileSync(logFile, backupFile);
  console.log(`💾 Backup created: ${backupFile}`);

  // Parse all rows
  const parsedRows = dataLines.map(parseCsvLineForRecompute);

  // Process each row and recompute rolling averages
  const updatedLines = [header];
  const historyByProvider = {};

  for (let i = 0; i < parsedRows.length; i++) {
    const row = parsedRows[i];
    const provider = row.provider;

    // Initialize history for this provider if needed
    if (!historyByProvider[provider]) {
      historyByProvider[provider] = [];
    }

    // Get history up to (but not including) current row
    const pastRows = historyByProvider[provider];

    // Recompute rolling averages using the same function as index.cjs
    const rolling = computeRollingWindows(pastRows, CONFIG.ROLLING_WINDOWS);

    // Update the row with new rolling averages
    row.cloudflare_avg_1h = rolling.cloudflare_avg_1h;
    row.cloudflare_avg_24h = rolling.cloudflare_avg_24h;
    row.cloudflare_jitter_1h = rolling.cloudflare_jitter_1h;
    row.cloudflare_jitter_24h = rolling.cloudflare_jitter_24h;
    row.cloudflare_loss_1h = rolling.cloudflare_loss_1h;
    row.cloudflare_loss_24h = rolling.cloudflare_loss_24h;
    row.download_1h = rolling.download_1h;
    row.download_24h = rolling.download_24h;
    row.upload_1h = rolling.upload_1h;
    row.upload_24h = rolling.upload_24h;
    row.stability_1h = rolling.stability_1h;
    row.stability_24h = rolling.stability_24h;

    // Add updated row to output
    updatedLines.push(reconstructCsvLine(row));

    // Add current row to history for next iteration
    // Use the same format as parseCsvLine in utils.cjs
    historyByProvider[provider].push({
      provider: row.provider,
      cloudflare_avg: Number(row.cloudflare_avg_ms) || null,
      cloudflare_jitter: Number(row.cloudflare_jitter_ms) || null,
      cloudflare_loss: Number(row.cloudflare_loss_pct) || null,
      download_mbps: Number(row.speed_download_mbps) || null,
      upload_mbps: Number(row.speed_upload_mbps) || null,
      ping_ms: Number(row.speed_ping_ms) || null,
      stability: Number(row.stability_score) || null,
    });

    // Progress indicator
    if ((i + 1) % 10 === 0 || i === parsedRows.length - 1) {
      process.stdout.write(
        `\r⏳ Processing: ${i + 1}/${parsedRows.length} rows`
      );
    }
  }

  console.log("\n");

  // Write updated CSV
  fs.writeFileSync(logFile, updatedLines.join("\n") + "\n", "utf8");

  console.log("✅ Rolling averages recomputed successfully!");
  console.log(`📝 Updated file: ${logFile}`);
  console.log(`💾 Backup saved: ${backupFile}`);

  // Show summary by provider
  console.log("\n📈 Summary:");
  for (const [provider, rows] of Object.entries(historyByProvider)) {
    console.log(`   ${provider}: ${rows.length} rows`);
  }
}

main();
