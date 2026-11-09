import type { BrowserStatus } from '../browser/types.js';
import type { FormExecutionReport, ValidationErrorItem } from '../executor/types.js';
import type { DetectedField } from '../intelligence/types.js';

export type SessionState =
  | 'IDLE'
  | 'BROWSER_RUNNING'
  | 'INSPECTING'
  | 'FILLING'
  | 'PAUSED'
  | 'HUMAN_TAKEOVER'
  | 'REVIEW_REQUIRED'
  | 'SUBMITTED'
  | 'FAILED';

export type ActivityLevel = 'info' | 'success' | 'warn' | 'error';

export interface ActivityLogEntry {
  id: string;
  timestamp: string;
  level: ActivityLevel;
  message: string;
  state: SessionState;
}

export interface SessionSnapshot {
  sessionState: SessionState;
  browserStatus: BrowserStatus;
  currentUrl: string | null;
  pageTitle: string;
  humanTakeoverActive: boolean;
  isPaused: boolean;
  detectedFields: DetectedField[];
  missingFields: DetectedField[];
  validationErrors: ValidationErrorItem[];
  lastExecutionReport: FormExecutionReport | null;
  activityLogs: ActivityLogEntry[];
}
