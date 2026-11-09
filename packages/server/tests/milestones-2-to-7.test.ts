import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/api/server.js';
import { BrowserManager } from '../src/browser/browser-manager.js';
import { FormExecutor } from '../src/executor/form-executor.js';
import { FormIntelligence } from '../src/intelligence/form-intelligence.js';
import { AnswerMemory } from '../src/memory/answer-memory.js';
import { SessionController } from '../src/session/session-controller.js';

const SAMPLE_JOB_FORM_HTML = `
<!DOCTYPE html>
<html>
  <head>
    <title>Software Engineer - Acme Corp</title>
  </head>
  <body>
    <form id="job-form">
      <div>
        <label for="first_name">First Name *</label>
        <input id="first_name" name="first_name" type="text" required placeholder="Enter first name" />
      </div>
      <div>
        <label for="last_name">Last Name *</label>
        <input id="last_name" name="last_name" type="text" required />
      </div>
      <div>
        <label for="email">Email Address *</label>
        <input id="email" name="email" type="email" required />
      </div>
      <div>
        <label for="work_auth">Are you legally authorized to work?</label>
        <select id="work_auth" name="work_auth">
          <option value="">Select...</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
      </div>
      <div>
        <label>
          <input id="terms_check" name="terms" type="checkbox" />
          Acknowledge privacy policy
        </label>
      </div>
      <div>
        <label for="custom_question">Why do you want to join Acme Corp? *</label>
        <textarea id="custom_question" name="custom_question" required></textarea>
      </div>
      <div>
        <label for="resume_upload">Resume / CV *</label>
        <input id="resume_upload" name="resume" type="file" required />
      </div>
      <button type="submit" id="submit-btn" onclick="event.preventDefault(); document.body.setAttribute('data-submitted', 'true');">
        Submit Application
      </button>
    </form>
  </body>
</html>
`;

describe('Milestones 2 to 7 Integration Suite', () => {
  let tempDir: string;
  let browserManager: BrowserManager | null = null;
  let answerMemory: AnswerMemory | null = null;

  beforeEach(() => {
    tempDir = path.join(
      os.tmpdir(),
      `jobsearch-m2-7-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    );
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(async () => {
    if (browserManager) {
      await browserManager.close();
      browserManager = null;
    }
    if (answerMemory) {
      answerMemory.close();
      answerMemory = null;
    }
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup locks on Windows
      }
    }
  });

  describe('Milestone 5: Answer Memory & Profile Management (SQLite)', () => {
    it('should store and update user profile, save reusable answers, and never invent missing answers', () => {
      const dbPath = path.join(tempDir, 'memory.db');
      answerMemory = new AnswerMemory(dbPath);

      // Update profile
      const profile = answerMemory.updateProfile({
        firstName: 'Deepak',
        lastName: 'Gupta',
        email: 'deepak@example.com',
        workAuthorization: 'Yes',
      });

      expect(profile.firstName).toBe('Deepak');
      expect(profile.email).toBe('deepak@example.com');

      // Save custom answer
      const saved = answerMemory.upsertAnswer({
        rawQuestion: 'How many years of TypeScript experience do you have?',
        answer: '5',
        category: 'experience',
      });
      expect(saved.answer).toBe('5');

      // Match known profile field
      const firstNameMatch = answerMemory.matchField({
        id: 'f1',
        selector: '#first_name',
        tagName: 'input',
        type: 'text',
        name: 'first_name',
        elementId: 'first_name',
        label: 'First Name',
        placeholder: '',
        ariaLabel: '',
        required: true,
        currentValue: '',
      });
      expect(firstNameMatch.answer).toBe('Deepak');
      expect(firstNameMatch.needsClarification).toBe(false);
      expect(firstNameMatch.confidence).toBeGreaterThanOrEqual(0.9);

      // Unknown question must NEVER invent personal information
      const unknownMatch = answerMemory.matchField({
        id: 'f2',
        selector: '#security_clearance',
        tagName: 'input',
        type: 'text',
        name: 'security_clearance',
        elementId: 'security_clearance',
        label: 'Active DoD Security Clearance Number',
        placeholder: '',
        ariaLabel: '',
        required: true,
        currentValue: '',
      });
      expect(unknownMatch.answer).toBeNull();
      expect(unknownMatch.confidence).toBe(0);
      expect(unknownMatch.needsClarification).toBe(true);
    });
  });

  describe('Milestone 3, 4, 6, 7: Form Intelligence, Executor, Human Takeover & Approval', () => {
    it('should detect form fields, lock during human takeover, fill verified values, upload resume, and require approval to submit', async () => {
      browserManager = new BrowserManager({
        userDataDir: path.join(tempDir, 'profile'),
        headless: true,
      });
      answerMemory = new AnswerMemory(path.join(tempDir, 'test.db'));
      const formIntelligence = new FormIntelligence();
      const formExecutor = new FormExecutor();
      const controller = new SessionController(
        browserManager,
        formIntelligence,
        answerMemory,
        formExecutor
      );

      // Create dummy resume file
      const resumeFile = path.join(tempDir, 'Deepak_Resume.pdf');
      fs.writeFileSync(resumeFile, '%PDF-1.4 dummy resume content');

      // Populate profile & custom answer
      answerMemory.updateProfile({
        firstName: 'Deepak',
        lastName: 'Gupta',
        email: 'deepak@example.com',
        workAuthorization: 'Yes',
        resumePath: resumeFile,
      });
      answerMemory.upsertAnswer({
        rawQuestion: 'Acknowledge privacy policy',
        answer: 'true',
      });

      // Navigate to sample job form
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(SAMPLE_JOB_FORM_HTML)}`;
      await controller.navigateTo(dataUrl);
      expect(controller.getState()).toBe('BROWSER_RUNNING');

      // Milestone 3: Activate Human Takeover & verify automation lockout
      controller.startHumanTakeover('Solving CAPTCHA');
      expect(controller.getState()).toBe('HUMAN_TAKEOVER');
      await expect(controller.inspectCurrentPage()).rejects.toThrow(/Human Takeover is active/i);
      await expect(controller.fillFields()).rejects.toThrow(/Human Takeover is active/i);

      // End Human Takeover -> automatically inspects page (Milestone 4)
      const snapAfterTakeover = await controller.endHumanTakeover();
      expect(snapAfterTakeover.sessionState).toBe('REVIEW_REQUIRED');
      expect(snapAfterTakeover.detectedFields.length).toBe(7);

      // Verify missing fields detection ("Why do you want to join Acme Corp?" has no saved answer yet)
      expect(snapAfterTakeover.missingFields.some((f) => f.elementId === 'custom_question')).toBe(
        true
      );

      // Save answer for the missing custom question
      answerMemory.upsertAnswer({
        rawQuestion: 'Why do you want to join Acme Corp?',
        answer: 'Passionate about building reliable automation systems.',
      });
      controller.refreshFieldSuggestions();
      expect(controller.getMissingFields()).toHaveLength(0);

      // Milestone 6: Run Form Assistance (fills fields + uploads resume + verifies values)
      const assistedSnap = await controller.startFormAssistance();
      expect(assistedSnap.sessionState).toBe('REVIEW_REQUIRED');
      expect(assistedSnap.lastExecutionReport?.filledCount).toBe(7);
      expect(assistedSnap.lastExecutionReport?.verifiedCount).toBe(7);

      // Verify form was NOT automatically submitted
      const page = browserManager.getActivePage()!;
      const submittedBeforeApproval = await page.evaluate(() =>
        document.body.getAttribute('data-submitted')
      );
      expect(submittedBeforeApproval).toBeNull();

      // Milestone 7: Explicit user submission approval & application history
      const submittedSnap = await controller.approveSubmission({
        company: 'Acme Corp',
        roleTitle: 'Software Engineer',
        notes: 'Applied via automated test',
      });
      expect(submittedSnap.sessionState).toBe('SUBMITTED');

      const submittedAfterApproval = await page.evaluate(() =>
        document.body.getAttribute('data-submitted')
      );
      expect(submittedAfterApproval).toBe('true');

      const history = answerMemory.listApplicationHistory();
      expect(history).toHaveLength(1);
      expect(history[0].company).toBe('Acme Corp');
      expect(history[0].roleTitle).toBe('Software Engineer');
      expect(history[0].status).toBe('SUBMITTED');
    });
  });

  describe('Milestone 2: Fastify API Server & WebSocket Updates', () => {
    it('should expose REST control APIs for profile, memory, pause/resume, and history', async () => {
      browserManager = new BrowserManager({
        userDataDir: path.join(tempDir, 'api-profile'),
        headless: true,
      });
      answerMemory = new AnswerMemory(path.join(tempDir, 'api.db'));

      const { app } = await createServer({
        browserManager,
        answerMemory,
      });

      // Health check
      const healthRes = await app.inject({ method: 'GET', url: '/api/health' });
      expect(healthRes.statusCode).toBe(200);
      expect(healthRes.json().ok).toBe(true);

      // Update profile via API
      const putProfileRes = await app.inject({
        method: 'PUT',
        url: '/api/profile',
        payload: { firstName: 'Deepak', email: 'deepak@example.com' },
      });
      expect(putProfileRes.statusCode).toBe(200);
      expect(putProfileRes.json().firstName).toBe('Deepak');

      // Save answer via API
      const saveAnsRes = await app.inject({
        method: 'POST',
        url: '/api/memory/answers',
        payload: {
          rawQuestion: 'Notice Period',
          answer: '2 weeks',
          category: 'experience',
        },
      });
      expect(saveAnsRes.statusCode).toBe(200);
      expect(saveAnsRes.json().answer).toBe('2 weeks');

      // Pause & resume via API
      const pauseRes = await app.inject({ method: 'POST', url: '/api/session/pause' });
      expect(pauseRes.statusCode).toBe(200);
      expect(pauseRes.json().sessionState).toBe('PAUSED');

      // Navigating while paused must return 409 Conflict
      const blockedNav = await app.inject({
        method: 'POST',
        url: '/api/browser/navigate',
        payload: { url: 'https://example.com' },
      });
      expect(blockedNav.statusCode).toBe(409);

      const resumeRes = await app.inject({ method: 'POST', url: '/api/session/resume' });
      expect(resumeRes.statusCode).toBe(200);
      expect(resumeRes.json().isPaused).toBe(false);

      await app.close();
    });
  });
});
