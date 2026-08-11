import type { OtzariaSearchChunk } from './models';

export interface NetworkFetchParams extends Record<string, unknown> {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export type NetworkFetchStreamChunk =
  | {
      sequence: number;
      type: 'response';
      status: number;
      ok: boolean;
      headers: Record<string, string>;
    }
  | {
      sequence: number;
      type: 'data';
      body: string;
    };

export interface HostBridge {
  call(
    method: 'search.query',
    payload: Record<string, unknown>,
  ): AsyncIterable<OtzariaSearchChunk>;
  call(
    method: 'network.fetchStream',
    payload: NetworkFetchParams,
  ): AsyncIterable<NetworkFetchStreamChunk>;
  call<T>(method: string, payload?: Record<string, unknown>): Promise<OtzariaResponse<T>>;
  on(event: string, callback: (payload: never) => void): void;
}

export function getHostBridge(): HostBridge | null {
  return (window.Otzaria as HostBridge | undefined) ?? null;
}

export async function requireHostData<T>(
  bridge: HostBridge,
  method: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const response = await bridge.call<T>(method, payload);
  if (!response.success || response.data === null) {
    throw new Error(response.error?.message ?? `הפעולה ${method} נכשלה`);
  }
  return response.data;
}
