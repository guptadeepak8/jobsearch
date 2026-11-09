export type FieldType =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'password'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'date'
  | 'unknown';

export interface FieldOption {
  label: string;
  value: string;
}

export interface DetectedField {
  id: string;
  selector: string;
  tagName: string;
  type: FieldType;
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

export interface PageInspectionResult {
  url: string;
  title: string;
  inspectedAt: string;
  fields: DetectedField[];
}
