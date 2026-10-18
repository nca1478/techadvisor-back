import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/**
 * Free-tier entrypoint (`npm run start:free`).
 *
 * Runs the API and the ingestion worker in a single container because
 * Render's free tier offers no Background Workers (see ADR 0067). The paid
 * topology (one service per process, ADR 0019) stays the reference; this
 * launcher is only a cost tradeoff for hobby deployments.
 *
 * The container exits as soon as either child exits so the platform
 * restarts an intact API+worker pair. Logs of both processes share stdout
 * (prefix `[run-free]` marks launcher lines).
 */
const children = new Set<ChildProcess>();

function launch(script: string, label: string): void {
  const child = spawn(process.execPath, [script], { stdio: 'inherit' });
  children.add(child);
  child.on('exit', (code, signal) => {
    console.log(
      `[run-free] ${label} exited (code=${String(code)} signal=${String(signal)}), stopping the other process...`,
    );
    for (const other of children) {
      if (other !== child && other.exitCode === null) {
        other.kill('SIGTERM');
      }
    }
    // Justificado: se propaga el fallo del hijo para que Render reinicie el par completo.
    process.exitCode = code ?? 1;
    setTimeout(() => process.exit(process.exitCode ?? 1), 5000).unref();
  });
}

const distDir = import.meta.dirname;
launch(path.join(distDir, 'main.js'), 'api');
launch(path.join(distDir, 'modules', 'ingestion', 'ingestion.worker.js'), 'ingestion-worker');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[run-free] received ${signal}, forwarding...`);
    for (const child of children) {
      child.kill(signal);
    }
  });
}
