const { execFile } = require("child_process");
const fs = require("fs");
const dns = require("dns").promises;
const https = require("https");
const { CONFIG } = require("./config.cjs");

function debugLog(...args) {
  const ts = new Date().toISOString();
  const log = `[${ts}] ${args.join(" ")}`;
  console.log(log);
}

function runTraceroute(host = "1.1.1.1", maxHops = 5) {
  return new Promise((resolve) => {
    // Try ICMP mode first (requires root), fallback to UDP
    // Note: traceroute often fails in launchctl due to permissions
    // This is optional monitoring and gracefully degrades
    execFile(
      "/usr/sbin/traceroute",
      ["-I", "-m", String(maxHops), "-w", "2", host], // -I for ICMP, -w 2s timeout per hop
      { timeout: 15000 },
      (err, stdout, stderr) => {
        // If ICMP fails (no permissions), try UDP mode
        if (err) {
          execFile(
            "/usr/sbin/traceroute",
            ["-m", String(maxHops), "-w", "2", host],
            { timeout: 15000 },
            (err2, stdout2) => {
              if (err2) {
                // Traceroute unavailable - this is OK, continue without it
                // Common in launchctl without root permissions
                debugLog("Traceroute unavailable (no permissions)");
                return resolve(null);
              }
              resolve(parseTracerouteOutput(stdout2));
            }
          );
          return;
        }

        resolve(parseTracerouteOutput(stdout));
      }
    );
  });
}

function parseTracerouteOutput(stdout) {
  const hops = [];
  const lines = stdout.split("\n").slice(1);

  for (const line of lines) {
    const hopMatch = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!hopMatch) continue;

    const raw = hopMatch[2];
    const msMatches = raw.match(/([\d.]+)\s*ms/g);

    let avg = null;
    if (msMatches) {
      const times = msMatches.map((m) => parseFloat(m));
      avg = times.reduce((a, b) => a + b, 0) / times.length;
    }

    const hasStar = raw.includes("*");
    hops.push({
      hop: Number(hopMatch[1]),
      avg,
      hasStar,
      raw,
    });
  }

  return hops.length > 0 ? hops : null;
}

function evaluateTraceroute(hops) {
  if (!hops || !hops.length) {
    return {
      score: null,
      issues: ["Traceroute unavailable"],
    };
  }

  const issues = [];
  let score = 100;

  // Hop 1 health
  if (hops[0].avg != null && hops[0].avg > 40) {
    issues.push("High latency on first hop (VPN tunnel or local signal)");
    score -= (hops[0].avg - 40) * 0.5;
  }

  // Large hop-to-hop jumps
  for (let i = 1; i < hops.length; i++) {
    const prev = hops[i - 1];
    const cur = hops[i];
    if (prev.avg != null && cur.avg != null) {
      const diff = cur.avg - prev.avg;
      if (diff > 40) {
        issues.push(`Large latency jump at hop ${i + 1}`);
        score -= diff * 0.3;
      }
    }
  }

  // Stars (*) mean ICMP filtered or unstable
  hops.forEach((h) => {
    if (h.hasStar) {
      issues.push(`Unstable or filtered hop ${h.hop}`);
      score -= 10;
    }
  });

  // Final hop should not exceed 200ms (for VPN-to-EU baseline)
  const last = hops[hops.length - 1];
  if (last.avg > 200) {
    issues.push("High final-hop latency (VPN distance or congestion)");
    score -= (last.avg - 200) * 0.2;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return { score, issues };
}

function parseCsvLine(line) {
  const parts = line.split(",");
  return {
    provider: parts[1] || null,
    cloudflare_avg: Number(parts[10]) || null,
    cloudflare_jitter: Number(parts[11]) || null,
    cloudflare_loss: Number(parts[12]) || null,
    download_mbps: Number(parts[13]) || null,
    upload_mbps: Number(parts[14]) || null,
    ping_ms: Number(parts[15]) || null,
    stability: Number(parts[20]) || null,
  };
}

function computeRollingAverage(values) {
  const valid = values.filter((v) => typeof v === "number" && !isNaN(v));
  if (!valid.length) {
    return "";
  }
  return (valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(2);
}

function computeRollingWindows(allRows, windows) {
  const results = {};

  for (const window of windows) {
    const slice = allRows.slice(-window.rows);

    results[`cloudflare_avg_${window.label}`] = computeRollingAverage(
      slice.map((r) => r.cloudflare_avg)
    );

    results[`cloudflare_jitter_${window.label}`] = computeRollingAverage(
      slice.map((r) => r.cloudflare_jitter)
    );

    results[`cloudflare_loss_${window.label}`] = computeRollingAverage(
      slice.map((r) => r.cloudflare_loss)
    );

    results[`download_${window.label}`] = computeRollingAverage(
      slice.map((r) => r.download_mbps)
    );

    results[`upload_${window.label}`] = computeRollingAverage(
      slice.map((r) => r.upload_mbps)
    );

    results[`stability_${window.label}`] = computeRollingAverage(
      slice.map((r) => r.stability)
    );
  }

  return results;
}

function getRouterIp() {
  return new Promise((resolve) => {
    execFile("/usr/sbin/netstat", ["-rn", "-f", "inet"], (err, stdout) => {
      if (err) {
        debugLog("Getting router IP failed:", err.message);
        return resolve(null);
      }

      const lines = stdout.split("\n");

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);

        if (parts[0] === "default" && parts[parts.length - 1] === "en0") {
          const gateway = parts[1];
          debugLog("Got default router ip: " + gateway);
          return resolve(gateway);
        }
      }

      debugLog("Getting router IP failed: no default route found for en0");
      resolve(null);
    });
  });
}

async function measureHttpTTFB(url) {
  return new Promise((resolve) => {
    const start = Date.now();
    let ttfb = null;

    const req = https.get(url, { timeout: 8000 }, (res) => {
      res.once("data", () => {
        ttfb = Date.now() - start;
        resolve(ttfb);
        req.destroy(); // stop reading
      });

      // if server responds but delays first byte too much
      res.once("end", () => {
        if (ttfb === null) {
          debugLog(`Failed to get TTFB for "${url}:" No data received`);
          resolve(null);
        }
      });
    });

    req.on("timeout", () => {
      debugLog(`Failed to get TTFB for "${url}:" Timedout`);
      req.destroy();
      resolve(null);
    });

    req.on("error", (err) => {
      debugLog(`Failed to get TTFB for "${url}:" ${err}`);
      resolve(null);
    });
  });
}

async function measureDns(domain) {
  const start = Date.now();
  try {
    await dns.lookup(domain);
    return Date.now() - start; // ms
  } catch (err) {
    debugLog("DNS lookup failed for", domain, err.message);
    return null;
  }
}

async function detectHomeNetwork() {
  debugLog("Starting home network detection...");

  const HOME_ROUTER_IP = process.env.HOME_ROUTER_IP || "192.168.1.1";
  const HOME_ROUTER_MAC = (process.env.HOME_ROUTER_MAC || "").toLowerCase();

  if (!process.env.HOME_ROUTER_MAC) {
    debugLog(
      "⚠️  HOME_ROUTER_MAC not set in environment, skipping home network detection"
    );
    return false;
  }

  // --- STEP 1: Warm up ARP table ---
  debugLog("ARP warm-up: pinging router once...");
  await new Promise((resolve) => {
    execFile(
      "/sbin/ping",
      ["-c", "1", "-W", "500", HOME_ROUTER_IP],
      (err, stdout, stderr) => {
        if (err) {
          debugLog("ARP warm-up ping failed:", err.message);
        } else {
          debugLog("ARP warm-up ping successful.");
        }
        resolve();
      }
    );
  });

  // --- STEP 2: Read ARP table ---
  debugLog("Checking ARP table for router MAC...");

  return new Promise((resolve) => {
    execFile("/usr/sbin/arp", ["-a"], (err, stdout) => {
      if (err) {
        debugLog("Failed to read ARP table:", err.message);
        return resolve(false);
      }

      debugLog("ARP table output:\n" + stdout);

      const lines = stdout.split("\n");
      for (const line of lines) {
        if (line.includes(HOME_ROUTER_IP)) {
          debugLog("Found router ARP line: " + line);

          const match = line.match(/at ([0-9a-f:]+)/i);
          if (match) {
            const mac = match[1].toLowerCase();
            debugLog("Extracted router MAC:", mac);

            if (mac === HOME_ROUTER_MAC) {
              debugLog("Router MAC matches home network.");
              return resolve(true);
            } else {
              debugLog(
                "Router MAC mismatch. Expected:",
                HOME_ROUTER_MAC,
                "but got:",
                mac
              );
            }
          } else {
            debugLog("Could not extract MAC from ARP line.");
          }
        }
      }

      debugLog("Router MAC not found in ARP table — not home network.");
      resolve(false);
    });
  });
}

function ensureCsvHeader() {
  if (!fs.existsSync(CONFIG.LOG_FILE)) {
    const header =
      [
        "timestamp",
        "provider",
        "vpn",
        "online",

        // Router, Google, Cloudflare pings
        "router_avg_ms",
        "router_jitter_ms",
        "router_loss_pct",

        "google_avg_ms",
        "google_jitter_ms",
        "google_loss_pct",

        "cloudflare_avg_ms",
        "cloudflare_jitter_ms",
        "cloudflare_loss_pct",

        // Speedtest base
        "speed_download_mbps",
        "speed_upload_mbps",
        "speed_ping_ms",

        // NEW Speedtest jitter + packet loss
        "speedtest_idle_jitter_ms",
        "speedtest_download_jitter_ms",
        "speedtest_upload_jitter_ms",
        "speedtest_packet_loss_pct",

        // Stability
        "stability_score",

        // DNS
        "dns_cloudflare_ms",
        "dns_google_ms",

        // HTTP TTFB
        "http_ttfb_cloudflare_ms",

        // Rolling averages
        "cloudflare_avg_1h",
        "cloudflare_avg_24h",
        "cloudflare_jitter_1h",
        "cloudflare_jitter_24h",
        "cloudflare_loss_1h",
        "cloudflare_loss_24h",
        "download_1h",
        "download_24h",
        "upload_1h",
        "upload_24h",
        "stability_1h",
        "stability_24h",

        // NEW: summary fields
        "trace_score",
        "health_grade",
        "health_issue_count",
        "stability_label",
      ].join(",") + "\n";

    fs.writeFileSync(CONFIG.LOG_FILE, header, "utf8");
  }
}

// ---- PING / LATENCY / JITTER / PACKET LOSS ----

async function runPingTarget(targetName, ip) {
  debugLog(`Running ping to ${targetName} (${ip})...`);
  const result = await runPing(ip);
  debugLog(`Ping result for ${targetName}: ${JSON.stringify(result)}`);
  return { target: targetName, ip, ...result };
}

function runPing(target) {
  return new Promise((resolve) => {
    const args = ["-c", String(CONFIG.PING_COUNT), "-n", target];

    debugLog("Executing ping:", "/sbin/ping", args.join(" "));

    execFile(
      "/sbin/ping",
      args,
      { timeout: CONFIG.PING_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          debugLog("Ping error:", err.message);
          debugLog("Ping stderr:", stderr);
          return resolve({
            success: false,
            avgMs: null,
            minMs: null,
            maxMs: null,
            jitterMs: null,
            packetLossPct: null,
          });
        }

        debugLog("Ping stdout:", stdout);

        const lines = stdout.split("\n");
        const latencies = [];

        for (const line of lines) {
          const timeIndex = line.indexOf("time=");
          if (timeIndex !== -1) {
            const afterTime = line.slice(timeIndex + 5);
            const msStr = afterTime.split(" ")[0];
            const ms = parseFloat(msStr);
            if (!isNaN(ms)) {
              latencies.push(ms);
            }
          }
        }

        let packetLossPct = null;
        for (const line of lines) {
          if (line.includes("packet loss")) {
            const match = line.match(/([\d.]+)%\s*packet loss/);
            if (match) {
              packetLossPct = parseFloat(match[1]);
            }
            break;
          }
        }

        const result = {
          success: latencies.length > 0,
          avgMs: latencies.length
            ? latencies.reduce((a, b) => a + b, 0) / latencies.length
            : null,
          minMs: latencies.length ? Math.min(...latencies) : null,
          maxMs: latencies.length ? Math.max(...latencies) : null,
          jitterMs:
            latencies.length > 1
              ? latencies
                  .slice(1)
                  .map((v, i) => Math.abs(v - latencies[i]))
                  .reduce((a, b) => a + b, 0) /
                (latencies.length - 1)
              : 0,
          packetLossPct,
        };

        debugLog("Parsed ping result:", JSON.stringify(result));
        resolve(result);
      }
    );
  });
}

// ---- STABILITY SCORE ----
function labelForStability(score) {
  if (score >= 90) {
    return {
      label: "Excellent",
      description:
        "Very stable connection with low latency variation and strong throughput.",
    };
  } else if (score >= 75) {
    return {
      label: "Good",
      description:
        "Stable overall with minor fluctuations. Suitable for all normal tasks.",
    };
  } else if (score >= 60) {
    return {
      label: "Fair",
      description:
        "Some instability present. Browsing fine; video calls may occasionally suffer.",
    };
  } else if (score >= 40) {
    return {
      label: "Unstable",
      description:
        "High jitter or routing issues. Expect problems with real-time applications.",
    };
  } else if (score >= 20) {
    return {
      label: "Poor",
      description: "Significant instability. Only basic usage is reliable.",
    };
  } else {
    return {
      label: "Severely Degraded",
      description:
        "Connection barely functional. High packet loss or major routing issues.",
    };
  }
}

function computeStability(metrics) {
  const {
    pingAvg,
    pingJitter,
    packetLoss,
    downloadMbps,

    dnsCloudflare,
    dnsGoogle,
    ttfbCloudflare,

    idleJitter,
    downloadJitter,
    uploadJitter,

    speedtestPingMs,
  } = metrics;

  const thresholds = CONFIG.STABILITY;
  let score = 100;

  // -------------------------------
  // 1. Effective latency (avg of ICMP + Speedtest)
  // -------------------------------
  const latencies = [];
  if (pingAvg != null) latencies.push(pingAvg);
  if (speedtestPingMs != null) latencies.push(speedtestPingMs);

  const effPing =
    latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : null;

  if (effPing == null) {
    score -= thresholds.LATENCY_NULL_PENALTY;
  } else {
    if (effPing > thresholds.LATENCY_NORMAL_MAX) {
      score -=
        (effPing - thresholds.LATENCY_NORMAL_MAX) *
        thresholds.LATENCY_NORMAL_PENALTY;
    }

    if (effPing > thresholds.LATENCY_HIGH_THRESHOLD) {
      score -=
        (effPing - thresholds.LATENCY_HIGH_THRESHOLD) *
        thresholds.LATENCY_HIGH_PENALTY;
    }
  }

  // -------------------------------
  // 2. ICMP jitter
  // -------------------------------
  if (pingJitter != null) {
    const capped = Math.min(pingJitter, thresholds.JITTER_CAP);
    const over = Math.max(0, capped - thresholds.JITTER_THRESHOLD);
    score -= over * thresholds.JITTER_PENALTY;
  }

  // -------------------------------
  // 3. Stream jitter (speedtest jitter)
  // -------------------------------
  const streamJitter = Math.max(
    idleJitter ?? 0,
    downloadJitter ?? 0,
    uploadJitter ?? 0
  );

  if (streamJitter > thresholds.STREAM_JITTER_THRESHOLD) {
    score -=
      (streamJitter - thresholds.STREAM_JITTER_THRESHOLD) *
      thresholds.STREAM_JITTER_PENALTY;
  }

  // -------------------------------
  // 4. Packet loss (exponential scaling)
  // -------------------------------
  if (packetLoss != null && packetLoss > 0) {
    if (packetLoss < 5) {
      // Mild loss: 1-5% = -1 to -5 points
      score -= packetLoss * 1.0;
    } else if (packetLoss < 15) {
      // Moderate loss: 5-15% = -5 to -30 points
      score -= 5 + (packetLoss - 5) * 2.5;
    } else {
      // Severe loss: 15%+ = -30 to -45 points (capped impact)
      const severeLoss = Math.min(packetLoss - 15, 15); // Cap at 30% total
      score -= 30 + severeLoss * 1.0;
    }
  }

  // -------------------------------
  // 5. DNS latency
  // -------------------------------
  const dnsValues = [dnsCloudflare, dnsGoogle].filter(
    (v) => v != null && !Number.isNaN(v)
  );

  if (dnsValues.length) {
    const dnsAvg = dnsValues.reduce((a, b) => a + b, 0) / dnsValues.length;

    if (dnsAvg > thresholds.DNS_SLOW) {
      score -= (dnsAvg - thresholds.DNS_SLOW) * thresholds.DNS_SLOW_PENALTY;
    }
    if (dnsAvg > thresholds.DNS_VERY_SLOW) {
      score -=
        (dnsAvg - thresholds.DNS_VERY_SLOW) * thresholds.DNS_VERY_SLOW_PENALTY;
    }
  }

  // -------------------------------
  // 6. HTTP TTFB
  // -------------------------------
  if (ttfbCloudflare != null) {
    if (ttfbCloudflare > thresholds.TTFB_SLOW) {
      score -=
        (ttfbCloudflare - thresholds.TTFB_SLOW) * thresholds.TTFB_SLOW_PENALTY;
    }
    if (ttfbCloudflare > thresholds.TTFB_VERY_SLOW) {
      score -=
        (ttfbCloudflare - thresholds.TTFB_VERY_SLOW) *
        thresholds.TTFB_VERY_SLOW_PENALTY;
    }
  }

  // -------------------------------
  // 7. Download speed penalty
  // -------------------------------
  if (downloadMbps != null) {
    if (downloadMbps < thresholds.DOWNLOAD_MIN) {
      score -=
        (thresholds.DOWNLOAD_MIN - downloadMbps) *
        thresholds.DOWNLOAD_MIN_PENALTY;
    }
    if (downloadMbps < thresholds.DOWNLOAD_CRITICAL) {
      score -=
        (thresholds.DOWNLOAD_CRITICAL - downloadMbps) *
        thresholds.DOWNLOAD_CRITICAL_PENALTY;
    }
  } else {
    score -= thresholds.DOWNLOAD_NULL_PENALTY;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}

function generateHealthSummary({
  online,
  pingAvg,
  pingJitter,
  packetLoss,
  downloadMbps,
  uploadMbps,
  dnsCloudflare,
  dnsGoogle,
  ttfbCloudflare,
  idleJitter,
  downloadJitter,
  uploadJitter,
  stabilityScore,
  tracerouteHealth,
  vpn,
}) {
  let gradeScore = 4;
  let issues = [];

  const isVpn = Boolean(vpn);
  const base = CONFIG.HEALTH;

  // VPN-adjusted latency thresholds
  const latencyModerate = isVpn
    ? base.LATENCY_MODERATE + base.VPN_LATENCY_MODERATE_OFFSET
    : base.LATENCY_MODERATE;

  const latencyHigh = isVpn
    ? base.LATENCY_HIGH + base.VPN_LATENCY_HIGH_OFFSET
    : base.LATENCY_HIGH;

  const latencyVeryHigh = isVpn
    ? base.LATENCY_VERY_HIGH + base.VPN_LATENCY_VERY_HIGH_OFFSET
    : base.LATENCY_VERY_HIGH;

  // ---------------- OFFLINE ----------------
  if (!online) {
    return {
      grade: "F",
      issues: ["Device appears offline"],
      recommendation: "Check router, modem, or VPN connection.",
    };
  }

  // ---------------- LATENCY ----------------
  if (typeof pingAvg === "number") {
    if (pingAvg > latencyVeryHigh) {
      gradeScore = Math.min(gradeScore, 1);
      issues.push("Very high latency (likely VPN distance)");
    } else if (pingAvg > latencyHigh) {
      gradeScore = Math.min(gradeScore, 2);
      issues.push("High latency");
    } else if (pingAvg > latencyModerate) {
      gradeScore = Math.min(gradeScore, 3);
      issues.push("Moderate latency");
    }
  }

  // ---------------- ICMP JITTER ----------------
  if (typeof pingJitter === "number") {
    if (pingJitter > base.JITTER_SEVERE) {
      gradeScore = Math.min(gradeScore, 1);
      issues.push("Severe jitter (unstable connection)");
    } else if (pingJitter > base.JITTER_HIGH) {
      gradeScore = Math.min(gradeScore, 2);
      issues.push("High jitter");
    }
  }

  // ---------------- SPEEDTEST JITTER ----------------
  if (typeof idleJitter === "number" && idleJitter > base.IDLE_JITTER_SEVERE) {
    gradeScore = Math.min(gradeScore, 1);
    issues.push("Severe idle jitter (VPN routing issue)");
  }

  if (
    typeof downloadJitter === "number" &&
    downloadJitter > base.DOWNLOAD_JITTER_HIGH
  ) {
    gradeScore = Math.min(gradeScore, 1);
    issues.push("High download jitter (streaming may stutter)");
  }

  if (
    typeof uploadJitter === "number" &&
    uploadJitter > base.UPLOAD_JITTER_HIGH
  ) {
    gradeScore = Math.min(gradeScore, 1);
    issues.push("High upload jitter (video calls impacted)");
  }

  // ---------------- SPEED ----------------
  if (typeof downloadMbps === "number") {
    if (downloadMbps < base.DOWNLOAD_SLOW) {
      gradeScore = Math.min(gradeScore, 1);
      issues.push("Slow download speed");
    } else if (downloadMbps < base.DOWNLOAD_BELOW_AVG) {
      gradeScore = Math.min(gradeScore, 2);
      issues.push("Below average download speed");
    }
  }

  if (typeof uploadMbps === "number" && uploadMbps < base.UPLOAD_SLOW) {
    issues.push("Slow upload speed");
  }

  // ---------------- PACKET LOSS ----------------
  if (
    typeof packetLoss === "number" &&
    packetLoss > base.PACKET_LOSS_THRESHOLD
  ) {
    gradeScore = Math.min(gradeScore, 1);
    issues.push("Packet loss detected");
  }

  // ---------------- DNS ----------------
  const slowDns =
    (typeof dnsCloudflare === "number" && dnsCloudflare > base.DNS_SLOW) ||
    (typeof dnsGoogle === "number" && dnsGoogle > base.DNS_SLOW);

  if (slowDns) {
    gradeScore = Math.min(gradeScore, 3);
    issues.push("Slow DNS resolution");
  }

  // ---------------- TTFB ----------------
  if (typeof ttfbCloudflare === "number" && ttfbCloudflare > base.TTFB_SLOW) {
    gradeScore = Math.min(gradeScore, 3);
    issues.push("Slow HTTP response (TTFB)");
  }

  // ---------------- STABILITY ----------------
  if (typeof stabilityScore === "number") {
    if (stabilityScore < base.STABILITY_VERY_UNSTABLE) {
      gradeScore = Math.min(gradeScore, 1);
      issues.push("Very unstable connection");
    } else if (stabilityScore < base.STABILITY_REDUCED) {
      gradeScore = Math.min(gradeScore, 2);
      issues.push("Reduced stability");
    }
  }

  // ---------------- TRACEROUTE ----------------
  if (
    tracerouteHealth &&
    typeof tracerouteHealth.score === "number" &&
    tracerouteHealth.score < base.TRACEROUTE_POOR
  ) {
    issues.push("Routing instability detected");
    gradeScore = Math.min(gradeScore, 2);
  }

  // ---------------- RECOMMENDATION ----------------
  let recommendation = "";

  const pl = packetLoss ?? 0;
  const pj = pingJitter ?? 0;
  const dj = downloadJitter ?? 0;
  const uj = uploadJitter ?? 0;
  const dnsCf = dnsCloudflare ?? 0;
  const dnsG = dnsGoogle ?? 0;

  if (pl > base.SEVERE_PACKET_LOSS) {
    recommendation =
      "Severe packet loss — check Wi-Fi signal, router placement, or VPN stability.";
  } else if (typeof pingAvg === "number" && pingAvg > latencyVeryHigh) {
    recommendation = isVpn
      ? "Very high latency — try switching to a closer or less busy VPN server."
      : "Very high latency — check your ISP or another network.";
  } else if (
    pj > base.SEVERE_JITTER ||
    dj > base.SEVERE_DOWNLOAD_JITTER ||
    uj > base.SEVERE_UPLOAD_JITTER
  ) {
    recommendation = isVpn
      ? "High jitter — likely VPN congestion; try another server."
      : "High jitter — check Wi-Fi quality or reduce local traffic.";
  } else if (
    typeof downloadMbps === "number" &&
    downloadMbps < base.DOWNLOAD_SLOW
  ) {
    recommendation = isVpn
      ? "Slow download speed — reconnect VPN or select a closer server."
      : "Slow download speed — check cabling or ISP plan.";
  } else if (dnsCf > base.DNS_SLOW || dnsG > base.DNS_SLOW) {
    recommendation = isVpn
      ? "Slow DNS — configure Cloudflare DNS (1.1.1.1) in your VPN settings."
      : "Slow DNS — set Cloudflare DNS (1.1.1.1) system-wide.";
  } else if (
    typeof ttfbCloudflare === "number" &&
    ttfbCloudflare > base.TTFB_SLOW
  ) {
    recommendation = isVpn
      ? "High TTFB — likely due to VPN distance."
      : "High TTFB — remote server slow or routing issue.";
  } else if (
    tracerouteHealth &&
    typeof tracerouteHealth.score === "number" &&
    tracerouteHealth.score < base.TRACEROUTE_POOR
  ) {
    recommendation = isVpn
      ? "Routing issue over VPN — try another region/server."
      : "Routing issue — possible ISP transit congestion.";
  } else {
    recommendation = "Connection is functioning normally.";
  }

  const letterGrades = ["F", "D", "C", "B", "A"];
  const grade = letterGrades[gradeScore];

  return {
    grade,
    issues: issues.length ? issues : ["No major issues"],
    recommendation,
  };
}

module.exports = {
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
};
