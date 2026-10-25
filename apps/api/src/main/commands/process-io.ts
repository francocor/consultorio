import type { CommandIo } from './io.js';

/** The standard input of the process as text, up to a size no input of ours comes near. */
async function readStandardInput(): Promise<string> {
  const limit = 64 * 1024;
  let text = '';
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.length > limit) throw new Error('standard input is too long');
  }
  return text;
}

/** A command's view of the process it runs in: its environment, its flags and its three streams. */
export function processIo(args: readonly string[]): CommandIo {
  return {
    env: process.env,
    args,
    readStdin: readStandardInput,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
