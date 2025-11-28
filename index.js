// server.js - IPO Data Proxy Server (Fixed for Render - Chrome at Runtime)
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

let puppeteer;
try {
  puppeteer = require("puppeteer");
  console.log("✓ Using puppeteer (bundled Chrome)");
} catch (e) {
  puppeteer = require("puppeteer-core");
  console.log("✓ Using puppeteer-core (requires external Chrome)");
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Cache
let cachedData = null;
let lastFetchTime = null;
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// Chrome installation flag
let chromeReady = false;
let chromeExecutablePath = null;

// Function to install Chrome at runtime if needed
async function ensureChromeInstalled() {
  if (chromeReady) return chromeExecutablePath;

  console.log("🔍 Checking for Chrome installation...");

  // Check if we're on Render (production)
  const isProduction =
    process.env.RENDER || process.env.NODE_ENV === "production";

  if (!isProduction) {
    console.log("🏠 Running locally - will use bundled Chrome");
    chromeReady = true;
    return null;
  }

  const chromePath = "/tmp/chrome";

  try {
    // Check if Chrome already exists
    if (fs.existsSync(chromePath)) {
      console.log("✓ Chrome directory exists, searching for executable...");
      const executable = findChromeExecutableRecursive(chromePath);
      if (executable) {
        console.log(`✓ Chrome found at: ${executable}`);
        chromeExecutablePath = executable;
        chromeReady = true;
        return executable;
      }
    }

    // Install Chrome
    console.log("📦 Installing Chrome (this may take 30-60 seconds)...");
    execSync(
      `npx @puppeteer/browsers install chrome@stable --path ${chromePath}`,
      { stdio: "inherit" }
    );

    // Find the installed Chrome
    const executable = findChromeExecutableRecursive(chromePath);
    if (executable) {
      console.log(`✓ Chrome installed successfully at: ${executable}`);
      chromeExecutablePath = executable;
      chromeReady = true;
      return executable;
    } else {
      throw new Error("Chrome installed but executable not found");
    }
  } catch (error) {
    console.error("❌ Failed to install Chrome:", error.message);
    console.log("⚠️  Will attempt to use bundled Chrome as fallback");
    chromeReady = true; // Set to true to avoid repeated installation attempts
    return null;
  }
}

// Recursive function to find Chrome executable
function findChromeExecutableRecursive(dir) {
  if (!fs.existsSync(dir)) return null;

  try {
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const fullPath = path.join(dir, item);

      try {
        const stat = fs.statSync(fullPath);

        if (stat.isFile() && (item === "chrome" || item === "chromium")) {
          // Check if file is executable
          try {
            fs.accessSync(fullPath, fs.constants.X_OK);
            return fullPath;
          } catch (e) {
            // Not executable, continue searching
          }
        } else if (stat.isDirectory()) {
          const found = findChromeExecutableRecursive(fullPath);
          if (found) return found;
        }
      } catch (e) {
        // Skip files we can't access
        continue;
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dir}:`, error.message);
  }

  return null;
}

async function scrapeIPOData() {
  let browser = null;

  try {
    // Ensure Chrome is installed
    const executablePath = await ensureChromeInstalled();

    // Launch configuration
    const launchOptions = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-extensions",
        "--disable-default-apps",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
      ],
    };

    if (executablePath) {
      launchOptions.executablePath = executablePath;
      console.log("🚀 Launching with custom Chrome");
    } else {
      console.log("🚀 Launching with bundled Chrome");
    }

    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    console.log("Navigating to IPO page...");
    await page.goto(
      "https://www.investorgain.com/report/live-ipo-gmp/331/all/",
      {
        waitUntil: "networkidle2",
        timeout: 30000,
      }
    );

    await page.waitForSelector("#report_table tbody tr", { timeout: 15000 });

    console.log("Extracting data with column detection...");

    const ipos = await page.evaluate(() => {
      const data = [];

      const headerRow = document.querySelector("#report_table thead tr");
      const headers = Array.from(headerRow?.querySelectorAll("th") || []);

      const columnMap = {};
      headers.forEach((header, index) => {
        const text = header.textContent.trim().toLowerCase();
        columnMap[text] = index;

        if (text.includes("name")) columnMap["name"] = index;
        if (text.includes("gmp")) columnMap["gmp"] = index;
        if (text.includes("rating") || text.includes("rate"))
          columnMap["rating"] = index;
        if (text.includes("sub")) columnMap["subscription"] = index;
        if (text.includes("price")) columnMap["price"] = index;
        if (text.includes("size")) columnMap["size"] = index;
        if (text.includes("lot")) columnMap["lot"] = index;
        if (text.includes("open")) columnMap["open"] = index;
        if (text.includes("close")) columnMap["close"] = index;
        if (text.includes("boa")) columnMap["boa"] = index;
        if (text.includes("list")) columnMap["listing"] = index;
        if (text.includes("updat")) columnMap["updated"] = index;
        if (text.includes("anchor")) columnMap["anchor"] = index;
      });

      const rows = document.querySelectorAll("#report_table tbody tr");

      rows.forEach((row) => {
        if (
          row.classList.contains("tbody-repeated-header") ||
          row.querySelector("th")
        ) {
          return;
        }

        const cells = row.querySelectorAll("td");
        if (cells.length < 5) return;

        const nameCell = cells[columnMap["name"] || 0];
        const nameLink = nameCell?.querySelector("a");
        const name = nameLink
          ? nameLink.textContent.trim()
          : nameCell?.textContent.trim() || "";

        if (!name || name.length < 3) return;

        const getCellText = (columnName, defaultIndex) => {
          const index = columnMap[columnName] ?? defaultIndex;
          if (index >= cells.length) return "";

          const cell = cells[index];
          const div = cell.querySelector("div");
          return div ? div.textContent.trim() : cell.textContent.trim();
        };

        const ipoData = {
          name: name,
          gmp: getCellText("gmp", 1) || "₹-- (0%)",
          rating: getCellText("rating", 2),
          subscription: getCellText("subscription", 3) || "N/A",
          gmpRange: getCellText("gmp(l/h)", 4),
          price: getCellText("price", 5),
          ipoSize: getCellText("size", 6) || "N/A",
          lot: getCellText("lot", 7),
          open: getCellText("open", 8),
          close: getCellText("close", 9),
          boaDate: getCellText("boa", 10),
          listing: getCellText("listing", 11),
          updatedOn: getCellText("updated", 12),
          anchor: getCellText("anchor", 13),
        };

        data.push(ipoData);
      });

      return data;
    });

    console.log(`✓ Scraped ${ipos.length} IPOs`);

    const now = new Date();
    const processedIPOs = ipos.map((ipo) => {
      let status = "Unknown";
      const closeText = ipo.close.toLowerCase();

      if (closeText.includes("allot") || ipo.listing.trim()) {
        status = "Listed";
      } else if (closeText === "-" || closeText === "") {
        status = "Upcoming";
      } else {
        const closeDate = parseDate(ipo.close);
        if (closeDate) {
          const daysDiff = Math.floor(
            (closeDate - now) / (1000 * 60 * 60 * 24)
          );
          if (daysDiff < -1) {
            status = "Closed";
          } else if (daysDiff <= 7) {
            status = "Open";
          } else {
            status = "Upcoming";
          }
        }
      }

      return {
        ...ipo,
        status,
        scrapedAt: new Date().toISOString(),
      };
    });

    return {
      success: true,
      count: processedIPOs.length,
      data: processedIPOs,
      timestamp: new Date().toISOString(),
      cached: false,
    };
  } catch (error) {
    console.error("Scraping error:", error);
    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error("Error closing browser:", e);
      }
    }
  }
}

function parseDate(dateText) {
  if (!dateText || dateText === "-") return null;

  try {
    const parts = dateText.split("-");
    if (parts.length === 2) {
      const day = parseInt(parts[0]);
      const monthMap = {
        jan: 0,
        feb: 1,
        mar: 2,
        apr: 3,
        may: 4,
        jun: 5,
        jul: 6,
        aug: 7,
        sep: 8,
        oct: 9,
        nov: 10,
        dec: 11,
      };
      const month = monthMap[parts[1].toLowerCase()];

      if (month !== undefined && !isNaN(day)) {
        const now = new Date();
        let year = now.getFullYear();

        if (month < now.getMonth()) {
          const testDate = new Date(year, month, day);
          if (now - testDate > 30 * 24 * 60 * 60 * 1000) {
            year++;
          }
        }

        return new Date(year, month, day);
      }
    }
  } catch (e) {
    console.error("Date parse error:", e);
  }

  return null;
}

app.get("/api/ipos", async (req, res) => {
  try {
    const now = Date.now();

    if (cachedData && lastFetchTime && now - lastFetchTime < CACHE_DURATION) {
      console.log(
        `Returning cached data (${Math.floor(
          (now - lastFetchTime) / 1000
        )}s old)`
      );
      return res.json({
        ...cachedData,
        cached: true,
        cacheAge: Math.floor((now - lastFetchTime) / 1000),
      });
    }

    console.log("Fetching fresh data...");
    const data = await scrapeIPOData();

    cachedData = data;
    lastFetchTime = now;

    res.json(data);
  } catch (error) {
    console.error("API error:", error);

    if (cachedData) {
      return res.json({
        ...cachedData,
        cached: true,
        stale: true,
        error: "Failed to fetch fresh data, returning cached",
        cacheAge: Math.floor((Date.now() - lastFetchTime) / 1000),
      });
    }

    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    chromeReady: chromeReady,
    chromeExecutablePath: chromeExecutablePath,
    uptime: process.uptime(),
    cached: !!cachedData,
    cacheAge: lastFetchTime
      ? Math.floor((Date.now() - lastFetchTime) / 1000)
      : null,
    memory: process.memoryUsage(),
  });
});

app.post("/api/refresh", async (req, res) => {
  try {
    console.log("Force refresh requested");
    cachedData = null;
    lastFetchTime = null;

    const data = await scrapeIPOData();
    cachedData = data;
    lastFetchTime = Date.now();

    res.json(data);
  } catch (error) {
    console.error("Refresh error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/ipos/:name", async (req, res) => {
  try {
    if (!cachedData) {
      const data = await scrapeIPOData();
      cachedData = data;
      lastFetchTime = Date.now();
    }

    const ipoName = req.params.name.toLowerCase();
    const ipo = cachedData.data.find((i) =>
      i.name.toLowerCase().includes(ipoName)
    );

    if (ipo) {
      res.json({ success: true, data: ipo });
    } else {
      res.status(404).json({ success: false, error: "IPO not found" });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 IPO Proxy Server running on port ${PORT}`);
  console.log(`📊 API endpoint: http://localhost:${PORT}/api/ipos`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
  console.log(`🔄 Force refresh: POST http://localhost:${PORT}/api/refresh`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  process.exit(0);
});
