import { spawn } from 'node:child_process';

export async function openBrowser(url: string): Promise<void> {
  const target = new URL(url).toString();
  const command = browserCommand(target);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function browserCommand(url: string): { file: string; args: string[] } {
  if (process.platform === 'darwin') return { file: 'open', args: [url] };
  if (process.platform === 'win32') {
    return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  return { file: 'xdg-open', args: [url] };
}
