# Job Application Automation Server

A lightweight, open-source, locally operated automated job application assistant designed for deployment on dedicated hardware (such as a spare Dell Latitude 3340 running Linux Mint 22.2 + i3) and remote management from a primary workstation.

---

## Architecture Overview

```
jobsearch/
├── packages/
│   ├── server/           # Fastify API, Playwright Browser Manager, SQLite memory, Form Engine
│   └── dashboard/        # React + TypeScript + Tailwind dashboard UI (Milestone 2/7)
├── docs/
│   └── linux-mint-deployment.md  # Step-by-step Linux Mint 22.2 + i3 + X11 guide
├── data/                 # Local data (gitignored: browser profile, SQLite db)
├── .env.example          # Template environment configuration
├── pnpm-workspace.yaml   # Workspace definition
└── package.json          # Root scripts
```

### Core Design Principles

- **Zero Paid AI / Cloud APIs**: Operates locally with rule-based heuristics and local SQLite storage.
- **Resource Efficient (4 GB RAM Budget)**: Single persistent Chromium instance, single-tab enforcement, memory-tuned Chromium flags (`--disable-dev-shm-usage`, disabled background bloat), static dashboard serving from Fastify.
- **Persistent Profile & Cookies**: Preserves user logins, session cookies, and authentication state in `./data/browser-profile` across restarts. Never purges credentials automatically.
- **Human Takeover First**: Full pause and remote takeover via encrypted VNC-over-SSH on X11 (`:0`). Automation strictly yields control when humans interact.
- **Explicit User Approval**: The system will **never** automatically submit an application without explicit user review and confirmation.

---

## Technology Stack

- **Runtime**: Node.js 24 (LTS)
- **Package Manager**: pnpm
- **Browser Automation**: Playwright + Chromium
- **Backend**: Fastify + `@fastify/websocket`
- **Database**: SQLite via `better-sqlite3`
- **Validation**: Zod
- **Frontend**: React + TypeScript + Tailwind CSS (Vite)
- **Testing**: Vitest

---

## Development Setup (Windows & Linux)

### Prerequisites

- Node.js 24 (`node -v`)
- pnpm (`pnpm -v`)

### Installation

1. **Clone repository**:
   ```bash
   git clone <repo-url>
   cd jobsearch
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

3. **Install Chromium browser for Playwright**:
   ```bash
   pnpm --filter @jobsearch/server exec playwright install chromium
   ```

4. **Configure environment**:
   ```bash
   cp .env.example .env
   ```

5. **Run tests**:
   ```bash
   pnpm test
   ```

6. **Build project**:
   ```bash
   pnpm build
   ```

---

## Production Deployment (Linux Mint 22.2 + i3 + X11)

For dedicated hardware (e.g. Dell Latitude 3340, Intel i5, 4 GB RAM, HDD):

1. Follow the comprehensive setup in [docs/linux-mint-deployment.md](docs/linux-mint-deployment.md).
2. Install system dependencies:
   ```bash
   sudo apt install -y curl git openssh-server x11vnc
   pnpm --filter @jobsearch/server exec playwright install-deps chromium
   ```
3. Set `DISPLAY=:0` in `.env`.
4. Connect remotely from your workstation:
   ```bash
   # Secure tunnel for Dashboard (3000) and VNC (5900)
   ssh -L 5900:127.0.0.1:5900 -L 3000:127.0.0.1:3000 user@spare-laptop-ip
   ```

---

## Milestone Progress

- [x] **Milestone 1**: Project structure, Browser Manager, Persistent Chromium context, URL navigation, Lifecycle management, Test suite.
- [x] **Milestone 2**: Fastify API Server, Browser control endpoints, WebSocket real-time updates.
- [x] **Milestone 3**: Remote browser monitoring, Human takeover controller, Pause/Resume mechanisms.
- [x] **Milestone 4**: Generic form detection, Accessible DOM inspection, Structured field extraction.
- [x] **Milestone 5**: Profile management, SQLite answer memory with `better-sqlite3` / `node:sqlite`.
- [x] **Milestone 6**: Form filling engine, Validation checks, Resume upload handler.
- [x] **Milestone 7**: Web dashboard integration, Application review & approval guard, Application history.

---

## Security & Privacy Guidelines

- **Never Commit Sensitive Data**: Resumes, profile directories, SQLite databases, cookies, and `.env` files are strictly excluded via `.gitignore`.
- **Localhost Binding**: All internal services bind to `127.0.0.1`. Remote management occurs exclusively through encrypted SSH tunnels.
- **Safety Invariants**: Form automation cannot submit forms without human sign-off; automation cannot interact with the page while human takeover is active.
