#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Configuration
const CONFIG = {
  ollama: {
    enabled: process.env.OLLAMA_ENABLED === "true",
    endpoint: process.env.OLLAMA_ENDPOINT || "http://localhost:11434",
    model: process.env.OLLAMA_MODEL || "llama3.1:8b",
  },
};

// Constants
const COMPARISON_METRICS = [
  // Speed metrics
  { key: "download", name: "Download Speed", higher: true, unit: "Mbps" },
  { key: "upload", name: "Upload Speed", higher: true, unit: "Mbps" },

  // Latency metrics
  { key: "ping", name: "Speedtest Ping", higher: false, unit: "ms" },
  { key: "routerLatency", name: "Router Latency", higher: false, unit: "ms" },
  {
    key: "cloudflareLatency",
    name: "Cloudflare Latency",
    higher: false,
    unit: "ms",
  },
  { key: "googleLatency", name: "Google Latency", higher: false, unit: "ms" },

  // Jitter metrics
  { key: "routerJitter", name: "Router Jitter", higher: false, unit: "ms" },
  {
    key: "cloudflareJitter",
    name: "Cloudflare Jitter",
    higher: false,
    unit: "ms",
  },
  { key: "downloadJitter", name: "Download Jitter", higher: false, unit: "ms" },
  { key: "uploadJitter", name: "Upload Jitter", higher: false, unit: "ms" },

  // Packet loss metrics
  { key: "routerLoss", name: "Router Packet Loss", higher: false, unit: "%" },
  {
    key: "cloudflareLoss",
    name: "Cloudflare Packet Loss",
    higher: false,
    unit: "%",
  },
  { key: "googleLoss", name: "Google Packet Loss", higher: false, unit: "%" },

  // Stability metrics
  { key: "stabilityScore", name: "Stability Score", higher: true, unit: "" },
  { key: "healthIssues", name: "Health Issues", higher: false, unit: "" },
];

/**
 * Parse CSV file into array of objects
 */
function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");
  const headers = lines[0].split(",");

  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const obj = {};
    headers.forEach((header, i) => {
      const value = values[i];
      // Convert to number if possible, otherwise keep as string
      obj[header] =
        value === "" ? null : isNaN(value) ? value : parseFloat(value);
    });
    return obj;
  });
}

/**
 * Calculate statistics for a numeric array
 */
function calculateStats(values) {
  const validValues = values.filter((v) => v !== null && !isNaN(v));
  if (validValues.length === 0) return null;

  const sorted = [...validValues].sort((a, b) => a - b);
  const sum = validValues.reduce((a, b) => a + b, 0);
  const mean = sum / validValues.length;

  const variance =
    validValues.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) /
    validValues.length;
  const stdDev = Math.sqrt(variance);

  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];

  return {
    count: validValues.length,
    min: Math.min(...validValues),
    max: Math.max(...validValues),
    mean: mean,
    median: p50,
    stdDev: stdDev,
    p95: p95,
    p99: p99,
  };
}

/**
 * Group data by provider
 */
function groupByProvider(data) {
  return data.reduce((groups, row) => {
    if (!groups[row.provider]) groups[row.provider] = [];
    groups[row.provider].push(row);
    return groups;
  }, {});
}

/**
 * Analyze time-of-day patterns
 */
function analyzeTimePatterns(data) {
  const patterns = {
    morning: { hours: [6, 7, 8, 9, 10, 11], data: [] },
    afternoon: { hours: [12, 13, 14, 15, 16, 17], data: [] },
    evening: { hours: [18, 19, 20, 21, 22, 23], data: [] },
    night: { hours: [0, 1, 2, 3, 4, 5], data: [] },
  };

  // Group data by time of day
  data.forEach((record) => {
    if (!record.timestamp) return;

    const date = new Date(record.timestamp);
    const hour = date.getHours();

    if (patterns.morning.hours.includes(hour)) {
      patterns.morning.data.push(record);
    } else if (patterns.afternoon.hours.includes(hour)) {
      patterns.afternoon.data.push(record);
    } else if (patterns.evening.hours.includes(hour)) {
      patterns.evening.data.push(record);
    } else if (patterns.night.hours.includes(hour)) {
      patterns.night.data.push(record);
    }
  });

  // Calculate stats for each time period
  const stats = {};
  Object.entries(patterns).forEach(([period, { data: periodData }]) => {
    if (periodData.length > 0) {
      stats[period] = {
        count: periodData.length,
        download: calculateStats(periodData.map((r) => r.speed_download_mbps)),
        upload: calculateStats(periodData.map((r) => r.speed_upload_mbps)),
        ping: calculateStats(periodData.map((r) => r.speed_ping_ms)),
        stabilityScore: calculateStats(
          periodData.map((r) => r.stability_score)
        ),
      };
    }
  });

  return stats;
}

/**
 * Analyze key metrics for each provider
 */
function analyzeProvider(data, providerName) {
  const metrics = {
    provider: providerName,
    totalSamples: data.length,

    // Time-of-day patterns
    timePatterns: analyzeTimePatterns(data),

    // Speed metrics
    download: calculateStats(data.map((r) => r.speed_download_mbps)),
    upload: calculateStats(data.map((r) => r.speed_upload_mbps)),

    // Latency metrics
    ping: calculateStats(data.map((r) => r.speed_ping_ms)),
    routerLatency: calculateStats(data.map((r) => r.router_avg_ms)),
    cloudflareLatency: calculateStats(data.map((r) => r.cloudflare_avg_ms)),
    googleLatency: calculateStats(data.map((r) => r.google_avg_ms)),

    // Jitter metrics
    routerJitter: calculateStats(data.map((r) => r.router_jitter_ms)),
    cloudflareJitter: calculateStats(data.map((r) => r.cloudflare_jitter_ms)),
    downloadJitter: calculateStats(
      data.map((r) => r.speedtest_download_jitter_ms)
    ),
    uploadJitter: calculateStats(data.map((r) => r.speedtest_upload_jitter_ms)),

    // Packet loss
    routerLoss: calculateStats(data.map((r) => r.router_loss_pct)),
    cloudflareLoss: calculateStats(data.map((r) => r.cloudflare_loss_pct)),
    googleLoss: calculateStats(data.map((r) => r.google_loss_pct)),
    speedtestLoss: calculateStats(data.map((r) => r.speedtest_packet_loss_pct)),

    // Stability
    stabilityScore: calculateStats(data.map((r) => r.stability_score)),

    // Health
    healthGrades: data.map((r) => r.health_grade).filter(Boolean),
    healthIssues: calculateStats(data.map((r) => r.health_issue_count)),

    // Stability labels
    stabilityLabels: data.map((r) => r.stability_label).filter(Boolean),
  };

  return metrics;
}

/**
 * Compare multiple providers (2 or more)
 */
function compareProviders(analyses) {
  const comparison = { winner: {}, differences: {}, providerNames: [] };

  if (!analyses || analyses.length < 2) {
    throw new Error("Need at least 2 providers to compare");
  }

  comparison.providerNames = analyses.map((a) => a.provider);

  COMPARISON_METRICS.forEach(({ key, name, higher, unit }) => {
    const metricData = {
      name,
      unit,
      values: {},
      medians: {},
    };

    // Collect all values for this metric
    let bestValue = null;
    let bestProvider = null;
    let allNull = true;

    analyses.forEach((analysis) => {
      const val = analysis[key]?.mean;
      const median = analysis[key]?.median;

      metricData.values[analysis.provider] = val;
      metricData.medians[analysis.provider] = median;

      if (val != null) {
        allNull = false;

        // Determine best value
        if (bestValue === null) {
          bestValue = val;
          bestProvider = analysis.provider;
        } else {
          const isBetter = higher ? val > bestValue : val < bestValue;
          if (isBetter) {
            bestValue = val;
            bestProvider = analysis.provider;
          }
        }
      }
    });

    if (!allNull) {
      comparison.winner[key] = bestProvider;

      // Calculate differences from best
      const differences = {};
      analyses.forEach((analysis) => {
        const val = analysis[key]?.mean;
        if (val != null && bestValue != null) {
          const diff = Math.abs(val - bestValue);
          const diffPct = bestValue !== 0 ? (diff / bestValue) * 100 : 0;
          differences[analysis.provider] = {
            value: val,
            diff: diff,
            diffPct: diffPct,
          };
        }
      });

      metricData.winner = bestProvider;
      metricData.differences = differences;
      comparison.differences[key] = metricData;
    }
  });

  return comparison;
}

/**
 * Format a number with proper precision
 */
function formatNumber(num, decimals = 2) {
  if (num == null) return "N/A";
  return num.toFixed(decimals);
}

/**
 * Format time patterns for AI analysis context
 */
function formatTimePatterns(timePatterns) {
  if (!timePatterns) return "";

  const periods = [
    { key: "morning", label: "Morning (6am-12pm)" },
    { key: "afternoon", label: "Afternoon (12pm-6pm)" },
    { key: "evening", label: "Evening (6pm-12am)" },
    { key: "night", label: "Night (12am-6am)" },
  ];

  const hasData = periods.some((p) => timePatterns[p.key]?.count > 0);
  if (!hasData) return "";

  let text = "\n**TIME-OF-DAY PATTERNS:**\n";
  periods.forEach(({ key, label }) => {
    const pattern = timePatterns[key];
    if (pattern && pattern.count > 0) {
      text += `\n${label} (${pattern.count} samples):\n`;
      text += `  Download: ${formatNumber(
        pattern.download?.mean
      )} Mbps (median: ${formatNumber(pattern.download?.median)})\n`;
      text += `  Upload: ${formatNumber(
        pattern.upload?.mean
      )} Mbps (median: ${formatNumber(pattern.upload?.median)})\n`;
      text += `  Ping: ${formatNumber(
        pattern.ping?.mean
      )} ms (median: ${formatNumber(pattern.ping?.median)})\n`;
      text += `  Stability: ${formatNumber(
        pattern.stabilityScore?.mean
      )} (median: ${formatNumber(pattern.stabilityScore?.median)})\n`;
    }
  });

  return text;
}

/**
 * Count distribution of values
 */
function countDistribution(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

/**
 * Print distribution with percentages
 */
function printDistribution(title, distribution, total) {
  console.log(title);
  Object.entries(distribution)
    .sort()
    .forEach(([label, count]) => {
      const pct = ((count / total) * 100).toFixed(1);
      console.log(`  ${label}: ${count} (${pct}%)`);
    });
}

/**
 * Print statistics table
 */
function printStats(stats, metric) {
  if (!stats) return "N/A";
  return `${formatNumber(stats.mean)} (±${formatNumber(
    stats.stdDev
  )}) median: ${formatNumber(stats.median)} [${formatNumber(
    stats.min
  )}-${formatNumber(stats.max)}]`;
}

/**
 * Print detailed provider analysis
 */
function printProviderAnalysis(analysis) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`PROVIDER: ${analysis.provider}`);
  console.log(`${"=".repeat(80)}`);
  console.log(`Total Samples: ${analysis.totalSamples}\n`);

  console.log("SPEED METRICS:");
  console.log(`  Download:        ${printStats(analysis.download)} Mbps`);
  console.log(`  Upload:          ${printStats(analysis.upload)} Mbps\n`);

  console.log("LATENCY METRICS:");
  console.log(`  Speedtest Ping:  ${printStats(analysis.ping)} ms`);
  console.log(`  Router:          ${printStats(analysis.routerLatency)} ms`);
  console.log(
    `  Cloudflare:      ${printStats(analysis.cloudflareLatency)} ms`
  );
  console.log(`  Google:          ${printStats(analysis.googleLatency)} ms\n`);

  console.log("JITTER METRICS:");
  console.log(`  Router:          ${printStats(analysis.routerJitter)} ms`);
  console.log(`  Cloudflare:      ${printStats(analysis.cloudflareJitter)} ms`);
  console.log(`  Download:        ${printStats(analysis.downloadJitter)} ms`);
  console.log(`  Upload:          ${printStats(analysis.uploadJitter)} ms\n`);

  console.log("PACKET LOSS:");
  console.log(`  Router:          ${printStats(analysis.routerLoss)} %`);
  console.log(`  Cloudflare:      ${printStats(analysis.cloudflareLoss)} %`);
  console.log(`  Google:          ${printStats(analysis.googleLoss)} %`);
  console.log(`  Speedtest:       ${printStats(analysis.speedtestLoss)} %\n`);

  console.log("STABILITY:");
  console.log(`  Stability Score: ${printStats(analysis.stabilityScore)}`);
  console.log(`  Health Issues:   ${printStats(analysis.healthIssues)}\n`);

  // Print time-of-day patterns
  if (analysis.timePatterns && Object.keys(analysis.timePatterns).length > 0) {
    console.log("TIME-OF-DAY PATTERNS:");
    const periods = ["morning", "afternoon", "evening", "night"];
    const labels = {
      morning: "Morning (6am-12pm)",
      afternoon: "Afternoon (12pm-6pm)",
      evening: "Evening (6pm-12am)",
      night: "Night (12am-6am)",
    };

    periods.forEach((period) => {
      const stats = analysis.timePatterns[period];
      if (stats && stats.count > 0) {
        console.log(
          `  ${labels[period].padEnd(25)} ${stats.count
            .toString()
            .padStart(2)} samples | DL: ${formatNumber(
            stats.download?.mean
          ).padStart(6)} Mbps | Ping: ${formatNumber(stats.ping?.mean).padStart(
            6
          )} ms`
        );
      }
    });
    console.log();
  }

  // Print distributions
  printDistribution(
    "HEALTH GRADE DISTRIBUTION:",
    countDistribution(analysis.healthGrades),
    analysis.totalSamples
  );

  console.log();
  printDistribution(
    "STABILITY LABEL DISTRIBUTION:",
    countDistribution(analysis.stabilityLabels),
    analysis.totalSamples
  );
}

/**
 * Format difference string
 */
function formatDifference(diff, unit, diffPct) {
  if (diff === 0) return "Equal";
  return `${formatNumber(diff).padStart(10)} ${unit} (${formatNumber(
    diffPct,
    1
  )}%)`;
}

/**
 * Print comparison between multiple providers
 */
function printComparison(comparison, providers) {
  console.log(`\n${"=".repeat(80)}`);
  console.log("PROVIDER COMPARISON");
  console.log(`${"=".repeat(80)}\n`);

  Object.entries(comparison.differences).forEach(([key, data]) => {
    const winnerMark = (p) => (data.winner === p ? "✓" : " ");

    console.log(`${data.name}:`);

    // Print each provider's value
    providers.forEach((provider) => {
      const value = data.values[provider];
      const median = data.medians[provider];

      if (value != null) {
        console.log(
          `  ${winnerMark(provider)} ${provider.padEnd(15)} ${formatNumber(
            value
          ).padStart(10)} ${data.unit} (median: ${formatNumber(median)})`
        );
      }
    });

    // Show differences from winner
    if (providers.length === 2) {
      const [p1, p2] = providers;
      const val1 = data.values[p1];
      const val2 = data.values[p2];
      if (val1 != null && val2 != null) {
        const diff = Math.abs(val1 - val2);
        const diffPct = (diff / Math.min(val1, val2)) * 100;
        console.log(
          `  Difference: ${formatDifference(diff, data.unit, diffPct)}`
        );
      }
    } else {
      // For 3+ providers, show difference from best
      console.log(`  Differences from best (${data.winner}):`);
      providers.forEach((provider) => {
        if (provider !== data.winner && data.differences[provider]) {
          const diff = data.differences[provider];
          console.log(
            `    ${provider}: +${formatNumber(diff.diff)} ${
              data.unit
            } (+${formatNumber(diff.diffPct, 1)}%)`
          );
        }
      });
    }

    console.log();
  });

  // Summary
  const winCounts = providers.reduce(
    (counts, p) => ({ ...counts, [p]: 0 }),
    {}
  );
  Object.values(comparison.winner).forEach((w) => winCounts[w]++);
  const totalMetrics = Object.keys(comparison.winner).length;

  console.log("SUMMARY:");
  providers.forEach((provider) => {
    const pct = ((winCounts[provider] / totalMetrics) * 100).toFixed(0);
    console.log(
      `  ${provider}: ${winCounts[provider]}/${totalMetrics} metrics best (${pct}%)`
    );
  });
}

/**
 * Generate markdown report for multiple providers (3+)
 */
function generateMultiProviderReport(analyses, providers) {
  let md = "# Network Provider Multi-Comparison Report\n\n";
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Providers: ${providers.join(", ")}\n\n`;

  // Create a table with all providers
  md += "## Performance Overview\n\n";

  // Download Speed
  md += "### Download Speed (Mbps)\n\n";
  md += "| Provider | Mean | Median | Std Dev | Min | Max | P95 |\n";
  md += "|----------|------|--------|---------|-----|-----|-....|\n";
  analyses.forEach((analysis) => {
    md += `| ${analysis.provider} | ${formatNumber(
      analysis.download?.mean
    )} | ${formatNumber(analysis.download?.median)} | ${formatNumber(
      analysis.download?.stdDev
    )} | ${formatNumber(analysis.download?.min)} | ${formatNumber(
      analysis.download?.max
    )} | ${formatNumber(analysis.download?.p95)} |\n`;
  });
  md += "\n";

  // Upload Speed
  md += "### Upload Speed (Mbps)\n\n";
  md += "| Provider | Mean | Median | Std Dev | Min | Max | P95 |\n";
  md += "|----------|------|--------|---------|-----|-----|-....|\n";
  analyses.forEach((analysis) => {
    md += `| ${analysis.provider} | ${formatNumber(
      analysis.upload?.mean
    )} | ${formatNumber(analysis.upload?.median)} | ${formatNumber(
      analysis.upload?.stdDev
    )} | ${formatNumber(analysis.upload?.min)} | ${formatNumber(
      analysis.upload?.max
    )} | ${formatNumber(analysis.upload?.p95)} |\n`;
  });
  md += "\n";

  // Latency Summary
  md += "### Latency Summary (ms)\n\n";
  md += "| Provider | Speedtest Ping | Router | Cloudflare | Google |\n";
  md += "|----------|----------------|--------|------------|--------|\n";
  analyses.forEach((analysis) => {
    md += `| ${analysis.provider} | ${formatNumber(
      analysis.ping?.mean
    )} | ${formatNumber(analysis.routerLatency?.mean)} | ${formatNumber(
      analysis.cloudflareLatency?.mean
    )} | ${formatNumber(analysis.googleLatency?.mean)} |\n`;
  });
  md += "\n";

  // Packet Loss Summary
  md += "### Packet Loss (%)\n\n";
  md += "| Provider | Router | Cloudflare | Google |\n";
  md += "|----------|--------|------------|--------|\n";
  analyses.forEach((analysis) => {
    md += `| ${analysis.provider} | ${formatNumber(
      analysis.routerLoss?.mean
    )} | ${formatNumber(analysis.cloudflareLoss?.mean)} | ${formatNumber(
      analysis.googleLoss?.mean
    )} |\n`;
  });
  md += "\n";

  // Stability
  md += "### Stability\n\n";
  md += "| Provider | Stability Score | Health Issues | Samples |\n";
  md += "|----------|-----------------|---------------|----------|\n";
  analyses.forEach((analysis) => {
    md += `| ${analysis.provider} | ${formatNumber(
      analysis.stabilityScore?.mean
    )} | ${formatNumber(analysis.healthIssues?.mean)} | ${
      analysis.totalSamples
    } |\n`;
  });
  md += "\n";

  // Individual Details
  md += "## Detailed Provider Statistics\n\n";
  analyses.forEach((analysis) => {
    md += `### ${analysis.provider}\n\n`;
    md += `- **Total Samples**: ${analysis.totalSamples}\n`;
    md += `- **Download Speed**: ${formatNumber(
      analysis.download?.mean
    )} ± ${formatNumber(
      analysis.download?.stdDev
    )} Mbps (median: ${formatNumber(analysis.download?.median)})\n`;
    md += `- **Upload Speed**: ${formatNumber(
      analysis.upload?.mean
    )} ± ${formatNumber(analysis.upload?.stdDev)} Mbps (median: ${formatNumber(
      analysis.upload?.median
    )})\n`;
    md += `- **Speedtest Ping**: ${formatNumber(
      analysis.ping?.mean
    )} ± ${formatNumber(analysis.ping?.stdDev)} ms\n`;
    md += `- **Stability Score**: ${formatNumber(
      analysis.stabilityScore?.mean
    )} ± ${formatNumber(analysis.stabilityScore?.stdDev)}\n\n`;
  });

  return md;
}

/**
 * Generate markdown report for single provider
 */
function generateSingleProviderReport(analysis, provider) {
  let md = "# Network Performance Report\n\n";
  md += `Provider: ${provider}\n`;
  md += `Generated: ${new Date().toISOString()}\n`;
  md += `Total Samples: ${analysis.totalSamples}\n\n`;

  md += "## Speed Metrics\n\n";
  md += `- **Download Speed**: ${formatNumber(
    analysis.download?.mean
  )} ± ${formatNumber(analysis.download?.stdDev)} Mbps (median: ${formatNumber(
    analysis.download?.median
  )})\n`;
  md += `  - Range: [${formatNumber(analysis.download?.min)} - ${formatNumber(
    analysis.download?.max
  )}] Mbps\n`;
  md += `  - 95th percentile: ${formatNumber(analysis.download?.p95)} Mbps\n`;
  md += `- **Upload Speed**: ${formatNumber(
    analysis.upload?.mean
  )} ± ${formatNumber(analysis.upload?.stdDev)} Mbps (median: ${formatNumber(
    analysis.upload?.median
  )})\n`;
  md += `  - Range: [${formatNumber(analysis.upload?.min)} - ${formatNumber(
    analysis.upload?.max
  )}] Mbps\n`;
  md += `  - 95th percentile: ${formatNumber(analysis.upload?.p95)} Mbps\n\n`;

  md += "## Latency Metrics\n\n";
  md += `- **Speedtest Ping**: ${formatNumber(
    analysis.ping?.mean
  )} ± ${formatNumber(analysis.ping?.stdDev)} ms (median: ${formatNumber(
    analysis.ping?.median
  )})\n`;
  md += `- **Router Latency**: ${formatNumber(
    analysis.routerLatency?.mean
  )} ± ${formatNumber(
    analysis.routerLatency?.stdDev
  )} ms (median: ${formatNumber(analysis.routerLatency?.median)})\n`;
  md += `- **Cloudflare Latency**: ${formatNumber(
    analysis.cloudflareLatency?.mean
  )} ± ${formatNumber(
    analysis.cloudflareLatency?.stdDev
  )} ms (median: ${formatNumber(analysis.cloudflareLatency?.median)})\n`;
  md += `- **Google Latency**: ${formatNumber(
    analysis.googleLatency?.mean
  )} ± ${formatNumber(
    analysis.googleLatency?.stdDev
  )} ms (median: ${formatNumber(analysis.googleLatency?.median)})\n\n`;

  md += "## Jitter Metrics\n\n";
  md += `- **Router Jitter**: ${formatNumber(
    analysis.routerJitter?.mean
  )} ± ${formatNumber(
    analysis.routerJitter?.stdDev
  )} ms (median: ${formatNumber(analysis.routerJitter?.median)})\n`;
  md += `- **Cloudflare Jitter**: ${formatNumber(
    analysis.cloudflareJitter?.mean
  )} ± ${formatNumber(
    analysis.cloudflareJitter?.stdDev
  )} ms (median: ${formatNumber(analysis.cloudflareJitter?.median)})\n`;
  md += `- **Download Jitter**: ${formatNumber(
    analysis.downloadJitter?.mean
  )} ± ${formatNumber(
    analysis.downloadJitter?.stdDev
  )} ms (median: ${formatNumber(analysis.downloadJitter?.median)})\n`;
  md += `- **Upload Jitter**: ${formatNumber(
    analysis.uploadJitter?.mean
  )} ± ${formatNumber(
    analysis.uploadJitter?.stdDev
  )} ms (median: ${formatNumber(analysis.uploadJitter?.median)})\n\n`;

  md += "## Packet Loss\n\n";
  md += `- **Router Packet Loss**: ${formatNumber(
    analysis.routerLoss?.mean
  )}% (median: ${formatNumber(analysis.routerLoss?.median)})\n`;
  md += `- **Cloudflare Packet Loss**: ${formatNumber(
    analysis.cloudflareLoss?.mean
  )}% (median: ${formatNumber(analysis.cloudflareLoss?.median)})\n`;
  md += `- **Google Packet Loss**: ${formatNumber(
    analysis.googleLoss?.mean
  )}% (median: ${formatNumber(analysis.googleLoss?.median)})\n\n`;

  md += "## Stability\n\n";
  md += `- **Stability Score**: ${formatNumber(
    analysis.stabilityScore?.mean
  )} ± ${formatNumber(analysis.stabilityScore?.stdDev)} (median: ${formatNumber(
    analysis.stabilityScore?.median
  )})\n`;
  md += `  - Range: [${formatNumber(
    analysis.stabilityScore?.min
  )} - ${formatNumber(analysis.stabilityScore?.max)}]\n`;
  md += `- **Health Issues**: ${formatNumber(
    analysis.healthIssues?.mean
  )} (median: ${formatNumber(analysis.healthIssues?.median)})\n\n`;

  // Add time-of-day patterns if available
  if (analysis.timePatterns) {
    const periods = [
      { key: "morning", label: "Morning (6am-12pm)", emoji: "🌅" },
      { key: "afternoon", label: "Afternoon (12pm-6pm)", emoji: "☀️" },
      { key: "evening", label: "Evening (6pm-12am)", emoji: "🌆" },
      { key: "night", label: "Night (12am-6am)", emoji: "🌙" },
    ];

    const hasData = periods.some(
      (p) => analysis.timePatterns[p.key]?.count > 0
    );
    if (hasData) {
      md += "## Time-of-Day Performance Patterns\n\n";
      md += "Performance metrics grouped by time of day:\n\n";

      periods.forEach(({ key, label, emoji }) => {
        const pattern = analysis.timePatterns[key];
        if (pattern && pattern.count > 0) {
          md += `### ${emoji} ${label}\n\n`;
          md += `- **Samples**: ${pattern.count}\n`;
          md += `- **Download**: ${formatNumber(
            pattern.download?.mean
          )} ± ${formatNumber(pattern.download?.stdDev)} Mbps`;
          md += ` (${formatNumber(pattern.download?.min)}-${formatNumber(
            pattern.download?.max
          )} Mbps)\n`;
          md += `- **Upload**: ${formatNumber(
            pattern.upload?.mean
          )} ± ${formatNumber(pattern.upload?.stdDev)} Mbps`;
          md += ` (${formatNumber(pattern.upload?.min)}-${formatNumber(
            pattern.upload?.max
          )} Mbps)\n`;
          md += `- **Ping**: ${formatNumber(
            pattern.ping?.mean
          )} ± ${formatNumber(pattern.ping?.stdDev)} ms`;
          md += ` (${formatNumber(pattern.ping?.min)}-${formatNumber(
            pattern.ping?.max
          )} ms)\n`;
          md += `- **Stability**: ${formatNumber(
            pattern.stabilityScore?.mean
          )} ± ${formatNumber(pattern.stabilityScore?.stdDev)}\n\n`;
        }
      });
    }
  }

  return md;
}

/**
 * Generate markdown report for comparison (works with any number of providers)
 */
function generateMarkdownReport(analyses, comparison, providers) {
  let md = "# Network Provider Comparison Report\n\n";
  md += `Generated: ${new Date().toISOString()}\n\n`;

  md += "## Summary\n\n";
  const winCounts = {};
  providers.forEach((p) => (winCounts[p] = 0));
  Object.values(comparison.winner).forEach((w) => winCounts[w]++);

  providers.forEach((provider) => {
    const wins = winCounts[provider];
    const total = Object.keys(comparison.winner).length;
    const pct = ((wins / total) * 100).toFixed(0);
    md += `- **${provider}**: ${wins}/${total} metrics best (${pct}%)\n`;
  });

  md += "\n## Detailed Comparison\n\n";
  md += "| Metric | " + providers.join(" | ") + " | Winner |\n";
  md +=
    "|--------|" + providers.map(() => "-------").join("|") + "|--------|\n";

  Object.entries(comparison.differences).forEach(([key, data]) => {
    const vals = providers.map((p) => {
      const val = data.values[p];
      return val != null ? `${formatNumber(val)} ${data.unit}` : "N/A";
    });
    md += `| ${data.name} | ${vals.join(" | ")} | ${data.winner} |\n`;
  });

  md += "\n## Individual Provider Details\n\n";

  providers.forEach((provider) => {
    const analysis = analyses.find((a) => a.provider === provider);
    md += `### ${provider}\n\n`;
    md += `- **Total Samples**: ${analysis.totalSamples}\n`;
    md += `- **Download Speed**: ${formatNumber(
      analysis.download?.mean
    )} ± ${formatNumber(analysis.download?.stdDev)} Mbps\n`;
    md += `- **Upload Speed**: ${formatNumber(
      analysis.upload?.mean
    )} ± ${formatNumber(analysis.upload?.stdDev)} Mbps\n`;
    md += `- **Ping**: ${formatNumber(analysis.ping?.mean)} ± ${formatNumber(
      analysis.ping?.stdDev
    )} ms\n`;
    md += `- **Cloudflare Latency**: ${formatNumber(
      analysis.cloudflareLatency?.mean
    )} ± ${formatNumber(analysis.cloudflareLatency?.stdDev)} ms\n`;
    md += `- **Packet Loss**: ${formatNumber(
      analysis.cloudflareLoss?.mean
    )}%\n`;
    md += `- **Stability Score**: ${formatNumber(
      analysis.stabilityScore?.mean
    )}\n`;

    // Add time-of-day patterns if available
    if (analysis.timePatterns) {
      const periods = [
        { key: "morning", label: "Morning (6am-12pm)" },
        { key: "afternoon", label: "Afternoon (12pm-6pm)" },
        { key: "evening", label: "Evening (6pm-12am)" },
        { key: "night", label: "Night (12am-6am)" },
      ];

      const hasData = periods.some(
        (p) => analysis.timePatterns[p.key]?.count > 0
      );
      if (hasData) {
        md += `\n**Time-of-Day Patterns:**\n`;
        periods.forEach(({ key, label }) => {
          const pattern = analysis.timePatterns[key];
          if (pattern && pattern.count > 0) {
            md += `  - ${label}: DL ${formatNumber(
              pattern.download?.mean
            )} Mbps, `;
            md += `Ping ${formatNumber(pattern.ping?.mean)} ms (${
              pattern.count
            } samples)\n`;
          }
        });
      }
    }

    md += "\n";
  });

  return md;
}

/**
 * Call Ollama to analyze a single provider's performance
 */
async function analyzeSingleProviderWithOllama(
  markdown,
  analysis,
  provider,
  grouped
) {
  try {
    console.log("\n" + "=".repeat(80));
    console.log("🤖 Generating AI Analysis with Ollama...");
    console.log("=".repeat(80) + "\n");

    // Check VPN status from the data
    const data = grouped[provider];
    const vpnOn = data.filter((r) => r.vpn === "on").length;
    const vpnOff = data.filter((r) => r.vpn === "off").length;
    const vpnPercentOn = ((vpnOn / data.length) * 100).toFixed(0);

    const vpnContext =
      vpnPercentOn === "100"
        ? "All measurements were taken through VPN."
        : vpnPercentOn === "0"
        ? "All measurements were taken without VPN."
        : `${vpnPercentOn}% of measurements were taken through VPN (${vpnOn}/${data.length} samples).`;

    // Prepare the prompt for single provider analysis
    const prompt = `You are a network performance analyst. Analyze the network performance data for a single internet provider below.

**YOUR TASK:**
Provide a structured analysis with EXACTLY these sections in this order:

## Overall Assessment
Write a 2-3 sentence summary of the network's overall quality. Be direct and specific.

## Speed Performance
Analyze download and upload speeds. Are they suitable for common use cases (streaming, video calls, downloads, gaming)? Mention if speeds are consistent (compare mean vs median).

## Latency & Responsiveness
Evaluate ping times, router latency, and DNS performance. Is the network responsive enough for real-time applications (gaming, video calls)? Note any routing issues.

## Stability & Reliability
Assess jitter, packet loss, and stability scores. Are there reliability concerns? Mention if median differs significantly from mean (indicating intermittent issues vs consistent problems).

## Recommendations
Write 2-4 sentences with PRACTICAL advice the USER can take at home to improve their network experience. Focus on actionable steps like: optimizing router placement, using ethernet instead of WiFi, adjusting router settings (QoS, channel selection), upgrading router firmware, using WiFi extenders, changing DNS servers, scheduling heavy downloads for off-peak hours, or considering equipment upgrades. Do NOT tell the ISP what to do - only what the user can control. If the connection is already excellent, acknowledge that and suggest minor optimizations. Write as flowing paragraphs, no bullet points.

---

**PROVIDER DATA:**

Provider: ${provider}
Total Samples: ${data.length}
${vpnContext}

**PERFORMANCE METRICS:**

Download Speed: ${formatNumber(
      analysis.download?.mean
    )} Mbps (median: ${formatNumber(analysis.download?.median)})
  Range: [${formatNumber(analysis.download?.min)} - ${formatNumber(
      analysis.download?.max
    )}]
  Std Dev: ±${formatNumber(analysis.download?.stdDev)}

Upload Speed: ${formatNumber(
      analysis.upload?.mean
    )} Mbps (median: ${formatNumber(analysis.upload?.median)})
  Range: [${formatNumber(analysis.upload?.min)} - ${formatNumber(
      analysis.upload?.max
    )}]
  Std Dev: ±${formatNumber(analysis.upload?.stdDev)}

Speedtest Ping: ${formatNumber(analysis.ping?.mean)} ms (median: ${formatNumber(
      analysis.ping?.median
    )})
Router Latency: ${formatNumber(
      analysis.routerLatency?.mean
    )} ms (median: ${formatNumber(analysis.routerLatency?.median)})
Cloudflare Latency: ${formatNumber(
      analysis.cloudflareLatency?.mean
    )} ms (median: ${formatNumber(analysis.cloudflareLatency?.median)})
Google Latency: ${formatNumber(
      analysis.googleLatency?.mean
    )} ms (median: ${formatNumber(analysis.googleLatency?.median)})

Router Jitter: ${formatNumber(
      analysis.routerJitter?.mean
    )} ms (median: ${formatNumber(analysis.routerJitter?.median)})
Cloudflare Jitter: ${formatNumber(
      analysis.cloudflareJitter?.mean
    )} ms (median: ${formatNumber(analysis.cloudflareJitter?.median)})
Download Jitter: ${formatNumber(
      analysis.downloadJitter?.mean
    )} ms (median: ${formatNumber(analysis.downloadJitter?.median)})
Upload Jitter: ${formatNumber(
      analysis.uploadJitter?.mean
    )} ms (median: ${formatNumber(analysis.uploadJitter?.median)})

Router Packet Loss: ${formatNumber(
      analysis.routerLoss?.mean
    )}% (median: ${formatNumber(analysis.routerLoss?.median)})
Cloudflare Packet Loss: ${formatNumber(
      analysis.cloudflareLoss?.mean
    )}% (median: ${formatNumber(analysis.cloudflareLoss?.median)})
Google Packet Loss: ${formatNumber(
      analysis.googleLoss?.mean
    )}% (median: ${formatNumber(analysis.googleLoss?.median)})

Stability Score: ${formatNumber(
      analysis.stabilityScore?.mean
    )} (median: ${formatNumber(analysis.stabilityScore?.median)})
  Range: [${formatNumber(analysis.stabilityScore?.min)} - ${formatNumber(
      analysis.stabilityScore?.max
    )}]

Health Issues: ${formatNumber(
      analysis.healthIssues?.mean
    )} (median: ${formatNumber(analysis.healthIssues?.median)})

${formatTimePatterns(analysis.timePatterns)}

**USER CONTEXT:**
The user's primary activities include:
- AI-assisted programming (requires stable connection, moderate bandwidth)
- Video conferencing (requires low latency, stable connection, 5-10 Mbps up/down)
- Software downloads and updates (benefits from high download speeds)
- Web browsing and research (requires responsive latency)
- Gaming (benefits from low latency and jitter, minimal packet loss)
- YouTube/streaming (requires 25+ Mbps download for 4K, stable connection)

---

**IMPORTANT FORMATTING RULES:**

REQUIRED Sections (use exact headers):
1. ## Overall Assessment
2. ## Speed Performance
3. ## Latency & Responsiveness
4. ## Stability & Reliability
5. ## Recommendations

DO NOT:
- Add extra sections beyond the 5 required
- Use bullet points or lists anywhere
- Use vague language - be specific with numbers
- Compare to other providers (this is single provider analysis)

DO:
- Use the exact section headers specified above
- Write in flowing paragraphs
- Cite specific metric values in your analysis
- Mention when median differs from mean (outliers present)
- Be direct about strengths and weaknesses
- In Recommendations: Provide ONLY user-actionable advice (router settings, equipment, network optimization) - NOT what the ISP should do
- Consider time-of-day patterns if significant variations exist (e.g., evening congestion, consistent morning performance)
- Suggest practical home network improvements: router placement, ethernet cables, WiFi optimization, QoS settings, DNS changes, firmware updates`;

    // Call Ollama API
    const response = await fetch(`${CONFIG.ollama.endpoint}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CONFIG.ollama.model,
        prompt: prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama API error: ${response.status} ${response.statusText}`
      );
    }

    const result = await response.json();

    // Return the AI analysis to be appended to the main report
    return result.response;
  } catch (error) {
    console.error("❌ Failed to generate AI analysis:", error.message);
    console.log(`💡 Make sure Ollama is running: ollama serve`);
    console.log(
      `💡 And the model is installed: ollama pull ${CONFIG.ollama.model}`
    );
    console.log(`💡 Or disable AI analysis in .env: OLLAMA_ENABLED=false\n`);
    return null;
  }
}

/**
 * Call Ollama to analyze the markdown report (comparison mode)
 */
async function analyzeWithOllama(
  markdown,
  analyses,
  comparison,
  providers,
  grouped
) {
  try {
    console.log("\n" + "=".repeat(80));
    console.log("🤖 Generating AI Analysis with Ollama...");
    console.log("=".repeat(80) + "\n");

    // Check VPN status from the data
    const vpnInfo = {};
    providers.forEach((provider) => {
      const data = grouped[provider];
      const vpnOn = data.filter((r) => r.vpn === "on").length;
      const vpnOff = data.filter((r) => r.vpn === "off").length;
      vpnInfo[provider] = {
        on: vpnOn,
        off: vpnOff,
        total: data.length,
        percentOn: ((vpnOn / data.length) * 100).toFixed(0),
      };
    });

    const vpnContext = providers
      .map(
        (p) =>
          `${p}: ${vpnInfo[p].percentOn}% with VPN (${vpnInfo[p].on}/${vpnInfo[p].total} samples)`
      )
      .join("\n");

    // Prepare the prompt with data
    const providersText =
      providers.length === 2
        ? `Compare these two network providers and recommend which is better.`
        : `Compare these ${providers.length} network providers and recommend which is best overall.`;

    const prompt = `You are a network performance analyst. Analyze the network provider comparison data below.

**YOUR TASK:**
${providersText}

Provide a structured analysis with EXACTLY these sections in this order:

1. **Recommendation:** - Clear choice in paragraph form with key reasons cited inline (no lists/bullets)
2. **Performance for Specific Usage Patterns:** - Bullet points for each usage category with specific analysis
3. **Key Concerns or Red Flags:** - Bullet points highlighting critical issues with metrics
4. **Summary:** - 2-3 sentences for decision makers

**CRITICAL FORMATTING REQUIREMENTS:**
- Use EXACTLY these section headers with bold markdown: **Recommendation:**, **Performance for Specific Usage Patterns:**, **Key Concerns or Red Flags:**, **Summary:**
- Start each section header on a new line
- For Recommendation: Write as PARAGRAPHS (no numbered lists, no bullet points). State the choice and explain key reasons in flowing prose with specific metrics cited inline
- Include specific numbers from the data in your analysis
- Compare BOTH mean and median values when they differ significantly (indicates outliers)
- For Performance section: Use bullet points with bold activity names followed by analysis
- Be direct and specific - cite actual metric values
- When comparing ${
      providers.length
    } providers, focus on the top performer and note any providers that significantly underperform

Here's the data:

${markdown}

**IMPORTANT - VPN USAGE CONTEXT:**
${vpnContext}

Note: ${
      providers.length > 1
        ? "ALL measurements were taken while connected to a VPN."
        : ""
    } This means:
- Latency numbers include VPN overhead (expect +20-50ms added)
- These are real-world performance numbers actually experienced
- Speed tests reflect what you get through the VPN tunnel
- Packet loss and jitter are actual experienced values, not theoretical
- Provider comparison is FAIR since all were tested under identical VPN conditions
- When median differs significantly from mean, there are outliers - mention this!

**TIME-OF-DAY PATTERNS:**
Review the time-of-day performance patterns in the data above. Consider:
- Are there significant differences between time periods (morning/afternoon/evening/night)?
- Does any provider show congestion during peak hours (evening typically 6pm-12am)?
- Is performance more consistent during certain times of day?
- For work-from-home use, morning/afternoon performance is most critical

MY SPECIFIC USAGE PATTERNS (Typical Daily Activities):

**Core Work Activities:**
- **AI Programming & ChatGPT/Claude/Copilot**: Heavy API usage, code generation, debugging assistance - requires consistent connectivity with low packet loss
- **Software Development**: Git operations, npm/pip installs, Docker pulls, CI/CD pipelines - needs reliable high-speed downloads
- **Video Calls (Zoom/Teams/Meet)**: Daily standup meetings, pair programming sessions - requires low latency, low jitter, and zero packet loss
- **YouTube & Technical Content**: Tutorial videos, conference talks, documentation videos - HD/4K streaming quality preferred
- **Large File Downloads**: Development tools, SDKs, OS updates, game downloads - needs high download speeds

**Secondary Activities:**
- **Gaming (Mostly Offline)**: Single-player games with occasional updates/patches, game launcher downloads (Steam/Epic), cloud save syncs - download speed more critical than low latency
- **Background Streaming**: Music (Spotify), background YouTube/Twitch while coding - needs stable connection
- **Cloud Backup & Sync**: GitHub, iCloud, Dropbox - continuous background uploads/downloads
- **Documentation & Research**: Multiple browser tabs, Stack Overflow, documentation sites - needs stable browsing

**Critical Requirements:**
- Packet loss > 1% is CRITICAL - will cause video call drops, API request failures, and git push failures
- Jitter > 20ms affects video/audio quality during meetings
- Download speed is PRODUCTIVITY - faster downloads = less waiting, more coding time
- Upload speed matters for git pushes, code sharing, screen sharing in calls
- Latency under 150ms preferred for responsive AI/API interactions
- Stability score is crucial - need reliable connectivity throughout the 8-10 hour workday
- Zero tolerance for "Severely Degraded" periods during work hours

**ANALYSIS FOCUS:**
Analyze which provider is better FOR MY SPECIFIC WORK AND LIFESTYLE REQUIREMENTS. Be direct and practical about real-world impact.

DO NOT:
- Provide generic "practical advice" or optimization tips
- Suggest things to try or monitor
- Add extra sections beyond the 4 required
- Use vague language - be specific with numbers

DO:
- Use the exact section headers specified above
- Cite specific metric values in your analysis
- Mention when median differs from mean (outliers present)
- Focus on comparing the providers objectively
- Be direct about which is better and why
- For 3+ providers, highlight the clear winner and note significant differences`;

    // Call Ollama API
    const response = await fetch(`${CONFIG.ollama.endpoint}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CONFIG.ollama.model,
        prompt: prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama API error: ${response.status} ${response.statusText}`
      );
    }

    const result = await response.json();

    console.log("AI ANALYSIS:");
    console.log("─".repeat(80));
    console.log(result.response);
    console.log("─".repeat(80) + "\n");

    // Return the AI analysis to be appended to the main report
    return result.response;
  } catch (error) {
    console.error("❌ Failed to generate AI analysis:", error.message);
    console.log(`💡 Make sure Ollama is running: ollama serve`);
    console.log(
      `💡 And the model is installed: ollama pull ${CONFIG.ollama.model}`
    );
    console.log(`💡 Or disable AI analysis in .env: OLLAMA_ENABLED=false\n`);
    return null;
  }
}

/**
 * Main function
 */
async function main() {
  const csvPath =
    process.argv[2] || path.join(__dirname, "logs", "net_monitor.csv");

  console.log(`Analyzing: ${csvPath}\n`);

  // Parse CSV
  const data = parseCSV(csvPath);
  console.log(`Loaded ${data.length} records\n`);

  // Group by provider
  const grouped = groupByProvider(data);
  const providers = Object.keys(grouped);

  console.log(`Found ${providers.length} providers: ${providers.join(", ")}\n`);

  // Analyze each provider
  const analyses = providers.map((provider) =>
    analyzeProvider(grouped[provider], provider)
  );

  // Print individual analyses
  analyses.forEach(printProviderAnalysis);

  // Handle different scenarios based on provider count
  if (providers.length === 1) {
    // Single provider analysis
    const provider = providers[0];
    const analysis = analyses[0];

    // Generate markdown report
    const reportPath = path.join(__dirname, "provider_analysis.md");
    let markdown = generateSingleProviderReport(analysis, provider);

    // Analyze with Ollama (if enabled) and append to markdown
    if (CONFIG.ollama.enabled) {
      const aiAnalysis = await analyzeSingleProviderWithOllama(
        markdown,
        analysis,
        provider,
        grouped
      );

      if (aiAnalysis) {
        // Prepend AI analysis to the report
        markdown = `# Network Performance Analysis\n\nProvider: ${provider}\nGenerated: ${new Date().toISOString()}\nSamples: ${
          grouped[provider].length
        }\n\n${aiAnalysis}\n\n---\n\n## Statistical Details\n\n${markdown
          .split("\n")
          .slice(4)
          .join("\n")}`;
      }
    }

    // Write final report
    fs.writeFileSync(reportPath, markdown);
    console.log(`\n${"=".repeat(80)}`);
    console.log(`📝 Performance report saved to: ${reportPath}`);
    console.log(`${"=".repeat(80)}\n`);

    if (!CONFIG.ollama.enabled) {
      console.log(
        "ℹ️  AI analysis disabled. Set OLLAMA_ENABLED=true in .env to enable.\n"
      );
    }
  } else {
    // Do comparison for all providers
    const comparison = compareProviders(analyses);
    printComparison(comparison, providers);

    // Generate markdown report
    const reportPath = path.join(__dirname, "provider_comparison.md");
    let markdown = generateMarkdownReport(analyses, comparison, providers);

    // AI analysis (if enabled) and append to markdown
    if (CONFIG.ollama.enabled) {
      const aiAnalysis = await analyzeWithOllama(
        markdown,
        analyses,
        comparison,
        providers,
        grouped
      );

      if (aiAnalysis) {
        // Prepend AI analysis to the report
        markdown = `# Network Provider Comparison Report\n\nGenerated: ${new Date().toISOString()}\n\n## AI Analysis\n\n${aiAnalysis}\n\n---\n\n${markdown
          .split("\n")
          .slice(3)
          .join("\n")}`;
      }
    }

    // Write final report
    fs.writeFileSync(reportPath, markdown);
    console.log(`\n${"=".repeat(80)}`);
    console.log(`📝 Provider comparison saved to: ${reportPath}`);
    console.log(`${"=".repeat(80)}\n`);

    if (!CONFIG.ollama.enabled) {
      console.log(
        "ℹ️  AI analysis disabled. Set OLLAMA_ENABLED=true in .env to enable.\n"
      );
    }
  }
}

// Run
if (require.main === module) {
  main();
}

module.exports = { parseCSV, analyzeProvider, compareProviders };
