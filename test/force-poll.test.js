const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

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
  console.log('=== Test: --force-poll fallback mode ===\n');

  execSync('node ' + path.join(__dirname, 'setup.js'), { stdio: 'inherit' });

  const cdc = spawn('node', [
    path.join(__dirname, '..', 'dist', 'cli.js'),
    DB_PATH,
    '-v',
    '--force-poll',
    '--before',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const events = [];
  cdc.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n').filter(Boolean);
    for (const line of lines) {
      events.push(line);
      console.log('  EVENT:', line);
    }
  });

  cdc.stderr.on('data', (data) => {
    const str = data.toString();
    if (str.includes('Polling interval') || str.includes('polling fallback')) {
      process.stderr.write('  ✅ ' + str);
    }
  });

  await sleep(1200);

  console.log('\n[test] INSERT:');
  await writeDb(db => {
    db.run("INSERT INTO users (name, email) VALUES ('Diana', 'diana@test.com')");
  });
  await sleep(1200);

  console.log('\n[test] UPDATE:');
  await writeDb(db => {
    db.run("UPDATE users SET email = 'alice_v2@test.com' WHERE name = 'Alice'");
  });
  await sleep(1200);

  console.log('\n[test] DELETE:');
  await writeDb(db => {
    db.run("DELETE FROM users WHERE name = 'Bob'");
  });
  await sleep(1200);

  cdc.kill();
  await sleep(300);

  console.log('\n=== Results ===');
  console.log(`Events: ${events.length}`);

  let inserts = 0, updates = 0, deletes = 0;
  for (const e of events) {
    try {
      const obj = JSON.parse(e);
      if (obj.operation === 'INSERT') inserts++;
      else if (obj.operation === 'UPDATE') updates++;
      else if (obj.operation === 'DELETE') deletes++;
    } catch {}
  }

  if (inserts >= 1 && updates >= 1 && deletes >= 1) {
    console.log('✅ Force-poll mode works correctly');
  } else {
    console.log('❌ Force-poll mode failed');
    console.log(`Expected >=1 each, got INSERT=${inserts}, UPDATE=${updates}, DELETE=${deletes}`);
    process.exit(1);
  }

  try { fs.unlinkSync(DB_PATH); } catch {}
  console.log('\n✅ All tests passed!');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
