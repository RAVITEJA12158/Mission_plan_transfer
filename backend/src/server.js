const fs = require('fs');
const path = require('path');
const env = require('./config/env');
const { prisma } = require('./config/database');
const app = require('./app');

function prepareStorage() {
  fs.mkdirSync(env.tmpDir, { recursive: true });
  // Single-instance server: at startup no upload can legitimately be in progress, so every temp file is a
  // leftover from a crash or interrupted transfer. Remove them all so repeated crashes cannot fill the disk.
  let removed = 0;
  for (const name of fs.readdirSync(env.tmpDir)) {
    try { fs.unlinkSync(path.join(env.tmpDir, name)); removed += 1; } catch (_) { /* ignore */ }
  }
  if (removed) console.warn(`Removed ${removed} leftover partial upload(s) from a previous run`);
}

async function main() {
  prepareStorage();
  await prisma.$queryRaw`SELECT 1`; // fail fast if PostgreSQL is unreachable
  const server = app.listen(env.port, '0.0.0.0', () => console.log(`UAV backend listening on :${env.port}`));
  // Large log uploads over slow Wi-Fi: do not time out the socket aggressively.
  server.requestTimeout = 0;
  server.headersTimeout = 65000;
  const shutdown = () => server.close(() => prisma.$disconnect().finally(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
