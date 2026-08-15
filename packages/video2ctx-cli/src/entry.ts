import { homedir } from 'node:os';
import { join } from 'node:path';
import { openBrowser } from './browser';
import { runCli } from './cli';
import { FileCredentialStore } from './profile-store';

const environment = process.env;
const configDirectory = environment.VIDEO2CTX_CONFIG_DIR
  ?? (environment.XDG_CONFIG_HOME
    ? join(environment.XDG_CONFIG_HOME, 'video2ctx')
    : join(homedir(), '.config', 'video2ctx'));

process.exitCode = await runCli(process.argv.slice(2), {
  fetch,
  store: new FileCredentialStore(configDirectory),
  environment,
  openBrowser,
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
