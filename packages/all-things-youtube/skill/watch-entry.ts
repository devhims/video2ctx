import { runWatchCli } from './watch-cli';

process.exitCode = await runWatchCli(process.argv.slice(2), {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
});
