const fs = require("fs/promises");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.RecoverPilot_DATA_DIR
  ? path.resolve(process.env.RecoverPilot_DATA_DIR)
  : path.join(__dirname, "..", "data");
const DB_FILE = process.env.RecoverPilot_DB_FILE
  ? path.resolve(process.env.RecoverPilot_DB_FILE)
  : path.join(DATA_DIR, "retargeting.sqlite");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SAMPLE_ABANDONED_CART_FILE = path.join(__dirname, "..", "sample-data", "abandoned-cart-event.json");
const SAMPLE_NO_CONSENT_ABANDONED_CART_FILE = path.join(__dirname, "..", "sample-data", "no-consent-abandoned-cart-event.json");
const SAMPLE_PURCHASE_FILE = path.join(__dirname, "..", "sample-data", "purchase-event.json");
const DASHBOARD_FILE = path.join(__dirname, "dashboard.html");
const LANDING_FILE = path.join(__dirname, "landing.html");
const TABLES = [
  "events",
  "stores",
  "customers",
  "carts",
  "messages",
  "conversions",
  "campaign_settings",
  "activity"
];

let dbReadyPromise = null;
let dbInstance = null;

function emptyState() {
  return {
    events: [],
    stores: [],
    customers: [],
    carts: [],
    messages: [],
    conversions: [],
    campaign_settings: [],
    activity: []
  };
}

function tablePrimaryKey(tableName) {
  return {
    events: "event_id",
    stores: "store_id",
    customers: "customer_id",
    carts: "cart_id",
    messages: "message_id",
    conversions: "conversion_id",
    campaign_settings: "store_id",
    activity: "activity_id"
  }[tableName];
}

function openDatabase() {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_FILE);
    dbInstance.exec("PRAGMA journal_mode = WAL");
  }

  return dbInstance;
}

function initializeSchema(db) {
  for (const tableName of TABLES) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      )
    `);
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

function replaceStateTables(db, state) {
  db.exec("BEGIN");

  try {
    for (const tableName of TABLES) {
      db.exec(`DELETE FROM ${tableName}`);

      const items = state[tableName] || [];
      if (items.length === 0) {
        continue;
      }

      const insert = db.prepare(`INSERT INTO ${tableName} (id, json) VALUES (?, ?)`);
      const primaryKey = tablePrimaryKey(tableName);

      for (const item of items) {
        insert.run(String(item[primaryKey]), JSON.stringify(item));
      }
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function tableRowCount(db, tableName) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

async function migrateLegacyJsonIfNeeded(db) {
  const hasLegacyState = await fileExists(STATE_FILE);
  const databaseIsEmpty = TABLES.every((tableName) => tableRowCount(db, tableName) === 0);

  if (!databaseIsEmpty || !hasLegacyState) {
    return;
  }

  const raw = await fs.readFile(STATE_FILE, "utf8");
  replaceStateTables(db, JSON.parse(raw));
}

async function ensureDatabaseReady() {
  if (!dbReadyPromise) {
    dbReadyPromise = (async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const db = openDatabase();
      initializeSchema(db);
      await migrateLegacyJsonIfNeeded(db);
      return db;
    })();
  }

  return dbReadyPromise;
}

async function readState() {
  const db = await ensureDatabaseReady();
  const state = emptyState();

  for (const tableName of TABLES) {
    const rows = db.prepare(`SELECT json FROM ${tableName} ORDER BY rowid`).all();
    state[tableName] = rows.map((row) => JSON.parse(row.json));
  }

  return state;
}

async function writeState(state) {
  const db = await ensureDatabaseReady();
  replaceStateTables(db, state);
}

async function resetState() {
  const state = emptyState();
  await writeState(state);
  return state;
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function readTextFile(filePath) {
  return fs.readFile(filePath, "utf8");
}

module.exports = {
  DASHBOARD_FILE,
  DB_FILE,
  LANDING_FILE,
  SAMPLE_ABANDONED_CART_FILE,
  SAMPLE_NO_CONSENT_ABANDONED_CART_FILE,
  SAMPLE_PURCHASE_FILE,
  STATE_FILE,
  emptyState,
  readJsonFile,
  readState,
  readTextFile,
  resetState,
  writeState
};
