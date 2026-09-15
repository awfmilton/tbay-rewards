/**
 * Turns a referrer + query string into the source/medium/campaign tuple the
 * acquisition reports are built on. UTM parameters always win; otherwise the
 * referrer host is classified, and a direct hit falls back to ('direct','none').
 */

export interface TouchpointInput {
  url?: string | null;
  referrer?: string | null;
  linkCode?: string | null;
}

export interface Touchpoint {
  source: string;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
  referrerUrl: string | null;
  referrerHost: string | null;
  landingPath: string | null;
  linkCode: string | null;
}

const SEARCH_ENGINES = [
  'google.', 'bing.', 'duckduckgo.', 'yahoo.', 'yandex.', 'baidu.', 'ecosia.',
  'brave.', 'startpage.', 'search.marcia', 'qwant.',
];

const SOCIAL_NETWORKS: Record<string, string> = {
  'facebook.': 'facebook',
  'fb.': 'facebook',
  'instagram.': 'instagram',
  'x.com': 'x',
  'twitter.': 'x',
  't.co': 'x',
  'linkedin.': 'linkedin',
  'lnkd.in': 'linkedin',
  'pinterest.': 'pinterest',
  'reddit.': 'reddit',
  'tiktok.': 'tiktok',
  'youtube.': 'youtube',
  'youtu.be': 'youtube',
  'threads.': 'threads',
  'mastodon': 'mastodon',
  'bsky.': 'bluesky',
  'discord.': 'discord',
  'whatsapp.': 'whatsapp',
  'telegram.': 'telegram',
  't.me': 'telegram',
};

const EMAIL_CLIENTS = ['mail.google.', 'outlook.', 'mail.yahoo.', 'webmail.'];

export function hostOf(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function pathOf(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).pathname || '/';
  } catch {
    return null;
  }
}

/** Classify a referrer host into a (source, medium) pair. */
export function classifyReferrer(host: string): { source: string; medium: string } {
  for (const [needle, network] of Object.entries(SOCIAL_NETWORKS)) {
    if (host === needle || host.includes(needle)) return { source: network, medium: 'social' };
  }
  if (SEARCH_ENGINES.some((needle) => host.includes(needle))) {
    return { source: host.split('.')[0] ?? host, medium: 'organic' };
  }
  if (EMAIL_CLIENTS.some((needle) => host.includes(needle))) {
    return { source: host, medium: 'email' };
  }
  return { source: host, medium: 'referral' };
}

export function resolveTouchpoint(input: TouchpointInput, selfHosts: string[] = []): Touchpoint {
  const params = queryParams(input.url);
  const referrerHost = hostOf(input.referrer);
  const landingPath = pathOf(input.url);

  const utmSource = params.get('utm_source');
  const utmMedium = params.get('utm_medium');
  const linkCode = input.linkCode ?? params.get('tb_ref') ?? params.get('tbref') ?? null;

  // Same-site referrers are internal navigation, not acquisition.
  const external = referrerHost && !selfHosts.includes(referrerHost) ? referrerHost : null;

  let source: string;
  let medium: string | null;

  if (utmSource) {
    source = utmSource;
    medium = utmMedium ?? (external ? classifyReferrer(external).medium : 'unknown');
  } else if (linkCode) {
    // A trackable link with no UTMs: credit the referring host if we have one.
    const classified = external ? classifyReferrer(external) : null;
    source = classified?.source ?? 'tracked-link';
    medium = utmMedium ?? classified?.medium ?? 'referral';
  } else if (external) {
    const classified = classifyReferrer(external);
    source = classified.source;
    medium = utmMedium ?? classified.medium;
  } else {
    source = 'direct';
    medium = utmMedium ?? 'none';
  }

  return {
    source,
    medium,
    campaign: params.get('utm_campaign'),
    term: params.get('utm_term'),
    content: params.get('utm_content'),
    referrerUrl: input.referrer ?? null,
    referrerHost: external,
    landingPath,
    linkCode,
  };
}

function queryParams(rawUrl: string | null | undefined): URLSearchParams {
  if (!rawUrl) return new URLSearchParams();
  try {
    return new URL(rawUrl).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Collapse a URL to a stable heatmap key: path only, lowercased, no query or
 * fragment, with trailing slashes and common id segments normalised so that
 * /product/123 and /product/456 do not each get their own heatmap.
 */
export function pageKey(rawUrl: string | null | undefined, patterns: string[] = []): string {
  let path = pathOf(rawUrl) ?? '/';
  path = path.toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '') path = '/';

  for (const pattern of patterns) {
    // Patterns look like /product/:slug — match segment counts and literals.
    if (matchesPattern(path, pattern)) return pattern;
  }
  return path.slice(0, 512);
}

function matchesPattern(path: string, pattern: string): boolean {
  const pathParts = path.split('/').filter(Boolean);
  const patternParts = pattern.toLowerCase().split('/').filter(Boolean);
  if (pathParts.length !== patternParts.length) return false;
  return patternParts.every((part, i) => part.startsWith(':') || part === pathParts[i]);
}
