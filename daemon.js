import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { injectChaos, restoreRepo } from './src/chaos-injector.js';
import { executeCommand } from './src/executor.js';
import { requestFix } from './src/gemini-agent.js';
import { recordResult, recordBug } from './src/evaluator.js';

const TARGET_REPO_PATH = path.resolve(process.env.TARGET_REPO_PATH || '.');
const MIN_DELAY_MS = 10 * 60_000;
const MAX_DELAY_MS = 15 * 60_000;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeSleepEarly = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function randomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

function buildRepoContext() {
  let pkgSummary = '(no package.json found)';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(TARGET_REPO_PATH, 'package.json'), 'utf8'));
    pkgSummary = JSON.stringify(
      { name: pkg.name, type: pkg.type, scripts: pkg.scripts },
      null,
      2
    );
  } catch {
    // ignore, keep default summary
  }
  return `Target repository path: ${TARGET_REPO_PATH}\npackage.json summary:\n${pkgSummary}`;
}

function printBanner() {
  console.log(chalk.red.bold('\n=================================================='));
  console.log(chalk.red.bold('   ANVIL - 24/7 Autonomous Agentic Stress-Tester'));
  console.log(chalk.gray('   Hammering NexusMem & AI Context Engines since now'));
  console.log(chalk.red.bold('==================================================\n'));
  console.log(chalk.gray(`Target repo:  ${TARGET_REPO_PATH}`));
  console.log(chalk.gray(`Cycle delay:  ${MIN_DELAY_MS / 1000}s - ${MAX_DELAY_MS / 1000}s`));
  console.log(chalk.gray(`Gemini key:   ${process.env.GEMINI_API_KEY ? 'loaded' : chalk.red('MISSING - fixes will fail')}\n`));
}

/**
 * Runs exactly one chaos -> detect -> fix -> verify cycle.
 * Never throws — all failure modes are caught and recorded so the outer
 * daemon loop can run forever without interruption.
 */
async function runCycle(round) {
  const startedAt = Date.now();
  let scenario = null;

  try {
    console.log(chalk.yellow(`\n[Round ${round}] Injecting chaos into ${TARGET_REPO_PATH} ...`));
    scenario = injectChaos(TARGET_REPO_PATH);
    console.log(chalk.yellow(`[Round ${round}] Scenario: ${chalk.bold(scenario.scenarioName)} - ${scenario.description}`));

    console.log(chalk.gray(`[Round ${round}] Running: ${scenario.testCommand}`));
    const failingRun = await executeCommand(scenario.testCommand, TARGET_REPO_PATH);

    if (failingRun.exitCode === 0) {
      console.log(chalk.gray(`[Round ${round}] Chaos did not trigger a failure this round - skipping fix cycle.`));
      return;
    }

    console.log(chalk.red(`[Round ${round}] Failure captured (exit ${failingRun.exitCode}). Asking Gemini for a fix...`));

    let fixCommand;
    try {
      fixCommand = await requestFix({
        errorLog: failingRun.stderr,
        commandOutput: `$ ${scenario.testCommand}\nSTDOUT:\n${failingRun.stdout}\nSTDERR:\n${failingRun.stderr}`,
        repoContext: `${buildRepoContext()}\nInjected scenario: ${scenario.scenarioName} (${scenario.description})`
      });
    } catch (err) {
      fixCommand = null;
      console.log(chalk.red(`[Round ${round}] Gemini request failed: ${err.message}`));
    }

    let verifyRun = { exitCode: 1, stdout: '', stderr: 'no fix attempted' };
    if (fixCommand) {
      console.log(chalk.cyan(`[Round ${round}] Gemini fix: ${fixCommand}`));
      const fixRun = await executeCommand(fixCommand, TARGET_REPO_PATH);
      console.log(chalk.gray(`[Round ${round}] Fix command exited with code ${fixRun.exitCode}`));

      console.log(chalk.gray(`[Round ${round}] Re-running: ${scenario.testCommand}`));
      verifyRun = await executeCommand(scenario.testCommand, TARGET_REPO_PATH);
    }

    const success = verifyRun.exitCode === 0;
    const durationMs = Date.now() - startedAt;

    if (success) {
      console.log(chalk.green(`[Round ${round}] RECOVERED in ${durationMs}ms [OK]`));
    } else {
      console.log(chalk.red(`[Round ${round}] FIX FAILED - exit ${verifyRun.exitCode} [FAIL]`));
    }

    recordResult({ scenarioName: scenario.scenarioName, success, durationMs });

    if (!success) {
      recordBug({
        scenarioName: scenario.scenarioName,
        description: scenario.description,
        targetFile: scenario.targetFile,
        testCommand: scenario.testCommand,
        initialError: failingRun.stderr || failingRun.stdout,
        fixCommand,
        verifyStdout: verifyRun.stdout,
        verifyStderr: verifyRun.stderr,
        durationMs
      });
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.log(chalk.red(`[Round ${round}] Unexpected error during cycle: ${err.message}`));
    recordResult({ scenarioName: scenario?.scenarioName || 'unknown', success: false, durationMs });
    recordBug({
      scenarioName: scenario?.scenarioName || 'unknown',
      description: 'Unexpected daemon-level exception',
      error: err.message,
      stack: err.stack,
      durationMs
    });
  } finally {
    console.log(chalk.gray(`[Round ${round}] Restoring repo to a clean state...`));
    const restored = await restoreRepo(TARGET_REPO_PATH);
    if (!restored.success) {
      console.log(chalk.red(`[Round ${round}] WARNING: restore did not fully succeed - repo may be dirty.`));
    }
  }
}

// A killed-not-terminated process still runs its finally blocks, so a normal
// stop leaves the repo clean. A hard kill (SIGKILL, taskkill /F, Stop-Process
// -Force) does not — the OS ends the process before any JS, including
// runCycle()'s finally { restoreRepo() }, gets to run. These handlers make a
// *graceful* stop (SIGINT/SIGTERM, e.g. Render.com's shutdown signal, Ctrl+C)
// finish the in-flight cycle's restore before exiting, instead of racing it.
let shuttingDown = false;
let wakeSleepEarly = null;

function handleShutdownSignal(signal) {
  if (shuttingDown) {
    console.log(chalk.red.bold(`[daemon] Second ${signal} received - forcing immediate exit (repo may be left dirty).`));
    process.exit(1);
  }
  shuttingDown = true;
  console.log(chalk.yellow(`\n[daemon] ${signal} received - finishing the current cycle's restore, then exiting gracefully...`));
  if (wakeSleepEarly) {
    wakeSleepEarly();
    wakeSleepEarly = null;
  }
}

async function main() {
  printBanner();
  let round = 0;

  // Top-level guard: no thrown error, anywhere, should ever kill this process.
  while (!shuttingDown) {
    round += 1;
    try {
      await runCycle(round);
    } catch (err) {
      console.log(chalk.red.bold(`[Round ${round}] FATAL-LOOKING ERROR SWALLOWED: ${err?.message || err}`));
    }

    if (shuttingDown) break;

    const delay = randomDelay();
    console.log(chalk.gray(`[Round ${round}] Sleeping ${Math.round(delay / 1000)}s before next round...`));
    await sleep(delay);
  }

  console.log(chalk.yellow('[daemon] Shutdown complete - repo left in a clean, restored state.'));
  process.exit(0);
}

process.on('uncaughtException', (err) => {
  console.log(chalk.red.bold(`[daemon] uncaughtException: ${err?.message || err}`));
});
process.on('unhandledRejection', (err) => {
  console.log(chalk.red.bold(`[daemon] unhandledRejection: ${err?.message || err}`));
});
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));

main();
