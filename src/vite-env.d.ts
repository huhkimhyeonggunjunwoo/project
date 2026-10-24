/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the API: a path like "/api" or a full URL. */
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
