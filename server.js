 express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcrypt');
const session = require('express-session');

const upload = multer({ dest: 'uploads/' });

const app = express();
const port = process.env.PORT || 3000;
const dbFile = process.env.DB_PATH || path.join(__dirname, 'mapdata.db');

// Load server settings for admin list
let serverSettings = { Admins: [] };
try {
  const settingsPath = path.join(__dirname, 'ServerSettings.json');
  serverSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  console.log('Loaded ServerSettings.json, Admins:', serverSettings.Admins);
} catch (err) {
  console.warn('Could not load ServerSettings.json for admin list:', err.message);
}

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

  // Create users table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Add claim tracking columns to users table
  db.all(`PRAGMA table_info(users)`, (err, cols) => {
    if (err) return;
    const names = cols.map(c => c.name);
    if (!names.includes('daily_claim_limit')) {
      db.run(`ALTER TABLE users ADD COLUMN daily_claim_limit INTEGER`, (err2) => {
        if (!err2) console.log('Added daily_claim_limit column to users');
      });
    }
    if (!names.includes('claims_used_today')) {
      db.run(`ALTER TABLE users ADD COLUMN claims_used_today INTEGER DEFAULT 0`, (err2) => {
        if (!err2) console.log('Added claims_used_today column to users');
      });
    }
    if (!names.includes('last_claim_date')) {
      db.run(`ALTER TABLE users ADD COLUMN last_claim_date TEXT`, (err2) => {
        if (!err2) console.log('Added last_claim_date column to users');
      });
    }
  });

  // Add user_id to claims table
  db.all(`PRAGMA table_info(claims)`, (err, cols) => {
    if (err) return;
    const names = cols.map(c => c.name);
    if (!names.includes('user_id')) {
      db.run(`ALTER TABLE claims ADD COLUMN user_id INTEGER`, (err2) => {
        if (!err2) console.log('Added user_id column to claims');
      });
    }
    if (!names.includes('player')) {
      db.run(`ALTER TABLE claims ADD COLUMN player TEXT`, (err2) => {
        if (!err2) console.log('Added player column to claims');
      });
    }
  });
});

// Session middleware
app.use(session({
  secret: 'tem-claim-map-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // set to true if using HTTPS
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

app.use(express.json());

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({ error: 'Authentication required' });
}

// Admin middleware
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const isAdmin = serverSettings.Admins && serverSettings.Admins.includes(req.session.username);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}

// Register endpoint
app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  if (username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Username must be 3+ chars, password 6+ chars' });
  }
  
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    
    db.run(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username, passwordHash],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'Username already exists' });
          }
          console.error('Registration error:', err);
          return res.status(500).json({ error: 'Registration failed' });
        }
        
        req.session.userId = this.lastID;
        req.session.username = username;
        res.json({ ok: true, username });
      }
    );
  } catch (err) {
    console.error('Hash error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login endpoint
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  db.get(
    'SELECT id, username, password_hash FROM users WHERE username = ?',
    [username],
    async (err, user) => {
      if (err) {
        console.error('Login error:', err);
        return res.status(500).json({ error: 'Login failed' });
      }
      
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      try {
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
          return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        req.session.userId = user.id;
        req.session.username = user.username;
        res.json({ ok: true, username: user.username });
      } catch (err) {
        console.error('Password compare error:', err);
        res.status(500).json({ error: 'Login failed' });
      }
    }
  );
});

// Logout endpoint
app.post('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ ok: true });
  });
});

// Check session endpoint
app.get('/auth/me', (req, res) => {
  if (req.session && req.session.userId) {
    const isAdmin = serverSettings.Admins && serverSettings.Admins.includes(req.session.username);
    
    // Get user's claim info
    db.get(
      'SELECT daily_claim_limit, claims_used_today, last_claim_date FROM users WHERE id = ?',
      [req.session.userId],
      (err, user) => {
        if (err) {
          console.error('Error fetching user claim info:', err);
          return res.json({ 
            authenticated: true, 
            username: req.session.username,
            isAdmin: isAdmin
          });
        }
        
        const today = new Date().toISOString().split('T')[0];
        let claimsUsed = user?.claims_used_today || 0;
        const lastClaimDate = user?.last_claim_date;
        
        // Reset if it's a new day
        if (lastClaimDate !== today) {
          claimsUsed = 0;
        }
        
        const limit = user?.daily_claim_limit || serverSettings.defaultDailyClaimLimit || 10;
        
        return res.json({ 
          authenticated: true, 
          username: req.session.username,
          isAdmin: isAdmin,
          claimsUsedToday: claimsUsed,
          dailyClaimLimit: isAdmin ? -1 : limit, // -1 means unlimited for admins
          claimsRemaining: isAdmin ? -1 : Math.max(0, limit - claimsUsed)
        });
      }
    );
  } else {
    res.json({ authenticated: false, isAdmin: false });
  }
});

// Helper function to check and update claim usage
function checkAndUpdateClaimUsage(userId, claimCount, callback) {
  const today = new Date().toISOString().split('T')[0];
  
  db.get(
    'SELECT username, daily_claim_limit, claims_used_today, last_claim_date FROM users WHERE id = ?',
    [userId],
    (err, user) => {
      if (err) return callback(err, null);
      if (!user) return callback(new Error('User not found'), null);
      
      // Check if user is admin (unlimited claims)
      const isAdmin = serverSettings.Admins && serverSettings.Admins.includes(user.username);
      if (isAdmin) {
        // Admins have unlimited claims, just update the date
        db.run(
          'UPDATE users SET last_claim_date = ? WHERE id = ?',
          [today, userId],
          (err) => callback(err, { allowed: true })
        );
        return;
      }
      
      let claimsUsed = user.claims_used_today || 0;
      const lastClaimDate = user.last_claim_date;
      const limit = user.daily_claim_limit || serverSettings.defaultDailyClaimLimit || 10;
      
      // Reset if it's a new day
      if (lastClaimDate !== today) {
        claimsUsed = 0;
      }
      
      // Check if user has enough claims left
      if (claimsUsed + claimCount > limit) {
        return callback(null, { 
          allowed: false, 
          remaining: Math.max(0, limit - claimsUsed),
          limit: limit
        });
      }
      
      // Update claim usage
      db.run(
        'UPDATE users SET claims_used_today = ?, last_claim_date = ? WHERE id = ?',
        [claimsUsed + claimCount, today, userId],
        (err) => {
          if (err) return callback(err, null);
          callback(null, { 
            allowed: true, 
            newUsage: claimsUsed + claimCount,
            remaining: limit - (claimsUsed + claimCount)
          });
        }
      );
    }
  );
}

// API: create claims (bulk)
app.post('/claims', requireAuth, (req, res) => {
  const { claims } = req.body || {};
  if (!Array.isArray(claims) || claims.length === 0) {
    return res.status(400).json({ error: 'No claims provided' });
  }

  // Check claim limit
  checkAndUpdateClaimUsage(req.session.userId, claims.length, (err, result) => {
    if (err) {
      console.error('Error checking claim usage:', err);
      return res.status(500).json({ error: 'Failed to check claim limit' });
    }
    
    if (!result.allowed) {
      return res.status(403).json({ 
        error: 'Daily claim limit exceeded',
        remaining: result.remaining,
        limit: result.limit
      });
    }

    // Proceed with inserting claims
    db.serialize(() => {
      const stmt = db.prepare('INSERT INTO claims (x, y, date, team, color, user_id, player) VALUES (?, ?, ?, ?, ?, ?, ?)');
      db.run('BEGIN TRANSACTION');
      for (const c of claims) {
        stmt.run(c.imgX, c.imgY, c.date, c.team || null, c.color || null, req.session.userId, req.session.username);
      }
      db.run('COMMIT');
      stmt.finalize((err) => {
        if (err) {
          console.error('Insert error', err);
          return res.status(500).json({ error: 'DB insert failed' });
        }
        return res.json({ 
          ok: true, 
          inserted: claims.length,
          claimsRemaining: result.remaining
        });
      });
    });
  });
});

// API: clear all claims (admin only)
app.delete('/claims', requireAdmin, (req, res) => {
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

// API: Get all users with their claim limits (admin only)
app.get('/admin/users', requireAdmin, (req, res) => {
  db.all(
    'SELECT id, username, daily_claim_limit, claims_used_today, last_claim_date, created_at FROM users ORDER BY username',
    (err, users) => {
      if (err) {
        console.error('Failed to fetch users:', err);
        return res.status(500).json({ error: 'Failed to fetch users' });
      }
      
      const today = new Date().toISOString().split('T')[0];
      const defaultLimit = serverSettings.defaultDailyClaimLimit || 10;
      
      const usersWithInfo = users.map(u => {
        const isAdmin = serverSettings.Admins && serverSettings.Admins.includes(u.username);
        const limit = u.daily_claim_limit || defaultLimit;
        let claimsUsed = u.claims_used_today || 0;
        
        // Reset if it's a new day
        if (u.last_claim_date !== today) {
          claimsUsed = 0;
        }
        
        return {
          id: u.id,
          username: u.username,
          isAdmin: isAdmin,
          dailyClaimLimit: limit,
          claimsUsedToday: claimsUsed,
          claimsRemaining: isAdmin ? -1 : Math.max(0, limit - claimsUsed)
        };
      });
      
      res.json({ users: usersWithInfo });
    }
  );
});

// API: Update user claim limit (admin only)
app.post('/admin/users/:userId/claim-limit', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.userId);
  const { dailyClaimLimit } = req.body;
  
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
  
  if (!Number.isInteger(dailyClaimLimit) || dailyClaimLimit < 0) {
    return res.status(400).json({ error: 'Invalid claim limit. Must be a non-negative integer.' });
  }
  
  db.run(
    'UPDATE users SET daily_claim_limit = ? WHERE id = ?',
    [dailyClaimLimit, userId],
    function(err) {
      if (err) {
        console.error('Failed to update claim limit:', err);
        return res.status(500).json({ error: 'Failed to update claim limit' });
      }
      
      if (this.changes === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      res.json({ ok: true, userId, dailyClaimLimit });
    }
  );
});

// API: Clear all claims for a user from today (admin only)
app.post('/admin/users/:userId/clear-today', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.userId);
  
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
  
  const today = new Date().toISOString().split('T')[0];
  
  // Get user info first
  db.get(
    'SELECT username FROM users WHERE id = ?',
    [userId],
    (err, user) => {
      if (err) {
        console.error('Failed to fetch user:', err);
        return res.status(500).json({ error: 'Failed to fetch user' });
      }
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      // Get all claims from today for this user
      db.all(
        'SELECT id FROM claims WHERE user_id = ? AND date LIKE ?',
        [userId, today + '%'],
        (err, claims) => {
          if (err) {
            console.error('Failed to fetch claims:', err);
            return res.status(500).json({ error: 'Failed to fetch claims' });
          }
          
          if (claims.length === 0) {
            return res.json({ ok: true, deleted: 0, message: 'No claims found for today' });
          }
          
          // Delete the claims
          db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            const stmt = db.prepare('DELETE FROM claims WHERE id = ?');
            claims.forEach(c => stmt.run(c.id));
            db.run('COMMIT', (err) => {
              stmt.finalize();
              if (err) {
                console.error('Failed to delete claims:', err);
                return res.status(500).json({ error: 'Failed to delete claims' });
              }
              
              // Refund the claims by resetting claims_used_today to 0
              db.run(
                'UPDATE users SET claims_used_today = 0 WHERE id = ? AND last_claim_date = ?',
                [userId, today],
                (err) => {
                  if (err) {
                    console.error('Failed to refund claims:', err);
                    return res.json({ 
                      ok: true, 
                      deleted: claims.length,
                      refunded: false,
                      message: 'Claims deleted but refund failed'
                    });
                  }
                  
                  res.json({ 
                    ok: true, 
                    deleted: claims.length,
                    refunded: true,
                    username: user.username
                  });
                }
              );
            });
          });
        }
      );
    }
  );
});

// API: Search/filter claims (admin only)
app.post('/admin/claims/search', requireAdmin, (req, res) => {
  const { player, team, date, limit = 1000 } = req.body || {};
  
  let query = 'SELECT id, x, y, date, team, color, player, user_id FROM claims WHERE 1=1';
  const params = [];
  
  if (player) {
    query += ' AND player LIKE ?';
    params.push(`%${player}%`);
  }
  
  if (team) {
    query += ' AND team LIKE ?';
    params.push(`%${team}%`);
  }
  
  if (date) {
    query += ' AND date LIKE ?';
    params.push(`${date}%`);
  }
  
  query += ' ORDER BY date DESC LIMIT ?';
  params.push(limit);
  
  db.all(query, params, (err, claims) => {
    if (err) {
      console.error('Failed to search claims:', err);
      return res.status(500).json({ error: 'Failed to search claims' });
    }
    
    res.json({ claims: claims || [], count: claims?.length || 0 });
  });
});

app.post('/claims/delete', requireAuth, (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
  
  const clean = ids.map(i => parseInt(i)).filter(n => Number.isInteger(n));
  if (clean.length === 0) return res.status(400).json({ error: 'No valid ids provided' });

  const isAdmin = serverSettings.Admins && serverSettings.Admins.includes(req.session.username);
  const today = new Date().toISOString().split('T')[0];

  // First, verify ownership and get claim info
  db.all(
    `SELECT id, user_id, player FROM claims WHERE id IN (${clean.map(() => '?').join(',')})`,
    clean,
    (err, claims) => {
      if (err) {
        console.error('Failed to fetch claims for deletion:', err);
        return res.status(500).json({ error: 'DB query failed' });
      }

      // Filter claims based on ownership (unless admin)
      const allowedIds = [];
      const deniedIds = [];
      
      for (const claim of claims) {
        if (isAdmin || claim.user_id === req.session.userId) {
          allowedIds.push(claim.id);
        } else {
          deniedIds.push(claim.id);
        }
      }

      if (allowedIds.length === 0) {
        return res.status(403).json({ 
          error: 'You can only delete your own claims',
          denied: deniedIds.length
        });
      }

      // Delete allowed claims
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        const stmt = db.prepare('DELETE FROM claims WHERE id = ?');
        for (const id of allowedIds) stmt.run(id);
        db.run('COMMIT', (err) => {
          stmt.finalize();
          if (err) {
            console.error('Failed to delete claims', err);
            return res.status(500).json({ error: 'DB delete failed' });
          }

          // Return claims to the user (decrement claims_used_today)
          if (!isAdmin && allowedIds.length > 0) {
            db.get(
              'SELECT claims_used_today, last_claim_date FROM users WHERE id = ?',
              [req.session.userId],
              (err, user) => {
                if (err || !user) {
                  console.error('Failed to fetch user for claim return:', err);
                  return res.json({ 
                    ok: true, 
                    deleted: allowedIds.length,
                    denied: deniedIds.length 
                  });
                }

                let claimsUsed = user.claims_used_today || 0;
                // Only decrement if it's the same day
                if (user.last_claim_date === today) {
                  // Give back 2 claims for each claim removed
                  claimsUsed = Math.max(0, claimsUsed - (allowedIds.length * 2));
                  
                  db.run(
                    'UPDATE users SET claims_used_today = ? WHERE id = ?',
                    [claimsUsed, req.session.userId],
                    (err) => {
                      if (err) console.error('Failed to update claims_used_today:', err);
                      return res.json({ 
                        ok: true, 
                        deleted: allowedIds.length,
                        denied: deniedIds.length,
                        claimsReturned: allowedIds.length * 2
                      });
                    }
                  );
                } else {
                  return res.json({ 
                    ok: true, 
                    deleted: allowedIds.length,
                    denied: deniedIds.length,
                    claimsReturned: 0
                  });
                }
              }
            );
          } else {
            return res.json({ 
              ok: true, 
              deleted: allowedIds.length,
              denied: deniedIds.length
            });
          }
        });
      });
    }
  );
});

// API: upload map PNG (admin only)
app.post('/upload-map', requireAdmin, upload.single('mapImage'), async (req, res) => {
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

// Serve static files (your site) - MUST come after API routes
app.use(express.static(path.join(__dirname)));

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
