import React, { useEffect, useState } from 'react';
import type {
  ApplicationHistoryEntry,
  DetectedField,
  SavedAnswer,
  SessionSnapshot,
  SessionState,
  UserProfile,
} from './types';

const INITIAL_SNAPSHOT: SessionSnapshot = {
  sessionState: 'IDLE',
  browserStatus: 'DISCONNECTED',
  currentUrl: null,
  pageTitle: '',
  humanTakeoverActive: false,
  isPaused: false,
  detectedFields: [],
  missingFields: [],
  validationErrors: [],
  activityLogs: [],
};

const EMPTY_PROFILE: UserProfile = {
  fullName: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  location: '',
  linkedinUrl: '',
  githubUrl: '',
  portfolioUrl: '',
  resumePath: '',
  yearsOfExperience: '',
  workAuthorization: '',
  sponsorshipRequired: '',
  salaryExpectation: '',
  noticePeriod: '',
  summary: '',
};

const STATE_BADGE_COLORS: Record<SessionState, string> = {
  IDLE: 'bg-slate-700 text-slate-200',
  BROWSER_RUNNING: 'bg-emerald-900/70 text-emerald-300 border border-emerald-700',
  INSPECTING: 'bg-sky-900/70 text-sky-300 border border-sky-700',
  FILLING: 'bg-indigo-900/70 text-indigo-300 border border-indigo-700',
  PAUSED: 'bg-amber-900/70 text-amber-300 border border-amber-700',
  HUMAN_TAKEOVER: 'bg-purple-900/80 text-purple-200 border border-purple-500 animate-pulse',
  REVIEW_REQUIRED: 'bg-cyan-900/70 text-cyan-200 border border-cyan-600',
  SUBMITTED: 'bg-green-900/80 text-green-200 border border-green-600',
  FAILED: 'bg-rose-900/80 text-rose-200 border border-rose-600',
};

export default function App() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(INITIAL_SNAPSHOT);
  const [wsConnected, setWsConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<'workspace' | 'memory' | 'history'>('workspace');
  const [urlInput, setUrlInput] = useState('');
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Field answer draft overrides keyed by field.id
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, string>>({});

  // Submission approval metadata
  const [submitCompany, setSubmitCompany] = useState('');
  const [submitRole, setSubmitRole] = useState('');
  const [submitNotes, setSubmitNotes] = useState('');

  // Profile & Answer memory state
  const [profile, setProfile] = useState<UserProfile>(EMPTY_PROFILE);
  const [savedAnswers, setSavedAnswers] = useState<SavedAnswer[]>([]);
  const [newQuestion, setNewQuestion] = useState('');
  const [newAnswer, setNewAnswer] = useState('');
  const [newCategory, setNewCategory] = useState<'profile' | 'experience' | 'legal' | 'custom'>('custom');

  // Application history state
  const [history, setHistory] = useState<ApplicationHistoryEntry[]>([]);

  useEffect(() => {
    void fetchInitialData();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connectWs = () => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimer = setTimeout(connectWs, 3000);
      };
      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as {
            type: string;
            payload: SessionSnapshot;
          };
          if (parsed.type === 'SNAPSHOT' && parsed.payload) {
            setSnapshot(parsed.payload);
          }
        } catch {
          // ignore malformed messages
        }
      };
    };

    connectWs();

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  async function fetchInitialData() {
    try {
      const [statusRes, profileRes, answersRes, historyRes] = await Promise.all([
        fetch('/api/session/status'),
        fetch('/api/profile'),
        fetch('/api/memory/answers'),
        fetch('/api/history'),
      ]);

      if (statusRes.ok) {
        const snap = (await statusRes.json()) as SessionSnapshot;
        setSnapshot(snap);
        if (snap.currentUrl && !urlInput) {
          setUrlInput(snap.currentUrl);
        }
      }
      if (profileRes.ok) {
        setProfile((await profileRes.json()) as UserProfile);
      }
      if (answersRes.ok) {
        const data = (await answersRes.json()) as { answers: SavedAnswer[] };
        setSavedAnswers(data.answers);
      }
      if (historyRes.ok) {
        const data = (await historyRes.json()) as { history: ApplicationHistoryEntry[] };
        setHistory(data.history);
      }
    } catch {
      // Server may not be reachable yet
    }
  }

  async function callApi<T = SessionSnapshot>(
    path: string,
    options?: RequestInit
  ): Promise<T | null> {
    setErrorBanner(null);
    setBusy(true);
    try {
      const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorBanner(data.error || `Request failed with status ${res.status}`);
        return null;
      }
      return data as T;
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleStartBrowser() {
    const snap = await callApi('/api/browser/start', { method: 'POST', body: '{}' });
    if (snap) setSnapshot(snap);
  }

  async function handleStopBrowser() {
    const snap = await callApi('/api/browser/stop', { method: 'POST', body: '{}' });
    if (snap) setSnapshot(snap);
  }

  async function handleNavigate(e: React.FormEvent) {
    e.preventDefault();
    if (!urlInput.trim()) return;
    const snap = await callApi('/api/browser/navigate', {
      method: 'POST',
      body: JSON.stringify({ url: urlInput.trim() }),
    });
    if (snap) setSnapshot(snap);
  }

  async function handleInspect() {
    const snap = await callApi('/api/session/inspect', { method: 'POST', body: '{}' });
    if (snap) setSnapshot(snap);
  }

  async function handleAutoAssist() {
    const snap = await callApi('/api/session/assist', { method: 'POST', body: '{}' });
    if (snap) setSnapshot(snap);
  }

  async function handlePause() {
    const snap = await callApi('/api/session/pause', { method: 'POST', body: '{}' });
    if (snap) setSnapshot(snap);
  }

  async function handleResume() {
    const snap = await callApi('/api/session/resume', { method: 'POST', body: '{}' });
    if (snap) setSnapshot(snap);
  }

  async function handleStartTakeover() {
    const snap = await callApi('/api/session/takeover/start', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Manual interaction requested from Dashboard' }),
    });
    if (snap) setSnapshot(snap);
  }

  async function handleEndTakeover() {
    const snap = await callApi('/api/session/takeover/end', { method: 'POST', body: '{}' });
    if (snap) setSnapshot(snap);
  }

  async function handleSaveFieldAnswer(field: DetectedField, value: string, alsoFill: boolean) {
    if (!value.trim()) return;
    await callApi<SavedAnswer>('/api/memory/answers', {
      method: 'POST',
      body: JSON.stringify({
        rawQuestion: field.label,
        answer: value.trim(),
        category: 'custom',
      }),
    });

    const answersRes = await fetch('/api/memory/answers');
    if (answersRes.ok) {
      const data = (await answersRes.json()) as { answers: SavedAnswer[] };
      setSavedAnswers(data.answers);
    }

    if (alsoFill) {
      const snap = await callApi('/api/session/fill', {
        method: 'POST',
        body: JSON.stringify({
          instructions: [
            {
              fieldId: field.id,
              selector: field.selector,
              type: field.type,
              value: value.trim(),
              label: field.label,
            },
          ],
        }),
      });
      if (snap) setSnapshot(snap);
    }
  }

  async function handleApproveSubmit(e: React.FormEvent) {
    e.preventDefault();
    const snap = await callApi('/api/session/approve-submit', {
      method: 'POST',
      body: JSON.stringify({
        company: submitCompany || undefined,
        roleTitle: submitRole || undefined,
        notes: submitNotes || undefined,
        clickSubmitInBrowser: true,
      }),
    });
    if (snap) {
      setSnapshot(snap);
      setSubmitCompany('');
      setSubmitRole('');
      setSubmitNotes('');
      const historyRes = await fetch('/api/history');
      if (historyRes.ok) {
        const data = (await historyRes.json()) as { history: ApplicationHistoryEntry[] };
        setHistory(data.history);
      }
    }
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    const updated = await callApi<UserProfile>('/api/profile', {
      method: 'PUT',
      body: JSON.stringify(profile),
    });
    if (updated) setProfile(updated);
  }

  async function handleAddMemoryAnswer(e: React.FormEvent) {
    e.preventDefault();
    if (!newQuestion.trim() || !newAnswer.trim()) return;
    await callApi<SavedAnswer>('/api/memory/answers', {
      method: 'POST',
      body: JSON.stringify({
        rawQuestion: newQuestion.trim(),
        answer: newAnswer.trim(),
        category: newCategory,
      }),
    });
    setNewQuestion('');
    setNewAnswer('');
    const answersRes = await fetch('/api/memory/answers');
    if (answersRes.ok) {
      const data = (await answersRes.json()) as { answers: SavedAnswer[] };
      setSavedAnswers(data.answers);
    }
  }

  async function handleDeleteAnswer(id: number) {
    await callApi(`/api/memory/answers/${id}`, { method: 'DELETE' });
    setSavedAnswers((prev) => prev.filter((a) => a.id !== id));
  }

  const isLocked = snapshot.humanTakeoverActive || snapshot.isPaused;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Header Bar */}
      <header className="border-b border-slate-800 bg-slate-900/80 px-6 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold tracking-tight text-white">
            Job Application Assistant
          </h1>
          <span
            className={`px-3 py-1 rounded-full text-xs font-semibold ${
              STATE_BADGE_COLORS[snapshot.sessionState]
            }`}
          >
            {snapshot.sessionState}
          </span>
          <span className="text-xs text-slate-400">
            Browser: <strong className="text-slate-200">{snapshot.browserStatus}</strong>
          </span>
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <span
              className={`w-2 h-2 rounded-full ${
                wsConnected ? 'bg-emerald-400' : 'bg-rose-500'
              }`}
            />
            {wsConnected ? 'Live WS' : 'Offline'}
          </span>
        </div>

        {/* Browser & Session Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {snapshot.browserStatus === 'DISCONNECTED' || snapshot.browserStatus === 'CLOSED' ? (
            <button
              onClick={handleStartBrowser}
              disabled={busy}
              className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-xs font-medium text-white cursor-pointer"
            >
              Start Browser
            </button>
          ) : (
            <button
              onClick={handleStopBrowser}
              disabled={busy}
              className="px-3.5 py-1.5 rounded-lg bg-rose-700 hover:bg-rose-600 disabled:opacity-50 text-xs font-medium text-white cursor-pointer"
            >
              Stop Browser
            </button>
          )}

          {!snapshot.isPaused ? (
            <button
              onClick={handlePause}
              disabled={busy || snapshot.sessionState === 'IDLE'}
              className="px-3.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-xs font-medium text-white cursor-pointer"
            >
              Pause
            </button>
          ) : (
            <button
              onClick={handleResume}
              disabled={busy}
              className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-xs font-medium text-white cursor-pointer"
            >
              Resume
            </button>
          )}

          {!snapshot.humanTakeoverActive ? (
            <button
              onClick={handleStartTakeover}
              disabled={busy || snapshot.sessionState === 'IDLE'}
              className="px-3.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-xs font-medium text-white cursor-pointer"
            >
              Human Takeover
            </button>
          ) : (
            <button
              onClick={handleEndTakeover}
              disabled={busy}
              className="px-3.5 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-400 ring-2 ring-purple-300 text-xs font-semibold text-white cursor-pointer"
            >
              End Takeover & Resume
            </button>
          )}
        </div>
      </header>

      {/* Human Takeover Banner */}
      {snapshot.humanTakeoverActive && (
        <div className="bg-purple-950/90 border-b border-purple-700 px-6 py-3 flex items-center justify-between">
          <div className="text-sm text-purple-200">
            <strong>Human Takeover Active:</strong> All automated browser actions are locked while you interact with the Chromium window directly (local desktop or via VNC tunnel <code className="bg-purple-900 px-1.5 py-0.5 rounded text-xs">localhost:5900</code>).
          </div>
          <button
            onClick={handleEndTakeover}
            className="px-3 py-1 rounded bg-purple-600 hover:bg-purple-500 text-xs font-semibold text-white cursor-pointer"
          >
            Return Control to Assistant
          </button>
        </div>
      )}

      {/* Error Banner */}
      {errorBanner && (
        <div className="bg-rose-950/90 border-b border-rose-800 px-6 py-2.5 text-xs text-rose-200 flex items-center justify-between">
          <span>{errorBanner}</span>
          <button
            onClick={() => setErrorBanner(null)}
            className="text-rose-400 hover:text-white font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="border-b border-slate-800 bg-slate-900/40 px-6 flex gap-6 text-sm">
        <button
          onClick={() => setActiveTab('workspace')}
          className={`py-3 border-b-2 font-medium cursor-pointer ${
            activeTab === 'workspace'
              ? 'border-sky-500 text-sky-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          Form Workspace ({snapshot.detectedFields.length})
        </button>
        <button
          onClick={() => setActiveTab('memory')}
          className={`py-3 border-b-2 font-medium cursor-pointer ${
            activeTab === 'memory'
              ? 'border-sky-500 text-sky-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          Profile & Answer Memory ({savedAnswers.length})
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`py-3 border-b-2 font-medium cursor-pointer ${
            activeTab === 'history'
              ? 'border-sky-500 text-sky-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          Application History ({history.length})
        </button>
      </div>

      {/* Main Content Layout */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 p-6">
        {/* Left/Center 2 Columns */}
        <div className="lg:col-span-2 space-y-6">
          {activeTab === 'workspace' && (
            <>
              {/* URL Bar & Page Actions */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
                <form onSubmit={handleNavigate} className="flex gap-2">
                  <input
                    type="text"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="Enter job application URL (e.g. boards.greenhouse.io/...)"
                    disabled={isLocked}
                    className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3.5 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={busy || isLocked || !urlInput.trim()}
                    className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-sm font-medium text-white cursor-pointer"
                  >
                    Navigate
                  </button>
                  <button
                    type="button"
                    onClick={handleInspect}
                    disabled={busy || isLocked || snapshot.sessionState === 'IDLE'}
                    className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-sm font-medium text-slate-200 cursor-pointer"
                  >
                    Inspect Page
                  </button>
                  <button
                    type="button"
                    onClick={handleAutoAssist}
                    disabled={busy || isLocked || snapshot.sessionState === 'IDLE'}
                    className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-sm font-medium text-white cursor-pointer"
                  >
                    Auto-Fill Known Fields
                  </button>
                </form>

                {/* Active Page Metadata */}
                <div className="flex flex-wrap items-center justify-between text-xs text-slate-400 pt-1">
                  <div className="truncate max-w-xl">
                    <span className="text-slate-500">Current Page:</span>{' '}
                    <span className="text-slate-200 font-medium">
                      {snapshot.pageTitle || 'No page loaded'}
                    </span>{' '}
                    {snapshot.currentUrl && (
                      <span className="text-slate-400">({snapshot.currentUrl})</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Missing Information Alert */}
              {snapshot.missingFields.length > 0 && (
                <div className="bg-amber-950/40 border border-amber-800/80 rounded-xl p-4 space-y-2">
                  <h2 className="text-sm font-semibold text-amber-300">
                    Missing Information / Clarification Needed ({snapshot.missingFields.length})
                  </h2>
                  <p className="text-xs text-amber-200/80">
                    The assistant never invents personal data. Provide answers for the fields below to save them to Answer Memory and populate the form:
                  </p>
                  <ul className="text-xs text-amber-100 list-disc list-inside space-y-1">
                    {snapshot.missingFields.map((mf) => (
                      <li key={mf.id}>
                        <strong>{mf.label}</strong> ({mf.type}
                        {mf.required ? ', required' : ''})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Validation Errors */}
              {snapshot.validationErrors.length > 0 && (
                <div className="bg-rose-950/40 border border-rose-800 rounded-xl p-4 space-y-2">
                  <h2 className="text-sm font-semibold text-rose-300">
                    Form Validation Errors ({snapshot.validationErrors.length})
                  </h2>
                  <ul className="text-xs text-rose-200 list-disc list-inside space-y-1">
                    {snapshot.validationErrors.map((err, i) => (
                      <li key={i}>
                        <strong>{err.label}:</strong> {err.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Detected Form Fields Table */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-200">
                    Detected Form Fields ({snapshot.detectedFields.length})
                  </h2>
                </div>

                {snapshot.detectedFields.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-500">
                    No fields inspected yet. Navigate to a job application page and click{' '}
                    <strong className="text-slate-300">Inspect Page</strong> or{' '}
                    <strong className="text-slate-300">Auto-Fill Known Fields</strong>.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-800">
                    {snapshot.detectedFields.map((field) => {
                      const draftVal =
                        fieldDrafts[field.id] ??
                        field.suggestedAnswer ??
                        field.currentValue ??
                        '';

                      return (
                        <div key={field.id} className="p-4 space-y-2 hover:bg-slate-800/30">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-white">
                                {field.label}
                              </span>
                              {field.required && (
                                <span className="px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800 text-[10px] font-semibold">
                                  Required
                                </span>
                              )}
                              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px] font-mono">
                                {field.type}
                              </span>
                            </div>

                            <div className="flex items-center gap-2 text-xs">
                              {field.confidence && field.confidence > 0 ? (
                                <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">
                                  Matched ({Math.round(field.confidence * 100)}%)
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800">
                                  Needs Answer
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="text-xs text-slate-400 flex flex-wrap gap-4">
                            <span>
                              Current DOM Value:{' '}
                              <strong className="text-slate-200">
                                {field.currentValue || '(empty)'}
                              </strong>
                            </span>
                            {field.suggestedAnswer && (
                              <span>
                                Suggested:{' '}
                                <strong className="text-emerald-300">
                                  {field.suggestedAnswer}
                                </strong>
                              </span>
                            )}
                          </div>

                          <div className="flex gap-2 pt-1">
                            <input
                              type="text"
                              value={draftVal}
                              onChange={(e) =>
                                setFieldDrafts((prev) => ({
                                  ...prev,
                                  [field.id]: e.target.value,
                                }))
                              }
                              placeholder={
                                field.type === 'file'
                                  ? 'Absolute path to resume file...'
                                  : `Enter answer for "${field.label}"...`
                              }
                              className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
                            />
                            <button
                              type="button"
                              disabled={busy || isLocked || !draftVal.trim()}
                              onClick={() => handleSaveFieldAnswer(field, draftVal, true)}
                              className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-xs font-medium text-white cursor-pointer"
                            >
                              Save & Fill
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Explicit Submission Approval Panel */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-white">
                      Submission Review & Explicit Approval
                    </h2>
                    <p className="text-xs text-slate-400">
                      The assistant will never submit an application automatically. Review the filled fields in the browser, then approve below.
                    </p>
                  </div>
                </div>

                <form onSubmit={handleApproveSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                  <input
                    type="text"
                    value={submitCompany}
                    onChange={(e) => setSubmitCompany(e.target.value)}
                    placeholder="Company Name (optional)"
                    className="rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  />
                  <input
                    type="text"
                    value={submitRole}
                    onChange={(e) => setSubmitRole(e.target.value)}
                    placeholder="Role Title (optional)"
                    className="rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  />
                  <input
                    type="text"
                    value={submitNotes}
                    onChange={(e) => setSubmitNotes(e.target.value)}
                    placeholder="Notes (optional)"
                    className="rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  />
                  <div className="md:col-span-3 flex justify-end">
                    <button
                      type="submit"
                      disabled={busy || isLocked || snapshot.sessionState === 'IDLE'}
                      className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-xs font-semibold text-white cursor-pointer"
                    >
                      Approve & Submit Application
                    </button>
                  </div>
                </form>
              </div>
            </>
          )}

          {activeTab === 'memory' && (
            <div className="space-y-6">
              {/* Canonical Profile Editor */}
              <form
                onSubmit={handleSaveProfile}
                className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-white">
                    Reusable Candidate Profile
                  </h2>
                  <button
                    type="submit"
                    disabled={busy}
                    className="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-medium text-white cursor-pointer"
                  >
                    Save Profile
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  {(Object.keys(EMPTY_PROFILE) as Array<keyof UserProfile>).map((key) => (
                    <div key={key} className="space-y-1">
                      <label className="block text-slate-400 capitalize">
                        {key.replace(/([A-Z])/g, ' $1')}
                      </label>
                      <input
                        type="text"
                        value={profile[key]}
                        onChange={(e) =>
                          setProfile((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                        className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-slate-100"
                      />
                    </div>
                  ))}
                </div>
              </form>

              {/* Saved Question-Answer Mappings */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <h2 className="text-sm font-semibold text-white">
                  Answer Memory ({savedAnswers.length})
                </h2>

                <form onSubmit={handleAddMemoryAnswer} className="flex flex-wrap gap-2">
                  <input
                    type="text"
                    value={newQuestion}
                    onChange={(e) => setNewQuestion(e.target.value)}
                    placeholder="Application question / label..."
                    className="flex-1 min-w-[200px] rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  />
                  <input
                    type="text"
                    value={newAnswer}
                    onChange={(e) => setNewAnswer(e.target.value)}
                    placeholder="Approved answer..."
                    className="flex-1 min-w-[200px] rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  />
                  <select
                    value={newCategory}
                    onChange={(e) =>
                      setNewCategory(
                        e.target.value as 'profile' | 'experience' | 'legal' | 'custom'
                      )
                    }
                    className="rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs text-slate-100"
                  >
                    <option value="custom">Custom</option>
                    <option value="profile">Profile</option>
                    <option value="experience">Experience</option>
                    <option value="legal">Legal</option>
                  </select>
                  <button
                    type="submit"
                    disabled={busy}
                    className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white cursor-pointer"
                  >
                    Save Answer
                  </button>
                </form>

                <div className="divide-y divide-slate-800 text-xs">
                  {savedAnswers.map((item) => (
                    <div
                      key={item.id}
                      className="py-2.5 flex items-center justify-between gap-4"
                    >
                      <div>
                        <div className="font-medium text-slate-200">{item.rawQuestion}</div>
                        <div className="text-emerald-400">{item.answer}</div>
                      </div>
                      <button
                        onClick={() => handleDeleteAnswer(item.id)}
                        className="text-rose-400 hover:text-rose-300 cursor-pointer"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'history' && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800">
                <h2 className="text-sm font-semibold text-white">
                  Submitted Applications ({history.length})
                </h2>
              </div>
              {history.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No applications recorded yet.
                </div>
              ) : (
                <div className="divide-y divide-slate-800 text-xs">
                  {history.map((item) => (
                    <div
                      key={item.id}
                      className="p-4 flex flex-wrap items-center justify-between gap-2"
                    >
                      <div>
                        <div className="text-sm font-semibold text-white">
                          {item.roleTitle} — <span className="text-sky-400">{item.company}</span>
                        </div>
                        <div className="text-slate-400 truncate max-w-lg">{item.url}</div>
                        {item.notes && <div className="text-slate-300 mt-1">{item.notes}</div>}
                      </div>
                      <div className="text-right space-y-1">
                        <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 font-semibold">
                          {item.status}
                        </span>
                        <div className="text-slate-500">
                          {new Date(item.appliedAt).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Column: Real-Time Activity Logs */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl flex flex-col max-h-[750px]">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">Activity Logs</h2>
            <span className="text-[11px] text-slate-500">
              {snapshot.activityLogs.length} events
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2.5 text-xs font-mono">
            {snapshot.activityLogs.length === 0 ? (
              <div className="text-slate-500 text-center py-8">No activity yet.</div>
            ) : (
              snapshot.activityLogs.map((log) => (
                <div
                  key={log.id}
                  className="border-l-2 pl-2.5 py-0.5 border-slate-700 space-y-0.5"
                >
                  <div className="flex items-center justify-between text-[10px] text-slate-500">
                    <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
                    <span>{log.state}</span>
                  </div>
                  <div
                    className={
                      log.level === 'error'
                        ? 'text-rose-400'
                        : log.level === 'warn'
                          ? 'text-amber-300'
                          : log.level === 'success'
                            ? 'text-emerald-300'
                            : 'text-slate-300'
                    }
                  >
                    {log.message}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
