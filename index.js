// server.js - MORE SCALABLE IPO Data Proxy Server
// Install: npm install express puppeteer cors

const express = require("express");
const puppeteer = require("puppeteer");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
process.env.PUPPETEER_SKIP_DOWNLOAD = "true";

const PORT = process.env.PORT || 3000;

// Cache
let cachedData = null;
let lastFetchTime = null;
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

const puppeteer = require("puppeteer-core");

async function scrapeIPOData() {
  let browser = null;

  try {
    // Use pre-installed Chrome from build step
    const chromePath =
      process.env.CHROME_PATH || "/tmp/chrome/chrome-linux/chrome";

    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process", // Important for low-memory environments
        "--disable-extensions",
        "--disable-default-apps",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
      ],
    });

    // Rest of your scraping code stays the same...
    const page = await browser.newPage();

    // Better user agent
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

      // IMPROVED: Find column indices dynamically by header text
      const headerRow = document.querySelector("#report_table thead tr");
      const headers = Array.from(headerRow?.querySelectorAll("th") || []);

      // Map header text to column index
      const columnMap = {};
      headers.forEach((header, index) => {
        const text = header.textContent.trim().toLowerCase();
        columnMap[text] = index;

        // Handle variations
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

      console.log("Column mapping:", columnMap);

      const rows = document.querySelectorAll("#report_table tbody tr");

      rows.forEach((row) => {
        // Skip header rows within tbody
        if (
          row.classList.contains("tbody-repeated-header") ||
          row.querySelector("th")
        ) {
          return;
        }

        const cells = row.querySelectorAll("td");
        if (cells.length < 5) return; // Need at least some basic cells

        // Extract name (usually first column with a link)
        const nameCell = cells[columnMap["name"] || 0];
        const nameLink = nameCell?.querySelector("a");
        const name = nameLink
          ? nameLink.textContent.trim()
          : nameCell?.textContent.trim() || "";

        if (!name || name.length < 3) return;

        // Helper function to safely get cell text
        const getCellText = (columnName, defaultIndex) => {
          const index = columnMap[columnName] ?? defaultIndex;
          if (index >= cells.length) return "";

          const cell = cells[index];
          // Check for div content first (GMP often has this)
          const div = cell.querySelector("div");
          return div ? div.textContent.trim() : cell.textContent.trim();
        };

        // Extract data using dynamic column mapping with fallbacks
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

    // Additional processing: categorize IPOs
    const now = new Date();
    const processedIPOs = ipos.map((ipo) => {
      // Determine status based on dates
      let status = "Unknown";
      const closeText = ipo.close.toLowerCase();

      if (closeText.includes("allot") || ipo.listing.trim()) {
        status = "Listed";
      } else if (closeText === "-" || closeText === "") {
        status = "Upcoming";
      } else {
        // Parse close date to determine if open/closed
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

// Helper: Parse date from text like "25-Nov"
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

        // Smart year detection
        if (month < now.getMonth()) {
          // If month has passed, check if it should be next year
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

// Main API endpoint
app.get("/api/ipos", async (req, res) => {
  try {
    const now = Date.now();

    // Return cached data if valid
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

    // Return stale cache if available on error
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

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    cached: !!cachedData,
    cacheAge: lastFetchTime
      ? Math.floor((Date.now() - lastFetchTime) / 1000)
      : null,
    memory: process.memoryUsage(),
  });
});

// Force refresh endpoint
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

// Get specific IPO by name
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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 IPO Proxy Server running on port ${PORT}`);
  console.log(`📊 API endpoint: http://localhost:${PORT}/api/ipos`);
  console.log(`❤️  Health check: http://localhost:${PORT}/health`);
  console.log(`🔄 Force refresh: POST http://localhost:${PORT}/api/refresh`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  process.exit(0);
});
