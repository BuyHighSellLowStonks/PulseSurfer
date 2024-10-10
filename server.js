const express = require('express');
const https = require('https');
const http = require('http');
const socketIo = require('socket.io');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require("express-rate-limit");
const dotenv = require('dotenv');
const cors = require('cors');
const session = require('express-session');
const axios = require('axios');

// Load environment variables
dotenv.config();

const app = express();

// Settings functionality
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const STATE_FILE_PATH = path.join(__dirname, 'trading_state.json');

const DEFAULT_SETTINGS = {
  SENTIMENT_BOUNDARIES: {
    EXTREME_FEAR: 15,
    FEAR: 35,
    GREED: 65,
    EXTREME_GREED: 85
  },
  SENTIMENT_MULTIPLIERS: {
    EXTREME_FEAR: 0.05,
    FEAR: 0.03,
    GREED: 0.03,
    EXTREME_GREED: 0.05
  },
  DEVELOPER_TIP_PERCENTAGE: 0, // In percent, 0 = no tip. This is added to the 0.05% fixed fee.
  MONITOR_MODE: false
};

function ensureSettingsFile() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    console.log('settings.json not found. Creating with default values...');
    try {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2));
      console.log('settings.json created successfully.');
    } catch (error) {
      console.error('Error creating settings.json:', error);
      process.exit(1);
    }
  }
}

function readSettings() {
  ensureSettingsFile();
  try {
    const settingsData = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return JSON.parse(settingsData);
  } catch (error) {
    console.error('Error reading settings.json:', error);
    return DEFAULT_SETTINGS;
  }
}

function getMonitorMode() {
  const settings = readSettings();
  return settings.MONITOR_MODE === true;
}

function writeSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log('Settings updated successfully.');
  } catch (error) {
    console.error('Error writing settings.json:', error);
  }
}

function updateSettings(newSettings) {
  const currentSettings = readSettings();
  const updatedSettings = { ...currentSettings, ...newSettings };

  //ensure tip is at least 0
  updatedSettings.DEVELOPER_TIP_PERCENTAGE = Math.max(0, updatedSettings.DEVELOPER_TIP_PERCENTAGE);

  // ensure MONITOR_MODE is a boolean
  updatedSettings.MONITOR_MODE = updatedSettings.MONITOR_MODE === true;

  writeSettings(updatedSettings);
  return updatedSettings;
}

let tradingParams = readSettings();

// Middleware setup
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Use Helmet!
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'wss:', 'https:'],
      frameSrc: ["'self'", 'https://birdeye.so'],
      upgradeInsecureRequests: [],
    },
  }
}));

// Set up session
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using https
}));

// Set up rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Check for ADMIN_PASSWORD
if (!process.env.ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD is not set in the .env file. Please set it and restart the server.");
  process.exit(1);
}

// Server setup
let server;
if (fs.existsSync('/path/to/privkey.pem') && fs.existsSync('/path/to/cert.pem') && fs.existsSync('/path/to/chain.pem')) {
  const privateKey = fs.readFileSync('/path/to/privkey.pem', 'utf8');
  const certificate = fs.readFileSync('/path/to/cert.pem', 'utf8');
  const ca = fs.readFileSync('/path/to/chain.pem', 'utf8');

  const credentials = { key: privateKey, cert: certificate, ca: ca };
  server = https.createServer(credentials, app);
  console.log('HTTPS server created');
} else {
  server = http.createServer(app);
  console.log('HTTP server created. Consider setting up HTTPS for production use.');
}

const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Authentication middleware
const authenticate = (req, res, next) => {
  if (req.session.authenticated) {
    next();
  } else {
    res.status(401).json({ error: 'Authentication required' });
  }
};

// Login route
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Logout route
app.post('/api/logout', (req, res) => {
  req.session.authenticated = false;
  res.json({ success: true });
});

// Apply authentication to /api routes
app.use('/api', authenticate);

// Event emitter setup
const paramUpdateEmitter = new EventEmitter();

// Data storage
let initialData = null;
const recentTrades = [];
const MAX_RECENT_TRADES = 50;

function addRecentTrade(trade) {
  if (recentTrades.length > 0) {
    const lastTrade = recentTrades[0];
    if (lastTrade.timestamp === trade.timestamp &&
      lastTrade.amount === trade.amount &&
      lastTrade.price === trade.price) {
      console.log("Duplicate trade detected, not adding to recent trades");
      return;
    }
  }
  recentTrades.unshift(trade);
  if (recentTrades.length > MAX_RECENT_TRADES) {
    recentTrades.pop();
  }
}

// API routes
app.get('/api/initial-data', (req, res) => {
  const latestData = getLatestTradingData();
  if (latestData) {
    res.json(latestData);
  } else {
    res.status(503).json({ error: 'Initial data not yet available' });
  }
});

app.get('/api/params', (req, res) => {
  res.json(tradingParams);
});

app.get('/api/recent-trades', (req, res) => {
  res.json(recentTrades);
});

app.post('/api/params', (req, res) => {
  const newParams = req.body;
  tradingParams = updateSettings(newParams);
  io.emit('paramsUpdated', tradingParams);
  paramUpdateEmitter.emit('paramsUpdated', tradingParams);
  res.json({ message: 'Parameters updated successfully', params: tradingParams });
});

app.post('/api/restart', authenticate, (req, res) => {
  paramUpdateEmitter.emit('restartTrading');
  res.json({ success: true, message: 'Trading restart initiated' });
});

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2));
    console.log("State saved successfully.");
  } catch (error) {
    console.error("Error saving state:", error);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const data = fs.readFileSync(STATE_FILE_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("Error loading state:", error);
  }
  return null;
}

function emitRestartTrading() {
  clearRecentTrades();
  io.emit('restartTrading');
}

function clearRecentTrades() {
  recentTrades.length = 0; // This clears the array
  console.log("Recent trades cleared");
}

// Socket.io setup
io.on('connection', (socket) => {
  console.log('\nNew client connected');
  socket.on('disconnect', () => {
    console.log('\nClient disconnected');
  });
});

// Exchange rate functionality
let currentExchangeRate = 0.909592; // Default value from the provided JSON
let nextUpdateTime = Date.now(); // Initialize to current time

async function fetchExchangeRate() {
  try {
    const response = await axios.get('https://open.er-api.com/v6/latest/USD');
    const data = response.data;

    if (data.result === "success") {
      currentExchangeRate = data.rates.EUR;
      console.log('Updated exchange rate:', currentExchangeRate);

      // Set the next update time
      nextUpdateTime = data.time_next_update_unix * 1000; // Convert to milliseconds
      console.log('Next USD/EUR update:', new Date(nextUpdateTime).toUTCString());

      // Schedule the next update
      const timeUntilNextUpdate = nextUpdateTime - Date.now();
      setTimeout(fetchExchangeRate, timeUntilNextUpdate);
    } else {
      console.error('Failed to fetch exchange rate:', data);
      // Retry after 1 hour if there's an error
      setTimeout(fetchExchangeRate, 60 * 60 * 1000);
    }
  } catch (error) {
    console.error('Error fetching exchange rate:', error);
    // Retry after 1 hour if there's an error
    setTimeout(fetchExchangeRate, 60 * 60 * 1000);
  }
}
function calculateAPY(initialValue, currentValue, runTimeInDays) {
  // Check if less than 48 hours have passed
  if (runTimeInDays < 2) {
    return "Insufficient data";
  }

  // Calculate SOL appreciation
  const solAppreciation = (initialValue / initialData.initialSolPrice) * initialData.price;

  // Calculate total return, excluding SOL/USDC market change
  const totalReturn = (currentValue - solAppreciation) / initialValue;
  
  // Calculate elapsed time in years
  const yearsElapsed = runTimeInDays / 365;

  // User cost (replace with actual user input (0-9999))
  const userCost = 0; 

  // The operational costs and exponential APY impact are applied gradually,
  // preventing drastic early distortions in APY calculations.
  const costEffectScaling = Math.min(0.1 + (runTimeInDays / 28) * 0.9, 1);
  
  // Calculate operational cost factor
  const opCostFactor = (((monthlyCost * 12) * yearsElapsed) / initialValue) * costEffectScaling;

  // Calculate APY
  const apy = (Math.pow(1 + (totalReturn - opCostFactor), (1 / yearsElapsed) * costEffectScaling) - 1) * 100;

  // Determine the appropriate APY return format based on value
  if (apy < -99.99) {
    return "Err";  // Return "Err" for APY less than -99.99%
  } else if (apy > 999) {
    return "Err";  // Return "Err" for APY greater than 999%
  } else if (apy < 0) {
    return Math.round(apy);  // Round to the nearest whole number for negative values
  } else if (apy < 0.1) {
    return 0;  // Return 0 for values less than 0.1
  } else if (apy >= 0.5 && apy < 10) {
    return apy.toFixed(2);  // Round to 2 decimals for values between 0.5 and 10
  } else if (apy >= 10 && apy < 20) {
    return apy.toFixed(1);  // Round to 1 decimal for values between 10 and 20
  } else if (apy >= 20) {
    return Math.round(apy);  // Round to the nearest whole number for values 20 or higher
  }
}

function getRunTimeInDays(startTime) {
  const currentTime = Date.now();
  const runTimeInMilliseconds = currentTime - startTime;
  const runTimeInDays = runTimeInMilliseconds / (1000 * 60 * 60 * 24);
  return runTimeInDays;
}

// Call this function when your server starts
fetchExchangeRate();

function getLatestTradingData() {
  if (!initialData) {
    return null;
  }
  const days = getRunTimeInDays(initialData.startTime);
  const estimatedAPY = calculateAPY(initialData.initialPortfolioValue, initialData.portfolioValue, days);

  console.log(`Server Version: ${initialData.version}`);
  return {
    version: initialData.version,
    fearGreedIndex: initialData.fearGreedIndex,
    sentiment: initialData.sentiment,
    timestamp: initialData.timestamp,
    netChange: parseFloat(initialData.netChange.toFixed(3)),
    price: {
      usd: parseFloat(initialData.price.toFixed(2)),
      eur: parseFloat((initialData.price * currentExchangeRate).toFixed(2))
    },
    portfolioValue: {
      usd: parseFloat(initialData.portfolioValue.toFixed(2)),
      eur: parseFloat((initialData.portfolioValue * currentExchangeRate).toFixed(2))
    },
    solBalance: parseFloat(initialData.solBalance.toFixed(6)),
    usdcBalance: parseFloat(initialData.usdcBalance.toFixed(2)),
    portfolioWeighting: {
      usdc: parseFloat(((initialData.usdcBalance / initialData.portfolioValue) * 100).toFixed(2)),
      sol: parseFloat(((initialData.solBalance * initialData.price / initialData.portfolioValue) * 100).toFixed(2))
    },
    averageEntryPrice: initialData.averageEntryPrice > 0 ? parseFloat(initialData.averageEntryPrice.toFixed(2)) : 'N/A',
    averageSellPrice: initialData.averageSellPrice > 0 ? parseFloat(initialData.averageSellPrice.toFixed(2)) : 'N/A',
    programRunTime: formatTime(Date.now() - initialData.startTime),
    portfolioTotalChange: parseFloat(((initialData.portfolioValue - initialData.initialPortfolioValue) / initialData.initialPortfolioValue * 100).toFixed(2)),
    solanaMarketChange: parseFloat(((initialData.price - initialData.initialSolPrice) / initialData.initialSolPrice * 100).toFixed(2)),
    estimatedAPY: estimatedAPY,
    recentTrades: recentTrades,
    monitorMode: getMonitorMode()
  };
}

function emitTradingData(data) {
  console.log('Server emitting trading data with version:', data.version);
  const days = getRunTimeInDays(data.startTime);
  const hours = Math.floor((days % 1) * 24);
  const minutes = Math.floor(((days % 1) * 24 % 1) * 60);

  const estimatedAPY = calculateAPY(data.initialPortfolioValue, data.portfolioValue, days);

  const emitData = {
    version: data.version,
    timestamp: data.timestamp,
    price: {
      usd: parseFloat(data.price.toFixed(2)),
      eur: parseFloat((data.price * currentExchangeRate).toFixed(2))
    },
    netChange: {
      usd: parseFloat(data.netChange.toFixed(3)),
      eur: parseFloat((data.netChange * currentExchangeRate).toFixed(3))
    },
    portfolioValue: {
      usd: parseFloat(data.portfolioValue.toFixed(2)),
      eur: parseFloat((data.portfolioValue * currentExchangeRate).toFixed(2))
    },
    fearGreedIndex: data.fearGreedIndex,
    sentiment: data.sentiment,
    usdcBalance: parseFloat(data.usdcBalance.toFixed(2)),
    solBalance: parseFloat(data.solBalance.toFixed(6)),
    averageEntryPrice: {
      usd: data.averageEntryPrice > 0 ? parseFloat(data.averageEntryPrice.toFixed(2)) : 'N/A',
      eur: data.averageEntryPrice > 0 ? parseFloat((data.averageEntryPrice * currentExchangeRate).toFixed(2)) : 'N/A'
    },
    averageSellPrice: {
      usd: data.averageSellPrice > 0 ? parseFloat(data.averageSellPrice.toFixed(2)) : 'N/A',
      eur: data.averageSellPrice > 0 ? parseFloat((data.averageSellPrice * currentExchangeRate).toFixed(2)) : 'N/A'
    },
    recentTrades: recentTrades,
    txId: data.txId || null,
    txUrl: data.txId ? `https://solscan.io/tx/${data.txId}` : null,
    portfolioWeighting: {
      usdc: parseFloat(((data.usdcBalance / data.portfolioValue) * 100).toFixed(2)),
      sol: parseFloat(((data.solBalance * data.price / data.portfolioValue) * 100).toFixed(2))
    },
    programRunTime: `${Math.floor(days)}:${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`,
    portfolioTotalChange: parseFloat(((data.portfolioValue - data.initialPortfolioValue) / data.initialPortfolioValue * 100).toFixed(2)),
    solanaMarketChange: parseFloat(((data.price - data.initialSolPrice) / data.initialSolPrice * 100).toFixed(2)),
    estimatedAPY: estimatedAPY,
    nextExchangeRateUpdate: new Date(nextUpdateTime).toUTCString(),
    monitorMode: getMonitorMode(),
    initialData: {
      solPrice: {
        usd: parseFloat(data.initialSolPrice.toFixed(2)),
        eur: parseFloat((data.initialSolPrice * currentExchangeRate).toFixed(2))
      },
      portfolioValue: {
        usd: parseFloat(data.initialPortfolioValue.toFixed(2)),
        eur: parseFloat((data.initialPortfolioValue * currentExchangeRate).toFixed(2))
      },
      solBalance: parseFloat(data.initialSolBalance.toFixed(6)),
      usdcBalance: parseFloat(data.initialUsdcBalance.toFixed(2))
    }
  };

  console.log('Emitting trading data:', emitData);
  io.emit('tradingUpdate', emitData);

  // Update initialData with the latest data
  initialData = { ...data, recentTrades };
}

function formatTime(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

module.exports = {
  server,
  io,
  paramUpdateEmitter,
  setInitialData: (data) => {
    initialData = data;
  },
  addRecentTrade,
  emitTradingData,
  getLatestTradingData,
  readSettings,
  emitRestartTrading,
  clearRecentTrades,
  saveState,
  loadState
};
