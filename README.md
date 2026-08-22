# Anvil 🔨

**Anvil** is a **Universal 24/7 Autonomous Agentic Stress-Testing Framework**.

It exists to relentlessly *hammer* [**NexusMem**](https://github.com/) — a local-first AI Context Engine — and prove that it can survive real-world chaos: broken configs, missing modules, botched builds, failing tests, bad CLI flags, and everything in between. Anvil doesn't stop at NexusMem, though — point it at **any repository on the planet** and it will run the exact same 24/7 chaos-recovery loop against it.

Anvil runs forever as a background daemon, powered by the **Google Gemini API** (`@google/genai`), acting as a fully autonomous AI developer that must diagnose and repair whatever Anvil just broke — without a human in the loop.

## How it works

Every 10–15 minutes, Anvil runs one full cycle:

1. **Chaos Injection** — `src/chaos-injector.js` randomly picks 1 of 8 failure scenarios and injects it into the target repository:
   - Syntax errors
   - Missing imports / non-existent modules
   - Broken JSON in config files
   - Type mismatches
   - Invalid CLI flags
   - Simulated missing environment variables
   - Broken `npm run build`
   - Broken `npm test`
2. **Detection** — `src/executor.js` runs the relevant command and captures `exitCode`, `stdout`, and `stderr`.
3. **Autonomous Repair** — `src/gemini-agent.js` sends the error context to Gemini (`gemini-3.6-flash`, falling back to the rolling `gemini-flash-latest` alias if that model is ever retired), which responds with exactly **one line of bash** meant to fix the problem.
4. **Verification** — the fix is executed and the original failing command is re-run to confirm the exit code returns to `0`.
5. **Benchmarking** — `src/evaluator.js` records the outcome to `data/metrics.json` (total runs, success rate %, recovery time) and logs any unrecoverable case to `data/bugs.json`.
6. **Restoration** — `src/chaos-injector.js` runs `git reset --hard && git clean -fd` in a `finally` block, guaranteeing every cycle starts from a clean baseline — no matter what happened.

The entire loop is wrapped in defensive `try/catch/finally` blocks so that **Anvil itself never crashes**, even while running unattended for weeks on a platform like [Render.com](https://render.com) as a Background Worker, hammering NexusMem (or any other target) with roughly a hundred failure scenarios a day at the default 10–15 minute cadence (the cadence is a cost/coverage tradeoff against the Gemini API's per-call cost — see "Cost" below — not a hard limit; lower `MIN_DELAY_MS`/`MAX_DELAY_MS` in `daemon.js` for tighter coverage if your budget allows).

## Project structure

```
anvil/
├── daemon.js              # 24/7 main loop (entrypoint)
├── src/
│   ├── chaos-injector.js  # injectChaos() / restoreRepo()
│   ├── executor.js        # executeCommand()
│   ├── gemini-agent.js    # requestFix() via @google/genai
│   └── evaluator.js       # recordResult() / recordBug()
├── data/
│   ├── metrics.json       # aggregate benchmark stats (generated)
│   └── bugs.json          # unrecoverable cases (generated)
├── .env.example
└── package.json
```

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```
GEMINI_API_KEY=your_gemini_api_key_here
TARGET_REPO_PATH=.
```

- `GEMINI_API_KEY` — your Google Gemini API key.
- `TARGET_REPO_PATH` — path to the git repository Anvil should stress-test (e.g. a local clone of NexusMem). **Must be a git repository**, since restoration relies on `git reset --hard` / `git clean -fd`.

## Running

```bash
npm start
```

This starts `daemon.js`, which runs forever until the process is stopped.

## Deploying to Render.com

Anvil is designed to run as a **Background Worker**, and ships with a [`render.yaml`](render.yaml) Blueprint so most of the setup is pre-configured. To deploy:

1. In the Render dashboard: **New > Blueprint**, connect this GitHub repo, and let Render read `render.yaml`.
2. Fill in the two secret env vars it prompts for:
   - `GEMINI_API_KEY` — your Gemini API key.
   - `TARGET_REPO_GIT_URL` — the git URL of the repo Anvil should stress-test (e.g. NexusMem's clone URL). The build step clones it fresh into `TARGET_REPO_PATH` if it isn't already there, then runs `npm install` inside it too — the target's own `build`/`test`/`dev` scripts need its dependencies actually present, or every scenario that runs one fails with "command not found" regardless of what chaos was injected.
3. Deploy. Render runs `npm install` + the clone step as the build, then `node daemon.js` as the worker process.

The worker's filesystem is ephemeral by default: every redeploy re-clones the target repo from scratch (a clean baseline) and resets `data/metrics.json`/`data/bugs.json`. If you want the benchmark history to survive redeploys, attach a [Render Disk](https://render.com/docs/disks) mounted over `data/` — not included in the Blueprint by default since it's a paid add-on.

Prefer manual setup instead of the Blueprint? Configure a Background Worker directly with:
- **Build command:** `npm install`
- **Start command:** `node daemon.js`
- **Environment variables:** set `GEMINI_API_KEY` and `TARGET_REPO_PATH` (pointing at a repo already present on the instance) in the Render dashboard.

## Benchmark output

`data/metrics.json` tracks Anvil's overall benchmark of how well the target repo recovers from chaos, broken down per scenario:

```json
{
  "totalRuns": 128,
  "successCount": 121,
  "failureCount": 7,
  "successRatePercent": 94.53,
  "avgRecoveryTimeMs": 4821.3,
  "byScenario": { "...": "..." }
}
```

Unrecoverable cases — where Gemini's fix could not restore a `0` exit code — are appended to `data/bugs.json` for later triage.

## Cost

`gemini-3.6-flash`/`gemini-3.7-flash` are reasoning models — most of what they're billed for on each call is invisible "thinking" tokens spent before the visible one-line answer (confirmed live: 242–643 thinking tokens per call, against a ~10-token answer). Thinking tokens bill as **output** ($3.75 / 1M tokens), not input ($0.75 / 1M), so a single Anvil round costs roughly **$0.001–$0.003**. `thinkingConfig.thinkingBudget: 0` does not suppress this on either model — the only real lever is call frequency.

The free tier caps out at **20 requests/day per model** (40/day combined across the primary + `gemini-flash-latest` fallback), which a 24/7 daemon exhausts within hours. At the default 10–15 minute cadence, a paid tier runs roughly **$2–5/day per running instance** — local and Render deployments share the same quota and billing if they use the same `GEMINI_API_KEY`, so running both roughly doubles it.

## License

MIT
