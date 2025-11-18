#!/usr/bin/env node
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const fs = require("fs");
const {
  debugLog,
  runTraceroute,
  evaluateTraceroute,
  parseCsvLine,
  computeRollingWindows,
  getRouterIp,
  measureHttpTTFB,
  measureDns,
  detectHomeNetwork,
  ensureCsvHeader,
  runPingTarget,
  computeStability,
  labelForStability,
  generateHealthSummary,
} = require("./utils.cjs");

const { CONFIG } = require("./config.cjs");
const { runSpeedTest } = require("./speedtest.cjs");

if (!fs.existsSync(CONFIG.LOG_DIR)) {
  fs.mkdirSync(CONFIG.LOG_DIR);
}

async function main() {
  debugLog("Script started. Launchd environment:", JSON.stringify(process.env));
  await new Promise((r) => setTimeout(r, 2000));

  const routerIp = await getRouterIp();

  if (!routerIp) {
    debugLog("Router ip not found, aborting...");
    return;
  }

  const isHome = await detectHomeNetwork();
  debugLog("Home network:", isHome);

  // Skip if dry run
  if (!isHome && !CONFIG.DRY_RUN) {
    debugLog("Not on home network — skipping run.");
    console.log("Skipping — not on home network.");
    return;
  }

  ensureCsvHeader();

  if (!isHome) {
    CONFIG.PING_TARGETS.forEach((target) => {
      if (target.name === "router") {
        target.ip = routerIp;
      }
    });
  }

  debugLog(
    "Starting ping test to: " +
      CONFIG.PING_TARGETS.map((t) => `${t.name}(${t.ip})`).join(", ")
  );
  const pingResults = {};
  for (const target of CONFIG.PING_TARGETS) {
    const r = await runPingTarget(target.name, target.ip);
    pingResults[target.name] = r;
  }
  debugLog("Ping result:", JSON.stringify(pingResults));

  const timestamp = new Date().toISOString();

  const online =
    pingResults.router.success &&
    pingResults.cloudflare.success &&
    pingResults.cloudflare.packetLossPct != null &&
    pingResults.cloudflare.packetLossPct < 100;

  debugLog("Online determination:", online);

  debugLog("Running DNS tests...");
  const dnsCloudflare = await measureDns("one.one.one.one");
  const dnsGoogle = await measureDns("google.com");

  debugLog("DNS results:", dnsCloudflare, dnsGoogle);

  debugLog("Running HTTP TTFB tests...");
  const ttfbCloudflare = await measureHttpTTFB("https://1.1.1.1/cdn-cgi/trace");
  debugLog(`HTTP TTFB results:`, JSON.stringify(ttfbCloudflare));

  debugLog("Running traceroute...");
  const tracerouteHops = await runTraceroute("1.1.1.1", 5);
  debugLog(`Traceroute results:`, JSON.stringify(tracerouteHops));
  const tracerouteHealth = evaluateTraceroute(tracerouteHops);

  debugLog("Running speedtest...");
  let speedResult = {
    success: false,
    downloadMbps: null,
    uploadMbps: null,
    pingMs: null,
    idleJitter: null,
    downloadJitter: null,
    uploadJitter: null,
    raw: null,
  };

  if (online && CONFIG.RUN_SPEEDTEST) {
    speedResult = await runSpeedTest();
  }
  debugLog("Speedtest result:", JSON.stringify(speedResult));

  const stabilityScore = computeStability({
    pingAvg: pingResults.cloudflare.avgMs,
    pingJitter: pingResults.cloudflare.jitterMs,
    packetLoss: pingResults.cloudflare.packetLossPct,

    downloadMbps: speedResult.downloadMbps,

    dnsCloudflare,
    dnsGoogle,

    ttfbCloudflare,

    idleJitter: speedResult.idleJitter,
    downloadJitter: speedResult.downloadJitter,
    uploadJitter: speedResult.uploadJitter,

    speedtestPingMs: speedResult.pingMs,
  });

  const stabilityMeta = labelForStability(stabilityScore);

  // Read previous rows (up to maximum window size)
  let pastRows = [];
  try {
    if (fs.existsSync(CONFIG.LOG_FILE)) {
      const raw = fs
        .readFileSync(CONFIG.LOG_FILE, "utf8")
        .trim()
        .split("\n")
        .slice(1); // remove header

      pastRows = raw
        .map(parseCsvLine)
        .filter((row) => row.provider === CONFIG.PROVIDER);
    }
  } catch (e) {
    debugLog("Failed reading past CSV for rolling averages:", e.message);
  }

  // Compute rolling averages
  const rolling = computeRollingWindows(pastRows, CONFIG.ROLLING_WINDOWS);

  const health = generateHealthSummary({
    online,
    pingAvg: pingResults.cloudflare.avgMs,
    pingJitter: pingResults.cloudflare.jitterMs,
    packetLoss: pingResults.cloudflare.packetLossPct,
    downloadMbps: speedResult.downloadMbps,
    uploadMbps: speedResult.uploadMbps,
    dnsCloudflare,
    dnsGoogle,
    ttfbCloudflare,
    idleJitter: speedResult.idleJitter,
    downloadJitter: speedResult.downloadJitter,
    uploadJitter: speedResult.uploadJitter,
    speedtestPacketLoss: speedResult.packetLoss,
    stabilityScore,
    tracerouteHealth,
    vpn: CONFIG.VPN,
  });

  const line = [
    timestamp,
    CONFIG.PROVIDER,
    CONFIG.VPN,
    online ? 1 : 0,

    // router
    pingResults.router.avgMs ?? "",
    pingResults.router.jitterMs ?? "",
    pingResults.router.packetLossPct ?? "",

    // google
    pingResults.google.avgMs ?? "",
    pingResults.google.jitterMs ?? "",
    pingResults.google.packetLossPct ?? "",

    // cloudflare
    pingResults.cloudflare.avgMs ?? "",
    pingResults.cloudflare.jitterMs ?? "",
    pingResults.cloudflare.packetLossPct ?? "",

    // Speedtest
    speedResult.downloadMbps != null ? speedResult.downloadMbps.toFixed(2) : "",
    speedResult.uploadMbps != null ? speedResult.uploadMbps.toFixed(2) : "",
    speedResult.pingMs != null ? speedResult.pingMs.toFixed(2) : "",

    // NEW Speedtest jitter + packet loss
    speedResult.idleJitter ?? "",
    speedResult.downloadJitter ?? "",
    speedResult.uploadJitter ?? "",
    speedResult.packetLoss ?? "",

    // Stability
    stabilityScore,

    // DNS
    dnsCloudflare ?? "",
    dnsGoogle ?? "",

    // HTTP TTFB
    ttfbCloudflare ?? "",

    // Rolling averages
    rolling.cloudflare_avg_1h,
    rolling.cloudflare_avg_24h,
    rolling.cloudflare_jitter_1h,
    rolling.cloudflare_jitter_24h,
    rolling.cloudflare_loss_1h,
    rolling.cloudflare_loss_24h,
    rolling.download_1h,
    rolling.download_24h,
    rolling.upload_1h,
    rolling.upload_24h,
    rolling.stability_1h,
    rolling.stability_24h,

    // NEW: summary fields
    tracerouteHealth && typeof tracerouteHealth.score === "number"
      ? tracerouteHealth.score
      : "",
    health.grade ?? "",
    Array.isArray(health.issues) ? health.issues.length : "",
    stabilityMeta.label ?? "",
  ].join(",");

  if (!CONFIG.DRY_RUN) {
    fs.appendFileSync(CONFIG.LOG_FILE, line + "\n", "utf8");
  }

  console.log("\n=== 📡 Internet Quality Snapshot ===");

  if (CONFIG.DRY_RUN) {
    console.log("⚠️  DRY_RUN enabled — results NOT saved to logs\n");
  }

  console.log("🕒 Timestamp      :", timestamp);
  console.log("🏷️  Provider      :", CONFIG.PROVIDER || "(not set)");
  console.log("🛡️  VPN           :", CONFIG.VPN || "(not set)");
  console.log("📶 Online         :", online ? "YES" : "NO");

  // --- Ping Results ---
  console.log("\n--- 🔁 Ping Measurements (ms) ---");

  function fmtPing(label, result) {
    const avg = result.avgMs != null ? result.avgMs.toFixed(2) : "n/a";
    const jit = result.jitterMs != null ? result.jitterMs.toFixed(2) : "n/a";
    const loss =
      result.packetLossPct != null
        ? result.packetLossPct.toFixed(2) + " %"
        : "n/a";

    console.log(
      `${label.padEnd(14)} avg=${avg} ms | jitter=${jit} ms | loss=${loss}`
    );
  }

  fmtPing("Router", pingResults.router);
  fmtPing("Google", pingResults.google);
  fmtPing("Cloudflare", pingResults.cloudflare);

  // --- Speedtest ---
  console.log("\n--- 🚀 Speedtest ---");

  console.log(
    "Download       :",
    speedResult.downloadMbps != null
      ? speedResult.downloadMbps.toFixed(2) +
          " Mbps (" +
          (speedResult.downloadMbps / 8).toFixed(2) +
          " MBs)"
      : "n/a"
  );

  console.log(
    "Upload         :",
    speedResult.uploadMbps != null
      ? speedResult.uploadMbps.toFixed(2) +
          " Mbps (" +
          (speedResult.uploadMbps / 8).toFixed(2) +
          " MBs)"
      : "n/a"
  );

  console.log(
    "Server Latency :",
    speedResult.pingMs != null ? speedResult.pingMs.toFixed(2) + " ms" : "n/a"
  );

  // Additional jitter values
  console.log(
    "Idle Jitter    :",
    speedResult.idleJitter != null
      ? speedResult.idleJitter.toFixed(2) + " ms"
      : "n/a"
  );
  console.log(
    "DL Jitter      :",
    speedResult.downloadJitter != null
      ? speedResult.downloadJitter.toFixed(2) + " ms"
      : "n/a"
  );
  console.log(
    "UL Jitter      :",
    speedResult.uploadJitter != null
      ? speedResult.uploadJitter.toFixed(2) + " ms"
      : "n/a"
  );

  // Server details (if available)
  if (speedResult.raw?.server) {
    console.log("\n--- 🛰 Speedtest Server ---");
    console.log("Name           :", speedResult.raw.server.name);
    console.log("Location       :", speedResult.raw.server.location);
    console.log("Country        :", speedResult.raw.server.country);
    console.log("IP             :", speedResult.raw.server.ip);
    console.log("Host           :", speedResult.raw.server.host);
    console.log("Port           :", speedResult.raw.server.port);
  }

  // Interface info
  if (speedResult.raw?.interface) {
    console.log("\n--- 🔌 Interface Info ---");
    console.log("Router IP      :", routerIp);
    console.log("Internal IP    :", speedResult.raw.interface.internalIp);
    console.log("External IP    :", speedResult.raw.interface.externalIp);
    console.log("Network Name   :", speedResult.raw.interface.name);
    console.log(
      "Is VPN         :",
      speedResult.raw.interface.isVpn ? "YES" : "NO"
    );
  } else {
    console.log("\n--- 🔌 Interface Info ---");
    console.log("Router IP      :", routerIp);
  }

  if (speedResult.raw?.isp) {
    console.log("ISP            :", speedResult.raw.isp);
  }

  // --- Stability ---
  console.log("\n--- 📊 Stability ---");
  console.log("Stability Score :", stabilityScore, "/ 100");
  console.log("Stability Level :", stabilityMeta.label);
  console.log("Meaning         :", stabilityMeta.description);

  // --- Traceroute Health ---
  console.log("\n--- 🧭 Traceroute Health ---");

  if (!tracerouteHealth || tracerouteHealth.score === null) {
    console.log("Traceroute      : unavailable");
  } else {
    console.log("Trace Score     :", tracerouteHealth.score, "/ 100");
    console.log("Trace Issues    :", tracerouteHealth.issues.join("; "));

    console.log("\n--- Route Hops ---");
    tracerouteHops.forEach((h) => {
      console.log(
        `Hop ${h.hop}: avg=${h.avg ? h.avg.toFixed(2) : "n/a"} ms  ${
          h.hasStar ? "*" : ""
        }`
      );
    });
  }
  // --- DNS ---
  console.log("\n--- 🌐 DNS Lookup ---");
  console.log(
    "Cloudflare DNS :",
    dnsCloudflare != null ? dnsCloudflare + " ms" : "n/a"
  );
  console.log(
    "Google DNS     :",
    dnsGoogle != null ? dnsGoogle + " ms" : "n/a"
  );

  // --- HTTP ---
  console.log("\n--- 🌍 HTTP TTFB ---");
  console.log(
    "Cloudflare TTFB:",
    ttfbCloudflare != null ? ttfbCloudflare + " ms" : "n/a"
  );

  console.log("\n=== 🧠 Network Health Summary ===");
  console.log("Overall Grade    :", health.grade);
  console.log("Main Issues      :", health.issues.join("; "));
  console.log("Recommendation   :", health.recommendation);

  // --- Logs ---
  console.log("\nLog File       :", CONFIG.LOG_FILE);
  console.log("==========================================\n");
}

main().catch((err) => {
  console.error("Fatal error in net-monitor:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  debugLog("Unhandled Rejection at:", promise, "reason:", reason);
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  debugLog("Uncaught Exception thrown:", err);
  console.error("Uncaught Exception thrown:", err);
  process.exit(1);
});
