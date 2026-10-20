import { diagnosticText } from '#src/utils/diagnosticExport.ts';
import { reportActionFeedback } from '#src/lib/platform/ui.ts';

function resolveErrorMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof Error && !(error instanceof SyntaxError)) {
    const message = error.message.trim();
    if (message) {
      return diagnosticText(message);
    }
  }

  return fallbackMessage;
}

export function reportUiError(
  context: string,
  error: unknown,
  fallbackMessage = 'Something went wrong. Please try again.',
): void {
  console.error(diagnosticText(context));

  reportActionFeedback({
    type: 'negative',
    message: resolveErrorMessage(error, fallbackMessage),
  });
}
