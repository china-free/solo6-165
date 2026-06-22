const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DB_PATH = path.join(__dirname, 'test.db');

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function writeDb(mutator) {
  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buffer);
  mutator(db);
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  db.close();
}

async function main() {
  const setupPath = path.join(__dirname, 'setup.js');
  const { execSync } = require('child_process');
  execSync('node ' + setupPath, { stdio: 'inherit' });

  console.log('\n--- Testing pretty format output ---\n');

  const cdc = spawn('node', [
    path.join(__dirname, '..', 'dist', 'cli.js'),
    DB_PATH,
    '-f', 'pretty',
    '--before',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  cdc.stdout.on('data', (data) => {
    process.stdout.write('  ' + data.toString());
  });
  cdc.stderr.on('data', (data) => {
    process.stderr.write('  [err] ' + data.toString());
  });

  await sleep(1500);

  console.log('[test] INSERT Charlie:');
  await writeDb(db => {
    db.run("INSERT INTO users (name, email) VALUES ('Charlie', 'charlie@example.com')");
  });
  await sleep(800);

  console.log('[test] UPDATE Alice:');
  await writeDb(db => {
    db.run("UPDATE users SET email = 'alice_v2@test.com' WHERE name = 'Alice'");
  });
  await sleep(800);

  console.log('[test] DELETE Bob:');
  await writeDb(db => {
    db.run("DELETE FROM users WHERE name = 'Bob'");
  });
  await sleep(800);

  cdc.kill();
  await sleep(300);

  try { fs.unlinkSync(DB_PATH); } catch {}
  console.log('\n--- Pretty format test complete ---');
}

main().catch(console.error);
