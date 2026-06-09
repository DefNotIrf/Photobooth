/**
 * KepalaKotak Server
 * Requirements: npm install ws express node-fetch@2 multer
 * Usage: node server.js
 */

const express   = require('express');
const https     = require('https');
const http      = require('http');
const WebSocket = require('ws');
const { exec }  = require('child_process');
const path      = require('path');
const fs        = require('fs');
const fetch     = require('node-fetch');
const multer    = require('multer');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  port: 3000,
  mockMode: false,
  adminPassword: 'admin321',
  digicam:     'C:\\Program Files (x86)\\digiCamControl\\CameraControlCmd.exe',
  watchDir:    'Z:',  // mapped network share: net use Z: \\172.20.10.14\STUFF
  captureDir:  'C:\\Users\\User\\Desktop\\Techno\\captures',        // temp for print files
  printerName: 'Canon SELPHY CP1300 WS',
  appsScriptUrl: 'https://script.google.com/macros/s/AKfycbwYW3Z1qxjqXYjaQCeYxcUBaMsm07ZbgPibkhbWwfXtZD6DZDlX6ty5uMdgRKnxwNt3ZQ/exec',
  queueFile:   path.join(__dirname, 'queue.json'),
  designFile:  path.join(__dirname, 'custom-design.png'),
};

// ─────────────────────────────────────────────
// SSL
// ─────────────────────────────────────────────
const certFile = path.join(__dirname, 'cert.pem');
const keyFile  = path.join(__dirname, 'key.pem');
let sslOptions = null;
if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  sslOptions = { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  console.log('[SSL] Certificate loaded — running HTTPS');
}

// ─────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────
if (!fs.existsSync(CONFIG.captureDir)) fs.mkdirSync(CONFIG.captureDir, { recursive: true });

// ─────────────────────────────────────────────
// QUEUE
// ─────────────────────────────────────────────
let QUEUE = [];
let QUEUE_COUNTER = 0;

function loadQueue() {
  try {
    if (fs.existsSync(CONFIG.queueFile)) {
      const d = JSON.parse(fs.readFileSync(CONFIG.queueFile, 'utf8'));
      QUEUE = d.queue || [];
      QUEUE_COUNTER = d.counter || 0;
      console.log(`[QUEUE] Loaded — ${QUEUE.length} items, counter: ${QUEUE_COUNTER}`);
    }
  } catch(e) { QUEUE = []; QUEUE_COUNTER = 0; }
}

function saveQueue() {
  fs.writeFileSync(CONFIG.queueFile, JSON.stringify({ queue: QUEUE, counter: QUEUE_COUNTER }, null, 2));
}

function addToQueue({ format, outputMode, sessionId }) {
  QUEUE_COUNTER++;
  const item = {
    number: QUEUE_COUNTER, sessionId, format, outputMode,
    status: 'waiting',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  QUEUE.push(item);
  saveQueue();
  broadcastQueue();
  return item;
}

function updateQueueItem(number, status) {
  const item = QUEUE.find(q => q.number === number);
  if (item) { item.status = status; item.updatedAt = new Date().toISOString(); saveQueue(); broadcastQueue(); }
  return item;
}

function getActiveQueue() { return QUEUE.filter(q => q.status !== 'done'); }

loadQueue();

// ─────────────────────────────────────────────
// SESSION STATE — tracks active shooting session
// ─────────────────────────────────────────────
let SESSION = {
  active:    false,   // true when customer is on step 4
  format:    null,    // 'strip' | 'polaroid'
  filter:    'none',
  shotCount: 0,       // how many shots received so far
  total:     0,       // how many shots needed (3 strip, 1 polaroid)
};

function startSession(format, filter) {
  SESSION.active    = true;
  SESSION.format    = format;
  SESSION.filter    = filter || 'none';
  SESSION.shotCount = 0;
  SESSION.total     = format === 'polaroid' ? 1 : 3;
  console.log(`[SESSION] Started — format: ${format}, total: ${SESSION.total}`);
}

function resetSession() {
  SESSION.active    = false;
  SESSION.format    = null;
  SESSION.shotCount = 0;
  SESSION.total     = 0;
  console.log('[SESSION] Reset');
}

// ─────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────
const app    = express();
const server = sslOptions ? https.createServer(sslOptions, app) : http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// ─────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────
const clients = new Set();

function broadcast(payload) {
  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function broadcastQueue() {
  broadcast({ type: 'queue', queue: getActiveQueue(), counter: QUEUE_COUNTER });
}

function broadcastDesignUpdate() {
  broadcast({ type: 'design_updated', ts: Date.now() });
}

wss.on('connection', (ws, req) => {
  console.log('[WS] Client connected from', req.socket.remoteAddress);
  clients.add(ws);

  ws.send(JSON.stringify({ type: 'ready' }));
  ws.send(JSON.stringify({ type: 'queue', queue: getActiveQueue(), counter: QUEUE_COUNTER }));
  ws.send(JSON.stringify({ type: 'design_status', hasDesign: fs.existsSync(CONFIG.designFile) }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    // Customer entered step 4 — start watching for DSLR photos
    if (msg.type === 'session_start') {
      startSession(msg.format, msg.filter);
      ws.send(JSON.stringify({ type: 'session_ready', total: SESSION.total }));
    }

    // Customer retook — reset shot count
    if (msg.type === 'session_reset') {
      SESSION.shotCount = 0;
      SESSION.active    = true;
      console.log('[SESSION] Retake — shot count reset');
    }

    // Customer left step 4
    if (msg.type === 'session_end') {
      resetSession();
    }

    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  });

  ws.on('close', () => { clients.delete(ws); console.log('[WS] Client disconnected'); });
  ws.on('error', (e) => console.error('[WS] Error:', e.message));
});

// ─────────────────────────────────────────────
// FOLDER WATCHER — polling-based (works on network shares)
// ─────────────────────────────────────────────
const SEEN_FILES  = new Set();
const JPG_PATTERN = /\.(jpg|jpeg)$/i;
const POLL_MS     = 800; // check every 800ms

// Pre-populate seen files so existing files don't trigger on startup
function seedExistingFiles() {
  try {
    fs.readdirSync(CONFIG.watchDir).forEach(f => SEEN_FILES.add(f));
    console.log(`[WATCH] Pre-seeded ${SEEN_FILES.size} existing files in ${CONFIG.watchDir}`);
  } catch(e) {
    console.warn('[WATCH] Could not read watchDir on startup:', e.message);
  }
}

function pollWatchDir() {
  if (!SESSION.active || SESSION.shotCount >= SESSION.total) return;
  try {
    const files = fs.readdirSync(CONFIG.watchDir);
    for (const filename of files) {
      if (!JPG_PATTERN.test(filename)) continue;
      if (SEEN_FILES.has(filename)) continue;
      SEEN_FILES.add(filename);

      const filepath = path.join(CONFIG.watchDir, filename);
      setTimeout(() => {
        try {
          const data    = fs.readFileSync(filepath);
          if (!data || data.length === 0) return;
          const dataUrl = `data:image/jpeg;base64,${data.toString('base64')}`;
          const idx     = SESSION.shotCount;
          SESSION.shotCount++;

          console.log(`[WATCH] New photo: ${filename} → shot ${idx + 1}/${SESSION.total}`);
          broadcast({ type: 'photo', shotIndex: idx, dataUrl, filter: SESSION.filter });

          if (SESSION.shotCount >= SESSION.total) {
            console.log('[SESSION] All shots received');
            broadcast({ type: 'shots_complete', total: SESSION.total });
          }
        } catch(err) {
          // File still locked — retry after another 2 seconds
          console.warn('[WATCH] File locked, retrying in 2s:', filename, err.code);
          setTimeout(() => {
            try {
              const data    = fs.readFileSync(filepath);
              if (!data || data.length === 0) return;
              const dataUrl = `data:image/jpeg;base64,${data.toString('base64')}`;
              const idx     = SESSION.shotCount;
              SESSION.shotCount++;
              console.log(`[WATCH] New photo (retry): ${filename} → shot ${idx + 1}/${SESSION.total}`);
              broadcast({ type: 'photo', shotIndex: idx, dataUrl, filter: SESSION.filter });
              if (SESSION.shotCount >= SESSION.total) {
                broadcast({ type: 'shots_complete', total: SESSION.total });
              }
            } catch(err2) {
              SEEN_FILES.delete(filename);
              console.warn('[WATCH] Retry reason:', err2.code, err2.message, '| path:', filepath);
            }
          }, 2000);
        }
      }, 3000);
    }
  } catch(e) {
    // Network share temporarily unavailable — silently retry next poll
  }
}

seedExistingFiles();
setInterval(pollWatchDir, POLL_MS);
console.log(`[WATCH] Polling every ${POLL_MS}ms: ${CONFIG.watchDir}`);

// ─────────────────────────────────────────────
// PRINT
// ─────────────────────────────────────────────
function printImage(base64Data, format) {
  if (CONFIG.mockMode) {
    console.log('[MOCK] Print simulated');
    return new Promise(r => setTimeout(r, 1000));
  }

  const isLandscape = (format === 'polaroid');

  return new Promise((resolve, reject) => {
    const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const ts     = Date.now();
    const tmpImg = path.join(CONFIG.captureDir, `print_${ts}.png`);
    const tmpPs  = path.join(CONFIG.captureDir, `print_${ts}.ps1`);

    fs.writeFileSync(tmpImg, Buffer.from(base64, 'base64'));
    console.log('[PRINT] Image saved:', tmpImg, '| Format:', format, '| Landscape:', isLandscape);

    const psScript = `
Add-Type -AssemblyName System.Drawing

$imgPath     = '${tmpImg.replace(/\\/g, '\\\\').replace(/'/g, "''")}'
$printerName = '${CONFIG.printerName.replace(/'/g, "''")}'
$isLandscape = $${isLandscape ? 'true' : 'false'}

$img = [System.Drawing.Image]::FromFile($imgPath)
Write-Host "Image: $($img.Width) x $($img.Height) px | Landscape: $isLandscape"

$pd = New-Object System.Drawing.Printing.PrintDocument
$pd.PrinterSettings.PrinterName = $printerName
$pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
$pd.DefaultPageSettings.Landscape = $false

# Select borderless 4x6 paper explicitly
$allSizes = @($pd.PrinterSettings.PaperSizes)
Write-Host "Paper sizes available: $($allSizes.Count)"
$target = $allSizes | Where-Object { $_.PaperName -like '*borderless*' -and $_.PaperName -like '*P *' } | Select-Object -First 1
if (-not $target) { $target = $allSizes | Where-Object { $_.PaperName -like '*borderless*' } | Select-Object -First 1 }
if (-not $target) { $target = $allSizes | Select-Object -First 1 }
$pd.DefaultPageSettings.PaperSize = $target
Write-Host "Paper: $($target.PaperName) ($($target.Width) x $($target.Height))"

# Polaroid: rotate 90 deg to fill portrait page
if ($isLandscape) {
    $rotated = New-Object System.Drawing.Bitmap($img.Height, $img.Width)
    $g = [System.Drawing.Graphics]::FromImage($rotated)
    $g.TranslateTransform($img.Height / 2.0, $img.Width / 2.0)
    $g.RotateTransform(90)
    $g.TranslateTransform(-$img.Width / 2.0, -$img.Height / 2.0)
    $g.DrawImageUnscaled($img, 0, 0)
    $g.Dispose(); $img.Dispose(); $img = $rotated
    Write-Host "Rotated to portrait: $($img.Width) x $($img.Height)"
}

$script:imgRef = $img
$script:iw = $img.Width
$script:ih = $img.Height
$area = $pd.DefaultPageSettings.PrintableArea
$script:PRINT_DPI = 317
$script:pw = [int]($area.Width  / 100.0 * $script:PRINT_DPI)
$script:ph = [int]($area.Height / 100.0 * $script:PRINT_DPI)
$script:scale = [Math]::Min($script:pw / [float]$script:iw, $script:ph / [float]$script:ih)
$script:scale = $script:scale * (1.0 / 1.06)
$script:drawW = [int]($script:iw * $script:scale)
$script:drawH = [int]($script:ih * $script:scale)
$script:drawX = [int](($script:pw - $script:drawW) / 2)
$script:drawY = [int](($script:ph - $script:drawH) / 2)
Write-Host "DPI=$($script:PRINT_DPI) Page=$($script:pw)x$($script:ph) Draw=$($script:drawW)x$($script:drawH) at ($($script:drawX),$($script:drawY)) scale=$([Math]::Round($script:scale,4))"

$pd.Add_PrintPage({
    param($sender, $e)
    $e.Graphics.PageUnit          = [System.Drawing.GraphicsUnit]::Pixel
    $e.Graphics.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $e.Graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $e.Graphics.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $e.Graphics.DrawImage($script:imgRef, $script:drawX, $script:drawY, $script:drawW, $script:drawH)
    $e.HasMorePages = $false
})

try {
    $pd.Print()
    Write-Host "Spooled to $printerName"
} catch {
    Write-Error "Print failed: $_"; exit 1
} finally {
    $img.Dispose(); $pd.Dispose()
}
`.trimStart();

    fs.writeFileSync(tmpPs, psScript, 'utf8');
    const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpPs}"`;
    console.log('[PRINT] Executing PS script...');

    exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
      if (stdout && stdout.trim()) console.log('[PRINT]', stdout.trim());
      if (stderr && stderr.trim()) console.warn('[PRINT] ERR:', stderr.trim());
      setTimeout(() => {
        try { fs.unlinkSync(tmpImg); } catch(e) {}
        try { fs.unlinkSync(tmpPs); } catch(e) {}
      }, 10000);
      if (err && err.killed) return reject(new Error('Print timed out'));
      if (err && err.code === 1) return reject(new Error('Print failed — check printer is online'));
      console.log('[PRINT] Done for format:', format);
      resolve();
    });
  });
}

// ─────────────────────────────────────────────
// GOOGLE DRIVE
// ─────────────────────────────────────────────
async function uploadToDrive(base64Data, filename, sessionId) {
  if (!CONFIG.appsScriptUrl) return null;
  const res = await fetch(CONFIG.appsScriptUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify({ image: base64Data, filename, sessionId: sessionId || '' }),
  });
  const text = await res.text();
  if (text.trim().startsWith('<')) throw new Error('Apps Script returned HTML. Re-deploy with "Anyone" access.');
  const json = JSON.parse(text);
  if (!json.ok) throw new Error(json.error || 'Upload failed');
  console.log('[DRIVE] Uploaded:', json.url);
  return json.url;
}

// ─────────────────────────────────────────────
// ADMIN AUTH
// ─────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === CONFIG.adminPassword) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'photobooth-v3.html'), 'utf8');
  const designs = loadDesigns();
  if (designs.length > 0) {
    const designData = {};
    designs.forEach(d => {
      const file = path.join(DESIGNS_DIR, d.id + '.png');
      if (fs.existsSync(file)) designData[d.id] = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
    });
    const meta  = designs.map(d => ({ id: d.id, format: d.format, name: d.name || d.id }));
    const first = designs[0];
    const injection = '<script>\n' +
      'window.INJECTED_ALL_DESIGNS = ' + JSON.stringify(meta) + ';\n' +
      'window.INJECTED_DESIGN_DATA = ' + JSON.stringify(designData) + ';\n' +
      'window.INJECTED_DESIGN = ' + JSON.stringify(designData[first && first.id] || null) + ';\n' +
      'window.INJECTED_DESIGN_FORMAT = ' + JSON.stringify((first && first.format) || 'strip') + ';\n' +
      'window.INJECTED_DESIGN_ID = ' + JSON.stringify((first && first.id) || '') + ';\n' +
      'window.INJECTED_DESIGN_NAME = ' + JSON.stringify((first && first.name) || '') + ';\n' +
      '</script>';
    html = html.replace('</head>', injection + '</head>');
    console.log('[SERVER] Injected ' + designs.length + ' design(s):', meta.map(d => d.id + '(' + d.format + ')').join(', '));
  }
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/queue', (req, res) => res.json({ queue: getActiveQueue(), counter: QUEUE_COUNTER }));
app.get('/design', (req, res) => {
  if (fs.existsSync(CONFIG.designFile)) res.sendFile(CONFIG.designFile);
  else res.status(404).json({ error: 'No custom design uploaded' });
});

app.post('/print', async (req, res) => {
  const { image, outputMode, filename, format, sessionId } = req.body;
  if (!image) return res.status(400).json({ error: 'No image data' });
  try {
    const qItem = addToQueue({ format: format || 'strip', outputMode, sessionId: sessionId || Date.now().toString() });
    console.log(`[QUEUE] Added #${qItem.number}`);
    updateQueueItem(qItem.number, 'printing');
    await printImage(image, format);
    updateQueueItem(qItem.number, 'done');
    // Drive upload handled by browser directly
    res.json({ ok: true, queueNumber: qItem.number });
  } catch(err) {
    console.error('[PRINT] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === CONFIG.adminPassword) res.json({ ok: true, token: CONFIG.adminPassword });
  else res.status(401).json({ error: 'Wrong password' });
});

app.get('/admin/queue', adminAuth, (req, res) => res.json({ queue: QUEUE, counter: QUEUE_COUNTER }));

app.patch('/admin/queue/:number', adminAuth, (req, res) => {
  const number = parseInt(req.params.number);
  const { status } = req.body;
  if (!['waiting','printing','done'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const item = updateQueueItem(number, status);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, item });
});

app.delete('/admin/queue/done', adminAuth, (req, res) => {
  const before = QUEUE.length;
  QUEUE = QUEUE.filter(q => q.status !== 'done');
  saveQueue(); broadcastQueue();
  res.json({ ok: true, removed: before - QUEUE.length });
});

app.delete('/admin/queue/all', adminAuth, (req, res) => {
  QUEUE = []; saveQueue(); broadcastQueue();
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// DESIGN MANAGEMENT
// ─────────────────────────────────────────────
const DESIGNS_DIR  = path.join(__dirname, 'designs');
const DESIGNS_FILE = path.join(__dirname, 'designs.json');

if (!fs.existsSync(DESIGNS_DIR)) fs.mkdirSync(DESIGNS_DIR, { recursive: true });

if (fs.existsSync(CONFIG.designFile) && !fs.existsSync(DESIGNS_FILE)) {
  const id = 'strip_default';
  fs.copyFileSync(CONFIG.designFile, path.join(DESIGNS_DIR, id + '.png'));
  fs.writeFileSync(DESIGNS_FILE, JSON.stringify([{ id, format: 'strip', name: 'Default', uploadedAt: new Date().toISOString() }], null, 2));
  console.log('[DESIGN] Migrated old design');
}

function loadDesigns() {
  try {
    if (fs.existsSync(DESIGNS_FILE)) {
      const d = JSON.parse(fs.readFileSync(DESIGNS_FILE, 'utf8'));
      return d.map(x => ({ ...x, format: x.format === 'film' ? 'strip' : x.format }));
    }
  } catch(e) {}
  return [];
}

function saveDesigns(designs) {
  fs.writeFileSync(DESIGNS_FILE, JSON.stringify(designs, null, 2));
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => file.mimetype === 'image/png' ? cb(null, true) : cb(new Error('PNG only')),
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.get('/admin/designs', adminAuth, (req, res) => res.json({ designs: loadDesigns() }));

app.get('/admin/design-preview/:id', adminAuth, (req, res) => {
  const file = path.join(DESIGNS_DIR, req.params.id + '.png');
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(404).json({ error: 'Not found' });
});

app.patch('/admin/designs/:id', adminAuth, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const designs = loadDesigns();
  const item = designs.find(d => d.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  item.name = name.trim();
  saveDesigns(designs);
  broadcastDesignUpdate();
  res.json({ ok: true });
});

app.delete('/admin/designs/:id', adminAuth, (req, res) => {
  const id = req.params.id;
  try { fs.unlinkSync(path.join(DESIGNS_DIR, id + '.png')); } catch(e) {}
  saveDesigns(loadDesigns().filter(d => d.id !== id));
  broadcastDesignUpdate();
  res.json({ ok: true });
});

const MAX_DESIGNS_PER_FORMAT = 5;
app.post('/admin/upload-design', adminAuth, upload.single('design'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const { format: rawFormat, action, slotId, slotName } = req.body;
  const format = rawFormat === 'film' ? 'strip' : rawFormat;
  if (!format) return res.status(400).json({ error: 'format required' });
  const designs = loadDesigns();

  if (action === 'replace' && slotId) {
    const idx = designs.findIndex(d => d.id === slotId);
    if (idx >= 0) {
      designs[idx].uploadedAt = new Date().toISOString();
      if (slotName && slotName.trim()) designs[idx].name = slotName.trim();
    }
    fs.writeFileSync(path.join(DESIGNS_DIR, slotId + '.png'), req.file.buffer);
    saveDesigns(designs);
    fs.writeFileSync(CONFIG.designFile, req.file.buffer);
    broadcastDesignUpdate();
    return res.json({ ok: true, slotId });
  }

  const count = designs.filter(d => d.format === format).length;
  if (count >= MAX_DESIGNS_PER_FORMAT) return res.status(400).json({ error: `Max ${MAX_DESIGNS_PER_FORMAT} designs per format.` });

  const id = format + '_' + Date.now();
  designs.push({ id, format, name: (slotName && slotName.trim()) || id, uploadedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(DESIGNS_DIR, id + '.png'), req.file.buffer);
  saveDesigns(designs);
  fs.writeFileSync(CONFIG.designFile, req.file.buffer);
  broadcastDesignUpdate();
  res.json({ ok: true, slotId: id });
});

app.get('/design', (req, res) => {
  if (fs.existsSync(CONFIG.designFile)) res.sendFile(CONFIG.designFile);
  else res.status(404).json({ error: 'No custom design uploaded' });
});

app.get('/designs/:format', (req, res) => {
  res.json({ designs: loadDesigns().filter(d => d.format === req.params.format) });
});

app.get('/admin/status', adminAuth, (req, res) => {
  const designs = loadDesigns();
  res.json({
    ok: true, mockMode: CONFIG.mockMode, printer: CONFIG.printerName,
    driveEnabled: !!CONFIG.appsScriptUrl,
    hasDesign: designs.length > 0, designCount: designs.length,
    queueCount: getActiveQueue().length, totalServed: QUEUE_COUNTER,
    watchDir: CONFIG.watchDir,
  });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
server.listen(CONFIG.port, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  let localIp = 'localhost';
  for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === 'IPv4' && !net.internal) localIp = net.address;

  const proto = sslOptions ? 'https' : 'http';
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║      KepalaKotak Server Running           ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  User:    ${proto}://${localIp}:${CONFIG.port}        ║`);
  console.log(`║  Admin:   ${proto}://${localIp}:${CONFIG.port}/admin  ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Mode: ${CONFIG.mockMode ? '⚡ MOCK (no hardware needed)  ' : '🔴 LIVE                       '}║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});