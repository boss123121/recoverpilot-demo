const fs = require("fs");
const path = require("path");

const ENV_FILE = path.join(__dirname, "..", ".env");

function parseEnvLine(line) {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  let value = trimmed.slice(separatorIndex + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

function loadEnvFile(filePath = ENV_FILE) {
  if (!fs.existsSync(filePath)) {
    return {
      loaded: false,
      filePath,
      keys: []
    };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const keys = [];

  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed || !parsed.key) {
      continue;
    }

    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
      keys.push(parsed.key);
    }
  }

  return {
    loaded: true,
    filePath,
    keys
  };
}

module.exports = {
  ENV_FILE,
  loadEnvFile
};
