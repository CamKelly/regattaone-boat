import * as NotehubJs from '@blues-inc/notehub-js';
import {
  CompactPresencePayload,
  PRESENCE_INBOUND_NOTEFILE,
  PRESENCE_ACK_NOTEFILE,
} from '@regattaone/shared';
import { logFunction } from '../logging';

export interface NotehubServiceConfig {
  personalAccessToken: string;
  defaultProjectUid?: string;
}

export interface SendPresenceNoteResult {
  success: boolean;
  error?: string;
}

export interface PresenceAckEvent {
  deviceUid: string;
  messageId: string;
  receivedAt: number;
  ok: boolean;
}

/** notehub-js rejects with a plain object `{ status, body, error }`, not an Error. */
export function formatNotehubApiError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object') {
    const apiError = error as {
      status?: number;
      statusText?: string;
      body?: { err?: string; message?: string; code?: number };
      error?: { message?: string };
    };

    const parts: string[] = [];
    if (typeof apiError.status === 'number') {
      parts.push(`HTTP ${apiError.status}`);
    }

    const bodyMessage = apiError.body?.err ?? apiError.body?.message;
    if (bodyMessage) {
      parts.push(String(bodyMessage));
    } else if (apiError.error?.message) {
      parts.push(apiError.error.message);
    }

    if (parts.length > 0) {
      return parts.join(': ');
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

function notehubApiErrorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') {
    return {};
  }

  const apiError = error as {
    status?: number;
    statusText?: string;
    body?: unknown;
  };

  return {
    ...(typeof apiError.status === 'number' ? { httpStatus: apiError.status } : {}),
    ...(apiError.statusText ? { httpStatusText: apiError.statusText } : {}),
    ...(apiError.body !== undefined ? { httpBody: apiError.body } : {}),
  };
}

export class NotehubService {
  private readonly deviceApi: NotehubJs.DeviceApi;
  private readonly eventApi: NotehubJs.EventApi;
  private readonly defaultProjectUid?: string;

  constructor(config: NotehubServiceConfig) {
    const client = NotehubJs.ApiClient.instance;
    const auth = client.authentications['personalAccessToken'] as { accessToken?: string };
    auth.accessToken = config.personalAccessToken;

    this.deviceApi = new NotehubJs.DeviceApi();
    this.eventApi = new NotehubJs.EventApi();
    this.defaultProjectUid = config.defaultProjectUid;
  }

  resolveProjectUid(deviceProjectUid?: string): string {
    const projectUid = deviceProjectUid ?? this.defaultProjectUid;
    if (!projectUid) {
      throw new Error('Notehub project UID is required to send device notifications.');
    }

    return projectUid;
  }

  async sendPresenceNotification(
    projectUid: string,
    deviceUid: string,
    payload: CompactPresencePayload,
  ): Promise<SendPresenceNoteResult> {
    const noteInput = new NotehubJs.NoteInput();
    noteInput.body = payload as unknown as Record<string, unknown>;

    try {
      logFunction('notehubService', 'start', 'Sending presence.qi note', {
        projectUid: this.resolveProjectUid(projectUid),
        deviceUid,
        notefile: PRESENCE_INBOUND_NOTEFILE,
        compactPayload: payload,
      });

      await this.deviceApi.addQiNote(
        this.resolveProjectUid(projectUid),
        deviceUid,
        PRESENCE_INBOUND_NOTEFILE,
        noteInput,
      );

      logFunction('notehubService', 'success', 'presence.qi note accepted by Notehub API', {
        projectUid: this.resolveProjectUid(projectUid),
        deviceUid,
        messageId: payload.mid,
        type: payload.t,
        compactPayload: payload,
      });

      return { success: true };
    } catch (error) {
      const message = formatNotehubApiError(error);
      logFunction('notehubService', 'error', 'Notehub addQiNote failed', {
        projectUid,
        deviceUid,
        messageId: payload.mid,
        type: payload.t,
        compactPayload: payload,
        error: message,
        ...notehubApiErrorDetails(error),
      });
      return { success: false, error: message };
    }
  }

  async fetchLatestPresenceAck(
    projectUid: string,
    deviceUid: string,
    messageId: string,
  ): Promise<PresenceAckEvent | null> {
    try {
      const response = (await this.eventApi.getEvents(this.resolveProjectUid(projectUid), {
        deviceUID: [deviceUid],
        files: [PRESENCE_ACK_NOTEFILE],
        pageSize: 10,
        sortBy: 'captured',
        sortOrder: 'desc',
      })) as { events?: Array<{ body?: Record<string, unknown>; when?: number }> };

      const match = (response.events ?? []).find((event) => {
        const body = event.body ?? {};
        const ackId = String(body['mid'] ?? body['id'] ?? '');
        return ackId === messageId;
      });

      if (!match) {
        return null;
      }

      const body = match.body ?? {};
      const ok = body['ok'] !== false;

      return {
        deviceUid,
        messageId,
        receivedAt: match.when ?? Date.now() / 1000,
        ok,
      };
    } catch (error) {
      logFunction('notehubService', 'warn', 'Unable to poll Notehub presence ack', {
        deviceUid,
        messageId,
        error: formatNotehubApiError(error),
        ...notehubApiErrorDetails(error),
      });
      return null;
    }
  }
}

export function createNotehubService(config: NotehubServiceConfig): NotehubService {
  return new NotehubService(config);
}
