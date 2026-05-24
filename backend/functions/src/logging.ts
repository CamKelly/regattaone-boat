import { logger } from 'firebase-functions';

type LogPhase = 'start' | 'success' | 'skip' | 'warn' | 'error';

export function logFunction(
  functionName: string,
  phase: LogPhase,
  message: string,
  data: Record<string, unknown> = {},
): void {
  const payload = { function: functionName, ...data };

  switch (phase) {
    case 'start':
    case 'success':
    case 'skip':
      logger.info(`[${functionName}] ${message}`, payload);
      break;
    case 'warn':
      logger.warn(`[${functionName}] ${message}`, payload);
      break;
    case 'error':
      logger.error(`[${functionName}] ${message}`, payload);
      break;
  }
}

export function summarizePresenceState(
  data: FirebaseFirestore.DocumentData | undefined,
): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }

  return {
    online: data['online'] === true,
    deviceId: data['deviceId'] ?? data['boatId'] ?? '',
    deviceType: data['deviceType'] ?? '',
    product: data['product'] ?? '',
  };
}
