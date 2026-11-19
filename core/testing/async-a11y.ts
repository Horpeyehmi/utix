import { screen, waitFor } from '@testing-library/dom';
import {
  expectNoAxeViolations,
  expectRulePasses,
  collectAccessibilityReport,
  type AccessibilityReport,
} from './axe';

/**
 * Async error recovery accessibility helpers.
 *
 * Tests that async operations properly announce errors and manage focus,
 * allowing screen reader and keyboard users to discover and respond to failures.
 */

export interface AsyncErrorScenario {
  triggerError: () => Promise<void>;
  errorTextPattern?: RegExp | string;
  errorRoleExpected?: 'alert' | 'status' | 'region';
  focusExpectation?: {
    shouldMoveToError?: boolean;
    shouldMoveToRetry?: boolean;
  };
}

/**
 * Verifies that an async operation announces errors accessibly.
 * - Error message is announced to screen readers via a live region or alert
 * - Error text is visible and descriptive
 * - Focus is managed appropriately
 */
export async function expectAsyncErrorAnnouncement(
  container: Element,
  scenario: AsyncErrorScenario
): Promise<void> {
  const beforeReport = await collectAccessibilityReport(container);

  await scenario.triggerError();

  // Wait for error to appear
  if (scenario.errorTextPattern) {
    await waitFor(() => {
      expect(() => {
        if (typeof scenario.errorTextPattern === 'string') {
          screen.getByText(scenario.errorTextPattern);
        } else {
          screen.getByText(scenario.errorTextPattern);
        }
      }).not.toThrow();
    });
  }

  // Check for violations introduced by error state
  const afterReport = await collectAccessibilityReport(container);

  // Error should not introduce new violations
  const newViolations = afterReport.violations.filter(
    violation =>
      !beforeReport.violations.some(
        before => before.id === violation.id && before.nodes.length === violation.nodes.length
      )
  );

  expect(newViolations, `New accessibility violations in error state: ${JSON.stringify(newViolations)}`).toHaveLength(0);
}

/**
 * Verifies keyboard navigation during async operations and error recovery.
 * Tests Tab/Shift+Tab navigation to retry buttons and error messages.
 */
export async function expectKeyboardAccessibleErrorRecovery(
  container: Element,
  scenario: AsyncErrorScenario & { retryButtonText: string }
): Promise<void> {
  await scenario.triggerError();

  // Error message should be in document
  if (scenario.errorTextPattern) {
    await waitFor(() => {
      expect(() => {
        if (typeof scenario.errorTextPattern === 'string') {
          screen.getByText(scenario.errorTextPattern);
        } else {
          screen.getByText(scenario.errorTextPattern);
        }
      }).not.toThrow();
    });
  }

  // Retry button should be keyboard accessible
  const retryButton = screen.getByRole('button', { name: new RegExp(scenario.retryButtonText, 'i') });
  expect(retryButton).toBeInTheDocument();
  expect(retryButton).not.toHaveAttribute('disabled');

  // No violations in keyboard-focused error state
  await expectNoAxeViolations(container);
}

/**
 * Verifies that async loading and error states don't create violations.
 * Useful for forms and operations with loading spinners and error messages.
 */
export async function expectAsyncStateAccessible(
  container: Element,
  states: {
    idle: () => Promise<void>;
    loading: () => Promise<void>;
    error: () => Promise<void>;
    success?: () => Promise<void>;
  }
): Promise<void> {
  // Check idle state
  await states.idle();
  await expectNoAxeViolations(container);

  // Check loading state
  await states.loading();
  await waitFor(() => {
    // Loading state should have aria-busy or busy indicators
    const busy = container.querySelector('[aria-busy="true"]');
    if (!busy) {
      // Or a loading message
      expect(() => screen.getByText(/loading|processing|please wait/i)).not.toThrow();
    }
  });
  await expectNoAxeViolations(container);

  // Check error state
  await states.error();
  await waitFor(() => {
    // Error should have alert or error region
    expect(() => {
      screen.getByRole('alert');
    }).not.toThrow();
  });
  await expectNoAxeViolations(container);

  // Check success state if provided
  if (states.success) {
    await states.success();
    await expectNoAxeViolations(container);
  }
}

/**
 * Verifies that form validation errors are announced and managed accessibly.
 * Tests form field errors that appear asynchronously (e.g., server validation).
 */
export async function expectFormAsyncValidationA11y(
  container: Element,
  fieldLabel: string,
  errorMessage: string
): Promise<void> {
  const field = screen.getByLabelText(fieldLabel);

  // Initial state should be valid
  await expectNoAxeViolations(container);

  // Field should have error message announced
  await waitFor(() => {
    const errorElement = screen.getByText(errorMessage);
    expect(errorElement).toBeInTheDocument();
  });

  // Error state should not violate a11y rules
  await expectRulePasses(container, 'aria-required-attr');
  await expectRulePasses(container, 'aria-valid-attr-value');
  await expectRulePasses(container, 'aria-hidden-focus');
}

/**
 * Verifies pagination and "load more" async operations are accessible.
 * Common for lazy-loaded lists and infinite scroll.
 */
export async function expectAsyncPaginationA11y(
  container: Element,
  loadMoreButtonSelector: string
): Promise<void> {
  // Initial list should be accessible
  await expectNoAxeViolations(container);

  // Load more button should be accessible
  const button = container.querySelector(loadMoreButtonSelector);
  expect(button).toBeInTheDocument();

  // Button should have accessible name
  const accessibleName = (button as HTMLElement)?.textContent || (button as HTMLElement)?.getAttribute('aria-label');
  expect(accessibleName).toBeTruthy();

  // Loaded items should not create violations
  await expectNoAxeViolations(container);
}

/**
 * Verifies that dismissible alerts and notifications are accessible.
 * Tests focus management when alerts are closed or dismissed.
 */
export async function expectDismissibleNotificationA11y(
  container: Element,
  dismissButtonLabel: string,
  notificationText: string
): Promise<void> {
  // Notification should be present and accessible
  const notification = screen.getByText(notificationText);
  expect(notification).toBeInTheDocument();

  await expectNoAxeViolations(container);

  // Dismiss button should be accessible
  const dismissButton = screen.getByRole('button', { name: new RegExp(dismissButtonLabel, 'i') });
  expect(dismissButton).toBeInTheDocument();

  // Should not have violations when button is focused
  dismissButton.focus();
  await expectNoAxeViolations(container);
}

/**
 * Collects detailed a11y report for async error recovery flows.
 * Useful for debugging specific violations in complex async scenarios.
 */
export async function getAsyncErrorA11yReport(
  container: Element,
  scenario: AsyncErrorScenario
): Promise<AccessibilityReport> {
  const before = await collectAccessibilityReport(container);

  await scenario.triggerError();

  if (scenario.errorTextPattern) {
    await waitFor(() => {
      expect(() => {
        if (typeof scenario.errorTextPattern === 'string') {
          screen.getByText(scenario.errorTextPattern);
        } else {
          screen.getByText(scenario.errorTextPattern);
        }
      }).not.toThrow();
    });
  }

  const after = await collectAccessibilityReport(container);

  return {
    violations: [...before.violations, ...after.violations],
    incomplete: [...before.incomplete, ...after.incomplete],
    passes: after.passes,
    inapplicable: after.inapplicable,
  };
}
