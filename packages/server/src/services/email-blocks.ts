import { db, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { escapeHtml, layout } from './email.js';

/**
 * An email somebody can compose without writing HTML.
 *
 * Templates are hand-written HTML, which is fine for eight built-ins a
 * developer wrote once and wrong for the thing a retailer does weekly: put
 * this month's three products in a message, with a button, and send it. Today
 * that means editing a `<table>` in a textarea, and the first unclosed tag
 * breaks the layout in Outlook only.
 *
 * Blocks are typed pieces with typed fields, and the renderer emits the HTML.
 * The admin never writes any — which is also the security property. An HTML
 * textarea in wp-admin is a stored XSS vector against the next admin who opens
 * the preview; a list of blocks with escaped values is not, whatever anybody
 * types into it.
 */

export type Block =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3; visibleTo?: string; hiddenFrom?: string }
  | { type: 'text'; text: string; visibleTo?: string; hiddenFrom?: string }
  | { type: 'button'; label: string; url: string; visibleTo?: string; hiddenFrom?: string }
  | {
      type: 'image';
      src: string;
      alt?: string;
      url?: string;
      visibleTo?: string;
      hiddenFrom?: string;
    }
  | { type: 'divider'; visibleTo?: string; hiddenFrom?: string }
  | { type: 'spacer'; size?: 'small' | 'medium' | 'large'; visibleTo?: string; hiddenFrom?: string }
  | {
      type: 'products';
      items: Array<{ title: string; url?: string; image?: string; price?: string }>;
      visibleTo?: string;
      hiddenFrom?: string;
    }
  | {
      type: 'points';
      heading?: string;
      caption?: string;
      visibleTo?: string;
      hiddenFrom?: string;
    };

const TYPES = [
  'heading',
  'text',
  'button',
  'image',
  'divider',
  'spacer',
  'products',
  'points',
] as const;

const MAX_BLOCKS = 60;
const MAX_TEXT = 4_000;
const MAX_PRODUCTS = 12;

/**
 * A link an email client will follow, and nothing else.
 *
 * `javascript:` in an href is mostly inert in a mail client and entirely live
 * in the wp-admin preview, which renders the same HTML in an admin's session.
 * `data:` is a phishing page that never leaves the message. Neither is a thing
 * a retailer means to put in a newsletter.
 */
function assertUrl(value: unknown, field: string): string {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw ApiError.badRequest(`${field} must be a link`);
  }
  const raw = (value ?? '').trim();
  if (raw === '') throw ApiError.badRequest(`${field} is required`);
  if (raw.length > 2048) throw ApiError.badRequest(`${field} is too long`);

  // Merge fields are resolved later and are not URLs yet.
  if (/^\{\{[a-z0-9_.]+\}\}$/i.test(raw)) return raw;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw ApiError.badRequest(`${field} must be a full URL, starting http:// or https://`);
  }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    throw ApiError.badRequest(`${field} must be an http, https or mailto link`);
  }
  return raw;
}

/**
 * A text field's value.
 *
 * A non-string is refused rather than coerced: `String({a: 1})` is
 * "[object Object]", which a retailer then finds in a sent newsletter. The
 * builder posts strings, so anything else is a caller getting the shape wrong
 * and a 400 is the honest answer.
 */
function text(
  value: unknown,
  field: string,
  max = MAX_TEXT,
  required = false,
): string {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw ApiError.badRequest(`${field} must be text`);
  }
  const raw = value ?? '';
  if (raw.length > max) throw ApiError.badRequest(`${field} is longer than ${max} characters`);
  if (required && raw.trim() === '') throw ApiError.badRequest(`${field} is required`);
  return raw;
}

/**
 * Check and normalise a block list.
 *
 * Every unknown field is dropped rather than carried: a block is a contract
 * with the renderer, and storing fields it will never read is how a builder
 * accumulates a second, undocumented schema.
 */
export function validateBlocks(input: unknown): Block[] {
  if (!Array.isArray(input)) throw ApiError.badRequest('Blocks must be a list');
  if (input.length > MAX_BLOCKS) {
    throw ApiError.badRequest(`An email may hold at most ${MAX_BLOCKS} blocks`);
  }

  return input.map((raw, index): Block => {
    if (!raw || typeof raw !== 'object') {
      throw ApiError.badRequest(`Block ${index + 1} is not a block`);
    }
    const block = raw as Record<string, unknown>;
    const type = String(block.type ?? '');
    if (!TYPES.includes(type as never)) {
      throw ApiError.badRequest(`Block ${index + 1} has unknown type "${type}"`);
    }

    const audience: { visibleTo?: string; hiddenFrom?: string } = {};
    for (const key of ['visibleTo', 'hiddenFrom'] as const) {
      const value = block[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string') {
        throw ApiError.badRequest(`Block ${index + 1}: ${key} must be a segment key`);
      }
      const segment = value;
      if (!/^[a-z0-9_]{2,64}$/.test(segment)) {
        throw ApiError.badRequest(`Block ${index + 1}: "${segment}" is not a segment key`);
      }
      audience[key] = segment;
    }

    switch (type) {
      case 'heading': {
        const level = Number(block.level ?? 2);
        return {
          type: 'heading',
          text: text(block.text, `Block ${index + 1} heading`, 300, true),
          level: ([1, 2, 3].includes(level) ? level : 2) as 1 | 2 | 3,
          ...audience,
        };
      }
      case 'text':
        return {
          type: 'text',
          text: text(block.text, `Block ${index + 1} text`, MAX_TEXT, true),
          ...audience,
        };
      case 'button':
        return {
          type: 'button',
          label: text(block.label, `Block ${index + 1} label`, 120, true),
          url: assertUrl(block.url, `Block ${index + 1} link`),
          ...audience,
        };
      case 'image':
        return {
          type: 'image',
          src: assertUrl(block.src, `Block ${index + 1} image`),
          alt: text(block.alt ?? '', `Block ${index + 1} alt text`, 300),
          ...(block.url ? { url: assertUrl(block.url, `Block ${index + 1} link`) } : {}),
          ...audience,
        };
      case 'divider':
        return { type: 'divider', ...audience };
      case 'spacer': {
        const size = text(block.size ?? 'medium', `Block ${index + 1} height`, 16);
        return {
          type: 'spacer',
          size: (['small', 'medium', 'large'].includes(size) ? size : 'medium') as never,
          ...audience,
        };
      }
      case 'products': {
        if (block.items !== undefined && !Array.isArray(block.items)) {
          throw ApiError.badRequest(`Block ${index + 1}: products must be a list`);
        }
        const items = Array.isArray(block.items) ? block.items : [];
        if (items.length > MAX_PRODUCTS) {
          throw ApiError.badRequest(`Block ${index + 1}: at most ${MAX_PRODUCTS} products`);
        }
        return {
          type: 'products',
          items: items.map((item, position) => {
            const one = (item ?? {}) as Record<string, unknown>;
            return {
              title: text(one.title, `Block ${index + 1}, product ${position + 1}`, 200, true),
              ...(one.url ? { url: assertUrl(one.url, `Product ${position + 1} link`) } : {}),
              ...(one.image ? { image: assertUrl(one.image, `Product ${position + 1} image`) } : {}),
              ...(one.price ? { price: text(one.price, `Product ${position + 1} price`, 40) } : {}),
            };
          }),
          ...audience,
        };
      }
      default:
        return {
          type: 'points',
          heading: text(block.heading ?? 'Your points', `Block ${index + 1} heading`, 120),
          caption: text(block.caption ?? '', `Block ${index + 1} caption`, 300),
          ...audience,
        };
    }
  });
}

/** Every segment key a block list refers to. */
export function segmentsUsed(blocks: Block[]): string[] {
  const keys = new Set<string>();
  for (const block of blocks) {
    if (block.visibleTo) keys.add(block.visibleTo);
    if (block.hiddenFrom) keys.add(block.hiddenFrom);
  }
  return [...keys];
}

/**
 * Refuse a segment key that names no segment.
 *
 * A typo is otherwise invisible and silent in the worst direction: `visibleTo:
 * "vips"` hides the block from everybody, `hiddenFrom: "vips"` shows it to
 * everybody, and the retailer finds out from whoever received the wrong one.
 */
export async function assertSegmentsExist(
  tenantId: string,
  blocks: Block[],
  runner: Queryable = db(),
): Promise<void> {
  const wanted = segmentsUsed(blocks);
  if (wanted.length === 0) return;

  const { rows } = await runner.query<{ key: string }>(
    'SELECT key FROM segments WHERE tenant_id = $1 AND key = ANY($2::text[])',
    [tenantId, wanted],
  );
  const known = new Set(rows.map((row) => row.key));
  const missing = wanted.filter((key) => !known.has(key));
  if (missing.length > 0) {
    throw ApiError.badRequest(
      missing.length === 1
        ? `There is no segment "${missing[0]}"`
        : `No such segments: ${missing.join(', ')}`,
    );
  }
}

/**
 * Which of those segments this contact is in.
 *
 * One query for the whole message rather than one per conditional block: a
 * newsletter with four VIP blocks should cost the same as one with one.
 * `segment_members` is materialised by the segment worker, so this is an index
 * lookup and not a filter re-run.
 */
export async function membershipFor(
  tenantId: string,
  contactId: string,
  segmentKeys: string[],
  runner: Queryable = db(),
): Promise<Set<string>> {
  if (segmentKeys.length === 0) return new Set();

  const { rows } = await runner.query<{ key: string }>(
    `SELECT s.key
       FROM segment_members m
       JOIN segments s ON s.id = m.segment_id
      WHERE s.tenant_id = $1 AND m.contact_id = $2 AND s.key = ANY($3::text[])`,
    [tenantId, contactId, segmentKeys],
  );
  return new Set(rows.map((row) => row.key));
}

function visible(block: Block, member: Set<string>): boolean {
  if (block.visibleTo && !member.has(block.visibleTo)) return false;
  if (block.hiddenFrom && member.has(block.hiddenFrom)) return false;
  return true;
}

/**
 * Blocks to HTML.
 *
 * Tables and inline styles throughout, because that is what email clients
 * render. Outlook's word-processor engine ignores flexbox, grid, most of
 * `position`, and any stylesheet that is not inline — so the modern markup
 * this would otherwise use produces a message that looks correct everywhere
 * except at half the recipients.
 *
 * Every value is escaped. `{{merge_fields}}` survive escaping because braces
 * are not escaped, and are substituted afterwards by `renderTemplate`.
 */
export function renderBlocks(blocks: Block[], member: Set<string> = new Set()): string {
  const parts: string[] = [];

  for (const block of blocks) {
    if (!visible(block, member)) continue;

    switch (block.type) {
      case 'heading': {
        const size = block.level === 1 ? 26 : block.level === 3 ? 17 : 21;
        parts.push(
          `<h${block.level ?? 2} style="margin:0 0 12px;font-size:${size}px;line-height:1.3;color:#1d1d1f;">` +
            `${escapeHtml(block.text)}</h${block.level ?? 2}>`,
        );
        break;
      }

      case 'text':
        // Blank lines become paragraphs, which is what somebody typing into a
        // textarea means by them.
        for (const paragraph of block.text.split(/\n{2,}/)) {
          if (paragraph.trim() === '') continue;
          parts.push(
            `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#1d1d1f;">` +
              `${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`,
          );
        }
        break;

      case 'button':
        // A table, not an anchor with padding: Outlook drops padding on an
        // inline element, and the button becomes underlined text.
        parts.push(
          `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">` +
            `<tr><td style="background:#1d1d1f;border-radius:8px;">` +
            `<a href="${escapeHtml(block.url)}" style="display:inline-block;padding:12px 24px;` +
            `font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">` +
            `${escapeHtml(block.label)}</a></td></tr></table>`,
        );
        break;

      case 'image': {
        const img =
          `<img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt ?? '')}" ` +
          `style="display:block;width:100%;max-width:496px;height:auto;border-radius:8px;border:0;">`;
        parts.push(
          `<div style="margin:0 0 20px;">${
            block.url ? `<a href="${escapeHtml(block.url)}">${img}</a>` : img
          }</div>`,
        );
        break;
      }

      case 'divider':
        parts.push(`<hr style="border:none;border-top:1px solid #e5e5ea;margin:24px 0;">`);
        break;

      case 'spacer': {
        const height = block.size === 'small' ? 8 : block.size === 'large' ? 40 : 20;
        parts.push(`<div style="height:${height}px;line-height:${height}px;">&nbsp;</div>`);
        break;
      }

      case 'products': {
        if (block.items.length === 0) break;
        const cells = block.items
          .map((item) => {
            const image = item.image
              ? `<img src="${escapeHtml(item.image)}" alt="" style="display:block;width:100%;` +
                `height:auto;border-radius:6px;border:0;margin:0 0 8px;">`
              : '';
            const title = item.url
              ? `<a href="${escapeHtml(item.url)}" style="color:#1d1d1f;text-decoration:none;">` +
                `${escapeHtml(item.title)}</a>`
              : escapeHtml(item.title);
            const price = item.price
              ? `<div style="font-size:13px;color:#6e6e73;margin-top:2px;">${escapeHtml(item.price)}</div>`
              : '';
            return (
              `<td width="33%" valign="top" style="padding:0 8px 20px;font-size:14px;">` +
              `${image}<div style="font-weight:600;">${title}</div>${price}</td>`
            );
          })
          .join('');

        // Three to a row: two is wasteful on desktop and four is unreadable on
        // a phone, where the cells stack anyway.
        const rows: string[] = [];
        const list = cells.match(/<td[\s\S]*?<\/td>/g) ?? [];
        for (let index = 0; index < list.length; index += 3) {
          rows.push(`<tr>${list.slice(index, index + 3).join('')}</tr>`);
        }
        parts.push(
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
            `style="margin:0 -8px 4px;">${rows.join('')}</table>`,
        );
        break;
      }

      case 'points':
        parts.push(
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
            `style="margin:0 0 24px;background:#f5f5f7;border-radius:10px;"><tr>` +
            `<td style="padding:20px;text-align:center;">` +
            `<div style="font-size:13px;color:#6e6e73;">${escapeHtml(
              block.heading ?? 'Your points',
            )}</div>` +
            `<div style="font-size:30px;font-weight:700;margin:4px 0;">{{points_balance}}</div>` +
            (block.caption
              ? `<div style="font-size:13px;color:#6e6e73;">${escapeHtml(block.caption)}</div>`
              : '') +
            `</td></tr></table>`,
        );
        break;
    }
  }

  return parts.join('\n');
}

/**
 * A plain-text version built from the blocks rather than stripped from HTML.
 *
 * Stripping tags out of a table layout produces a column of stray whitespace
 * and the word "Shop" on its own line. Reading the blocks gives the text
 * somebody actually wrote, in order.
 */
export function blocksToText(blocks: Block[], member: Set<string> = new Set()): string {
  const lines: string[] = [];

  for (const block of blocks) {
    if (!visible(block, member)) continue;

    switch (block.type) {
      case 'heading':
        lines.push(block.text, '');
        break;
      case 'text':
        lines.push(block.text, '');
        break;
      case 'button':
        lines.push(`${block.label}: ${block.url}`, '');
        break;
      case 'image':
        if (block.url) lines.push(block.url, '');
        break;
      case 'divider':
        lines.push('---', '');
        break;
      case 'products':
        for (const item of block.items) {
          lines.push(
            [item.title, item.price, item.url].filter(Boolean).join(' — '),
          );
        }
        lines.push('');
        break;
      case 'points':
        lines.push(`${block.heading ?? 'Your points'}: {{points_balance}}`, '');
        break;
      case 'spacer':
        break;
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * This recipient's copy of a block-built message.
 *
 * Returned unchanged for a hand-written template, and for a built one with no
 * conditional block — which is the common case, and costs one `.some()` rather
 * than a query.
 *
 * When a block *is* conditional, the stored HTML is wrong for everybody: it
 * was rendered with nobody's membership, so it shows every block. This is
 * where one message becomes two audiences.
 */
export async function personalise<
  T extends { html: string; text?: string | null; blocks?: unknown; preheader?: string | null },
>(
  tenantId: string,
  contactId: string | null | undefined,
  template: T,
  runner: Queryable = db(),
): Promise<T> {
  if (!template.blocks || !contactId) return template;

  let blocks: Block[];
  try {
    const parsed = Array.isArray(template.blocks)
      ? template.blocks
      : JSON.parse(String(template.blocks));
    // Valid JSON that is not a list — `123`, `true`, an object — would reach
    // `for…of` below and throw. Only a direct database write can produce it,
    // which is exactly the case worth surviving.
    if (!Array.isArray(parsed)) return template;
    blocks = parsed as Block[];
  } catch {
    // Unparseable blocks are not a reason to fail somebody's receipt: the
    // stored HTML is a complete, if unconditional, copy of the message.
    return template;
  }

  const segments = segmentsUsed(blocks);
  if (segments.length === 0) return template;

  const member = await membershipFor(tenantId, contactId, segments, runner);
  return {
    ...template,
    html: renderDocument(blocks, member, template.preheader),
    text: blocksToText(blocks, member),
  };
}

/**
 * A block list as a whole message, framed and ready to send.
 *
 * `renderBlocks` deliberately returns a fragment — the preview pane and the
 * builder both want the body on its own. A message does not: without the
 * frame it has no unsubscribe link, no preferences link and no `<!doctype>`,
 * and Outlook renders a bare fragment in quirks mode. Everything that stores
 * or sends composed HTML goes through here so that cannot be forgotten in one
 * of the three places.
 */
export function renderDocument(
  blocks: Block[],
  member: Set<string> = new Set(),
  preheader?: string | null,
): string {
  return layout(renderPreheader(preheader) + renderBlocks(blocks, member));
}

/**
 * The line a mail client shows beside the subject.
 *
 * Hidden four ways because no single trick works everywhere, and trailing
 * zero-width characters so the client pads to its preview length with nothing
 * rather than pulling in the first words of the body — which for a message
 * that opens with an image is its alt text.
 */
function renderPreheader(preheader?: string | null): string {
  const line = String(preheader ?? '').trim();
  if (line === '') return '';
  return (
    '<div style="display:none;max-height:0;max-width:0;overflow:hidden;' +
    'opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:transparent;">' +
    escapeHtml(line.slice(0, 200)) +
    '&#847;&zwnj;&nbsp;'.repeat(30) +
    '</div>'
  );
}

/**
 * The balance a `points` block shows.
 *
 * Read only when a message actually holds one, so a newsletter without a
 * points block costs nothing extra. The default currency: a block that said
 * which one would have to survive a retailer renaming their currencies, and
 * "your balance" means the spendable one.
 */
export async function pointsBalanceFor(
  tenantId: string,
  contactId: string,
  runner: Queryable = db(),
): Promise<number> {
  const { rows } = await runner.query<{ balance: string }>(
    `SELECT b.balance
       FROM points_balances b
       JOIN point_types t ON t.tenant_id = b.tenant_id AND t.key = b.point_type
      WHERE b.tenant_id = $1 AND b.contact_id = $2
      ORDER BY t.is_default DESC, t.key
      LIMIT 1`,
    [tenantId, contactId],
  );
  return Number(rows[0]?.balance ?? 0);
}

// ── What a builder needs to know ─────────────────────────────────────────────

export type BlockFieldSpec = {
  name: string;
  label: string;
  kind: 'text' | 'longtext' | 'url' | 'choice' | 'list';
  required?: boolean;
  max?: number;
  choices?: Array<{ value: string; label: string }>;
  /** For `list` fields: the shape of one row. */
  fields?: BlockFieldSpec[];
  maxItems?: number;
  hint?: string;
};

export type BlockSpec = {
  type: Block['type'];
  label: string;
  summary: string;
  fields: BlockFieldSpec[];
};

/**
 * Every block type, and the fields each takes.
 *
 * The wp-admin builder renders its form from this rather than carrying its own
 * copy of the list. A hard-coded copy is a second schema: add a field here and
 * the plugin silently drops it, rename one and the plugin posts a key
 * `validateBlocks` discards — both of which look like the block "not saving"
 * and neither of which fails anywhere a developer is looking.
 *
 * The limits are the same constants the validator enforces, so the form stops
 * somebody at 60 blocks rather than the API rejecting the whole message after
 * they have written it.
 */
export function describeBlocks(): BlockSpec[] {
  // Every block may name a segment it is for, or one it is not for. That is
  // what makes one message serve two audiences rather than sending two.
  const audience: BlockFieldSpec[] = [
    {
      name: 'visibleTo',
      label: 'Only show to segment',
      kind: 'text',
      hint: 'Segment key. Leave blank to show this block to everybody.',
      max: 64,
    },
    {
      name: 'hiddenFrom',
      label: 'Hide from segment',
      kind: 'text',
      hint: 'Segment key. Leave blank to show this block to everybody.',
      max: 64,
    },
  ];

  const spec = (
    type: Block['type'],
    label: string,
    summary: string,
    fields: BlockFieldSpec[],
  ): BlockSpec => ({ type, label, summary, fields: [...fields, ...audience] });

  return [
    spec('heading', 'Heading', 'A line of larger text.', [
      { name: 'text', label: 'Heading', kind: 'text', required: true, max: 300 },
      {
        name: 'level',
        label: 'Size',
        kind: 'choice',
        choices: [
          { value: '1', label: 'Large' },
          { value: '2', label: 'Medium' },
          { value: '3', label: 'Small' },
        ],
      },
    ]),
    spec('text', 'Text', 'A paragraph. Blank lines start a new one.', [
      {
        name: 'text',
        label: 'Text',
        kind: 'longtext',
        required: true,
        max: MAX_TEXT,
        hint: 'Merge fields such as {{first_name}} are substituted when the message is sent.',
      },
    ]),
    spec('button', 'Button', 'A link styled as a button.', [
      { name: 'label', label: 'Button text', kind: 'text', required: true, max: 120 },
      { name: 'url', label: 'Links to', kind: 'url', required: true },
    ]),
    spec('image', 'Image', 'A full-width picture, optionally a link.', [
      { name: 'src', label: 'Image URL', kind: 'url', required: true },
      {
        name: 'alt',
        label: 'Alt text',
        kind: 'text',
        max: 300,
        hint: 'Shown when images are blocked, which they are by default in many mail clients.',
      },
      { name: 'url', label: 'Links to', kind: 'url' },
    ]),
    spec('divider', 'Divider', 'A horizontal rule.', []),
    spec('spacer', 'Spacer', 'Vertical space.', [
      {
        name: 'size',
        label: 'Height',
        kind: 'choice',
        choices: [
          { value: 'small', label: 'Small' },
          { value: 'medium', label: 'Medium' },
          { value: 'large', label: 'Large' },
        ],
      },
    ]),
    spec('products', 'Products', 'A row of products with prices and links.', [
      {
        name: 'items',
        label: 'Products',
        kind: 'list',
        maxItems: MAX_PRODUCTS,
        fields: [
          { name: 'title', label: 'Name', kind: 'text', required: true, max: 200 },
          { name: 'url', label: 'Links to', kind: 'url' },
          { name: 'image', label: 'Image URL', kind: 'url' },
          { name: 'price', label: 'Price', kind: 'text', max: 40 },
        ],
      },
    ]),
    spec('points', 'Points balance', "The recipient's balance, filled in when the message is sent.", [
      { name: 'heading', label: 'Heading', kind: 'text', max: 120 },
      { name: 'caption', label: 'Caption', kind: 'text', max: 300 },
    ]),
  ];
}

/** The most blocks one message may hold — the builder stops there too. */
export const BLOCK_LIMIT = MAX_BLOCKS;
