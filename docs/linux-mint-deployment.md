# Linux Mint 22.2 + i3 Automation Server Deployment Guide

This document details the configuration and deployment of the Job Application Automation server on a dedicated Dell Latitude 3340 running Linux Mint 22.2 with the i3 window manager.

---

## 1. Machine Specifications

- **Model**: Dell Latitude 3340
- **CPU**: Intel Core i5-4210U (2 cores / 4 threads @ 1.70 GHz)
- **RAM**: 4 GB DDR3
- **Storage**: HDD
- **Display**: X11 on `:0`
- **Window Manager**: i3

---

## 2. System Preparation & Prerequisites

On the Linux Mint machine, open a terminal and run:

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install system utilities, X11 VNC server, and OpenSSH server
sudo apt install -y curl git openssh-server x11vnc ufw
```

### Install Node.js 24 and pnpm

```bash
# Install Node.js 24 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

# Verify versions
node -v # Expected: v24.x
npm -v

# Install pnpm globally
sudo npm install -g pnpm
pnpm -v
```

---

## 3. Clone Repository & Install Dependencies

```bash
# Clone the repository
git clone <your-repository-url> ~/jobsearch
cd ~/jobsearch

# Install project dependencies
pnpm install

# Install Playwright system dependencies and Chromium binary
pnpm --filter @jobsearch/server exec playwright install-deps chromium
pnpm --filter @jobsearch/server exec playwright install chromium
```

---

## 4. Environment Configuration

```bash
cd ~/jobsearch
cp .env.example .env
```

Edit `.env`:
```ini
PORT=3000
HOST=127.0.0.1
NODE_ENV=production

BROWSER_HEADLESS=false
BROWSER_USER_DATA_DIR=./data/browser-profile
BROWSER_SLOW_MO=0
BROWSER_NAVIGATION_TIMEOUT=30000

# Attach to local X11 session
DISPLAY=:0
```

---

## 5. Remote Human Takeover via VNC over SSH

Automation should not expose insecure remote desktop protocols to the local network. We bind `x11vnc` exclusively to `127.0.0.1` and tunnel it through encrypted SSH.

### 5.1 Set Up x11vnc on Linux Mint

Create a systemd user service or launcher script for `x11vnc`:

```bash
mkdir -p ~/.config/systemd/user
cat << 'EOF' > ~/.config/systemd/user/x11vnc.service
[Unit]
Description=x11vnc VNC Server for X11 session
After=graphical-session.target

[Service]
Type=simple
ExecStart=/usr/bin/x11vnc -display :0 -localhost -rfbport 5900 -nopw -forever -shared
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now x11vnc
```

### 5.2 Connecting from Primary Laptop (Windows/Mac/Linux)

On your primary development laptop:

```bash
# Forward VNC port 5900 and Dashboard port 3000 securely
ssh -L 5900:127.0.0.1:5900 -L 3000:127.0.0.1:3000 user@<mint-laptop-ip>
```

- **Dashboard**: Open `http://localhost:3000` in your web browser.
- **Chromium Takeover**: Open your favorite VNC client (TigerVNC, RealVNC, TightVNC) and connect to `localhost:5900`. You will see the native Chromium browser running under i3.

---

## 6. Low Memory & Performance Tuning (4 GB RAM)

1. **Chromium Resource Flags**:
   The `BrowserManager` automatically applies:
   - `--disable-dev-shm-usage`: prevents crashes if `/dev/shm` fills up.
   - `--disable-background-networking`, `--disable-sync`, `--disable-translate`: disables memory-heavy background tasks.
2. **Single Tab Enforcement**:
   The automation server enforces a single active page policy to avoid tab proliferation.
3. **i3 Workspace Assignment**:
   In `~/.config/i3/config`, add:
   ```
   assign [class="Chromium"] 2
   ```
   This keeps Chromium on workspace 2, ensuring clean visual isolation.
4. **Swap Optimization**:
   Because the laptop uses an HDD, configure `swappiness` to avoid aggressive swapping:
   ```bash
   sudo sysctl vm.swappiness=10
   echo "vm.swappiness=10" | sudo tee -a /etc/sysctl.conf
   ```

---

## 7. Running the Application as a System Service

Create a systemd service to manage the automation server:

```bash
sudo cat << 'EOF' > /etc/systemd/system/jobsearch.service
[Unit]
Description=Job Application Automation Server
After=network.target

[Service]
Type=simple
User=deepak
WorkingDirectory=/home/deepak/jobsearch
Environment=NODE_ENV=production
Environment=DISPLAY=:0
ExecStart=/usr/bin/pnpm run build && /usr/bin/pnpm --filter @jobsearch/server start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable jobsearch
```
