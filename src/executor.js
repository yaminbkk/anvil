import { exec } from 'child_process';

/**
 * Executes a shell command in the given working directory and captures
 * exit code, stdout, and stderr without ever throwing — chaos-testing
 * daemons need to observe failures, not crash on them.
 * @param {string} cmd - The shell command to run.
 * @param {string} cwd - Working directory to run the command in.
 * @param {number} [timeoutMs=120000] - Max time to allow the command to run.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, cmd: string}>}
 */
export function executeCommand(cmd, cwd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    exec(
      cmd,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 10,
        windowsHide: true,
        // On win32, leave shell unset so Node uses cmd.exe (via ComSpec) — its
        // C-style `\"` quote escaping matches JSON.stringify()-built command
        // strings. PowerShell's quoting rules don't, and silently mangle them.
        shell: process.platform === 'win32' ? undefined : '/bin/bash'
      },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({
          exitCode,
          stdout: stdout ? stdout.toString() : '',
          stderr: stderr ? stderr.toString() : (error ? error.message : ''),
          cmd
        });
      }
    );
  });
}
