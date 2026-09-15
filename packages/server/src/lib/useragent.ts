export type DeviceClass = 'desktop' | 'tablet' | 'mobile' | 'bot' | 'unknown';

export interface UserAgentInfo {
  deviceClass: DeviceClass;
  os: string | null;
  browser: string | null;
  isBot: boolean;
}

const BOT_PATTERN =
  /(bot|crawler|spider|crawling|slurp|mediapartners|facebookexternalhit|embedly|quora link preview|pinterest|bitlybot|preview|scraper|curl|wget|python-requests|headlesschrome|lighthouse|gtmetrix|pingdom|uptimerobot|ahrefs|semrush|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|perplexity)/i;

const TABLET_PATTERN = /(ipad|tablet|playbook|silk|kindle|(android(?!.*mobile)))/i;
const MOBILE_PATTERN = /(iphone|ipod|android.*mobile|windows phone|blackberry|bb10|opera mini|iemobile)/i;

/**
 * Deliberately coarse UA parsing: we only need a device bucket for heatmap
 * segmentation and bot filtering, not a fingerprint.
 */
export function parseUserAgent(ua: string | undefined | null): UserAgentInfo {
  if (!ua) return { deviceClass: 'unknown', os: null, browser: null, isBot: false };

  if (BOT_PATTERN.test(ua)) {
    return { deviceClass: 'bot', os: null, browser: null, isBot: true };
  }

  let deviceClass: DeviceClass = 'desktop';
  if (MOBILE_PATTERN.test(ua)) deviceClass = 'mobile';
  else if (TABLET_PATTERN.test(ua)) deviceClass = 'tablet';

  let os: string | null = null;
  if (/windows nt/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/(iphone|ipad|ipod|ios)/i.test(ua)) os = 'iOS';
  else if (/mac os x/i.test(ua)) os = 'macOS';
  else if (/cros/i.test(ua)) os = 'ChromeOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  let browser: string | null = null;
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';
  else if (/chrome\//i.test(ua)) browser = 'Chrome';
  else if (/safari\//i.test(ua)) browser = 'Safari';

  return { deviceClass, os, browser, isBot: false };
}
