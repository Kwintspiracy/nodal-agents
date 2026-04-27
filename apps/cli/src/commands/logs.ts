// logs.ts — tail log files for web, runner, postgres

import chalk from 'chalk';
import { existsSync, createReadStream, watch, statSync } from 'fs';
import { join } from 'path';
import { LOG_DIR } from '../lib/config.ts';

type ServiceName = 'web' | 'runner' | 'postgres';

const VALID_SERVICES: ServiceName[] = ['web', 'runner', 'postgres'];

function isServiceName(s: string): s is ServiceName {
  return (VALID_SERVICES as string[]).includes(s);
}

/**
 * Tail a log file — prints the last N lines then follows new output.
 */
export async function runLogs(service?: string): Promise<void> {
  const target = service ?? 'all';

  if (target !== 'all' && !isServiceName(target)) {
    console.error(chalk.red(`Unknown service: ${target}. Valid: ${VALID_SERVICES.join(', ')}`));
    process.exit(1);
  }

  const services: ServiceName[] = target === 'all' ? VALID_SERVICES : [target as ServiceName];

  for (const svc of services) {
    const logFile = join(LOG_DIR, `${svc}.log`);
    if (!existsSync(logFile)) {
      console.log(chalk.gray(`  [${svc}] No log file yet at ${logFile}`));
      continue;
    }

    console.log(chalk.bold(`\n--- ${svc} ---`));
    // Print existing content
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(logFile, { encoding: 'utf-8' });
      stream.on('data', (chunk) => process.stdout.write(chunk as string));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  }

  if (target !== 'all') {
    // Follow the single service's log file
    const logFile = join(LOG_DIR, `${target}.log`);
    if (!existsSync(logFile)) {
      console.log(chalk.yellow('Waiting for log file to be created…'));
    }

    console.log(chalk.gray('\nFollowing log (Ctrl+C to stop)...\n'));

    // Simple tail -f using fs.watch
    let fileSize = 0;
    try {
      fileSize = statSync(logFile).size;
    } catch {
      /* file might not exist yet */
    }

    const watcher = watch(logFile, () => {
      try {
        const newSize = statSync(logFile).size;
        if (newSize > fileSize) {
          const stream = createReadStream(logFile, { start: fileSize, encoding: 'utf-8' });
          stream.on('data', (chunk) => process.stdout.write(chunk as string));
          fileSize = newSize;
        }
      } catch {
        /* ignore */
      }
    });

    // Suppress noUnusedLocals — watcher held open intentionally
    void watcher;

    // Keep the process alive
    await new Promise<void>(() => {
      /* never resolves — Ctrl+C exits */
    });
  }
}
