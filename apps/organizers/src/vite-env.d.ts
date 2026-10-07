/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL del backend al que el servidor de desarrollo reenvía `/api` (solo dev/preview). */
  readonly VITE_API_PROXY?: string;
}
