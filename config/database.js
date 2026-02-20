const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'learn.db'));

// Enable WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'student',
        created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS courses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        description TEXT,
        thumbnail TEXT,
        published INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lessons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        description TEXT,
        video_url TEXT,
        duration INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        content TEXT,
        created_at DATETIME DEFAULT (datetime('now')),
        FOREIGN KEY (course_id) REFERENCES courses(id)
    );

    CREATE TABLE IF NOT EXISTS progress (
        user_id INTEGER NOT NULL,
        lesson_id INTEGER NOT NULL,
        completed INTEGER DEFAULT 0,
        video_time REAL DEFAULT 0,
        updated_at DATETIME DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, lesson_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (lesson_id) REFERENCES lessons(id)
    );
`);

// Seed admin user if none exists
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
if (userCount === 0) {
    db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)')
        .run('Pete Devine', 'pete@amorphic.cloud', 'amorphic2026', 'admin');
    db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)')
        .run('John Esaki', 'esakij21@gmail.com', '7gen7gen', 'student');
    console.log('Seeded default users');
}

module.exports = db;
