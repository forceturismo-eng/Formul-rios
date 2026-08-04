/** Slug de organização e de formulário público. ASCII, minúsculo, sem acento. */

const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'blog',
  'checkout',
  'dashboard',
  'docs',
  'f',
  'forms',
  'help',
  'internal',
  'login',
  'logout',
  'new',
  'plans',
  'pricing',
  'public',
  'register',
  'settings',
  'signup',
  'static',
  'status',
  'support',
  'system',
  'www',
]);

export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/** Sufixo curto para desempatar slugs colididos, sem revelar contagem. */
export function withRandomSuffix(slug: string, random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${slug}-${suffix}`;
}
