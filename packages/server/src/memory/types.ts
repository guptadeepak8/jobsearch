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

export type AnswerCategory = 'profile' | 'experience' | 'legal' | 'custom';

export interface SavedAnswer {
  id: number;
  questionKey: string;
  rawQuestion: string;
  answer: string;
  category: AnswerCategory;
  aliases: string[];
  usageCount: number;
  updatedAt: string;
}

export interface UpsertAnswerInput {
  rawQuestion: string;
  answer: string;
  category?: AnswerCategory;
  aliases?: string[];
}

export interface AnswerMatchResult {
  answer: string | null;
  confidence: number;
  matchedKey: string | null;
  needsClarification: boolean;
}

export type ApplicationStatus = 'SUBMITTED' | 'REVIEW_REQUIRED' | 'IN_PROGRESS' | 'FAILED';

export interface ApplicationHistoryEntry {
  id: number;
  company: string;
  roleTitle: string;
  url: string;
  status: ApplicationStatus;
  filledFieldsCount: number;
  notes: string;
  appliedAt: string;
}

export interface CreateApplicationHistoryInput {
  company: string;
  roleTitle: string;
  url: string;
  status: ApplicationStatus;
  filledFieldsCount?: number;
  notes?: string;
}
