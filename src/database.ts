import { Database } from "bun:sqlite";

export const db = new Database("bot_data.sqlite", { create: true });

// Initialize database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    first_name TEXT,
    chat_id INTEGER UNIQUE NOT NULL,
    first_seen TEXT NOT NULL,
    last_activity TEXT NOT NULL,
    download_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    platform TEXT NOT NULL,
    media_type TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    error_context TEXT NOT NULL,
    error_message TEXT NOT NULL,
    original_message TEXT,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )
`);

// Create indexes for better performance
db.exec("CREATE INDEX IF NOT EXISTS idx_users_chat_id ON users (chat_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_downloads_user_id ON downloads (user_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_errors_user_id ON errors (user_id)");

// Database helper functions
export const upsertUser = (chatId: number, username?: string, firstName?: string): number => {
  const now = new Date().toISOString();

  // Check if user exists
  const existingUser = db.query("SELECT id FROM users WHERE chat_id = ?").get(chatId) as { id: number } | undefined;
  if (existingUser?.id) {
    // Update existing user
    db.query(`
      UPDATE users 
      SET username = ?, first_name = ?, last_activity = ?
      WHERE chat_id = ?
    `).run(username || null, firstName || null, now, chatId);
    return existingUser.id;
  }
  else {
    // Insert new user
    const result = db.query(`
      INSERT INTO users (username, first_name, chat_id, first_seen, last_activity)
      VALUES (?, ?, ?, ?, ?)
    `).run(username || null, firstName || null, chatId, now, now);
    return result.lastInsertRowid as number;
  }
};

export const recordDownload = (chatId: number, url: string, platform: string, mediaType: string, success: boolean, username?: string, firstName?: string) => {
  const userId = upsertUser(chatId, username, firstName);
  const now = new Date().toISOString();

  db.query(`
    INSERT INTO downloads (user_id, url, platform, media_type, success, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, url, platform, mediaType, success, now);

  // Update user download count if successful
  if (success) {
    db.query("UPDATE users SET download_count = download_count + 1 WHERE id = ?").run(userId);
  }
};

export const recordError = (chatId: number, errorContext: string, errorMessage: string, originalMessage?: string, username?: string, firstName?: string) => {
  const userId = upsertUser(chatId, username, firstName);
  const now = new Date().toISOString();

  db.query(`
    INSERT INTO errors (user_id, error_context, error_message, original_message, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, errorContext, errorMessage, originalMessage || null, now);

  // Update user error count
  db.query("UPDATE users SET error_count = error_count + 1 WHERE id = ?").run(userId);
};

export const updateUserActivity = (chatId: number) => {
  const now = new Date().toISOString();
  db.query("UPDATE users SET last_activity = ? WHERE chat_id = ?").run(now, chatId);
};

export const detectPlatform = (url: string): string => {
  if (url.includes("tiktok.com")) return "tiktok";
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("facebook.com") || url.includes("fb.com")) return "facebook";
  if (url.includes("twitter.com") || url.includes("x.com")) return "twitter";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  return "unknown";
};

// Admin query functions
export const getUsers = (limit: number) => {
  return db.query("SELECT * FROM users ORDER BY download_count DESC, last_activity DESC LIMIT ?").all(limit) as any[];
};

export const getStats = () => {
  const totalUsers = db.query("SELECT COUNT(*) as count FROM users").get() as { count: number };
  const totalDownloads = db.query("SELECT COUNT(*) as count FROM downloads WHERE success = 1").get() as { count: number };
  const totalErrors = db.query("SELECT COUNT(*) as count FROM errors").get() as { count: number };
  const activeUsers24h = db.query(`
    SELECT COUNT(*) as count FROM users 
    WHERE datetime(last_activity) > datetime('now', '-24 hours')
  `).get() as { count: number };

  return {
    totalUsers: totalUsers.count,
    totalDownloads: totalDownloads.count,
    totalErrors: totalErrors.count,
    activeUsers24h: activeUsers24h.count
  };
};

export const getTopUsers = (limit: number) => {
  return db.query(`
    SELECT * FROM users 
    WHERE download_count > 0
    ORDER BY download_count DESC 
    LIMIT ?
  `).all(limit) as any[];
};

export const getRecentErrors = (limit: number) => {
  return db.query(`
    SELECT 
      e.*,
      u.username,
      u.first_name,
      u.chat_id
    FROM errors e
    JOIN users u ON e.user_id = u.id
    ORDER BY e.timestamp DESC
    LIMIT ?
  `).all(limit) as any[];
};

export const getPlatformStats = () => {
  return db.query(`
    SELECT 
      platform,
      COUNT(*) as total_requests,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_downloads,
      ROUND(
        (SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*)), 2
      ) as success_rate
    FROM downloads 
    GROUP BY platform 
    ORDER BY total_requests DESC
  `).all() as any[];
};

// Utility function to split long messages for Telegram
export const splitMessage = (text: string, maxLength: number = 4096): string[] => {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let currentChunk = "";
  const lines = text.split("\n");

  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = line;
      }
      else {
        // Single line is too long, split it
        chunks.push(line.substring(0, maxLength));
        currentChunk = line.substring(maxLength);
      }
    }
    else {
      currentChunk += (currentChunk ? "\n" : "") + line;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
};

// Graceful shutdown handler
export const closeDatabase = () => {
  db.close();
};
