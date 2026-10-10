export interface AppClientOptions {
  enableOutboxModel: boolean;
}

function readBooleanBuildEnv(value: unknown): boolean {
  return value === true || value === 'true';
}

export function createAppClientOptions(env: Record<string, unknown> = process.env): AppClientOptions {
  return {
    enableOutboxModel: !readBooleanBuildEnv(env.APP_E2E_DISABLE_NDK_OUTBOX),
  };
}
