import fs from 'fs';
import path from 'path';
import { executeCommand } from './executor.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.cache', 'data', '.anvil', 'vendor', '.turbo'
]);

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

/**
 * Iteratively walks repoPath (bounded) collecting source files.
 * Bounded so chaos-injection stays fast even against large target repos.
 */
function listSourceFiles(repoPath, maxVisits = 4000) {
  const results = [];
  const stack = [repoPath];
  let visited = 0;

  while (stack.length > 0 && visited < maxVisits) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      visited++;
      if (visited >= maxVisits) break;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          stack.push(fullPath);
        }
      } else if (entry.isFile()) {
        if (SOURCE_EXT.has(path.extname(entry.name))) {
          results.push(fullPath);
        }
      }
    }
  }

  return results;
}

function listTestFiles(repoPath) {
  return listSourceFiles(repoPath).filter((f) => {
    const base = path.basename(f).toLowerCase();
    const dir = path.dirname(f).toLowerCase();
    return base.includes('.test.') || base.includes('.spec.') ||
      dir.includes(`${path.sep}test`) || dir.includes(`${path.sep}tests`) ||
      dir.includes(`${path.sep}__tests__`);
  });
}

function pickRandom(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function readPackageJson(repoPath) {
  const pkgPath = path.join(repoPath, 'package.json');
  try {
    return { pkgPath, pkg: JSON.parse(fs.readFileSync(pkgPath, 'utf8')) };
  } catch {
    return { pkgPath, pkg: null };
  }
}

function relative(repoPath, filePath) {
  return path.relative(repoPath, filePath) || filePath;
}

// Builds a single-quoted JS string literal for embedding a path inside a
// `node -e "..."` command (the outer argument uses double quotes).
function toSingleQuotedJsString(str) {
  return `'${str.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// --- 8 chaos scenarios -----------------------------------------------------

function scenarioSyntaxError(repoPath) {
  const files = listSourceFiles(repoPath);
  const file = pickRandom(files);
  if (!file) return null;

  fs.appendFileSync(
    file,
    '\n\n// [ANVIL CHAOS] syntax-error\nfunction anvilChaosBroken( {\n  console.log("unterminated"\n'
  );

  return {
    scenarioId: 1,
    scenarioName: 'syntax-error',
    description: `Injected an unclosed function/parenthesis into ${relative(repoPath, file)}`,
    targetFile: file,
    // Plain execution, not `node --check`: --check silently reports 0 (no
    // error) on this exact corruption whenever the file contains TypeScript
    // syntax (confirmed on real .ts files) — it skips the type-stripping
    // pass --check runs through, so it never actually parses the broken part.
    // Full execution always hits it, since a SyntaxError there aborts before
    // any of the file's real top-level code gets a chance to run.
    testCommand: `node "${file}"`
  };
}

function scenarioMissingImport(repoPath) {
  const files = listSourceFiles(repoPath);
  const file = pickRandom(files);
  if (!file) return null;

  const { pkg } = readPackageJson(repoPath);
  const isEsm = pkg?.type === 'module' || file.endsWith('.mjs');
  const original = fs.readFileSync(file, 'utf8');

  const badImport = isEsm
    ? `import anvilChaosGhost from 'anvil-chaos-ghost-module-does-not-exist';\n`
    : `const anvilChaosGhost = require('anvil-chaos-ghost-module-does-not-exist');\n`;

  fs.writeFileSync(file, badImport + original);

  return {
    scenarioId: 2,
    scenarioName: 'missing-import',
    description: `Injected a require/import of a non-existent module into ${relative(repoPath, file)}`,
    targetFile: file,
    testCommand: `node "${file}"`
  };
}

function scenarioBrokenJsonConfig(repoPath) {
  const candidates = listSourceFiles(repoPath.replace(/[/\\]$/, '')); // noop, kept for symmetry
  const jsonFiles = [];
  const stack = [repoPath];
  let visited = 0;
  while (stack.length > 0 && visited < 2000) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(fullPath);
      } else if (entry.name.endsWith('.json') && entry.name !== 'package-lock.json') {
        jsonFiles.push(fullPath);
      }
    }
  }

  const file = jsonFiles.includes(path.join(repoPath, 'package.json'))
    ? path.join(repoPath, 'package.json')
    : pickRandom(jsonFiles);
  if (!file) return null;

  const original = fs.readFileSync(file, 'utf8');
  try {
    JSON.parse(original);
  } catch {
    return null; // already broken, skip
  }

  // Corrupt by stripping the final closing brace/bracket.
  const trimmed = original.trimEnd();
  const corrupted = trimmed.slice(0, -1) + '\n  "anvilChaos": "broken-json-missing-brace"\n';
  fs.writeFileSync(file, corrupted);

  return {
    scenarioId: 3,
    scenarioName: 'broken-json-config',
    description: `Corrupted JSON structure in ${relative(repoPath, file)}`,
    targetFile: file,
    // Single-quoted JS string literal, nested inside the double-quoted -e
    // argument — matches require('fs')/'utf8' below. Using JSON.stringify()
    // (double quotes) here would nest unescaped " inside " and corrupt the
    // command under every shell, since it collides with the outer delimiter.
    testCommand: `node -e "JSON.parse(require('fs').readFileSync(${toSingleQuotedJsString(file)}, 'utf8'))"`
  };
}

function scenarioTypeMismatch(repoPath) {
  const files = listSourceFiles(repoPath);
  const file = pickRandom(files);
  if (!file) return null;

  fs.appendFileSync(
    file,
    '\n\n// [ANVIL CHAOS] type-mismatch\nconst anvilChaosTypeBug = "42".map((x) => x);\n'
  );

  return {
    scenarioId: 4,
    scenarioName: 'type-mismatch',
    description: `Injected a call to .map() on a string (TypeError) into ${relative(repoPath, file)}`,
    targetFile: file,
    testCommand: `node "${file}"`
  };
}

// Preference order for scenarioInvalidCliFlag: scripts that conventionally
// run once and exit with a real code. `start`/`dev` are excluded on purpose —
// confirmed live against a real CLI-tool repo that its bare "dev" script
// (no subcommand) exits 1 even completely unmodified (Commander.js's default
// "missing command" behavior), which would make the scenario un-passable no
// matter how correct the fix is, since the baseline itself never returns 0.
const CLEANLY_EXITING_SCRIPT_NAMES = ['test', 'build', 'typecheck', 'lint'];

function scenarioInvalidCliFlag(repoPath) {
  const { pkgPath, pkg } = readPackageJson(repoPath);
  if (pkg && pkg.scripts && Object.keys(pkg.scripts).length > 0) {
    const scriptName = CLEANLY_EXITING_SCRIPT_NAMES.find((name) => pkg.scripts[name])
      || Object.keys(pkg.scripts)[0];
    const original = pkg.scripts[scriptName];
    pkg.scripts[scriptName] = `${original} --anvil-invalid-flag-9917`;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    return {
      scenarioId: 5,
      scenarioName: 'invalid-cli-flag',
      description: `Appended a bogus CLI flag to the "${scriptName}" script in package.json`,
      targetFile: pkgPath,
      testCommand: `npm run ${scriptName}`
    };
  }

  return {
    scenarioId: 5,
    scenarioName: 'invalid-cli-flag',
    description: 'No npm scripts found; invoking node directly with a bogus flag',
    targetFile: null,
    testCommand: 'node --anvil-invalid-flag-9917 -e "1"'
  };
}

// Checks process.env first (in case the target's own npm script loads .env
// itself), then falls back to reading .env off disk directly. Deliberately
// dependency-free (plain fs, no require('dotenv')) since it runs with cwd
// set to the TARGET repo — that repo's node_modules may not have dotenv
// installed, and we can't rely on Anvil's own node_modules from there.
// A fix command in the same process pool can never make process.env.X true
// for a LATER, separately-spawned verify process (env vars don't propagate
// between sibling child_process.exec() calls) — the file check is the only
// avenue a single bash command actually has to make this scenario passable.
// The regex tolerates whitespace around '=' and the value, and optional
// quotes — confirmed live that cmd.exe's `echo VAR=1 > .env` leaves a
// trailing space before the line ending, which a real .env parser like
// dotenv would trim without issue, so a byte-exact match is too strict.
const REQUIRED_ENV_CHECK_SCRIPT = `node -e "const fs=require('fs'); let fromFile=''; try{fromFile=fs.readFileSync('.env','utf8')}catch(e){}; const ok=process.env.ANVIL_REQUIRED_TEST_VAR || /^[ \\t]*ANVIL_REQUIRED_TEST_VAR[ \\t]*=[ \\t]*[\\x22\\x27]?1[\\x22\\x27]?[ \\t]*$/m.test(fromFile); if(!ok){throw new Error('Missing required environment variable: ANVIL_REQUIRED_TEST_VAR')}"`;

function scenarioMissingEnv(repoPath) {
  const envPath = path.join(repoPath, '.env');
  const { pkg } = readPackageJson(repoPath);

  if (fs.existsSync(envPath)) {
    fs.renameSync(envPath, path.join(repoPath, '.env.anvil-bak'));
    const scriptName = CLEANLY_EXITING_SCRIPT_NAMES.find((name) => pkg?.scripts?.[name]) || null;
    return {
      scenarioId: 6,
      scenarioName: 'missing-env',
      description: 'Temporarily renamed .env to simulate missing environment variables',
      targetFile: envPath,
      // Falls back to the same file-based check as the no-.env branch below
      // when there's no test/build/typecheck/lint script to run instead —
      // an unconditional process.exit(1) here would never be fixable by any
      // bash command, the same structural bug the no-.env branch had.
      testCommand: scriptName ? `npm run ${scriptName}` : REQUIRED_ENV_CHECK_SCRIPT
    };
  }

  return {
    scenarioId: 6,
    scenarioName: 'missing-env',
    description: 'No .env present; simulating a required-but-missing environment variable',
    targetFile: null,
    testCommand: REQUIRED_ENV_CHECK_SCRIPT
  };
}

function scenarioBuildFailed(repoPath) {
  const { pkg } = readPackageJson(repoPath);
  const hasBuildScript = !!pkg?.scripts?.build;

  if (hasBuildScript) {
    const files = listSourceFiles(repoPath);
    const file = pickRandom(files);
    if (file) {
      fs.appendFileSync(file, '\n\n// [ANVIL CHAOS] build-failed\nfunction anvilChaosBuildBreak( {\n');
    }
    return {
      scenarioId: 7,
      scenarioName: 'build-failed',
      description: file
        ? `Broke syntax in ${relative(repoPath, file)} to force "npm run build" to fail`
        : 'Forcing "npm run build" to fail',
      targetFile: file || null,
      testCommand: 'npm run build'
    };
  }

  return {
    scenarioId: 7,
    scenarioName: 'build-failed',
    description: 'No "build" script defined; npm run build is expected to fail on its own',
    targetFile: null,
    testCommand: 'npm run build'
  };
}

function scenarioTestFailed(repoPath) {
  const { pkg } = readPackageJson(repoPath);
  const hasTestScript = !!pkg?.scripts?.test;

  if (hasTestScript) {
    const testFiles = listTestFiles(repoPath);
    const file = pickRandom(testFiles) || pickRandom(listSourceFiles(repoPath));
    if (file) {
      fs.appendFileSync(file, '\n\n// [ANVIL CHAOS] test-failed\nfunction anvilChaosTestBreak( {\n');
    }
    return {
      scenarioId: 8,
      scenarioName: 'test-failed',
      description: file
        ? `Broke syntax in ${relative(repoPath, file)} to force "npm test" to fail`
        : 'Forcing "npm test" to fail',
      targetFile: file || null,
      testCommand: 'npm test'
    };
  }

  return {
    scenarioId: 8,
    scenarioName: 'test-failed',
    description: 'No "test" script defined; npm test is expected to fail on its own',
    targetFile: null,
    testCommand: 'npm test'
  };
}

const SCENARIOS = [
  scenarioSyntaxError,
  scenarioMissingImport,
  scenarioBrokenJsonConfig,
  scenarioTypeMismatch,
  scenarioInvalidCliFlag,
  scenarioMissingEnv,
  scenarioBuildFailed,
  scenarioTestFailed
];

/**
 * Randomly picks and applies one of the 8 chaos scenarios against repoPath.
 * Falls back to the next scenario if the chosen one can't find a suitable
 * target (e.g. an empty repo with no source files), so a run never stalls.
 * @param {string} repoPath - Absolute path to the target repository.
 * @returns {{scenarioId:number, scenarioName:string, description:string, targetFile:string|null, testCommand:string}}
 */
export function injectChaos(repoPath) {
  const order = [...SCENARIOS].sort(() => Math.random() - 0.5);

  for (const scenarioFn of order) {
    try {
      const result = scenarioFn(repoPath);
      if (result) return result;
    } catch {
      // try next scenario
    }
  }

  throw new Error('Anvil: unable to inject chaos — no usable target found in repo');
}

/**
 * Restores the target repo to a pristine state via git, guaranteeing every
 * chaos run starts from a clean baseline regardless of what was mutated.
 * @param {string} repoPath - Absolute path to the target repository.
 * @returns {Promise<{success: boolean, resetResult: object, cleanResult: object}>}
 */
export async function restoreRepo(repoPath) {
  const resetResult = await executeCommand('git reset --hard', repoPath);
  const cleanResult = await executeCommand('git clean -fd', repoPath);

  return {
    success: resetResult.exitCode === 0 && cleanResult.exitCode === 0,
    resetResult,
    cleanResult
  };
}
