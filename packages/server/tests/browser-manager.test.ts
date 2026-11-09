import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserManager } from '../src/browser/browser-manager.js';
import type { BrowserStatus, NavigationResult } from '../src/browser/types.js';

describe('BrowserManager', () => {
  let testUserDataDir: string;
  let manager: BrowserManager | null = null;

  beforeEach(() => {
    // Unique temporary directory for test isolation
    testUserDataDir = path.join(
      os.tmpdir(),
      `jobsearch-test-profile-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
    );
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    // Clean up temporary profile folder
    if (fs.existsSync(testUserDataDir)) {
      try {
        fs.rmSync(testUserDataDir, { recursive: true, force: true });
      } catch {
        // Chromium might temporarily hold lock on Windows; ignore cleanup errors
      }
    }
  });

  describe('URL Normalization', () => {
    it('should prepend https:// when protocol is missing (including host:port)', () => {
      const bm = new BrowserManager({ userDataDir: testUserDataDir, headless: true });
      expect(bm.normalizeUrl('example.com')).toBe('https://example.com/');
      expect(bm.normalizeUrl('example.com/jobs/123')).toBe('https://example.com/jobs/123');
      expect(bm.normalizeUrl('localhost:3000')).toBe('https://localhost:3000/');
      expect(bm.normalizeUrl('example.com:8080/jobs')).toBe('https://example.com:8080/jobs');
    });

    it('should preserve explicit http and https schemes', () => {
      const bm = new BrowserManager({ userDataDir: testUserDataDir, headless: true });
      expect(bm.normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000/');
      expect(bm.normalizeUrl('https://careers.google.com')).toBe('https://careers.google.com/');
    });

    it('should reject invalid or unsupported protocols', () => {
      const bm = new BrowserManager({ userDataDir: testUserDataDir, headless: true });
      expect(bm.normalizeUrl('javascript:alert(1)')).toBeNull();
      expect(bm.normalizeUrl('mailto:hr@example.com')).toBeNull();
      expect(bm.normalizeUrl('ftp://files.example.com')).toBeNull();
      expect(bm.normalizeUrl('file:///etc/passwd')).toBeNull();
      expect(bm.normalizeUrl('')).toBeNull();
      expect(bm.normalizeUrl('   ')).toBeNull();
    });
  });

  describe('Browser Lifecycle', () => {
    it('should start in DISCONNECTED status', () => {
      manager = new BrowserManager({ userDataDir: testUserDataDir, headless: true });
      expect(manager.getStatus()).toBe('DISCONNECTED');
      expect(manager.isRunning()).toBe(false);
      expect(manager.getActivePage()).toBeNull();
      expect(manager.getContext()).toBeNull();
      expect(manager.getCurrentUrl()).toBeNull();
    });

    it('should launch persistent browser context and transition through status events', async () => {
      manager = new BrowserManager({
        userDataDir: testUserDataDir,
        headless: true,
      });

      const statusEvents: BrowserStatus[] = [];
      manager.on('statusChange', (newStatus) => {
        statusEvents.push(newStatus);
      });

      const context = await manager.launch();

      expect(context).toBeDefined();
      expect(manager.getStatus()).toBe('READY');
      expect(manager.isRunning()).toBe(true);
      expect(manager.getActivePage()).not.toBeNull();
      expect(statusEvents).toEqual(['LAUNCHING', 'READY']);

      // Ensure persistent directory was created on disk
      expect(fs.existsSync(testUserDataDir)).toBe(true);
    });

    it('should return existing context if launch is called sequentially or concurrently (singleton)', async () => {
      manager = new BrowserManager({
        userDataDir: testUserDataDir,
        headless: true,
      });

      const [context1, context2] = await Promise.all([manager.launch(), manager.launch()]);
      const context3 = await manager.launch();

      expect(context1).toBe(context2);
      expect(context1).toBe(context3);
      expect(manager.getStatus()).toBe('READY');
    });

    it('should handle active page closing by creating or switching to a valid page without duplicate events', async () => {
      manager = new BrowserManager({
        userDataDir: testUserDataDir,
        headless: true,
      });

      await manager.launch();
      const firstPage = manager.getActivePage()!;

      let pageChangeCount = 0;
      manager.on('activePageChanged', () => {
        pageChangeCount++;
      });

      await firstPage.close();

      // Wait briefly for fallback page creation
      await new Promise((r) => setTimeout(r, 250));

      const newActivePage = manager.getActivePage();
      expect(newActivePage).not.toBeNull();
      expect(newActivePage).not.toBe(firstPage);
      expect(newActivePage?.isClosed()).toBe(false);
      expect(pageChangeCount).toBe(1);
    });

    it('should gracefully close the browser and release resources', async () => {
      manager = new BrowserManager({
        userDataDir: testUserDataDir,
        headless: true,
      });

      await manager.launch();
      expect(manager.isRunning()).toBe(true);

      let closedEventFired = false;
      manager.on('closed', () => {
        closedEventFired = true;
      });

      await manager.close();

      expect(closedEventFired).toBe(true);
      expect(manager.getStatus()).toBe('DISCONNECTED');
      expect(manager.isRunning()).toBe(false);
      expect(manager.getContext()).toBeNull();
      expect(manager.getActivePage()).toBeNull();
    });
  });

  describe('URL Navigation', () => {
    it('should reject navigation when browser is not running', async () => {
      manager = new BrowserManager({ userDataDir: testUserDataDir, headless: true });
      await expect(manager.navigateTo('https://example.com')).rejects.toThrow(
        /browser is not running/i
      );
    });

    it('should return failure result for invalid URLs without throwing', async () => {
      manager = new BrowserManager({ userDataDir: testUserDataDir, headless: true });
      await manager.launch();

      const result = await manager.navigateTo('invalid-scheme://foo');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid URL format');
      expect(manager.getStatus()).toBe('READY');
    });

    it('should navigate to data HTML URL and report title and URL', async () => {
      manager = new BrowserManager({ userDataDir: testUserDataDir, headless: true });
      await manager.launch();

      const navigatedEvents: NavigationResult[] = [];
      manager.on('pageNavigated', (res) => {
        navigatedEvents.push(res);
      });

      // Use a self-contained data URL to test navigation without network dependency
      const testHtml =
        '<html><head><title>Job Portal Test</title></head><body><h1>Careers</h1></body></html>';
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(testHtml)}`;

      const result = await manager.navigateTo(dataUrl);

      expect(result.success).toBe(true);
      expect(result.title).toBe('Job Portal Test');
      expect(result.url).toBe(dataUrl);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(navigatedEvents).toHaveLength(1);
      expect(navigatedEvents[0].title).toBe('Job Portal Test');
      expect(manager.getCurrentUrl()).toBe(dataUrl);
    });

    it('should navigate to external URL with missing protocol auto-completed', async () => {
      manager = new BrowserManager({ userDataDir: testUserDataDir, headless: true });
      await manager.launch();

      const result = await manager.navigateTo('example.com');
      expect(result.success).toBe(true);
      expect(result.url).toContain('example.com');
      expect(result.title).toContain('Example Domain');
    });
  });

  describe('Session Persistence Verification', () => {
    it('should preserve cookies across browser restarts in the same profile directory', async () => {
      // Step 1: Launch first browser instance and set a persistent cookie
      manager = new BrowserManager({ userDataDir: testUserDataDir, headless: true });
      await manager.launch();

      const context1 = manager.getContext()!;
      const expiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours in the future
      await context1.addCookies([
        {
          name: 'session_token',
          value: 'secret_user_login_xyz',
          domain: '.example.com',
          path: '/',
          expires: expiry,
        },
      ]);

      const cookiesBeforeClose = await context1.cookies('https://example.com');
      expect(cookiesBeforeClose.some((c) => c.name === 'session_token')).toBe(true);

      // Close first instance gracefully
      await manager.close();
      manager = null;

      // Step 2: Launch second instance using the EXACT SAME userDataDir
      const secondManager = new BrowserManager({ userDataDir: testUserDataDir, headless: true });
      manager = secondManager;
      await secondManager.launch();

      const context2 = secondManager.getContext()!;
      const cookiesAfterRestart = await context2.cookies('https://example.com');

      const restoredCookie = cookiesAfterRestart.find((c) => c.name === 'session_token');
      expect(restoredCookie).toBeDefined();
      expect(restoredCookie?.value).toBe('secret_user_login_xyz');
    });
  });
});
