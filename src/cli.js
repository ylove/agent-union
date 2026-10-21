import { runHook } from './hook.js';

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'hook':
      return runHook(rest);
    default:
      process.stdout.write('usage: agent-union hook <harness> <event>\n');
      return cmd ? 1 : 0;
  }
}
