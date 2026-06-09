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
  captureDir:  'C:\\Users\\User\\Pictures\\digiCamControl\\STUFF',
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
    number: QUEUE_COUNTER,
    sessionId,
    format,
    outputMode,
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

function broadcastQueue() {
  const payload = JSON.stringify({ type: 'queue', queue: getActiveQueue(), counter: QUEUE_COUNTER });
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });
}

function broadcastDesignUpdate() {
  const payload = JSON.stringify({ type: 'design_updated', ts: Date.now() });
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });
}

wss.on('connection', (ws, req) => {
  console.log('[WS] Client connected from', req.socket.remoteAddress);
  clients.add(ws);

  // Send current state on connect
  ws.send(JSON.stringify({ type: 'ready' }));
  ws.send(JSON.stringify({ type: 'queue', queue: getActiveQueue(), counter: QUEUE_COUNTER }));
  ws.send(JSON.stringify({ type: 'design_status', hasDesign: fs.existsSync(CONFIG.designFile) }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    if (msg.type === 'capture') {
      console.log(`[WS] Capture — shot ${msg.shotIndex + 1}, filter: ${msg.filter}`);
      ws.send(JSON.stringify({ type: 'capturing', shotIndex: msg.shotIndex }));
      try {
        const dataUrl = await capturePhoto(msg.shotIndex);
        ws.send(JSON.stringify({ type: 'photo', shotIndex: msg.shotIndex, dataUrl, filter: msg.filter }));
      } catch(err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    }

    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  });

  ws.on('close', () => { clients.delete(ws); console.log('[WS] Client disconnected'); });
  ws.on('error', (e) => console.error('[WS] Error:', e.message));
});

// ─────────────────────────────────────────────
// CAPTURE (mock / real)
// ─────────────────────────────────────────────
function mockCapture(shotIndex) {
  return new Promise((resolve) => {
    const seeds = [10, 20, 30];
    const url = `https://picsum.photos/seed/${seeds[shotIndex % 3]}/800/600`;
    const lib = require('https');
    lib.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        console.log(`[MOCK] Shot ${shotIndex}: ${buf.length} bytes`);
        resolve(`data:image/jpeg;base64,${buf.toString('base64')}`);
      });
    }).on('error', () => {
      // Minimal grey JPEG fallback
      resolve('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVH//2Q==');
    });
  });
}

function capturePhoto(shotIndex) {
  if (CONFIG.mockMode) return new Promise(r => setTimeout(() => mockCapture(shotIndex).then(r), 800));
  return new Promise((resolve, reject) => {
    const filepath = path.join(CONFIG.captureDir, `shot_${Date.now()}.jpg`);
    exec(`"${CONFIG.digicam}" /capture "${filepath}"`, { timeout: 15000 }, (err) => {
      if (err) return reject(new Error('DSLR capture failed: ' + err.message));
      setTimeout(() => {
        if (!fs.existsSync(filepath)) return reject(new Error('File not found after capture'));
        const data = fs.readFileSync(filepath);
        try { fs.unlinkSync(filepath); } catch(e) {}
        resolve(`data:image/jpeg;base64,${data.toString('base64')}`);
      }, 800);
    });
  });
}

// ─────────────────────────────────────────────
// PRINT
// ─────────────────────────────────────────────
function printImage(base64Data, format) {
  if (CONFIG.mockMode) {
    console.log('[MOCK] Print simulated');
    return new Promise(r => setTimeout(r, 1000));
  }

  // Polaroid is landscape (1800×1200), strip is portrait (1200×1760)
  const isLandscape = (format === 'polaroid');

  return new Promise((resolve, reject) => {
    const base64   = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const ts       = Date.now();
    const tmpImg   = path.join(CONFIG.captureDir, `print_${ts}.png`);
    const tmpPs    = path.join(CONFIG.captureDir, `print_${ts}.ps1`);

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
$pd.DefaultPageSettings.Landscape = $false  # SELPHY always portrait — landscape images rotated below

# Select borderless 4x6 paper explicitly
$allSizes = @($pd.PrinterSettings.PaperSizes)
Write-Host "Paper sizes available: $($allSizes.Count)"
$target = $allSizes | Where-Object { $_.PaperName -like '*borderless*' -and $_.PaperName -like '*P *' } | Select-Object -First 1
if (-not $target) { $target = $allSizes | Where-Object { $_.PaperName -like '*borderless*' } | Select-Object -First 1 }
if (-not $target) { $target = $allSizes | Select-Object -First 1 }
$pd.DefaultPageSettings.PaperSize = $target
Write-Host "Paper: $($target.PaperName) ($($target.Width) x $($target.Height))"

# Polaroid canvas is landscape (1847x1248) — rotate 90 deg so it fills portrait page correctly
if ($isLandscape) {
    $rotated = New-Object System.Drawing.Bitmap($img.Height, $img.Width)
    $g = [System.Drawing.Graphics]::FromImage($rotated)
    $g.TranslateTransform($img.Height / 2.0, $img.Width / 2.0)
    $g.RotateTransform(90)
    $g.TranslateTransform(-$img.Width / 2.0, -$img.Height / 2.0)
    $g.DrawImageUnscaled($img, 0, 0)
    $g.Dispose()
    $img.Dispose()
    $img = $rotated
    Write-Host "Rotated to portrait: $($img.Width) x $($img.Height)"
}

# Pre-calculate all values before scriptblock (scope fix)
$script:imgRef = $img
$script:iw = $img.Width
$script:ih = $img.Height
$area = $pd.DefaultPageSettings.PrintableArea
$script:PRINT_DPI = 317
$script:pw = [int]($area.Width  / 100.0 * $script:PRINT_DPI)
$script:ph = [int]($area.Height / 100.0 * $script:PRINT_DPI)
$script:scale = [Math]::Min($script:pw / [float]$script:iw, $script:ph / [float]$script:ih)
# Driver auto-enlarges by ~6% — pre-shrink so final output is exactly edge to edge
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
    Write-Error "Print failed: $_"
    exit 1
} finally {
    $img.Dispose()
    $pd.Dispose()
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
    method:   'POST',
    headers:  { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify({ image: base64Data, filename, sessionId: sessionId || '' }),
  });

  const text = await res.text();

  // Guard against HTML error pages (auth redirects, quota errors)
  if (text.trim().startsWith('<')) {
    console.error('[DRIVE] Got HTML instead of JSON — check Apps Script deployment URL and access settings');
    console.error('[DRIVE] Response snippet:', text.slice(0, 200));
    throw new Error('Apps Script returned HTML. Re-deploy with "Anyone" access and use the /exec URL without /u/N/.');
  }

  const json = JSON.parse(text);
  if (!json.ok) throw new Error(json.error || 'Upload failed');
  console.log('[DRIVE] Uploaded:', json.url);
  return json.url;
}

// ─────────────────────────────────────────────
// ADMIN AUTH MIDDLEWARE
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
      if (fs.existsSync(file)) {
        designData[d.id] = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
      }
    });
    const meta = designs.map(d => ({ id: d.id, format: d.format, name: d.name || d.id }));
    const first = designs[0];
    const injection = '<script>\n' +
      'window.INJECTED_ALL_DESIGNS = ' + JSON.stringify(meta) + ';\n' +
      'window.INJECTED_DESIGN_DATA = ' + JSON.stringify(designData) + ';\n' +
      'window.INJECTED_DESIGN = ' + JSON.stringify(designData[first && first.id] || null) + ';\n' +
      'window.INJECTED_DESIGN_FORMAT = ' + JSON.stringify((first && first.format) || 'film') + ';\n' +
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

// Public queue (user-facing)
app.get('/queue', (req, res) => res.json({ queue: getActiveQueue(), counter: QUEUE_COUNTER }));

// Custom design PNG
app.get('/design', (req, res) => {
  if (fs.existsSync(CONFIG.designFile)) res.sendFile(CONFIG.designFile);
  else res.status(404).json({ error: 'No custom design uploaded' });
});

// Print + queue
app.post('/print', async (req, res) => {
  const { image, outputMode, filename, format, sessionId } = req.body;
  if (!image) return res.status(400).json({ error: 'No image data' });

  try {
    const qItem = addToQueue({ format: format || 'strip', outputMode, sessionId: sessionId || Date.now().toString() });
    console.log(`[QUEUE] Added #${qItem.number}`);

    updateQueueItem(qItem.number, 'printing');
    await printImage(image, format);

    // Always upload to Drive (every customer gets digital copy)
    let driveUrl = null;
    if (CONFIG.appsScriptUrl) {
      try { driveUrl = await uploadToDrive(image, filename || ('kepalakotak_' + Date.now() + '.png'), sessionId); }
      catch(e) { console.error('[DRIVE] Failed:', e.message); }
    }

    updateQueueItem(qItem.number, 'done');
    res.json({ ok: true, driveUrl, queueNumber: qItem.number });
  } catch(err) {
    console.error('[PRINT] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Admin login
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === CONFIG.adminPassword) res.json({ ok: true, token: CONFIG.adminPassword });
  else res.status(401).json({ error: 'Wrong password' });
});

// Admin queue (full, including done)
app.get('/admin/queue', adminAuth, (req, res) => res.json({ queue: QUEUE, counter: QUEUE_COUNTER }));

// Update queue item status
app.patch('/admin/queue/:number', adminAuth, (req, res) => {
  const number = parseInt(req.params.number);
  const { status } = req.body;
  if (!['waiting','printing','done'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const item = updateQueueItem(number, status);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, item });
});

// Clear done items
app.delete('/admin/queue/done', adminAuth, (req, res) => {
  const before = QUEUE.length;
  QUEUE = QUEUE.filter(q => q.status !== 'done');
  saveQueue(); broadcastQueue();
  res.json({ ok: true, removed: before - QUEUE.length });
});

// Clear all
app.delete('/admin/queue/all', adminAuth, (req, res) => {
  QUEUE = []; saveQueue(); broadcastQueue();
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// DESIGN MANAGEMENT — multi-slot per format
// ─────────────────────────────────────────────
const DESIGNS_DIR  = path.join(__dirname, 'designs');
const DESIGNS_FILE = path.join(__dirname, 'designs.json');

if (!fs.existsSync(DESIGNS_DIR)) fs.mkdirSync(DESIGNS_DIR, { recursive: true });

// Migrate old single design if exists
if (fs.existsSync(CONFIG.designFile) && !fs.existsSync(DESIGNS_FILE)) {
  const id = 'film_default';
  fs.copyFileSync(CONFIG.designFile, path.join(DESIGNS_DIR, id + '.png'));
  fs.writeFileSync(DESIGNS_FILE, JSON.stringify([{
    id, format: 'film', name: 'Default Film Strip',
    uploadedAt: new Date().toISOString()
  }], null, 2));
  console.log('[DESIGN] Migrated old design to multi-slot system');
}

function loadDesigns() {
  try {
    if (fs.existsSync(DESIGNS_FILE)) {
      const designs = JSON.parse(fs.readFileSync(DESIGNS_FILE, 'utf8'));
      // Migrate: treat 'film' as 'strip' — formats are now just strip + polaroid
      return designs.map(d => ({ ...d, format: d.format === 'film' ? 'strip' : d.format }));
    }
  } catch(e) {}
  return [];
}

function saveDesigns(designs) {
  fs.writeFileSync(DESIGNS_FILE, JSON.stringify(designs, null, 2));
}

// Multer for design uploads — save to temp first
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => file.mimetype === 'image/png' ? cb(null, true) : cb(new Error('PNG only')),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// GET /admin/designs — list all design slots
app.get('/admin/designs', adminAuth, (req, res) => {
  res.json({ designs: loadDesigns() });
});

// GET /admin/design-preview/:id — serve design thumbnail
app.get('/admin/design-preview/:id', adminAuth, (req, res) => {
  const file = path.join(DESIGNS_DIR, req.params.id + '.png');
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(404).json({ error: 'Not found' });
});

// PATCH /admin/designs/:id — rename a design
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

// DELETE /admin/designs/:id
app.delete('/admin/designs/:id', adminAuth, (req, res) => {
  const id = req.params.id;
  const file = path.join(DESIGNS_DIR, id + '.png');
  try { fs.unlinkSync(file); } catch(e) {}
  const designs = loadDesigns().filter(d => d.id !== id);
  saveDesigns(designs);
  broadcastDesignUpdate();
  res.json({ ok: true });
});

// POST /admin/upload-design
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
    console.log('[DESIGN] Replaced:', slotId);
    return res.json({ ok: true, slotId });
  }

  // Check limit for new additions
  const count = designs.filter(d => (d.format === 'film' ? 'strip' : d.format) === format).length;
  if (count >= MAX_DESIGNS_PER_FORMAT) {
    return res.status(400).json({ error: `Max ${MAX_DESIGNS_PER_FORMAT} designs per format. Replace an existing one.` });
  }

  const id = format + '_' + Date.now();
  designs.push({ id, format, name: (slotName && slotName.trim()) || id, uploadedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(DESIGNS_DIR, id + '.png'), req.file.buffer);
  saveDesigns(designs);
  fs.writeFileSync(CONFIG.designFile, req.file.buffer);
  broadcastDesignUpdate();
  console.log('[DESIGN] Added:', id, 'for', format);
  res.json({ ok: true, slotId: id });
});

// GET /design — serve active design (most recent for film, for backward compat)
app.get('/design', (req, res) => {
  if (fs.existsSync(CONFIG.designFile)) res.sendFile(CONFIG.designFile);
  else res.status(404).json({ error: 'No custom design uploaded' });
});

// GET /designs/:format — serve all designs for a format (future: random/cycle)
app.get('/designs/:format', (req, res) => {
  const designs = loadDesigns().filter(d => d.format === req.params.format);
  res.json({ designs });
});

// Admin status
app.get('/admin/status', adminAuth, (req, res) => {
  const designs = loadDesigns();
  res.json({
    ok: true, mockMode: CONFIG.mockMode, printer: CONFIG.printerName,
    driveEnabled: !!CONFIG.appsScriptUrl,
    hasDesign: designs.length > 0,
    designCount: designs.length,
    queueCount: getActiveQueue().length, totalServed: QUEUE_COUNTER,
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
  if (CONFIG.mockMode) console.log('👉 Set mockMode: false in CONFIG when hardware ready\n');
});