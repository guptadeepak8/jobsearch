import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type {
  FieldFillInstruction,
  FieldFillOutcome,
  FormExecutionReport,
  ValidationErrorItem,
} from './types.js';

/**
 * FormExecutor: Safely populates form fields, uploads resumes, verifies filled values,
 * and checks for validation errors.
 *
 * Safety invariant: Never submits a form automatically. Submission requires explicit
 * user approval (`userApproved: true`).
 */
export class FormExecutor {
  /**
   * Fills a batch of fields and verifies each filled value in the DOM.
   * Never triggers form submission.
   */
  public async fillFields(
    page: Page,
    instructions: FieldFillInstruction[]
  ): Promise<FormExecutionReport> {
    if (page.isClosed()) {
      throw new Error('Cannot fill fields on a closed page');
    }

    const outcomes: FieldFillOutcome[] = [];

    for (const item of instructions) {
      if (item.value === undefined || item.value === null || item.value === '') {
        continue;
      }

      if (item.type === 'file') {
        const uploadOutcome = await this.uploadResume(page, item.selector, item.value, item.fieldId);
        outcomes.push(uploadOutcome);
        continue;
      }

      const outcome = await this.fillSingleField(page, item);
      outcomes.push(outcome);
    }

    const validationErrors = await this.detectValidationErrors(page);

    const filledCount = outcomes.filter((o) => o.success).length;
    const verifiedCount = outcomes.filter((o) => o.verified).length;
    const failedCount = outcomes.filter((o) => !o.success).length;

    return {
      totalAttempted: outcomes.length,
      filledCount,
      verifiedCount,
      failedCount,
      outcomes,
      validationErrors,
    };
  }

  /**
   * Uploads a resume or document to a file input and verifies the filename.
   */
  public async uploadResume(
    page: Page,
    selector: string,
    filePath: string,
    fieldId = 'file-upload'
  ): Promise<FieldFillOutcome> {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      return {
        fieldId,
        selector,
        success: false,
        expectedValue: path.basename(resolvedPath),
        actualValue: '',
        verified: false,
        error: `Resume file not found at path: ${resolvedPath}`,
      };
    }

    try {
      const locator = page.locator(selector).first();
      await locator.setInputFiles(resolvedPath, { timeout: 10000 });

      // Verify the file input holds the expected file name
      const actualFileName = await locator.evaluate((el) => {
        if (el instanceof HTMLInputElement && el.files && el.files.length > 0) {
          return el.files[0].name;
        }
        return '';
      });

      const expectedFileName = path.basename(resolvedPath);
      const verified = actualFileName === expectedFileName;

      return {
        fieldId,
        selector,
        success: true,
        expectedValue: expectedFileName,
        actualValue: actualFileName,
        verified,
      };
    } catch (error) {
      return {
        fieldId,
        selector,
        success: false,
        expectedValue: path.basename(resolvedPath),
        actualValue: '',
        verified: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Inspects the page for HTML5 validity errors, aria-invalid attributes, and visible error alerts.
   */
  public async detectValidationErrors(page: Page): Promise<ValidationErrorItem[]> {
    if (page.isClosed()) return [];

    return page.evaluate((): ValidationErrorItem[] => {
      const errors: ValidationErrorItem[] = [];
      const elements = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          'input, select, textarea'
        )
      );

      for (const el of elements) {
        const isAriaInvalid = el.getAttribute('aria-invalid') === 'true';
        const nativeMessage = el.validationMessage || '';
        const isNativeInvalid = !el.checkValidity();

        if (isAriaInvalid || isNativeInvalid) {
          const id = el.getAttribute('data-jobsearch-id') || el.id || el.name || 'unknown';
          const selector = el.getAttribute('data-jobsearch-id')
            ? `[data-jobsearch-id="${el.getAttribute('data-jobsearch-id')}"]`
            : el.id
              ? `#${CSS.escape(el.id)}`
              : id;

          const labelEl = el.id
            ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
            : el.closest('label');
          const label = (labelEl?.textContent || el.getAttribute('aria-label') || el.name || id)
            .replace(/\s+/g, ' ')
            .trim();

          errors.push({
            selector,
            label,
            message: nativeMessage || 'Field marked as invalid',
          });
        }
      }

      return errors;
    });
  }

  /**
   * Submits the current form ONLY when explicit user approval is passed (`userApproved === true`).
   */
  public async submitWithExplicitApproval(
    page: Page,
    options: { userApproved: boolean; submitSelector?: string }
  ): Promise<{ submitted: boolean; url: string; error?: string }> {
    if (options.userApproved !== true) {
      throw new Error('Submission blocked: Explicit user approval is required before submitting any application.');
    }

    if (page.isClosed()) {
      throw new Error('Cannot submit on a closed page');
    }

    try {
      const selector =
        options.submitSelector ||
        'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Apply")';

      const submitBtn = page.locator(selector).first();
      const count = await submitBtn.count();

      if (count === 0) {
        return {
          submitted: false,
          url: page.url(),
          error: 'Could not locate a submit button on the current page.',
        };
      }

      await submitBtn.click({ timeout: 10000 });
      return {
        submitted: true,
        url: page.url(),
      };
    } catch (error) {
      return {
        submitted: false,
        url: page.url(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async fillSingleField(
    page: Page,
    item: FieldFillInstruction
  ): Promise<FieldFillOutcome> {
    try {
      const locator = page.locator(item.selector).first();
      const count = await locator.count();

      if (count === 0) {
        return {
          fieldId: item.fieldId,
          selector: item.selector,
          success: false,
          expectedValue: item.value,
          actualValue: '',
          verified: false,
          error: `Element not found for selector: ${item.selector}`,
        };
      }

      if (item.type === 'select') {
        // Try selecting by value first, then by visible label
        try {
          await locator.selectOption({ value: item.value }, { timeout: 5000 });
        } catch {
          await locator.selectOption({ label: item.value }, { timeout: 5000 });
        }

        const actual = await locator.evaluate((el) => {
          if (el instanceof HTMLSelectElement) {
            const selected = el.selectedOptions[0];
            return selected ? `${selected.value}|${selected.textContent?.trim()}` : el.value;
          }
          return '';
        });

        const parts = actual.split('|');
        const verified = parts.includes(item.value.trim());

        return {
          fieldId: item.fieldId,
          selector: item.selector,
          success: true,
          expectedValue: item.value,
          actualValue: parts[0] || actual,
          verified,
        };
      }

      if (item.type === 'checkbox') {
        const shouldCheck = /^(true|1|yes|checked|on)$/i.test(item.value.trim());
        if (shouldCheck) {
          await locator.check({ timeout: 5000 });
        } else {
          await locator.uncheck({ timeout: 5000 });
        }

        const isChecked = await locator.isChecked();
        const verified = isChecked === shouldCheck;

        return {
          fieldId: item.fieldId,
          selector: item.selector,
          success: true,
          expectedValue: String(shouldCheck),
          actualValue: String(isChecked),
          verified,
        };
      }

      if (item.type === 'radio') {
        await locator.check({ timeout: 5000 });
        const isChecked = await locator.isChecked();

        return {
          fieldId: item.fieldId,
          selector: item.selector,
          success: true,
          expectedValue: item.value,
          actualValue: isChecked ? item.value : '',
          verified: isChecked,
        };
      }

      // Standard text, email, tel, url, number, date, password, textarea
      await locator.fill(item.value, { timeout: 5000 });
      const actualValue = await locator.inputValue();
      const verified = actualValue === item.value;

      return {
        fieldId: item.fieldId,
        selector: item.selector,
        success: true,
        expectedValue: item.value,
        actualValue,
        verified,
      };
    } catch (error) {
      return {
        fieldId: item.fieldId,
        selector: item.selector,
        success: false,
        expectedValue: item.value,
        actualValue: '',
        verified: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
