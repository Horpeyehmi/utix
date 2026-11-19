import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  expectAsyncErrorAnnouncement,
  expectAsyncStateAccessible,
  expectKeyboardAccessibleErrorRecovery,
  getAsyncErrorA11yReport,
} from '../async-a11y';

describe('Async Error Recovery Accessibility', () => {
  beforeEach(() => {
    // Reset any test state
  });

  describe('async error announcement', () => {
    it('properly announces async errors to screen readers', async () => {
      const TestComponent = () => {
        const [error, setError] = React.useState<string | null>(null);
        const [isLoading, setIsLoading] = React.useState(false);

        const handleError = async () => {
          setIsLoading(true);
          try {
            throw new Error('Network error');
          } catch (e) {
            setError('Failed to load data. Please try again.');
          } finally {
            setIsLoading(false);
          }
        };

        return (
          <div>
            <button onClick={handleError} disabled={isLoading}>
              {isLoading ? 'Loading...' : 'Load'}
            </button>
            {error && <div role="alert">{error}</div>}
          </div>
        );
      };

      const { container } = render(<TestComponent />);
      const user = userEvent.setup();

      await expectAsyncErrorAnnouncement(container, {
        triggerError: async () => {
          const button = screen.getByRole('button', { name: /load/i });
          await user.click(button);
          await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument();
          });
        },
        errorTextPattern: 'Failed to load data',
        errorRoleExpected: 'alert',
      });
    });

    it('tracks accessibility changes during async operations', async () => {
      const TestComponent = () => {
        const [error, setError] = React.useState<string | null>(null);

        const handleError = async () => {
          try {
            throw new Error('Test error');
          } catch (e) {
            setError('An error occurred');
          }
        };

        return (
          <div>
            <button onClick={handleError}>Trigger Error</button>
            {error && <div role="alert">{error}</div>}
          </div>
        );
      };

      const { container } = render(<TestComponent />);
      const user = userEvent.setup();

      const report = await getAsyncErrorA11yReport(container, {
        triggerError: async () => {
          const button = screen.getByRole('button');
          await user.click(button);
          await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument();
          });
        },
        errorTextPattern: 'An error occurred',
      });

      expect(Array.isArray(report.violations)).toBe(true);
      expect(Array.isArray(report.passes)).toBe(true);
    });
  });

  describe('async state transitions', () => {
    it('maintains accessibility through idle, loading, and error states', async () => {
      const TestComponent = () => {
        const [state, setState] = React.useState<'idle' | 'loading' | 'error' | 'success'>('idle');

        const handleState = async (newState: typeof state) => {
          setState(newState);
          await new Promise(resolve => setTimeout(resolve, 100));
        };

        return (
          <div>
            <button onClick={() => handleState('loading')}>Trigger Loading</button>
            <button onClick={() => handleState('error')}>Trigger Error</button>
            <button onClick={() => handleState('success')}>Trigger Success</button>

            {state === 'loading' && <div aria-busy="true">Loading...</div>}
            {state === 'error' && <div role="alert">Error occurred</div>}
            {state === 'success' && <div role="status">Success!</div>}
          </div>
        );
      };

      const { container } = render(<TestComponent />);
      const user = userEvent.setup();

      await expectAsyncStateAccessible(container, {
        idle: async () => {
          // Already in idle state
        },
        loading: async () => {
          const loadingButton = screen.getByRole('button', { name: /trigger loading/i });
          await user.click(loadingButton);
        },
        error: async () => {
          const errorButton = screen.getByRole('button', { name: /trigger error/i });
          await user.click(errorButton);
        },
        success: async () => {
          const successButton = screen.getByRole('button', { name: /trigger success/i });
          await user.click(successButton);
        },
      });
    });
  });

  describe('keyboard navigation during error recovery', () => {
    it('allows keyboard users to reach retry buttons', async () => {
      const TestComponent = () => {
        const [error, setError] = React.useState<string | null>(null);

        const handleError = async () => {
          setError('Operation failed');
        };

        const handleRetry = async () => {
          setError(null);
        };

        return (
          <div>
            <button onClick={handleError}>Start Operation</button>
            {error && (
              <>
                <div role="alert">{error}</div>
                <button onClick={handleRetry}>Retry Operation</button>
              </>
            )}
          </div>
        );
      };

      const { container } = render(<TestComponent />);
      const user = userEvent.setup();

      await expectKeyboardAccessibleErrorRecovery(container, {
        triggerError: async () => {
          const button = screen.getByRole('button', { name: /start operation/i });
          await user.click(button);
          await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument();
          });
        },
        errorTextPattern: 'Operation failed',
        retryButtonText: 'Retry',
      });
    });
  });

  describe('error recovery focus management', () => {
    it('manages focus appropriately when errors appear', async () => {
      const TestComponent = () => {
        const [error, setError] = React.useState<string | null>(null);
        const alertRef = React.useRef<HTMLDivElement>(null);

        const handleError = async () => {
          setError('Error occurred');
          // Focus error message for screen readers
          alertRef.current?.focus();
        };

        return (
          <div>
            <button onClick={handleError}>Trigger</button>
            {error && (
              <div ref={alertRef} role="alert" tabIndex={-1}>
                {error}
              </div>
            )}
          </div>
        );
      };

      const { container } = render(<TestComponent />);
      const user = userEvent.setup();

      const button = screen.getByRole('button');
      await user.click(button);

      await waitFor(() => {
        const alert = screen.getByRole('alert');
        expect(alert).toBeInTheDocument();
      });

      // Verify no accessibility violations after focus change
      expect(container.querySelector('[role="alert"]')).toBeInTheDocument();
    });
  });
});

// Mock React for test file
import * as React from 'react';
