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
  private launchPromise: Promise<BrowserContext> | null = null;
  private trackedPages = new WeakSet<Page>();
  private isShuttingDown = false;
  private isCreatingFallbackPage = false;
  private readonly shutdownHandler: () => void;

  private readonly options: Required<Omit<BrowserManagerOptions, 'viewport' | 'chromiumArgs' | 'display'>> & {
    viewport?: BrowserManagerOptions['viewport'];
    chromiumArgs?: string[];
    display?: string;
  };

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

    this.shutdownHandler = () => {
      void this.close();
    };
  }

  public override on<K extends keyof BrowserManagerEvents>(
    eventName: K,
    listener: BrowserManagerEvents[K]
  ): this {
    return super.on(eventName, listener);
  }

  public override once<K extends keyof BrowserManagerEvents>(
    eventName: K,
    listener: BrowserManagerEvents[K]
  ): this {
    return super.once(eventName, listener);
  }

  public override off<K extends keyof BrowserManagerEvents>(
    eventName: K,
    listener: BrowserManagerEvents[K]
  ): this {
    return super.off(eventName, listener);
  }

  public override emit<K extends keyof BrowserManagerEvents>(
    eventName: K,
    ...args: Parameters<BrowserManagerEvents[K]>
  ): boolean {
    return super.emit(eventName, ...args);
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
    if (!this.activePage || this.activePage.isClosed()) {
      return null;
    }
    return this.activePage.url();
  }

  /**
   * Launches Playwright-managed Chromium with persistent profile context.
   * Preserves cookies, storage, and logins across sessions.
   * Safe against concurrent calls (returns the in-flight launch promise).
   */
  public async launch(): Promise<BrowserContext> {
    if (this.context && this.isRunning()) {
      return this.context;
    }

    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.launchPromise = this.performLaunch();
    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }

  private async performLaunch(): Promise<BrowserContext> {
    this.setStatus('LAUNCHING');

    try {
      // Ensure user data directory exists
      if (!fs.existsSync(this.options.userDataDir)) {
        fs.mkdirSync(this.options.userDataDir, { recursive: true });
      }

      // Combine default memory-safe arguments with user-provided arguments
      const args = Array.from(new Set([...DEFAULT_CHROMIUM_ARGS, ...(this.options.chromiumArgs ?? [])]));

      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
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

      this.registerSignalHandlers();

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
        // Close any leftover extra pages to conserve memory
        for (let i = 1; i < existingPages.length; i++) {
          await existingPages[i].close().catch(() => {});
        }
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
      this.unregisterSignalHandlers();
      this.context = null;
      this.activePage = null;
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

    const page = this.activePage;
    this.setStatus('NAVIGATING');

    const timeout = options.timeout ?? this.options.navigationTimeout;
    const waitUntil = options.waitUntil ?? 'domcontentloaded';

    try {
      const response = await page.goto(normalizedUrl, {
        waitUntil,
        timeout,
      });

      const currentPage = this.activePage ?? page;
      const title = !currentPage.isClosed() ? await currentPage.title().catch(() => '') : '';
      const httpStatus = response ? response.status() : undefined;
      const finalUrl = !currentPage.isClosed() ? currentPage.url() : normalizedUrl;

      const result: NavigationResult = {
        success: true,
        url: finalUrl,
        title,
        httpStatus,
        durationMs: Date.now() - startTime,
      };

      if (this.status === 'NAVIGATING') {
        this.setStatus('READY');
      }
      this.emit('pageNavigated', result);
      return result;
    } catch (error) {
      if (this.status === 'NAVIGATING') {
        this.setStatus('READY');
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      const currentPage = this.activePage;
      const title =
        currentPage && !currentPage.isClosed() ? await currentPage.title().catch(() => '') : '';
      const currentUrl =
        currentPage && !currentPage.isClosed() ? currentPage.url() || normalizedUrl : normalizedUrl;

      const result: NavigationResult = {
        success: false,
        url: currentUrl,
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
    this.unregisterSignalHandlers();

    if (!this.context) {
      this.setStatus('DISCONNECTED');
      return;
    }

    this.isShuttingDown = true;
    try {
      await this.context.close();
    } catch {
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
   * Auto-prepends 'https://' if scheme is omitted (including host:port inputs).
   */
  public normalizeUrl(raw: string): string | null {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // 1. Check for explicit hierarchical scheme (e.g. "http://", "https://", "ftp://")
    const hierarchicalSchemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
    if (hierarchicalSchemeMatch) {
      const scheme = hierarchicalSchemeMatch[1].toLowerCase();
      if (scheme !== 'http' && scheme !== 'https') {
        return null;
      }
      try {
        const parsed = new URL(trimmed);
        return parsed.toString();
      } catch {
        return null;
      }
    }

    // 2. Allow data: URLs for local/self-contained HTML rendering
    if (/^data:/i.test(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        return parsed.toString();
      } catch {
        return null;
      }
    }

    // 3. Reject non-hierarchical schemes (e.g. "javascript:", "mailto:", "file:", "about:")
    // while allowing "host:port" patterns (e.g. "localhost:3000", "example.com:8080/jobs")
    const isHostPort = /^[a-zA-Z0-9.-]+:\d+(\/|\?|#|$)/.test(trimmed);
    if (!isHostPort && /^([a-zA-Z][a-zA-Z0-9+.-]*):/.test(trimmed)) {
      return null;
    }

    // 4. No scheme provided, prepend https://
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

  private registerPageListeners(page: Page): void {
    if (this.trackedPages.has(page)) {
      return;
    }
    this.trackedPages.add(page);

    page.on('crash', () => {
      if (this.activePage === page) {
        this.setStatus('CRASHED');
        this.emit('browserCrashed', new Error('Active browser page crashed'));
      }
    });

    page.on('close', () => {
      if (this.isShuttingDown || !this.context) return;
      if (this.activePage !== page) return;

      const remainingPages = this.context
        .pages()
        .filter((p) => p !== page && !p.isClosed());

      if (remainingPages.length > 0) {
        this.setActivePage(remainingPages[remainingPages.length - 1]);
      } else if (!this.isCreatingFallbackPage) {
        // Active page closed and no others left; create a fresh page to keep session alive
        this.isCreatingFallbackPage = true;
        this.context
          .newPage()
          .then((p) => {
            if (!this.isShuttingDown && this.context) {
              this.setActivePage(p);
            }
          })
          .catch(() => {
            // Context might have closed simultaneously
          })
          .finally(() => {
            this.isCreatingFallbackPage = false;
          });
      }
    });
  }

  private setActivePage(page: Page): void {
    this.registerPageListeners(page);
    if (this.activePage === page) {
      return;
    }

    this.activePage = page;
    this.activePage.setDefaultNavigationTimeout(this.options.navigationTimeout);
    this.emit('activePageChanged', page);
  }

  private handleNewPage(newPage: Page): void {
    const previousPage = this.activePage;
    this.setActivePage(newPage);

    // In a 4GB RAM environment, if the previous page was an unused blank tab, close it
    if (
      previousPage &&
      previousPage !== newPage &&
      !previousPage.isClosed() &&
      previousPage.url() === 'about:blank'
    ) {
      void previousPage.close().catch(() => {});
    }
  }

  private handleContextClosed(): void {
    this.unregisterSignalHandlers();
    this.context = null;
    this.activePage = null;
    this.setStatus('CLOSED');
    this.emit('closed');
    this.setStatus('DISCONNECTED');
  }

  private registerSignalHandlers(): void {
    process.once('SIGINT', this.shutdownHandler);
    process.once('SIGTERM', this.shutdownHandler);
  }

  private unregisterSignalHandlers(): void {
    process.off('SIGINT', this.shutdownHandler);
    process.off('SIGTERM', this.shutdownHandler);
  }
}
