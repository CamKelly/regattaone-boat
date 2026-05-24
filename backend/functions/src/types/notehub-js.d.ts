declare module '@blues-inc/notehub-js' {
  export class ApiClient {
    static instance: ApiClient;
    authentications: Record<string, { accessToken?: string }>;
  }

  export class DeviceApi {
    addQiNote(
      projectOrProductUID: string,
      deviceUID: string,
      notefileID: string,
      noteInput: NoteInput,
    ): Promise<void>;
  }

  export class EventApi {
    getEvents(
      projectUID: string,
      opts?: Record<string, unknown>,
    ): Promise<unknown>;
  }

  export class NoteInput {
    body?: Record<string, unknown>;
  }
}
