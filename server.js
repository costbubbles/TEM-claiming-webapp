 express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;
const dbFile = process.env.DB_PATH || path.join(__dirname, 'mapdata.db');

// Ensure the directory exists for the database file
const dbDir = path.dirname(dbFile);
console.log('Database file path:', dbFile);
console.log('Database directory:', dbDir);

try {
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log('Created database directory:', dbDir);
  }
  
  // Test if directory is writable
  fs.accessSync(dbDir, fs.constants.W_OK);
  console.log('Database directory is writable');
} catch (err) {
  console.error('Cannot write to database directory:', dbDir, err);
  console.error('Please ensure the directory exists and has write permissions');
  process.exit(1);
}

// open (or create) the DB
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error('Failed to open DB', err);
    console.error('DB file path:', dbFile);
    console.error('Current working directory:', process.cwd());
    console.error('__dirname:', __dirname);
    process.exit(1);
  }
  console.log('Opened DB', dbFile);
});

// ensure table exists and perform lightweight migrations if necessary
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    x REAL NOT NULL,
    y REAL NOT NULL,
    date TEXT NOT NULL,
    team TEXT,
    color TEXT
  )`);

  // check whether the 'color' column exists; if not, add it (handles older DBs)
  db.all(`PRAGMA table_info(claims)`, (err, cols) => {
    if (err) {
      console.error('Failed to read table info for migrations', err);
      return;
    }
    const names = cols.map(c => c.name);
    if (!names.includes('color')) {
      console.log("Migrating DB: adding 'color' column to claims table");
      db.run(`ALTER TABLE claims ADD COLUMN color TEXT`, (err2) => {
        if (err2) console.error('Failed to add color column', err2);
        else console.log("Added 'color' column to claims table");
      });
    }
  });
});

app.use(express.json());
// serve static files (your site)
app.use(express.static(path.join(__dirname)));

// API: create claims (bulk)
app.post('/claims', (req, res) => {
  const { claims } = req.body || {};
  if (!Array.isArray(claims) || claims.length === 0) {
    return res.status(400).json({ error: 'No claims provided' });
  }

  db.serialize(() => {
    const stmt = db.prepare('INSERT INTO claims (x, y, date, team, color) VALUES (?, ?, ?, ?, ?)');
    db.run('BEGIN TRANSACTION');
    for (const c of claims) {
      stmt.run(c.imgX, c.imgY, c.date, c.team || null, c.color || null);
    }
    db.run('COMMIT');
    stmt.finalize((err) => {
      if (err) {
        console.error('Insert error', err);
        return res.status(500).json({ error: 'DB insert failed' });
      }
      return res.json({ ok: true, inserted: claims.length });
    });
  });
});

// API: clear all claims (debug endpoint) — DELETE /claims (localhost only with password)
app.delete('/claims', (req, res) => {
  // Check if request is from localhost/host IP
  const clientIp = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
  const isLocalhost = clientIp === '127.0.0.1' || 
                      clientIp === '::1' || 
                      clientIp === '::ffff:127.0.0.1' ||
                      clientIp === 'localhost';
  
  if (!isLocalhost) {
    console.log('Unauthorized clear DB attempt from:', clientIp);
    return res.status(403).json({ error: 'Forbidden: Only host can clear database' });
  }
  
  // Check password
  const { password } = req.body || {};
  if (password !== 'password') {
    console.log('Invalid password for clear DB from:', clientIp);
    return res.status(401).json({ error: 'Invalid password' });
  }
  
  db.run('DELETE FROM claims', function(err) {
    if (err) {
      console.error('Failed to clear claims', err);
      return res.status(500).json({ error: 'DB delete failed' });
    }
    // optionally run VACUUM to shrink DB
    db.run('VACUUM', (vErr) => {
      if (vErr) console.error('VACUUM failed', vErr);
      res.json({ ok: true, deleted: this.changes || 0 });
    });
  });
});

// API: delete specific claims by id (bulk)
app.post('/claims/delete', (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
  // sanitize IDs to integers
  const clean = ids.map(i => parseInt(i)).filter(n => Number.isInteger(n));
  if (clean.length === 0) return res.status(400).json({ error: 'No valid ids provided' });

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare('DELETE FROM claims WHERE id = ?');
    for (const id of clean) stmt.run(id);
    db.run('COMMIT', (err) => {
      stmt.finalize();
      if (err) {
        console.error('Failed to delete claims', err);
        return res.status(500).json({ error: 'DB delete failed' });
      }
      return res.json({ ok: true, deleted: clean.length });
    });
  });
});

// API: list claims
app.get('/claims', (req, res) => {
  db.all('SELECT * FROM claims ORDER BY id DESC LIMIT 100', (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB read failed' });
    res.json({ claims: rows });
  });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
