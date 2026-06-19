/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STELIS_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
