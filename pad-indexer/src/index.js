import { CFG } from './config.js';
import './db.js';
import { backfillAndTail } from './sync.js';
import { startApi } from './api.js';

async function main() {
  if (!CFG.backfillOnly) startApi();
  await backfillAndTail();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
