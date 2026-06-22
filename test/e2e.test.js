const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
  console.log('=== E2E Test: sqlite-cdc ===\n');

  console.log('Step 1: Creating test database...');
  execSync('node ' + path.join(__dirname, 'setup.js'), { stdio: 'inherit' });

  console.log('\nStep 2: Starting sqlite-cdc with --before...');
  const { spawn } = require('child_process');
  const cdc = spawn('node', [path.join(__dirname, '..', 'dist', 'cli.js'), DB_PATH, '-v', '--before'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const events = [];
  cdc.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n').filter(Boolean);
    for (const line of lines) {
      events.push(line);
      console.log('  EVENT:', line);
    }
  });

  cdc.stderr.on('data', (data) => {
    process.stderr.write('  [cdc-err] ' + data.toString());
  });

  await sleep(1500);

  console.log('\nStep 3: INSERT a new user...');
  await writeDb(db => {
    db.run("INSERT INTO users (name, email) VALUES ('Charlie', 'charlie@example.com')");
  });
  await sleep(1500);

  console.log('\nStep 4: UPDATE a user...');
  await writeDb(db => {
    db.run("UPDATE users SET email = 'alice_new@example.com' WHERE name = 'Alice'");
  });
  await sleep(1500);

  console.log('\nStep 5: DELETE a user...');
  await writeDb(db => {
    db.run("DELETE FROM users WHERE name = 'Bob'");
  });
  await sleep(1500);

  console.log('\nStep 6: INSERT into products...');
  await writeDb(db => {
    db.run("INSERT INTO products (name, price) VALUES ('Doohickey', 4.99)");
  });
  await sleep(1500);

  cdc.kill('SIGTERM');
  await sleep(500);

  console.log('\n=== Results ===');
  console.log(`Total events captured: ${events.length}`);

  let inserts = 0, updates = 0, deletes = 0;
  let deleteWithBefore = false;
  let updateWithBeforeAndAfter = false;
  let insertWithAfter = false;
  const parsedEvents = [];

  for (const e of events) {
    try {
      const obj = JSON.parse(e);
      parsedEvents.push(obj);
      if (obj.operation === 'INSERT') {
        inserts++;
        if (obj.after) insertWithAfter = true;
      }
      else if (obj.operation === 'UPDATE') {
        updates++;
        if (obj.before && obj.after) updateWithBeforeAndAfter = true;
      }
      else if (obj.operation === 'DELETE') {
        deletes++;
        if (obj.before) deleteWithBefore = true;
      }
    } catch {}
  }
  console.log(`INSERTs: ${inserts}, UPDATEs: ${updates}, DELETEs: ${deletes}`);
  console.log(`INSERT has after: ${insertWithAfter}`);
  console.log(`UPDATE has before+after: ${updateWithBeforeAndAfter}`);
  console.log(`DELETE has before: ${deleteWithBefore}`);

  let failed = false;

  if (inserts < 2 || updates < 1 || deletes < 1) {
    console.log('\n❌ Not all operation types detected');
    failed = true;
  }

  if (!insertWithAfter) {
    console.log('\n❌ INSERT event missing "after" field');
    failed = true;
  }

  if (!updateWithBeforeAndAfter) {
    console.log('\n❌ UPDATE event missing "before" and/or "after" field');
    failed = true;
  }

  if (!deleteWithBefore) {
    console.log('\n❌ DELETE event missing "before" field - the original bug!');
    failed = true;
  }

  const deleteEvent = parsedEvents.find(e => e.operation === 'DELETE');
  if (deleteEvent && deleteEvent.before) {
    if (deleteEvent.before.name !== 'Bob') {
      console.log(`\n❌ DELETE before.name expected "Bob", got "${deleteEvent.before.name}"`);
      failed = true;
    } else {
      console.log(`\n✅ DELETE before.name = "Bob" (correct)`);
    }
  }

  if (failed) {
    console.log('\n❌ E2E test FAILED');
    console.log('Parsed events:', JSON.stringify(parsedEvents, null, 2));
    process.exit(1);
  } else {
    console.log('\n✅ E2E test PASSED - all operation types + before/after data verified!');
  }

  try { fs.unlinkSync(DB_PATH); } catch {}
  try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
