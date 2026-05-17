/// <reference types="vite/client" />

declare module "lucide-react";

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_ENABLE_LEGACY_UPLOAD_FALLBACK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
