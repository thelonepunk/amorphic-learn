/**
 * amorphic learn
 * Training platform for amorphic users
 */

const express = require('express');
const { engine } = require('express-handlebars');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const db = require('./config/database');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3048;

// =============================================================================
// VIDEO RECOMPRESSION
// =============================================================================

/**
 * Recompress uploaded video to H.264 4K, optimised for web streaming.
 * Keeps _orig file, replaces the served file with the compressed version.
 * CRF 23 = good quality for screen recordings with vector graphics.
 * Returns a promise that resolves with the (unchanged) video URL path.
 */
function recompressVideo(filePath) {
    return new Promise((resolve, reject) => {
        const ext = path.extname(filePath);
        const base = filePath.slice(0, -ext.length);
        const origPath = base + '_orig' + ext;
        const tmpPath = base + '_tmp' + ext;  // write to temp, swap when done

        // Rename uploaded file to _orig — serve the original until compression finishes
        fs.copyFile(filePath, origPath, (err) => {
            if (err) return reject(err);

            console.log(`[recompress] Starting: ${path.basename(filePath)}`);
            const args = [
                '-i', origPath,
                '-c:v', 'libx264',
                '-preset', 'slow',        // better compression, worth the wait
                '-crf', '23',              // quality: 18=near-lossless, 23=good, 28=smaller
                '-pix_fmt', 'yuv420p',     // browser compatibility
                '-c:a', 'aac',
                '-b:a', '128k',
                '-movflags', '+faststart', // streaming: moov atom at start
                '-y',                      // overwrite
                tmpPath                    // write to temp file, not the served path
            ];

            execFile('ffmpeg', args, { timeout: 600000 }, (err, stdout, stderr) => {
                if (err) {
                    console.error(`[recompress] FAILED:`, err.message);
                    // Clean up temp file if it exists
                    try { fs.unlinkSync(tmpPath); } catch(e) {}
                    return reject(err);
                }

                // Atomic swap: replace served file with compressed version
                fs.rename(tmpPath, filePath, (err) => {
                    if (err) {
                        console.error(`[recompress] Swap failed:`, err.message);
                        return reject(err);
                    }

                    // Log compression stats
                    try {
                        const origSize = fs.statSync(origPath).size;
                        const compSize = fs.statSync(filePath).size;
                        const ratio = (origSize / compSize).toFixed(1);
                        console.log(`[recompress] Done: ${(origSize/1e6).toFixed(0)}MB → ${(compSize/1e6).toFixed(0)}MB (${ratio}x)`);
                    } catch(e) {}

                    resolve();
                });
            });
        });
    });
}

// Configure multer for video uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/videos/');
    },
    filename: (req, file, cb) => {
        // Generate unique filename while preserving extension
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        // Only allow video files
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed!'), false);
        }
    },
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB limit
    }
});

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
    secret: 'amorphic-learn-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

// Serve video files with range support for streaming
app.get('/videos/:filename', (req, res) => {
    const filePath = path.join(__dirname, 'public', 'videos', req.params.filename);
    
    // Get stats to determine file size
    fs.stat(filePath, (err, stats) => {
        if (err) {
            return res.status(404).send('File not found');
        }

        const range = req.headers.range;
        if (!range) {
            // No range requested, serve entire file
            res.sendFile(filePath);
            return;
        }

        const fileSize = stats.size;
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;
        const headers = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'video/mp4',
        };

        res.writeHead(206, headers);
        const stream = fs.createReadStream(filePath, { start, end });
        stream.pipe(res);
    });
});

app.use(express.static(path.join(__dirname, 'public')));

// Handlebars
app.engine('hbs', engine({
    extname: '.hbs',
    defaultLayout: 'main',
    layoutsDir: path.join(__dirname, 'views/layouts'),
    partialsDir: path.join(__dirname, 'views/partials'),
    helpers: {
        eq: (a, b) => a === b,
        json: (obj) => JSON.stringify(obj),
        duration: (seconds) => {
            if (!seconds) return '';
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            return `${m}:${s.toString().padStart(2, '0')}`;
        },
        progressPercent: (completed, total) => {
            if (!total) return 0;
            return Math.round((completed / total) * 100);
        },
        add: (a, b) => a + b
    }
}));
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

// Auth middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.redirect('/login');
}

function requireAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'admin') return next();
    res.status(403).render('error', { message: 'Admin access required' });
}

// Make user available to all templates
app.use((req, res, next) => {
    res.locals.user = req.session ? req.session.user : null;
    next();
});

// =============================================================================
// AUTH ROUTES
// =============================================================================

app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('login', { layout: 'auth' });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    
    if (!user || user.password !== password) {
        return res.render('login', { layout: 'auth', error: 'Invalid email or password' });
    }
    
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    res.redirect('/');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// =============================================================================
// MAIN ROUTES
// =============================================================================

app.get('/', requireAuth, (req, res) => {
    const courses = db.prepare(`
        SELECT c.*, 
            (SELECT COUNT(*) FROM lessons WHERE course_id = c.id) as lesson_count,
            (SELECT COUNT(*) FROM progress WHERE user_id = ? AND lesson_id IN (SELECT id FROM lessons WHERE course_id = c.id) AND completed = 1) as completed_count
        FROM courses c 
        WHERE c.published = 1 
        ORDER BY c.sort_order, c.id
    `).all(req.session.user.id);
    
    res.render('dashboard', { courses });
});

app.get('/course/:slug', requireAuth, (req, res) => {
    const course = db.prepare('SELECT * FROM courses WHERE slug = ? AND published = 1').get(req.params.slug);
    if (!course) return res.status(404).render('error', { message: 'Course not found' });
    
    const lessons = db.prepare(`
        SELECT l.*, 
            (SELECT completed FROM progress WHERE user_id = ? AND lesson_id = l.id) as completed
        FROM lessons l 
        WHERE l.course_id = ? 
        ORDER BY l.sort_order, l.id
    `).all(req.session.user.id, course.id);
    
    const completedCount = lessons.filter(l => l.completed).length;
    
    res.render('course', { course, lessons, completedCount, totalCount: lessons.length });
});

app.get('/course/:slug/:lessonSlug', requireAuth, (req, res) => {
    const course = db.prepare('SELECT * FROM courses WHERE slug = ?').get(req.params.slug);
    if (!course) return res.status(404).render('error', { message: 'Course not found' });
    
    const lesson = db.prepare('SELECT * FROM lessons WHERE course_id = ? AND slug = ?').get(course.id, req.params.lessonSlug);
    if (!lesson) return res.status(404).render('error', { message: 'Lesson not found' });
    
    const lessons = db.prepare(`
        SELECT l.*, 
            (SELECT completed FROM progress WHERE user_id = ? AND lesson_id = l.id) as completed
        FROM lessons l 
        WHERE l.course_id = ? 
        ORDER BY l.sort_order, l.id
    `).all(req.session.user.id, course.id);
    
    // Find prev/next
    const idx = lessons.findIndex(l => l.id === lesson.id);
    const prev = idx > 0 ? lessons[idx - 1] : null;
    const next = idx < lessons.length - 1 ? lessons[idx + 1] : null;
    
    res.render('lesson', { course, lesson, lessons, prev, next, currentIndex: idx });
});

// =============================================================================
// API ROUTES
// =============================================================================

app.post('/api/progress/:lessonId', requireAuth, (req, res) => {
    const { lessonId } = req.params;
    const { completed } = req.body;
    
    db.prepare(`
        INSERT INTO progress (user_id, lesson_id, completed, updated_at) 
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, lesson_id) DO UPDATE SET completed = ?, updated_at = datetime('now')
    `).run(req.session.user.id, lessonId, completed ? 1 : 0, completed ? 1 : 0);
    
    res.json({ ok: true });
});

app.post('/api/progress/:lessonId/time', requireAuth, (req, res) => {
    const { lessonId } = req.params;
    const { videoTime } = req.body;
    
    db.prepare(`
        INSERT INTO progress (user_id, lesson_id, video_time, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, lesson_id) DO UPDATE SET video_time = ?, updated_at = datetime('now')
    `).run(req.session.user.id, lessonId, videoTime, videoTime);
    
    res.json({ ok: true });
});

// =============================================================================
// ADMIN ROUTES
// =============================================================================

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
    const courses = db.prepare('SELECT * FROM courses ORDER BY sort_order, id').all();
    const lessons = db.prepare('SELECT * FROM lessons ORDER BY course_id, sort_order, id').all();
    const users = db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY id').all();
    
    // Organize lessons by course for the template
    const lessonsByCourse = {};
    lessons.forEach(lesson => {
        if (!lessonsByCourse[lesson.course_id]) {
            lessonsByCourse[lesson.course_id] = [];
        }
        lessonsByCourse[lesson.course_id].push(lesson);
    });
    
    res.render('admin', { courses, lessons: lessonsByCourse, users });
});

app.post('/admin/course', requireAuth, requireAdmin, (req, res) => {
    const { title, slug, description, thumbnail } = req.body;
    db.prepare('INSERT INTO courses (title, slug, description, thumbnail, published, sort_order) VALUES (?, ?, ?, ?, 1, 0)')
        .run(title, slug, description, thumbnail || '');
    res.redirect('/admin');
});

app.post('/admin/lesson', upload.single('video_file'), requireAuth, requireAdmin, async (req, res) => {
    const { course_id, title, slug, description, video_url, duration, sort_order, content } = req.body;
    
    // Determine video URL - either uploaded file or provided URL
    let final_video_url = video_url;
    if (req.file) {
        final_video_url = `/videos/${req.file.filename}`;
        // Recompress in background — don't block the response
        const fullPath = path.join(__dirname, 'public', 'videos', req.file.filename);
        recompressVideo(fullPath).catch(err => console.error('[recompress] Error:', err.message));
    }
    
    db.prepare('INSERT INTO lessons (course_id, title, slug, description, video_url, duration, sort_order, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(course_id, title, slug, description, final_video_url, duration || 0, sort_order || 0, content || '');
    res.redirect('/admin');
});

app.post('/admin/user', requireAuth, requireAdmin, (req, res) => {
    const { name, email, password, role } = req.body;
    db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)')
        .run(name, email, password, role || 'student');
    res.redirect('/admin');
});

// Update routes
app.post('/admin/course/update', requireAuth, requireAdmin, (req, res) => {
    const { id, title, slug, description, thumbnail } = req.body;
    db.prepare('UPDATE courses SET title = ?, slug = ?, description = ?, thumbnail = ? WHERE id = ?')
        .run(title, slug, description, thumbnail || '', id);
    res.redirect('/admin');
});

app.post('/admin/lesson/update', (req, res, next) => {
    // Check if this is a multipart request (has file upload)
    if (req.headers['content-type'] && req.headers['content-type'].startsWith('multipart/form-data')) {
        // Process with file upload
        upload.single('video_file')(req, res, (err) => {
            if (err) {
                return res.status(500).send('Upload error: ' + err.message);
            }
            // Continue to the actual route handler
            _updateLesson(req, res);
        });
    } else {
        // Process without file upload
        _updateLesson(req, res);
    }
});

// Actual update function
function _updateLesson(req, res) {
    const { id, course_id, title, slug, description, video_url, duration, sort_order, content } = req.body;
    
    // If a new file was uploaded, use that; otherwise keep the original video_url
    let final_video_url = video_url;
    if (req.file) {
        final_video_url = `/videos/${req.file.filename}`;
        // Recompress in background
        const fullPath = path.join(__dirname, 'public', 'videos', req.file.filename);
        recompressVideo(fullPath).catch(err => console.error('[recompress] Error:', err.message));
    }
    
    db.prepare('UPDATE lessons SET course_id = ?, title = ?, slug = ?, description = ?, video_url = ?, duration = ?, sort_order = ?, content = ? WHERE id = ?')
        .run(course_id, title, slug, description, final_video_url, duration || 0, sort_order || 0, content || '', id);
    res.redirect('/admin');
}

// Delete routes
app.post('/admin/course/delete', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.body;
    // Delete associated lessons first
    db.prepare('DELETE FROM lessons WHERE course_id = ?').run(id);
    // Then delete the course
    db.prepare('DELETE FROM courses WHERE id = ?').run(id);
    res.redirect('/admin');
});

app.post('/admin/lesson/delete', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.body;
    db.prepare('DELETE FROM lessons WHERE id = ?').run(id);
    res.redirect('/admin');
});

app.post('/admin/user/delete', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.body;
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.redirect('/admin');
});

// =============================================================================
// START
// =============================================================================

app.listen(PORT, () => {
    console.log(`amorphic learn running on port ${PORT}`);
});
