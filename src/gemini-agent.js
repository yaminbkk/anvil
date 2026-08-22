import { GoogleGenAI } from '@google/genai';

// gemini-2.5-flash / gemini-1.5-flash have been retired for new API keys
// (confirmed live: both 404 as of 2026-08). gemini-3.6-flash is the current
// generation; gemini-flash-latest is a rolling alias Google keeps pointed at
// whatever flash model is current, so the fallback survives future retirements.
const MODEL = 'gemini-3.6-flash';
const FALLBACK_MODEL = 'gemini-flash-latest';

const SYSTEM_PROMPT = `You are Anvil's Autonomous AI Developer — a fully autonomous repair agent embedded in a 24/7 chaos-engineering daemon.

You will be given:
- An error log produced by a target repository (often "NexusMem", a local-first AI context engine, but it could be any repository).
- The raw stdout/stderr of the command that just failed.
- Repository context (file paths, package.json, working directory, etc).

Your job: analyze the failure and return EXACTLY ONE single-line Bash command that, when executed from the repository root, fixes the problem so the failing command can pass on the next run.

STRICT OUTPUT RULES:
- Output ONLY the raw bash command. Nothing else.
- No explanations, no reasoning, no preamble, no postamble.
- No markdown, no code fences, no backticks.
- No multi-line scripts — exactly ONE line, chainable with && or ; if multiple steps are truly required.
- Do not wrap the answer in quotes unless the quotes are part of the actual shell command.
- If you cannot determine a fix, output exactly: echo "anvil: no-fix-available"
`;

function buildUserPrompt({ errorLog, commandOutput, repoContext }) {
  return [
    '### REPO CONTEXT',
    repoContext ? String(repoContext) : '(none provided)',
    '',
    '### ERROR LOG',
    errorLog ? String(errorLog) : '(none provided)',
    '',
    '### RAW COMMAND OUTPUT',
    commandOutput ? String(commandOutput) : '(none provided)',
    '',
    'Return the single-line bash command to fix this now.'
  ].join('\n');
}

function sanitizeToSingleLine(text) {
  if (!text) return 'echo "anvil: no-fix-available"';

  let cleaned = text.trim();

  cleaned = cleaned.replace(/```(?:bash|sh|shell)?/gi, '').replace(/```/g, '').trim();

  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !l.startsWith('#')) || lines[0] || 'echo "anvil: no-fix-available"';

  return line.trim();
}

let client = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set in the environment');
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

/**
 * Asks Gemini for a single-line bash fix command given the current failure.
 * @param {{errorLog?: string, commandOutput?: string, repoContext?: string}} params
 * @returns {Promise<string>} A single-line bash command (never empty, never multi-line).
 */
export async function requestFix({ errorLog, commandOutput, repoContext } = {}) {
  const ai = getClient();
  const userPrompt = buildUserPrompt({ errorLog, commandOutput, repoContext });

  const models = [MODEL, FALLBACK_MODEL];
  let lastError = null;

  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: userPrompt,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.2,
          // gemini-3.6-flash is a reasoning model — it spends part of this
          // budget on internal "thinking" tokens before the visible answer
          // (confirmed live: 242-643 thinking tokens per call). At 256 the
          // answer was getting cut off mid-command (finishReason MAX_TOKENS)
          // almost every time; thinkingConfig.thinkingBudget=0 did not
          // suppress it, so the fix is headroom, not disabling thinking.
          maxOutputTokens: 2048
        }
      });

      const text = response?.text ?? '';
      return sanitizeToSingleLine(text);
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Anvil: Gemini request failed on all models — ${lastError?.message ?? 'unknown error'}`);
}
