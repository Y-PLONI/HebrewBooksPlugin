interface OtzariaResponse<T = unknown> {
  success: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
}

interface OtzariaSearchChunk {
  sequence: number;
  results: unknown[];
  total: number | null;
  groupCount: number | null;
  truncated: boolean;
  limit: number;
  offset: number;
  facets: string[];
}

type NetworkFetchStreamChunk =
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

/// ערכת הצבעים שאוצריא שולחת — כל תפקידי ה-ColorScheme של Material 3,
/// בדיוק כפי שהם מחושבים ב-buildThemePayloadFromScheme.
interface OtzariaColorScheme {
  primary?: string;
  onPrimary?: string;
  primaryContainer?: string;
  onPrimaryContainer?: string;
  secondary?: string;
  onSecondary?: string;
  secondaryContainer?: string;
  onSecondaryContainer?: string;
  tertiary?: string;
  onTertiary?: string;
  tertiaryContainer?: string;
  onTertiaryContainer?: string;
  surface?: string;
  onSurface?: string;
  onSurfaceVariant?: string;
  surfaceContainerLowest?: string;
  surfaceContainerLow?: string;
  surfaceContainer?: string;
  surfaceContainerHigh?: string;
  surfaceContainerHighest?: string;
  error?: string;
  onError?: string;
  errorContainer?: string;
  onErrorContainer?: string;
  outline?: string;
  outlineVariant?: string;
  inverseSurface?: string;
  onInverseSurface?: string;
  inversePrimary?: string;
  shadow?: string;
  scrim?: string;
  surfaceTint?: string;
}

interface OtzariaTheme {
  mode: 'light' | 'dark';
  colorScheme: OtzariaColorScheme;
  typography: {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    commentatorsFontFamily?: string;
    commentatorsFontSize?: number;
  };
}

interface OtzariaBootPayload {
  app: { platform: string; version: string; locale: string; textDirection: string; devMode?: boolean };
  plugin: { id: string; version: string };
  theme: OtzariaTheme;
  permissions: string[];
}

interface Window {
  Otzaria?: {
    call(
      method: 'search.query',
      payload: Record<string, unknown>,
    ): AsyncIterable<OtzariaSearchChunk>;
    call(
      method: 'network.fetchStream',
      payload: Record<string, unknown> & { url: string },
    ): AsyncIterable<NetworkFetchStreamChunk>;
    call<T = unknown>(method: string, payload?: Record<string, unknown>): Promise<OtzariaResponse<T>>;
    on(event: string, callback: (payload: never) => void): void;
    off(event: string, callback: (payload: never) => void): void;
  };
}
