import type { Page } from 'playwright';
import type { DetectedField, FieldOption, FieldType, PageInspectionResult } from './types.js';

/**
 * FormIntelligence: Inspects the active browser page using a single lightweight
 * DOM evaluation pass to extract structured metadata for all interactive form fields.
 * Optimized for 4 GB RAM constraint (no full DOM snapshots or heavy screenshots).
 */
export class FormIntelligence {
  public async inspectPage(page: Page): Promise<PageInspectionResult> {
    if (page.isClosed()) {
      throw new Error('Cannot inspect a closed page');
    }

    const url = page.url();
    const title = await page.title().catch(() => '');

    const fields = await page.evaluate((): DetectedField[] => {
      const ignoredInputTypes = new Set([
        'hidden',
        'submit',
        'button',
        'reset',
        'image',
      ]);

      const cleanText = (txt: string | null | undefined): string => {
        if (!txt) return '';
        return txt.replace(/\s+/g, ' ').trim();
      };

      const isElementVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') {
          // File inputs are frequently hidden behind custom upload buttons; still include them
          if (el instanceof HTMLInputElement && el.type === 'file') {
            return true;
          }
          return false;
        }
        return true;
      };

      const extractLabel = (el: HTMLElement): { label: string; hasAsterisk: boolean } => {
        let rawLabel = '';

        // 1. aria-labelledby
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const parts = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || '')
            .filter(Boolean);
          if (parts.length > 0) {
            rawLabel = parts.join(' ');
          }
        }

        // 2. Explicit <label for="id">
        if (!rawLabel && el.id) {
          const escapedId = CSS.escape(el.id);
          const explicitLabel = document.querySelector(`label[for="${escapedId}"]`);
          if (explicitLabel) {
            rawLabel = explicitLabel.textContent || '';
          }
        }

        // 3. Wrapping <label>
        if (!rawLabel) {
          const parentLabel = el.closest('label');
          if (parentLabel) {
            const clone = parentLabel.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('input, select, textarea').forEach((child) => child.remove());
            rawLabel = clone.textContent || '';
          }
        }

        // 4. aria-label
        if (!rawLabel) {
          rawLabel = el.getAttribute('aria-label') || '';
        }

        // 5. Fieldset legend (helpful for radio/checkbox groups)
        if (!rawLabel && el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
          const fieldset = el.closest('fieldset');
          const legend = fieldset?.querySelector('legend');
          if (legend) {
            rawLabel = legend.textContent || '';
          }
        }

        // 6. Preceding label inside same field wrapper
        if (!rawLabel && el.parentElement) {
          const prevLabel = el.parentElement.querySelector('label');
          if (prevLabel && !prevLabel.getAttribute('for')) {
            rawLabel = prevLabel.textContent || '';
          }
        }

        // 7. Fallback to placeholder or name/id
        if (!rawLabel) {
          rawLabel =
            el.getAttribute('placeholder') ||
            el.getAttribute('name') ||
            el.id ||
            '';
        }

        const cleaned = cleanText(rawLabel);
        const hasAsterisk = cleaned.includes('*');
        const normalizedLabel = cleanText(cleaned.replace(/\*/g, ''));

        return { label: normalizedLabel, hasAsterisk };
      };

      const elements = Array.from(
        document.querySelectorAll<HTMLElement>('input, textarea, select')
      );

      const results: DetectedField[] = [];
      let index = 0;

      for (const el of elements) {
        if (!isElementVisible(el)) continue;

        const tagName = el.tagName.toLowerCase();
        let fieldType: FieldType = 'unknown';

        if (tagName === 'textarea') {
          fieldType = 'textarea';
        } else if (tagName === 'select') {
          fieldType = 'select';
        } else if (el instanceof HTMLInputElement) {
          const rawType = (el.getAttribute('type') || 'text').toLowerCase();
          if (ignoredInputTypes.has(rawType)) continue;

          const validTypes: FieldType[] = [
            'text',
            'email',
            'tel',
            'url',
            'number',
            'password',
            'radio',
            'checkbox',
            'file',
            'date',
          ];
          fieldType = validTypes.includes(rawType as FieldType)
            ? (rawType as FieldType)
            : 'text';
        }

        const fieldId = `field-${index++}`;
        el.setAttribute('data-jobsearch-id', fieldId);

        const elementId = el.id || '';
        const name = el.getAttribute('name') || '';
        const placeholder = el.getAttribute('placeholder') || '';
        const ariaLabel = el.getAttribute('aria-label') || '';
        const { label, hasAsterisk } = extractLabel(el);

        const isRequired =
          el.hasAttribute('required') ||
          el.getAttribute('aria-required') === 'true' ||
          hasAsterisk;

        // Build deterministic selector
        let selector = `[data-jobsearch-id="${fieldId}"]`;
        if (elementId && document.querySelectorAll(`#${CSS.escape(elementId)}`).length === 1) {
          selector = `#${CSS.escape(elementId)}`;
        }

        let currentValue = '';
        let checked: boolean | undefined;
        let options: FieldOption[] | undefined;
        let validationMessage = '';

        if (el instanceof HTMLInputElement) {
          currentValue = el.type === 'file' ? '' : el.value || '';
          if (el.type === 'checkbox' || el.type === 'radio') {
            checked = el.checked;
            // For radio buttons, capture the specific radio option text along with group label
            const parentLabel = el.closest('label');
            const optionLabel = cleanText(parentLabel?.textContent) || el.value;
            options = [{ label: optionLabel, value: el.value }];
          }
          validationMessage = el.validationMessage || '';
        } else if (el instanceof HTMLTextAreaElement) {
          currentValue = el.value || '';
          validationMessage = el.validationMessage || '';
        } else if (el instanceof HTMLSelectElement) {
          currentValue = el.value || '';
          options = Array.from(el.options)
            .filter((opt) => !opt.disabled && opt.value !== '')
            .map((opt) => ({
              label: cleanText(opt.textContent),
              value: opt.value,
            }));
          validationMessage = el.validationMessage || '';
        }

        results.push({
          id: fieldId,
          selector,
          tagName,
          type: fieldType,
          name,
          elementId,
          label: label || placeholder || name || elementId || fieldId,
          placeholder,
          ariaLabel,
          required: isRequired,
          currentValue,
          checked,
          options,
          validationMessage: validationMessage || undefined,
        });
      }

      return results;
    });

    return {
      url,
      title,
      inspectedAt: new Date().toISOString(),
      fields,
    };
  }
}
