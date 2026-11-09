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

export type BrowserStatus =
  | 'DISCONNECTED'
  | 'LAUNCHING'
  | 'READY'
  | 'NAVIGATING'
  | 'CLOSED'
  | 'CRASHED';

export interface FieldOption {
  label: string;
  value: string;
}

export interface DetectedField {
  id: string;
  selector: string;
  tagName: string;
  type: string;
  name: string;
  elementId: string;
  label: string;
  placeholder: string;
  ariaLabel: string;
  required: boolean;
  currentValue: string;
  checked?: boolean;
  options?: FieldOption[];
  validationMessage?: string;
  suggestedAnswer?: string | null;
  confidence?: number;
  matchedQuestionKey?: string | null;
  needsClarification?: boolean;
}

export interface ValidationErrorItem {
  selector: string;
  label: string;
  message: string;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warn' | 'error';
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
  activityLogs: ActivityLogEntry[];
}

export interface UserProfile {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedinUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  resumePath: string;
  yearsOfExperience: string;
  workAuthorization: string;
  sponsorshipRequired: string;
  salaryExpectation: string;
  noticePeriod: string;
  summary: string;
}

export interface SavedAnswer {
  id: number;
  questionKey: string;
  rawQuestion: string;
  answer: string;
  category: 'profile' | 'experience' | 'legal' | 'custom';
  aliases: string[];
  usageCount: number;
  updatedAt: string;
}

export interface ApplicationHistoryEntry {
  id: number;
  company: string;
  roleTitle: string;
  url: string;
  status: 'SUBMITTED' | 'REVIEW_REQUIRED' | 'IN_PROGRESS' | 'FAILED';
  filledFieldsCount: number;
  notes: string;
  appliedAt: string;
}
