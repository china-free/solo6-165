const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function main() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)');
  db.run('CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL)');

  db.run("INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')");
  db.run("INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')");
  db.run("INSERT INTO products (name, price) VALUES ('Widget', 9.99)");
  db.run("INSERT INTO products (name, price) VALUES ('Gadget', 24.99)");

  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(path.join(__dirname, 'test.db'), buffer);
  db.close();
  console.log('Test database created: test/test.db');
}

main().catch(console.error);
