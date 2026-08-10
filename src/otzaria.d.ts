interface OtzariaResponse<T = unknown> {
  success: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
}

interface OtzariaTheme {
  mode: 'light' | 'dark';
  colorScheme: Record<string, string | undefined>;
  typography: {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
  };
}

interface OtzariaBootPayload {
  app: { platform: string; version: string; locale: string; textDirection: string };
  plugin: { id: string; version: string };
  theme: OtzariaTheme;
  permissions: string[];
}

interface Window {
  Otzaria?: {
    call<T = unknown>(method: string, payload?: Record<string, unknown>): Promise<OtzariaResponse<T>>;
    on(event: string, callback: (payload: never) => void): void;
    off(event: string, callback: (payload: never) => void): void;
  };
}
