import fs from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BrowserManager } from '../browser/browser-manager.js';
import { FormExecutor } from '../executor/form-executor.js';
import { FormIntelligence } from '../intelligence/form-intelligence.js';
import { AnswerMemory } from '../memory/answer-memory.js';
import { SessionController } from '../session/session-controller.js';

export interface CreateServerOptions {
  browserManager?: BrowserManager;
  formIntelligence?: FormIntelligence;
  answerMemory?: AnswerMemory;
  formExecutor?: FormExecutor;
  sessionController?: SessionController;
  dashboardDistPath?: string;
  logger?: boolean;
}

const NavigateBodySchema = z.object({
  url: z.string().min(1, 'URL is required'),
});

const TakeoverStartBodySchema = z.object({
  reason: z.string().optional(),
});

const FillBodySchema = z.object({
  instructions: z
    .array(
      z.object({
        fieldId: z.string(),
        selector: z.string(),
        type: z.enum([
          'text',
          'email',
          'tel',
          'url',
          'number',
          'password',
          'textarea',
          'select',
          'radio',
          'checkbox',
          'file',
          'date',
          'unknown',
        ]),
        value: z.string(),
        label: z.string().optional(),
      })
    )
    .optional(),
});

const UploadResumeBodySchema = z.object({
  selector: z.string().min(1),
  filePath: z.string().min(1),
});

const UpsertAnswerBodySchema = z.object({
  rawQuestion: z.string().min(1, 'Question is required'),
  answer: z.string(),
  category: z.enum(['profile', 'experience', 'legal', 'custom']).optional(),
  aliases: z.array(z.string()).optional(),
});

const ApproveSubmitBodySchema = z.object({
  company: z.string().optional(),
  roleTitle: z.string().optional(),
  notes: z.string().optional(),
  submitSelector: z.string().optional(),
  clickSubmitInBrowser: z.boolean().optional(),
});

const CreateHistoryBodySchema = z.object({
  company: z.string().min(1),
  roleTitle: z.string().min(1),
  url: z.string().min(1),
  status: z.enum(['SUBMITTED', 'REVIEW_REQUIRED', 'IN_PROGRESS', 'FAILED']),
  filledFieldsCount: z.number().optional(),
  notes: z.string().optional(),
});

export async function createServer(options: CreateServerOptions = {}): Promise<{
  app: FastifyInstance;
  browserManager: BrowserManager;
  answerMemory: AnswerMemory;
  sessionController: SessionController;
}> {
  const browserManager = options.browserManager ?? new BrowserManager();
  const formIntelligence = options.formIntelligence ?? new FormIntelligence();
  const answerMemory = options.answerMemory ?? new AnswerMemory(':memory:');
  const formExecutor = options.formExecutor ?? new FormExecutor();
  const sessionController =
    options.sessionController ??
    new SessionController(browserManager, formIntelligence, answerMemory, formExecutor);

  const app = Fastify({
    logger: options.logger ?? false,
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(websocket);

  // Track connected WebSocket clients for real-time broadcasts
  const clients = new Set<{ send: (data: string) => void; readyState: number }>();

  const broadcastSnapshot = () => {
    if (clients.size === 0) return;
    const message = JSON.stringify({
      type: 'SNAPSHOT',
      payload: sessionController.getSnapshot(),
    });
    for (const client of clients) {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch {
          clients.delete(client);
        }
      }
    }
  };

  sessionController.on('snapshot', broadcastSnapshot);

  // WebSocket endpoint for real-time status & activity logs
  app.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);

    // Send initial snapshot immediately upon connection
    socket.send(
      JSON.stringify({
        type: 'SNAPSHOT',
        payload: sessionController.getSnapshot(),
      })
    );

    socket.on('close', () => {
      clients.delete(socket);
    });
  });

  // Health & Status
  app.get('/api/health', async () => ({
    ok: true,
    sessionState: sessionController.getState(),
    browserStatus: browserManager.getStatus(),
  }));

  app.get('/api/session/status', async () => {
    return sessionController.getSnapshot();
  });

  app.get('/api/session/fields', async () => ({
    fields: sessionController.getDetectedFields(),
    missingFields: sessionController.getMissingFields(),
  }));

  // Browser Lifecycle Control APIs
  app.post('/api/browser/start', async (_req, reply) => {
    try {
      const snapshot = await sessionController.startBrowser();
      return snapshot;
    } catch (error) {
      return reply.status(500).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/browser/stop', async (_req, reply) => {
    try {
      const snapshot = await sessionController.stopBrowser();
      return snapshot;
    } catch (error) {
      return reply.status(500).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/browser/navigate', async (req, reply) => {
    const parsed = NavigateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid body' });
    }

    try {
      const snapshot = await sessionController.navigateTo(parsed.data.url);
      return snapshot;
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Form Intelligence & Execution APIs
  app.post('/api/session/inspect', async (_req, reply) => {
    try {
      await sessionController.inspectCurrentPage();
      return sessionController.getSnapshot();
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/session/assist', async (_req, reply) => {
    try {
      const snapshot = await sessionController.startFormAssistance();
      return snapshot;
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/session/fill', async (req, reply) => {
    const parsed = FillBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid body' });
    }

    try {
      await sessionController.fillFields(parsed.data.instructions);
      return sessionController.getSnapshot();
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/session/upload-resume', async (req, reply) => {
    const parsed = UploadResumeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid body' });
    }

    try {
      const snapshot = await sessionController.uploadResume(
        parsed.data.selector,
        parsed.data.filePath
      );
      return snapshot;
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Pause, Resume & Human Takeover APIs
  app.post('/api/session/pause', async () => {
    return sessionController.pause();
  });

  app.post('/api/session/resume', async () => {
    return sessionController.resume();
  });

  app.post('/api/session/takeover/start', async (req) => {
    const parsed = TakeoverStartBodySchema.safeParse(req.body ?? {});
    return sessionController.startHumanTakeover(parsed.success ? parsed.data.reason : undefined);
  });

  app.post('/api/session/takeover/end', async () => {
    return sessionController.endHumanTakeover();
  });

  // Explicit Submission Approval API (Milestone 7)
  app.post('/api/session/approve-submit', async (req, reply) => {
    const parsed = ApproveSubmitBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid body' });
    }

    try {
      const snapshot = await sessionController.approveSubmission(parsed.data);
      return snapshot;
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Profile & Answer Memory APIs (Milestone 5)
  app.get('/api/profile', async () => {
    return answerMemory.getProfile();
  });

  app.put('/api/profile', async (req) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const updated = answerMemory.updateProfile(body);
    sessionController.refreshFieldSuggestions();
    return updated;
  });

  app.get('/api/memory/answers', async () => {
    return { answers: answerMemory.listAnswers() };
  });

  app.post('/api/memory/answers', async (req, reply) => {
    const parsed = UpsertAnswerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid body' });
    }

    try {
      const saved = answerMemory.upsertAnswer(parsed.data);
      sessionController.refreshFieldSuggestions();
      return saved;
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/memory/answers/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid ID' });
    }
    const deleted = answerMemory.deleteAnswer(id);
    sessionController.refreshFieldSuggestions();
    return { deleted };
  });

  // Application History APIs (Milestone 7)
  app.get('/api/history', async () => {
    return { history: answerMemory.listApplicationHistory() };
  });

  app.post('/api/history', async (req, reply) => {
    const parsed = CreateHistoryBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid body' });
    }
    const entry = answerMemory.addApplicationHistory(parsed.data);
    return entry;
  });

  // Serve built React dashboard in production if present (keeps Node.js to 1 process on 4GB machine)
  const distDir =
    options.dashboardDistPath ??
    path.resolve(process.cwd(), '..', 'dashboard', 'dist');

  if (fs.existsSync(distDir)) {
    await app.register(fastifyStatic, {
      root: distDir,
      prefix: '/',
    });
  }

  return {
    app,
    browserManager,
    answerMemory,
    sessionController,
  };
}
