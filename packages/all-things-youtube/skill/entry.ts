import { runSkillCli } from './cli';

process.exitCode = await runSkillCli(process.argv.slice(2), {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
});
