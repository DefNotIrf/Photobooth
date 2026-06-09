# KepalaKotak Photobooth

A full-stack photobooth system built for events. Customers choose a format, pick a filter, pose for the DSLR, review their composite, and walk away with a printed 4×6" photo and a digital copy via QR code.

## Live Demo

[https://photobooth-0j80.onrender.com]

---

## Features

- **Two formats** — Photo Strip (3 shots, portrait) and Polaroid (1 shot, landscape)
- **9 live filters** — applied via pixel manipulation (Safari-safe)
- **Custom design overlays** — upload PNG templates per format via admin panel
- **DSLR pipeline** — digiCamControl saves to a watched folder, server auto-pushes photos to browser via WebSocket
- **OBS Virtual Camera** — live viewfinder feed in the browser
- **Canon SELPHY CP1300 WS** — borderless 4×6" printing via PowerShell
- **Google Drive upload** — browser uploads directly to Drive, generates QR code for customer
- **Queue system** — persistent queue with admin panel to manage print status
- **Admin panel** — password-protected, manage queue and design templates

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS, Canvas API |
| Backend | Node.js, Express, WebSocket (ws) |
| Camera | digiCamControl + folder watcher |
| Printing | PowerShell + System.Drawing |
| Storage | Google Drive via Apps Script |
| Deploy | Render (mock mode) / Local (live mode) |

---

## Setup (Local — Live Hardware Mode)

### Requirements
- Windows laptop
- Node.js v18+
- Canon SELPHY CP1300 WS (WiFi)
- Canon DSLR + digiCamControl
- OBS Studio with Virtual Camera

### Installation

```bash
git clone https://github.com/DefNotIrf/Photobooth.git
cd Photobooth
npm install
```

### Configuration

Edit `server.js` CONFIG block:

```js
const CONFIG = {
  watchDir:    'Z:',              // mapped network share or local digiCamControl folder
  captureDir:  'C:\\...\\captures',
  printerName: 'Canon SELPHY CP1300 WS',
  appsScriptUrl: 'https://script.google.com/...',  // your Apps Script URL
};
```

### HTTPS (required for camera access)

```bash
# Generate self-signed cert
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes
```

### Run

```bash
# Local live mode
$env:LOCAL_MODE = "1"
node server.js
```

Open `https://localhost:3000` in browser.

---

## Deploy (Cloud — Mock Mode)

Deployed on [Render](https://render.com). Mock mode simulates hardware — no printer or camera needed.

```bash
git push  # Render auto-deploys on push
```

Environment variables on Render:
| Key | Value |
|---|---|
| `PORT` | `3000` |
| `ADMIN_PASSWORD` | your password |

---

## Network Share Setup (two-laptop setup)

If the DSLR laptop and server laptop are different machines:

```powershell
# On DSLR laptop (as Administrator)
net share STUFF="C:\Users\...\digiCamControl\STUFF" /grant:Everyone,FULL
icacls "C:\Users\...\digiCamControl\STUFF" /grant Everyone:(OI)(CI)F /T

# On server laptop
net use Z: \\<DSLR-laptop-IP>\STUFF /persistent:yes
# Set watchDir: 'Z:' in server.js CONFIG
```

---

## Admin Panel

Access at `/admin` — default password: `admin321`

- Upload/manage design templates (PNG with transparent or black holes)
- Monitor print queue
- Mark prints as done

---

## Google Drive Integration

Uses Google Apps Script as a relay. Deploy the script from `DriveUpload.gs`:

1. Go to [script.google.com](https://script.google.com)
2. Create new project, paste `DriveUpload.gs`
3. Deploy → Web App → Access: **Anyone**
4. Copy `/exec` URL → paste into `APPS_SCRIPT_URL` in `server.js` and `photobooth-v3.html`

---

## Team

| Name | Role |
|---|---|
| Anas | CEO & Marketing Lead |
| Irfan | COO & Lead Technician |
| Ammar | Technical Operations Specialist |
| Hafizullah | Technical Support & On-Site Coordinator |
| Raziq | Social Media & Content Manager |

---

## Contact

- Instagram: [@kepalakotak.kl](https://instagram.com/kepalakotak.kl)
- WhatsApp: +60-11 11240684
