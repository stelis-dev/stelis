/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUI_RPC_URL: string;
  readonly VITE_STELIS_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
