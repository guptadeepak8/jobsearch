import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type {
  BrowserManagerEvents,
  BrowserManagerOptions,
  BrowserStatus,
  NavigationOptions,
  NavigationResult,
} from './types.js';

/**
 * Default resource-conscious Chromium arguments.
 * Optimized for low memory (4GB RAM) and Linux Mint / i3 X11 compatibility.
 */
const DEFAULT_CHROMIUM_ARGS = [
  '--disable-dev-shm-usage', // Critical: uses /tmp instead of /dev/shm, avoiding OOM on constrained RAM
  '--no-default-browser-check',
  '--no-first-run',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-client-side-phishing-detection',
  '--disable-default-apps',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--password-store=basic',
  '--use-mock-keychain',
];

export class BrowserManager extends EventEmitter {
  private status: BrowserStatus = 'DISCONNECTED';
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  private readonly options: Required<Omit<BrowserManagerOptions, 'viewport' | 'chromiumArgs' | 'display'>> & {
    viewport?: BrowserManagerOptions['viewport'];
    chromiumArgs?: string[];
    display?: string;
  };
  private isShuttingDown = false;

  constructor(options: BrowserManagerOptions = {}) {
    super();

    const defaultProfilePath = path.resolve(process.cwd(), 'data', 'browser-profile');

    this.options = {
      userDataDir: options.userDataDir ? path.resolve(options.userDataDir) : defaultProfilePath,
      headless: options.headless ?? false,
      slowMo: options.slowMo ?? 0,
      navigationTimeout: options.navigationTimeout ?? 30000,
      viewport: options.viewport ?? null,
      chromiumArgs: options.chromiumArgs ?? [],
      display: options.display,
    };
  }

  /**
   * Returns current lifecycle status.
   */
  public getStatus(): BrowserStatus {
    return this.status;
  }

  /**
   * Returns whether browser is currently active and ready for interactions.
   */
  public isRunning(): boolean {
    return this.status === 'READY' || this.status === 'NAVIGATING';
  }

  /**
   * Returns active page instance, or null if browser is not launched.
   */
  public getActivePage(): Page | null {
    return this.activePage;
  }

  /**
   * Returns persistent browser context, or null if not launched.
   */
  public getContext(): BrowserContext | null {
    return this.context;
  }

  /**
   * Returns current URL of active page.
   */
  public getCurrentUrl(): string | null {
    return this.activePage ? this.activePage.url() : null;
  }

  /**
   * Launches Playwright-managed Chromium with persistent profile context.
   * Preserves cookies, storage, and logins across sessions.
   */
  public async launch(): Promise<BrowserContext> {
    if (this.context && this.isRunning()) {
      return this.context;
    }

    this.setStatus('LAUNCHING');

    try {
      // Ensure user data directory exists
      if (!fs.existsSync(this.options.userDataDir)) {
        fs.mkdirSync(this.options.userDataDir, { recursive: true });
      }

      // Combine default memory-safe arguments with user-provided arguments
      const args = Array.from(new Set([...DEFAULT_CHROMIUM_ARGS, ...(this.options.chromiumArgs ?? [])]));

      const env: Record<string, string> = { ...process.env as Record<string, string> };
      if (this.options.display) {
        env.DISPLAY = this.options.display;
      }

      this.context = await chromium.launchPersistentContext(this.options.userDataDir, {
        headless: this.options.headless,
        slowMo: this.options.slowMo,
        viewport: this.options.viewport,
        args,
        env,
        ignoreHTTPSErrors: false,
      });

      // Context close listener
      this.context.on('close', () => {
        if (!this.isShuttingDown) {
          this.handleContextClosed();
        }
      });

      // Manage single active page (4GB RAM conservation)
      const existingPages = this.context.pages();
      if (existingPages.length > 0) {
        this.setActivePage(existingPages[0]);
      } else {
        const newPage = await this.context.newPage();
        this.setActivePage(newPage);
      }

      // Track newly opened pages / popups
      this.context.on('page', (newPage) => {
        this.handleNewPage(newPage);
      });

      this.setStatus('READY');
      return this.context;
    } catch (error) {
      this.setStatus('CRASHED');
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('browserCrashed', err);
      throw err;
    }
  }

  /**
   * Navigates the active page to a target URL.
   * Auto-formats missing protocol, handles network timeouts, and returns structured result.
   */
  public async navigateTo(rawUrl: string, options: NavigationOptions = {}): Promise<NavigationResult> {
    if (!this.activePage || !this.isRunning()) {
      throw new Error(`Cannot navigate: browser is not running (current status: ${this.status})`);
    }

    const startTime = Date.now();
    const normalizedUrl = this.normalizeUrl(rawUrl);

    if (!normalizedUrl) {
      const errorResult: NavigationResult = {
        success: false,
        url: rawUrl,
        title: '',
        error: `Invalid URL format: "${rawUrl}". Must be a valid HTTP or HTTPS address.`,
        durationMs: Date.now() - startTime,
      };
      this.emit('pageNavigated', errorResult);
      return errorResult;
    }

    this.setStatus('NAVIGATING');

    const timeout = options.timeout ?? this.options.navigationTimeout;
    const waitUntil = options.waitUntil ?? 'domcontentloaded';

    try {
      const response = await this.activePage.goto(normalizedUrl, {
        waitUntil,
        timeout,
      });

      const title = await this.activePage.title().catch(() => '');
      const httpStatus = response ? response.status() : undefined;
      const finalUrl = this.activePage.url();

      const result: NavigationResult = {
        success: true,
        url: finalUrl,
        title,
        httpStatus,
        durationMs: Date.now() - startTime,
      };

      this.setStatus('READY');
      this.emit('pageNavigated', result);
      return result;
    } catch (error) {
      this.setStatus('READY');
      const errorMessage = error instanceof Error ? error.message : String(error);
      const title = await this.activePage.title().catch(() => '');

      const result: NavigationResult = {
        success: false,
        url: this.activePage.url() || normalizedUrl,
        title,
        error: errorMessage,
        durationMs: Date.now() - startTime,
      };

      this.emit('pageNavigated', result);
      return result;
    }
  }

  /**
   * Gracefully shuts down the browser context and releases file locks.
   */
  public async close(): Promise<void> {
    if (!this.context) {
      this.setStatus('DISCONNECTED');
      return;
    }

    this.isShuttingDown = true;
    try {
      await this.context.close();
    } catch (err) {
      // Ignore errors if browser process has already died
    } finally {
      this.context = null;
      this.activePage = null;
      this.isShuttingDown = false;
      this.setStatus('CLOSED');
      this.emit('closed');
      this.setStatus('DISCONNECTED');
    }
  }

  /**
   * Normalizes and validates incoming URL string.
   * Supports http, https, and data URLs.
   * Auto-prepends 'https://' if scheme is omitted.
   */
  public normalizeUrl(raw: string): string | null {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // Check if it already has a scheme (e.g. "http:", "https:", "ftp:", "javascript:", "data:")
    const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (schemeMatch) {
      const scheme = schemeMatch[1].toLowerCase();
      if (scheme !== 'http' && scheme !== 'https' && scheme !== 'data') {
        return null;
      }
      try {
        const parsed = new URL(trimmed);
        return parsed.toString();
      } catch {
        return null;
      }
    }

    // No scheme provided, prepend https://
    try {
      const withHttps = `https://${trimmed}`;
      const parsed = new URL(withHttps);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      return parsed.toString();
    } catch {
      return null;
    }
  }

  private setStatus(newStatus: BrowserStatus): void {
    if (this.status !== newStatus) {
      const previous = this.status;
      this.status = newStatus;
      this.emit('statusChange', newStatus, previous);
    }
  }

  private setActivePage(page: Page): void {
    this.activePage = page;
    this.activePage.setDefaultNavigationTimeout(this.options.navigationTimeout);

    this.activePage.on('crash', () => {
      this.setStatus('CRASHED');
      this.emit('browserCrashed', new Error('Active browser page crashed'));
    });

    this.activePage.on('close', () => {
      if (this.isShuttingDown || !this.context) return;
      const remainingPages = this.context.pages().filter((p) => p !== this.activePage);
      if (remainingPages.length > 0) {
        this.setActivePage(remainingPages[0]);
      } else {
        // Active page closed, no others left; create fresh page to maintain session
        this.context
          .newPage()
          .then((p) => this.setActivePage(p))
          .catch(() => {
            // Context might have closed simultaneously
          });
      }
    });

    this.emit('activePageChanged', page);
  }

  private handleNewPage(newPage: Page): void {
    // In a 4GB RAM environment, we prioritize the newly opened page (e.g. auth popup),
    // and close old blank/unused pages if they were abandoned.
    this.setActivePage(newPage);
  }

  private handleContextClosed(): void {
    this.context = null;
    this.activePage = null;
    this.setStatus('CLOSED');
    this.emit('closed');
    this.setStatus('DISCONNECTED');
  }
}
