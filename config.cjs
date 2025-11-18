const path = require("path");

const LOG_DIR = path.join(__dirname, "logs");

const CONFIG = {
  DRY_RUN: process.env.DRY_RUN === "true",
  LOG_DIR: LOG_DIR,
  LOG_FILE: path.join(LOG_DIR, "net_monitor.csv"),
  PING_TARGETS: [
    { name: "router", ip: process.env.HOME_ROUTER_IP || "192.168.1.1" },
    { name: "google", ip: "8.8.8.8" },
    { name: "cloudflare", ip: "1.1.1.1" },
  ],
  PING_COUNT: Number(process.env.PING_COUNT || 5),
  PING_TIMEOUT_MS: Number(process.env.PING_TIMEOUT_MS || 15_000),
  RUN_SPEEDTEST: process.env.NO_SPEEDTEST === "1" ? false : true,
  SPEED_TEST_TIMEOUT_MS: Number(process.env.SPEED_TEST_TIMEOUT_MS || 300_000), // 5 minutes
  PROVIDER: process.env.PROVIDER || "", // e.g. "Tele2 5G" or "Beeline"
  VPN: process.env.VPN || "", // e.g. "on", "off", "Amsterdam",
  ROLLING_WINDOWS: [
    { label: "1h", rows: 4 },
    { label: "24h", rows: 96 },
  ],

  // ---- Stability Score Thresholds ----
  STABILITY: {
    // Effective latency thresholds
    LATENCY_NORMAL_MAX: 180,
    LATENCY_NORMAL_PENALTY: 0.08,
    LATENCY_HIGH_THRESHOLD: 260,
    LATENCY_HIGH_PENALTY: 0.15,
    LATENCY_NULL_PENALTY: 8,

    // ICMP jitter thresholds
    JITTER_CAP: 120,
    JITTER_THRESHOLD: 25,
    JITTER_PENALTY: 0.2,

    // Stream jitter thresholds
    STREAM_JITTER_THRESHOLD: 45,
    STREAM_JITTER_PENALTY: 0.15,

    // Packet loss uses exponential scaling (see computeStability):
    // 0-5%: -1 to -5 points (mild)
    // 5-15%: -5 to -30 points (moderate)
    // 15-30%+: -30 to -45 points (severe, capped)

    // DNS thresholds
    DNS_SLOW: 200,
    DNS_SLOW_PENALTY: 0.04,
    DNS_VERY_SLOW: 350,
    DNS_VERY_SLOW_PENALTY: 0.08,

    // HTTP TTFB thresholds
    TTFB_SLOW: 650,
    TTFB_SLOW_PENALTY: 0.02,
    TTFB_VERY_SLOW: 1200,
    TTFB_VERY_SLOW_PENALTY: 0.05,

    // Download speed thresholds
    DOWNLOAD_MIN: 20,
    DOWNLOAD_MIN_PENALTY: 0.8,
    DOWNLOAD_CRITICAL: 5,
    DOWNLOAD_CRITICAL_PENALTY: 1.6,
    DOWNLOAD_NULL_PENALTY: 10,
  },

  // ---- Health Summary Thresholds ----
  HEALTH: {
    // VPN adjustment offsets
    VPN_LATENCY_MODERATE_OFFSET: 40,
    VPN_LATENCY_HIGH_OFFSET: 60,
    VPN_LATENCY_VERY_HIGH_OFFSET: 80,

    // Base latency thresholds
    LATENCY_MODERATE: 80,
    LATENCY_HIGH: 120,
    LATENCY_VERY_HIGH: 200,

    // Jitter thresholds
    JITTER_HIGH: 25,
    JITTER_SEVERE: 50,

    // Speedtest jitter thresholds
    DOWNLOAD_JITTER_HIGH: 35,
    UPLOAD_JITTER_HIGH: 35,
    IDLE_JITTER_SEVERE: 50,

    // Speed thresholds
    DOWNLOAD_SLOW: 10,
    DOWNLOAD_BELOW_AVG: 25,
    UPLOAD_SLOW: 3,

    // Packet loss threshold
    PACKET_LOSS_THRESHOLD: 1,

    // DNS threshold
    DNS_SLOW: 120,

    // TTFB threshold
    TTFB_SLOW: 600,

    // Stability thresholds
    STABILITY_VERY_UNSTABLE: 40,
    STABILITY_REDUCED: 70,

    // Traceroute threshold
    TRACEROUTE_POOR: 50,

    // Severe issue thresholds for recommendations
    SEVERE_PACKET_LOSS: 10,
    SEVERE_JITTER: 40,
    SEVERE_DOWNLOAD_JITTER: 60,
    SEVERE_UPLOAD_JITTER: 60,
  },
};

module.exports = { CONFIG };
