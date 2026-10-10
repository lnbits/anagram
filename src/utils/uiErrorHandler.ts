import { diagnosticText } from '#src/utils/diagnosticExport.ts';
import { Notify } from '#src/lib/platform/ui.ts';

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

  Notify.create({
    type: 'negative',
    message: resolveErrorMessage(error, fallbackMessage),
    position: 'top',
    timeout: 3200,
  });
}
