 express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const upload = multer({ dest: 'uploads/' });

const app = express();
const port = process.env.PORT || 3000;
const dbFile = process.env.DB_PATH || path.join(__dirname, 'mapdata.db');

// Ensure the directory exists for the database file
const dbDir = path.dirname(dbFile);

try {
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  fs.accessSync(dbDir, fs.constants.W_OK);
  console.log('Database directory ready:', dbDir);
} catch (err) {
  console.error('Cannot write to database directory:', dbDir, err);
  console.error('Please ensure the directory exists and has write permissions');
  process.exit(1);
}

const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error('Failed to open database:', dbFile, err);
    process.exit(1);
  }
  console.log('Database opened:', dbFile);
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

  db.all(`PRAGMA table_info(claims)`, (err, cols) => {
    if (err) return;
    const names = cols.map(c => c.name);
    if (!names.includes('color')) {
      db.run(`ALTER TABLE claims ADD COLUMN color TEXT`, (err2) => {
        if (!err2) console.log('Added color column to database');
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
    return res.status(403).json({ error: 'Forbidden: Only host can clear database' });
  }
  
  const { password } = req.body || {};
  if (password !== 'password') {
    return res.status(401).json({ error: 'Invalid password' });
  }
  
  db.run('DELETE FROM claims', function(err) {
    if (err) {
      console.error('Failed to clear claims', err);
      return res.status(500).json({ error: 'DB delete failed' });
    }
    db.run('VACUUM', (vErr) => {
      res.json({ ok: true, deleted: this.changes || 0 });
    });
  });
});

app.post('/claims/delete', (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
  
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

// API: upload map PNG (password protected)
app.post('/upload-map', upload.single('mapImage'), async (req, res) => {
  const { password } = req.body || {};
  if (password !== 'password') {
    if (req.file) fs.unlinkSync(req.file.path); // clean up uploaded file
    return res.status(401).json({ error: 'Invalid password' });
  }
  
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  if (!req.file.mimetype.startsWith('image/')) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'File must be an image' });
  }
  
  try {
    // Read ServerSettings.json to get the current map path
    const settingsPath = path.join(__dirname, 'ServerSettings.json');
    const settingsData = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const mapPath = path.join(__dirname, settingsData.mapImage);
    
    // Backup the old map
    const backupPath = mapPath + '.backup';
    if (fs.existsSync(mapPath)) {
      fs.copyFileSync(mapPath, backupPath);
    }
    
    // Move uploaded file to replace the map
    fs.copyFileSync(req.file.path, mapPath);
    fs.unlinkSync(req.file.path);
    
    res.json({ ok: true, message: 'Map uploaded successfully' });
  } catch (err) {
    console.error('Failed to upload map', err);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to upload map: ' + err.message });
  }
});

// API: list claims
app.get('/claims', (req, res) => {
  db.all('SELECT * FROM claims ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB read failed' });
    res.json({ claims: rows });
  });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
