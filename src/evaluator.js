import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const METRICS_PATH = path.join(DATA_DIR, 'metrics.json');
const BUGS_PATH = path.join(DATA_DIR, 'bugs.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function defaultMetrics() {
  return {
    totalRuns: 0,
    successCount: 0,
    failureCount: 0,
    successRatePercent: 0,
    totalRecoveryTimeMs: 0,
    avgRecoveryTimeMs: 0,
    byScenario: {},
    lastUpdated: null
  };
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Records the outcome of a single chaos -> fix -> verify cycle into
 * data/metrics.json, maintaining a running benchmark of how well NexusMem
 * (or whatever target repo is under test) recovers from injected failures.
 * @param {{scenarioName: string, success: boolean, durationMs: number}} result
 */
export function recordResult({ scenarioName, success, durationMs }) {
  ensureDataDir();
  const metrics = readJsonSafe(METRICS_PATH, defaultMetrics());

  metrics.totalRuns += 1;
  if (success) {
    metrics.successCount += 1;
  } else {
    metrics.failureCount += 1;
  }
  metrics.totalRecoveryTimeMs += durationMs || 0;
  metrics.successRatePercent = Number(
    ((metrics.successCount / metrics.totalRuns) * 100).toFixed(2)
  );
  metrics.avgRecoveryTimeMs = Number(
    (metrics.totalRecoveryTimeMs / metrics.totalRuns).toFixed(2)
  );
  metrics.lastUpdated = new Date().toISOString();

  if (!metrics.byScenario[scenarioName]) {
    metrics.byScenario[scenarioName] = {
      runs: 0,
      successCount: 0,
      failureCount: 0,
      totalRecoveryTimeMs: 0,
      avgRecoveryTimeMs: 0,
      successRatePercent: 0
    };
  }
  const s = metrics.byScenario[scenarioName];
  s.runs += 1;
  if (success) s.successCount += 1;
  else s.failureCount += 1;
  s.totalRecoveryTimeMs += durationMs || 0;
  s.avgRecoveryTimeMs = Number((s.totalRecoveryTimeMs / s.runs).toFixed(2));
  s.successRatePercent = Number(((s.successCount / s.runs) * 100).toFixed(2));

  writeJson(METRICS_PATH, metrics);
  return metrics;
}

/**
 * Appends an unrecoverable case — one Gemini's fix could not resolve — to
 * data/bugs.json for later triage.
 * @param {object} scenarioData - Arbitrary details about the failed scenario
 *   (scenarioName, errorLog, commandOutput, fixAttempted, finalOutput, etc).
 */
export function recordBug(scenarioData) {
  ensureDataDir();
  const bugs = readJsonSafe(BUGS_PATH, []);

  bugs.push({
    ...scenarioData,
    recordedAt: new Date().toISOString()
  });

  writeJson(BUGS_PATH, bugs);
  return bugs;
}
