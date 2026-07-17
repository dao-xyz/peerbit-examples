export const CLOUDFLARE_STATIC_ASSET_HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/assets/*
  Cache-Control: public, max-age=31556952, immutable
`;
