const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { startIrohTestProxy } = require('./iroh-test-proxy.cjs');

const composeArgs = ['compose', '-f', 'docker-compose.e2e.yml'];
const dockerCommand = process.platform === 'win32' ? 'docker.exe' : 'docker';
const commandEnv = buildCommandEnv();
const playwrightCli = require.resolve('@playwright/test/cli');

function buildCommandEnv() {
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extraPathEntries = [];

  if (process.platform === 'darwin') {
    extraPathEntries.push(
      '/Applications/Docker.app/Contents/Resources/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin'
    );
  }

  const nextPath = [...new Set([...extraPathEntries.filter((entry) => fs.existsSync(entry)), ...pathEntries])];

  return {
    ...process.env,
    APP_E2E_DISABLE_NDK_OUTBOX: 'true',
    APP_IROH_RELAY_URL: 'https://127.0.0.1:7004/',
    PATH: nextPath.join(path.delimiter)
  };
}

function runCommand(command, args, options = {}) {
  const {
    allowFailure = false
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: commandEnv,
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || allowFailure) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'null'}.`));
    });
  });
}

function waitForTcpPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({
        host,
        port
      });

      socket.once('connect', () => {
        socket.end();
        resolve();
      });

      socket.once('error', () => {
        socket.destroy();

        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for ${host}:${port}.`));
          return;
        }

        setTimeout(attempt, 500);
      });
    };

    attempt();
  });
}

async function main() {
  const playwrightArgs = process.argv.slice(2);

  await runCommand(dockerCommand, [...composeArgs, 'down', '-v', '--remove-orphans'], {
    allowFailure: true
  });
  await runCommand(dockerCommand, [...composeArgs, 'up', '-d']);

  try {
    await waitForTcpPort('127.0.0.1', 7000, 30_000);
    await waitForTcpPort('127.0.0.1', 7001, 30_000);
    await waitForTcpPort('127.0.0.1', 7003, 30_000);
    const stopProxy = await startIrohTestProxy();
    try {
      await runCommand(process.execPath, [playwrightCli, 'test', ...playwrightArgs]);
    } finally { await stopProxy(); }
  } finally {
    await runCommand(dockerCommand, [...composeArgs, 'down', '-v', '--remove-orphans'], {
      allowFailure: true
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
