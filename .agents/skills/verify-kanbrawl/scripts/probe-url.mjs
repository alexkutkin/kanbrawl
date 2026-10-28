// Runs inside the Playwright sandbox: verifies it can reach a Kanbrawl base URL.
import process from 'node:process';

const url = process.argv[2];
const token = process.argv[3];
if (!url) {
  console.error('usage: node probe-url.mjs <base-url> [token]');
  process.exit(2);
}

try {
  const response = await fetch(`${url}/api/board`, {
    headers: token ? { 'x-kanbrawl-token': token } : {},
    signal: AbortSignal.timeout(5000),
  });
  const board = await response.json();
  const columns = Array.isArray(board.columns)
    ? board.columns.map((column) => column.name).join(', ')
    : '?';
  console.log(`OK ${response.status} ${url} [${columns}]`);
} catch (error) {
  console.error(`FAIL ${url}: ${error.message}`);
  process.exit(1);
}
