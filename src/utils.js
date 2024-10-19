const os = require('os');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Keypair, Connection } = require('@solana/web3.js');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
const csv = require('csv-writer').createObjectCsvWriter;

const LOG_FILE_PATH = path.join(__dirname, '..', 'user', 'fgi_log.csv');

function getTimestamp() {
    const now = new Date();
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

    const weekday = days[now.getDay()];
    const day = String(now.getDate()).padStart(2, '0');
    const month = months[now.getMonth()];
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `${weekday}, ${day}/${month}, ${hours}:${minutes}:${seconds}`;
}

function formatTime(milliseconds) {
    const totalSeconds = Math.ceil(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
}

function getNextIntervalTime() {
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const milliseconds = now.getMilliseconds();

    const INTERVAL = 900000; // 15 minutes
    const DELAY_AFTER_INTERVAL = 45000; // 45 seconds

    const minutesToNext = 15 - (minutes % 15);
    let totalMs = (minutesToNext * 60 * 1000) - (seconds * 1000) - milliseconds + DELAY_AFTER_INTERVAL;

    if (totalMs < DELAY_AFTER_INTERVAL) {
        totalMs += INTERVAL;
    }

    return now.getTime() + totalMs;
}

function getWaitTime() {
    const now = new Date().getTime();
    const nextInterval = getNextIntervalTime();
    return nextInterval - now;
}

function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && !alias.internal) {
                if (alias.address.startsWith('192.168.') ||
                    alias.address.startsWith('10.') ||
                    alias.address.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) {
                    return alias.address;
                }
            }
        }
    }
    return 'Unable to determine LAN IP address';
}

function updateSettings(newParams) {
    const currentSettings = readSettings();
    const updatedSettings = { ...currentSettings, ...newParams };

    //ensure tip is at least 0
    updatedSettings.DEVELOPER_TIP_PERCENTAGE = Math.max(0, updatedSettings.DEVELOPER_TIP_PERCENTAGE);

    // ensure MONITOR_MODE is a boolean
    updatedSettings.MONITOR_MODE = updatedSettings.MONITOR_MODE === true;

    writeSettings(updatedSettings);
    return updatedSettings;
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

function writeSettings(settings) {
    try {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        console.log('Settings updated successfully.');
    } catch (error) {
        console.error('Error writing settings.json:', error);
    }
}

// Logging functions
const csvWriter = csv({
    path: LOG_FILE_PATH,
    header: [
        { id: 'timestamp', title: 'Time/Date' },
        { id: 'price', title: 'Price' },
        { id: 'indexValue', title: 'Index Value' }
    ],
    append: true
});

async function logTradingData(timestamp, price, indexValue) {
    const data = [{
        timestamp: timestamp,
        price: price,
        indexValue: indexValue
    }];

    try {
        await csvWriter.writeRecords(data);
        console.log('Trading data logged successfully');
    } catch (error) {
        console.error('Error logging trading data:', error);
    }
}

// Config functions
function setupEnvFile() {
    const envPath = path.join(__dirname, '..', 'user', '.env');

    if (!fs.existsSync(envPath)) {
        console.log('.env file not found. Creating a new one...');

        const envContent = `PRIVATE_KEY=
RPC_URL=
ADMIN_PASSWORD=
PORT=3000
`;

        fs.writeFileSync(envPath, envContent);
        console.log('.env file created successfully. Please fill in your details.');
        process.exit(0);
    }
}

async function loadEnvironment() {
    dotenv.config({ path: path.join(__dirname, '..', 'user', '.env') });

    if (!process.env.PRIVATE_KEY || !process.env.RPC_URL) {
        console.error("Missing required environment variables. Please ensure PRIVATE_KEY and RPC_URL are set in your .env file.");
        process.exit(1);
    }

    try {
        const privateKey = bs58.default.decode(process.env.PRIVATE_KEY);
        const keypair = Keypair.fromSecretKey(new Uint8Array(privateKey));
        const connection = new Connection(process.env.RPC_URL, 'confirmed');
        const wallet = new Wallet(keypair);

        wallet.connection = connection;

        return { keypair, connection, wallet };
    } catch (error) {
        console.error("Error verifying keypair:", error.message);
        process.exit(1);
    }
}

// Version function
function getVersion() {
    try {
        const packageJson = require('../package.json');
        return packageJson.version;
    } catch (error) {
        console.error('Error reading package.json:', error);
        return 'unknown';
    }
}

module.exports = {
    getTimestamp,
    formatTime,
    getNextIntervalTime,
    getWaitTime,
    getLocalIpAddress,
    updateSettings,
    readSettings,
    writeSettings,
    logTradingData,
    setupEnvFile,
    loadEnvironment,
    getVersion
};