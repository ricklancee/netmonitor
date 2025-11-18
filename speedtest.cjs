const puppeteer = require("puppeteer");
const path = require("path");
const { debugLog } = require("./utils.cjs");
const { CONFIG } = require("./config.cjs");

async function runSpeedTest() {
  debugLog("[Speedtest] Starting runSpeedTest()");

  let browser;
  let timeout;
  try {
    debugLog("[Speedtest] Launching Puppeteer…");

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    debugLog("[Speedtest] Browser launched.");

    const page = await browser.newPage();

    timeout = setTimeout(async () => {
      debugLog(`Speed test timed out`);
      await browser.close();
      throw new Error("Speed test timed out");
    }, CONFIG.SPEED_TEST_TIMEOUT_MS);

    // Capture browser console messages
    page.on("console", async (msg) => {
      try {
        const args = [];
        for (const arg of msg.args()) {
          try {
            args.push(await arg.jsonValue());
          } catch (err) {
            args.push("[unserializable]");
          }
        }

        console.log(
          `[PUPPETEER Console] ${msg.type().toUpperCase()}:`,
          ...args
        );
      } catch (err) {
        console.error("[PUPPETEER Console Handler Error]", err);
      }
    });

    // Capture browser errors
    page.on("pageerror", (err) => {
      console.error("[PUPPETEER PageError]", err);
    });

    debugLog("[Speedtest] Navigating to blank page…");
    await page.goto("about:blank");

    debugLog("[Speedtest] Exposing configuration to browser context…");
    await page.exposeFunction("speedtestRunConfig", () => ({
      measurements: [
        { type: "latency", numPackets: 1 },
        { type: "download", bytes: 1e5, count: 1, bypassMinDuration: true },
        { type: "latency", numPackets: 20 },
        { type: "download", bytes: 1e5, count: 9 },
        { type: "download", bytes: 1e6, count: 8 },
        { type: "upload", bytes: 1e5, count: 8 },
        { type: "upload", bytes: 1e6, count: 6 },
        { type: "download", bytes: 1e7, count: 6 },
        { type: "upload", bytes: 1e7, count: 4 },
        { type: "download", bytes: 2.5e7, count: 4 },
        { type: "upload", bytes: 2.5e7, count: 4 },
        { type: "download", bytes: 1e8, count: 3 },
        { type: "upload", bytes: 5e7, count: 3 },
        { type: "download", bytes: 2.5e8, count: 2 },
      ],
    }));

    debugLog("[Speedtest] Starting Cloudflare speedtest inside puppeteer…");

    const startTime = Date.now();

    await page.addScriptTag({
      path: path.join(__dirname, "speedtest.bundle.js"),
      type: "module",
    });

    const result = await page.evaluate(async () => {
      console.log("[Cloudflare] Importing speedtest module…");
      const SpeedTest = window.__CloudflareSpeedTest;

      if (!SpeedTest) {
        return { _error: "SpeedTest bundle not found in browser context" };
      }

      const cfg = await window.speedtestRunConfig();

      console.log("[Cloudflare] Loaded config:", cfg);

      return await new Promise((resolve) => {
        console.log("[Cloudflare] Creating SpeedTest instance…");
        const st = new SpeedTest({
          autoStart: true,
          ...cfg,
        });

        st.onRunningChange = (running) => {
          console.log("[Cloudflare] Running:", running);
        };

        st.onResultsChange = (info) => {
          //
        };

        st.onError = (err) => {
          console.error("[Cloudflare] Speedtest error:", err);
          resolve({
            _error: err?.toString?.() || "Unknown error",
          });
        };

        st.onFinish = (results) => {
          console.log("[Cloudflare] Test finished. Extracting metrics…");

          const downloadBps = results.getDownloadBandwidth();
          const uploadBps = results.getUploadBandwidth();

          const pingMs = results.getUnloadedLatency();
          const idleJitter = results.getUnloadedJitter();

          const downloadJitter = results.getDownLoadedJitter();
          const uploadJitter = results.getUpLoadedJitter();

          resolve({
            success: true,
            downloadMbps: downloadBps ? downloadBps / 1e6 : null,
            uploadMbps: uploadBps ? uploadBps / 1e6 : null,
            pingMs: pingMs ?? null,
            idleJitter: idleJitter ?? null,
            downloadJitter: downloadJitter ?? null,
            uploadJitter: uploadJitter ?? null,
            raw: {
              summary: results.getSummary(),
              latencyPoints: results.getUnloadedLatencyPoints(),
              downloadPoints: results.getDownloadBandwidthPoints(),
              uploadPoints: results.getUploadBandwidthPoints(),
              packetLossDetails: results.getPacketLossDetails?.() || null,
            },
          });
        };
      });
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    debugLog(`[Speedtest] Finished in ${duration}s`);

    if (result._error) {
      debugLog("[Speedtest] Browser test returned an error:", result._error);
      return {
        success: false,
        downloadMbps: null,
        uploadMbps: null,
        pingMs: null,
        idleJitter: null,
        downloadJitter: null,
        uploadJitter: null,
        raw: { error: result._error },
      };
    }

    debugLog("[Speedtest] Success. Returning measurements:", result);

    return result;
  } catch (err) {
    debugLog("[Speedtest] Fatal error:", err);

    return {
      success: false,
      downloadMbps: null,
      uploadMbps: null,
      pingMs: null,
      idleJitter: null,
      downloadJitter: null,
      uploadJitter: null,
      raw: { error: err.message },
    };
  } finally {
    clearTimeout(timeout);
    if (browser) {
      debugLog("[Speedtest] Closing browser…");
      await browser.close();
      debugLog("[Speedtest] Browser closed.");
    }
  }
}

module.exports = { runSpeedTest };
