import type { BrowserContext, Page, ViewportSize } from 'playwright';

export type BrowserStatus =
  | 'DISCONNECTED'
  | 'LAUNCHING'
  | 'READY'
  | 'NAVIGATING'
  | 'CLOSED'
  | 'CRASHED';

export interface BrowserManagerOptions {
  /**
   * Path to persistent user data directory where cookies, storage, and logins are preserved.
   * Default: `./data/browser-profile`
   */
  userDataDir?: string;

  /**
   * Whether to run browser in headless mode.
   * In production (Linux Mint/i3) or human-takeover mode, must be false.
   * Default: false
   */
  headless?: boolean;

  /**
   * Slow down Playwright operations by the specified amount of milliseconds.
   */
  slowMo?: number;

  /**
   * Default navigation timeout in milliseconds.
   * Default: 30000 (30s)
   */
  navigationTimeout?: number;

  /**
   * Browser viewport dimensions. Defaults to null (matches window/screen size).
   */
  viewport?: ViewportSize | null;

  /**
   * Custom Chromium CLI flags.
   */
  chromiumArgs?: string[];

  /**
   * X11 Display (e.g. ':0' for Linux Mint production).
   */
  display?: string;
}

export interface NavigationResult {
  success: boolean;
  url: string;
  title: string;
  httpStatus?: number;
  error?: string;
  durationMs: number;
}

export interface NavigationOptions {
  /**
   * Navigation wait strategy. Default: 'domcontentloaded' for fast, low-overhead completion.
   */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

  /**
   * Timeout in milliseconds for this specific navigation call.
   */
  timeout?: number;
}

export interface BrowserManagerEvents {
  statusChange: (newStatus: BrowserStatus, previousStatus: BrowserStatus) => void;
  pageNavigated: (result: NavigationResult) => void;
  activePageChanged: (page: Page) => void;
  browserCrashed: (error: Error) => void;
  closed: () => void;
}
