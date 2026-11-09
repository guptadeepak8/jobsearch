import { EventEmitter } from 'node:events';
import type { BrowserManager } from '../browser/browser-manager.js';
import type { FormExecutor } from '../executor/form-executor.js';
import type { FieldFillInstruction, FormExecutionReport, ValidationErrorItem } from '../executor/types.js';
import type { FormIntelligence } from '../intelligence/form-intelligence.js';
import type { DetectedField } from '../intelligence/types.js';
import type { AnswerMemory } from '../memory/answer-memory.js';
import type {
  ActivityLevel,
  ActivityLogEntry,
  SessionSnapshot,
  SessionState,
} from './types.js';

const MAX_ACTIVITY_LOGS = 100;

/**
 * SessionController: Finite state machine coordinating BrowserManager, FormIntelligence,
 * AnswerMemory, and FormExecutor.
 *
 * Enforces human takeover & pause lockouts and requires explicit user approval before submission.
 */
export class SessionController extends EventEmitter {
  private state: SessionState = 'IDLE';
  private previousRunningState: SessionState = 'BROWSER_RUNNING';
  private pageTitle = '';
  private detectedFields: DetectedField[] = [];
  private validationErrors: ValidationErrorItem[] = [];
  private lastExecutionReport: FormExecutionReport | null = null;
  private activityLogs: ActivityLogEntry[] = [];
  private logCounter = 0;

  constructor(
    private readonly browserManager: BrowserManager,
    private readonly formIntelligence: FormIntelligence,
    private readonly answerMemory: AnswerMemory,
    private readonly formExecutor: FormExecutor
  ) {
    super();
    this.bindBrowserEvents();
  }

  public getState(): SessionState {
    return this.state;
  }

  public isAutomationLocked(): boolean {
    return this.state === 'PAUSED' || this.state === 'HUMAN_TAKEOVER';
  }

  public getDetectedFields(): DetectedField[] {
    return this.detectedFields;
  }

  public getMissingFields(): DetectedField[] {
    return this.detectedFields.filter(
      (f) =>
        (f.required || f.needsClarification) &&
        !f.currentValue &&
        (!f.suggestedAnswer || f.suggestedAnswer.trim() === '')
    );
  }

  public getSnapshot(): SessionSnapshot {
    return {
      sessionState: this.state,
      browserStatus: this.browserManager.getStatus(),
      currentUrl: this.browserManager.getCurrentUrl(),
      pageTitle: this.pageTitle,
      humanTakeoverActive: this.state === 'HUMAN_TAKEOVER',
      isPaused: this.state === 'PAUSED',
      detectedFields: this.detectedFields,
      missingFields: this.getMissingFields(),
      validationErrors: this.validationErrors,
      lastExecutionReport: this.lastExecutionReport,
      activityLogs: this.activityLogs,
    };
  }

  /**
   * Starts the persistent Chromium browser session.
   */
  public async startBrowser(): Promise<SessionSnapshot> {
    this.log('info', 'Launching persistent Chromium session...');
    try {
      await this.browserManager.launch();
      this.setState('BROWSER_RUNNING');
      this.log('success', 'Browser running and ready.');
      return this.getSnapshot();
    } catch (error) {
      this.setState('FAILED');
      const msg = error instanceof Error ? error.message : String(error);
      this.log('error', `Failed to start browser: ${msg}`);
      throw error;
    }
  }

  /**
   * Stops the Chromium browser session and resets state to IDLE.
   */
  public async stopBrowser(): Promise<SessionSnapshot> {
    this.log('info', 'Stopping browser session...');
    await this.browserManager.close();
    this.detectedFields = [];
    this.validationErrors = [];
    this.lastExecutionReport = null;
    this.pageTitle = '';
    this.setState('IDLE');
    this.log('info', 'Browser stopped.');
    return this.getSnapshot();
  }

  /**
   * Navigates the browser to a user-provided URL.
   * Blocked during PAUSED or HUMAN_TAKEOVER.
   */
  public async navigateTo(url: string): Promise<SessionSnapshot> {
    this.assertNotLocked('navigate');

    if (!this.browserManager.isRunning()) {
      await this.startBrowser();
    }

    this.log('info', `Navigating to ${url}...`);
    const res = await this.browserManager.navigateTo(url);

    if (!res.success) {
      this.setState('FAILED');
      this.log('error', `Navigation failed: ${res.error}`);
      return this.getSnapshot();
    }

    this.pageTitle = res.title;
    this.detectedFields = [];
    this.validationErrors = [];
    this.setState('BROWSER_RUNNING');
    this.log('success', `Navigated to ${res.url} ("${res.title}")`);
    return this.getSnapshot();
  }

  /**
   * Inspects the current page for form fields and matches them against AnswerMemory.
   */
  public async inspectCurrentPage(): Promise<DetectedField[]> {
    this.assertNotLocked('inspect page');

    const page = this.browserManager.getActivePage();
    if (!page || !this.browserManager.isRunning()) {
      throw new Error('Browser is not running');
    }

    this.setState('INSPECTING');
    this.log('info', 'Inspecting current page for form fields...');

    try {
      const inspection = await this.formIntelligence.inspectPage(page);
      this.pageTitle = inspection.title;
      this.detectedFields = this.answerMemory.enrichDetectedFields(inspection.fields);
      this.validationErrors = await this.formExecutor.detectValidationErrors(page);

      const matchedCount = this.detectedFields.filter((f) => f.suggestedAnswer).length;
      const missingCount = this.getMissingFields().length;

      this.setState(this.detectedFields.length > 0 ? 'REVIEW_REQUIRED' : 'BROWSER_RUNNING');
      this.log(
        'success',
        `Detected ${this.detectedFields.length} fields (${matchedCount} matched with answers, ${missingCount} need clarification).`
      );
      this.emitSnapshot();
      return this.detectedFields;
    } catch (error) {
      this.setState('FAILED');
      const msg = error instanceof Error ? error.message : String(error);
      this.log('error', `Page inspection failed: ${msg}`);
      throw error;
    }
  }

  /**
   * Full form assistance workflow:
   * 1. Inspects page
   * 2. Fills all fields that have confident approved answers
   * 3. Re-inspects values and transitions to REVIEW_REQUIRED for human review
   */
  public async startFormAssistance(): Promise<SessionSnapshot> {
    this.assertNotLocked('run form assistance');

    await this.inspectCurrentPage();

    const instructions: FieldFillInstruction[] = this.detectedFields
      .filter((f) => f.suggestedAnswer && f.suggestedAnswer.trim() !== '')
      .map((f) => ({
        fieldId: f.id,
        selector: f.selector,
        type: f.type,
        value: f.suggestedAnswer!,
        label: f.label,
      }));

    if (instructions.length > 0) {
      await this.fillFields(instructions);
    } else {
      this.log('warn', 'No fields had matching saved answers to auto-fill.');
    }

    return this.getSnapshot();
  }

  /**
   * Fills specified fields on the active page and transitions to REVIEW_REQUIRED.
   */
  public async fillFields(instructions?: FieldFillInstruction[]): Promise<FormExecutionReport> {
    this.assertNotLocked('fill fields');

    const page = this.browserManager.getActivePage();
    if (!page || !this.browserManager.isRunning()) {
      throw new Error('Browser is not running');
    }

    const toFill: FieldFillInstruction[] =
      instructions ??
      this.detectedFields
        .filter((f) => f.suggestedAnswer && f.suggestedAnswer.trim() !== '')
        .map((f) => ({
          fieldId: f.id,
          selector: f.selector,
          type: f.type,
          value: f.suggestedAnswer!,
          label: f.label,
        }));

    this.setState('FILLING');
    this.log('info', `Filling ${toFill.length} form field(s)...`);

    try {
      const report = await this.formExecutor.fillFields(page, toFill);
      this.lastExecutionReport = report;
      this.validationErrors = report.validationErrors;

      // Refresh field values after filling
      const refreshed = await this.formIntelligence.inspectPage(page);
      this.detectedFields = this.answerMemory.enrichDetectedFields(refreshed.fields);

      this.setState('REVIEW_REQUIRED');
      this.log(
        'success',
        `Filled ${report.filledCount}/${report.totalAttempted} fields (${report.verifiedCount} verified). Ready for human review.`
      );
      this.emitSnapshot();
      return report;
    } catch (error) {
      this.setState('FAILED');
      const msg = error instanceof Error ? error.message : String(error);
      this.log('error', `Form filling failed: ${msg}`);
      throw error;
    }
  }

  /**
   * Uploads a resume file to a specific file input selector.
   */
  public async uploadResume(selector: string, filePath: string): Promise<SessionSnapshot> {
    this.assertNotLocked('upload resume');

    const page = this.browserManager.getActivePage();
    if (!page || !this.browserManager.isRunning()) {
      throw new Error('Browser is not running');
    }

    this.setState('FILLING');
    this.log('info', `Uploading resume from ${filePath}...`);

    const outcome = await this.formExecutor.uploadResume(page, selector, filePath);
    if (!outcome.success) {
      this.setState('REVIEW_REQUIRED');
      this.log('error', `Resume upload failed: ${outcome.error}`);
      throw new Error(outcome.error || 'Resume upload failed');
    }

    const refreshed = await this.formIntelligence.inspectPage(page);
    this.detectedFields = this.answerMemory.enrichDetectedFields(refreshed.fields);
    this.setState('REVIEW_REQUIRED');
    this.log('success', `Uploaded resume "${outcome.actualValue}" (verified: ${outcome.verified}).`);
    return this.getSnapshot();
  }

  /**
   * Pauses automation. Automation actions cannot execute while paused.
   */
  public pause(): SessionSnapshot {
    if (this.state !== 'PAUSED' && this.state !== 'HUMAN_TAKEOVER') {
      this.previousRunningState = this.state === 'IDLE' ? 'BROWSER_RUNNING' : this.state;
    }
    this.setState('PAUSED');
    this.log('warn', 'Automation paused by user.');
    return this.getSnapshot();
  }

  /**
   * Resumes automation from PAUSED or HUMAN_TAKEOVER.
   */
  public resume(): SessionSnapshot {
    if (this.state === 'PAUSED' || this.state === 'HUMAN_TAKEOVER') {
      const target = this.browserManager.isRunning()
        ? this.detectedFields.length > 0
          ? 'REVIEW_REQUIRED'
          : 'BROWSER_RUNNING'
        : 'IDLE';
      this.setState(target);
      this.log('info', `Automation resumed (state: ${target}).`);
    }
    return this.getSnapshot();
  }

  /**
   * Activates Human Takeover mode so the user can interact directly with Chromium
   * (locally or via VNC-over-SSH on Linux Mint X11) without automation interference.
   */
  public startHumanTakeover(reason = 'User requested manual browser control'): SessionSnapshot {
    if (this.state !== 'HUMAN_TAKEOVER' && this.state !== 'PAUSED') {
      this.previousRunningState = this.state;
    }
    this.setState('HUMAN_TAKEOVER');
    this.log('warn', `Human Takeover active: ${reason}. Automation controller locked.`);
    return this.getSnapshot();
  }

  /**
   * Ends Human Takeover mode and returns control to the session controller.
   */
  public async endHumanTakeover(): Promise<SessionSnapshot> {
    if (this.state === 'HUMAN_TAKEOVER') {
      const nextState = this.browserManager.isRunning()
        ? this.previousRunningState === 'IDLE'
          ? 'BROWSER_RUNNING'
          : this.previousRunningState
        : 'IDLE';
      this.setState(nextState);
      this.log('success', 'Human Takeover ended. Automation controller unlocked.');

      if (this.browserManager.isRunning()) {
        await this.inspectCurrentPage().catch(() => {});
      }
    }
    return this.getSnapshot();
  }

  /**
   * Approves and submits the form, recording the application in SQLite history.
   * Requires explicit user approval.
   */
  public async approveSubmission(options?: {
    company?: string;
    roleTitle?: string;
    notes?: string;
    submitSelector?: string;
    clickSubmitInBrowser?: boolean;
  }): Promise<SessionSnapshot> {
    this.assertNotLocked('submit application');

    const page = this.browserManager.getActivePage();
    if (!page || !this.browserManager.isRunning()) {
      throw new Error('Browser is not running');
    }

    const url = page.url();
    const shouldClick = options?.clickSubmitInBrowser ?? true;

    if (shouldClick) {
      const submitRes = await this.formExecutor.submitWithExplicitApproval(page, {
        userApproved: true,
        submitSelector: options?.submitSelector,
      });

      if (!submitRes.submitted) {
        this.log(
          'warn',
          `Submit button note: ${submitRes.error || 'Marked as submitted by user.'}`
        );
      }
    }

    const filledCount = this.detectedFields.filter((f) => f.currentValue || f.suggestedAnswer).length;

    this.answerMemory.addApplicationHistory({
      company: options?.company || this.extractCompanyFromTitle(this.pageTitle, url),
      roleTitle: options?.roleTitle || this.pageTitle || 'Job Application',
      url,
      status: 'SUBMITTED',
      filledFieldsCount: filledCount,
      notes: options?.notes || '',
    });

    this.setState('SUBMITTED');
    this.log('success', `Application approved and recorded as SUBMITTED for "${this.pageTitle || url}".`);
    return this.getSnapshot();
  }

  /**
   * Re-enriches currently detected fields after user updates saved answers or profile.
   */
  public refreshFieldSuggestions(): DetectedField[] {
    if (this.detectedFields.length > 0) {
      this.detectedFields = this.answerMemory.enrichDetectedFields(this.detectedFields);
      this.emitSnapshot();
    }
    return this.detectedFields;
  }

  private assertNotLocked(actionName: string): void {
    if (this.state === 'HUMAN_TAKEOVER') {
      throw new Error(
        `Cannot ${actionName}: Human Takeover is active. End Human Takeover before running automation.`
      );
    }
    if (this.state === 'PAUSED') {
      throw new Error(
        `Cannot ${actionName}: Session is PAUSED. Resume session before running automation.`
      );
    }
  }

  private setState(newState: SessionState): void {
    if (this.state !== newState) {
      const prev = this.state;
      this.state = newState;
      this.emit('stateChanged', newState, prev);
      this.emitSnapshot();
    }
  }

  private log(level: ActivityLevel, message: string): void {
    const entry: ActivityLogEntry = {
      id: `log-${++this.logCounter}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      level,
      message,
      state: this.state,
    };

    this.activityLogs.unshift(entry);
    if (this.activityLogs.length > MAX_ACTIVITY_LOGS) {
      this.activityLogs.length = MAX_ACTIVITY_LOGS;
    }

    this.emit('activityLogged', entry);
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    this.emit('snapshot', this.getSnapshot());
  }

  private bindBrowserEvents(): void {
    this.browserManager.on('pageNavigated', (res) => {
      this.pageTitle = res.title;
      this.emitSnapshot();
    });

    this.browserManager.on('browserCrashed', (err) => {
      this.setState('FAILED');
      this.log('error', `Browser crashed: ${err.message}`);
    });

    this.browserManager.on('closed', () => {
      if (this.state !== 'IDLE') {
        this.setState('IDLE');
        this.log('info', 'Browser session closed.');
      }
    });
  }

  private extractCompanyFromTitle(title: string, url: string): string {
    if (title) {
      const parts = title.split(/[-|–•@]/).map((s) => s.trim()).filter(Boolean);
      if (parts.length > 1) {
        return parts[parts.length - 1];
      }
    }
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'Company';
    }
  }
}
