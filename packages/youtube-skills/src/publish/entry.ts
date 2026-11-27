import { runPublishCli } from './cli';

process.exitCode = await runPublishCli(process.argv.slice(2), {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
});
