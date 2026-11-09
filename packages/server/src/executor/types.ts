import type { FieldType } from '../intelligence/types.js';

export interface FieldFillInstruction {
  fieldId: string;
  selector: string;
  type: FieldType;
  value: string;
  label?: string;
}

export interface FieldFillOutcome {
  fieldId: string;
  selector: string;
  success: boolean;
  expectedValue: string;
  actualValue: string;
  verified: boolean;
  error?: string;
}

export interface ValidationErrorItem {
  selector: string;
  label: string;
  message: string;
}

export interface FormExecutionReport {
  totalAttempted: number;
  filledCount: number;
  verifiedCount: number;
  failedCount: number;
  outcomes: FieldFillOutcome[];
  validationErrors: ValidationErrorItem[];
}
