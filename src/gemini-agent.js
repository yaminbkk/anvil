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

// The model doesn't always follow the "one bash command, nothing else"
// instruction — sometimes it answers with reasoning/prose instead (confirmed
// live: multi-sentence explanations, questions, even a verbatim echo of this
// file's own SYSTEM_PROMPT text). sanitizeToSingleLine() has no way to tell
// that apart from a real command, so whatever it picked was getting executed
// as-is — reliably exit 127 ("prose sentence" as a command name) or a stray
// exit 2 from an unbalanced quote left over from the echoed prose. This is a
// cheap, generic filter (not a parser) to catch the shape of those failures
// before they reach the shell.
function looksLikeShellCommand(line) {
  if (!line) return false;
  const trimmed = line.trim();
  if (!trimmed) return false;

  // Real fix commands don't end mid-sentence with a question mark.
  if (trimmed.endsWith('?')) return false;

  // An odd number of quote characters means prose swallowed (or left
  // dangling) a stray one — a real shell command's quoting always balances.
  const doubleQuotes = (trimmed.match(/(?<!\\)"/g) || []).length;
  const singleQuotes = (trimmed.match(/(?<!\\)'/g) || []).length;
  if (doubleQuotes % 2 !== 0 || singleQuotes % 2 !== 0) return false;

  // Sentence-starting words that are never how a real shell command opens.
  if (/^(if|what|when|why|how|consider|note|based on|it looks|it seems|maybe|perhaps|possibly|i think|i believe|the |this |these |there |you |we )\b/i.test(trimmed)) {
    return false;
  }

  return true;
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

async function callModelsForFix(userPrompt) {
  const ai = getClient();
  const models = [MODEL, FALLBACK_MODEL];
  const errorsByModel = [];

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
      // Keep every model's failure reason, not just the last one — a
      // combined "failed on all models" error that only showed the fallback's
      // message made the primary model's actual failure invisible (found
      // live: a 429 quota error from the fallback masked why gemini-3.6-flash
      // itself had already failed).
      errorsByModel.push(`${model}: ${err?.message ?? 'unknown error'}`);
    }
  }

  throw new Error(`Anvil: Gemini request failed on all models — ${errorsByModel.join(' | ')}`);
}

/**
 * Asks Gemini for a single-line bash fix command given the current failure.
 * @param {{errorLog?: string, commandOutput?: string, repoContext?: string}} params
 * @returns {Promise<string>} A single-line bash command (never empty, never multi-line).
 */
export async function requestFix({ errorLog, commandOutput, repoContext } = {}) {
  const basePrompt = buildUserPrompt({ errorLog, commandOutput, repoContext });

  const firstAttempt = await callModelsForFix(basePrompt);
  if (looksLikeShellCommand(firstAttempt)) return firstAttempt;

  // The model ignored the "one bash command, nothing else" instruction and
  // answered with prose instead — give it one more shot with the offending
  // answer quoted back, rather than executing that prose as a shell command.
  const retryPrompt = [
    basePrompt,
    '',
    '### YOUR PREVIOUS ANSWER WAS REJECTED',
    `It was not a valid single-line shell command: ${JSON.stringify(firstAttempt)}`,
    'Reply with ONLY the raw single-line bash command. No prose, no reasoning, no questions.'
  ].join('\n');

  const secondAttempt = await callModelsForFix(retryPrompt);
  if (looksLikeShellCommand(secondAttempt)) return secondAttempt;

  return 'echo "anvil: no-fix-available"';
}
