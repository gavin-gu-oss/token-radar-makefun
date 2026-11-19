/** A deterministic, offline interpretation of the sealed snapshot. No identity-based scoring. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'log-radar-1.0.0';
export const EARLY_ROWS = 160;
export const LIVE_ROWS = 24;
export const MODEL = Object.freeze({
  tvl_scale_usd: 10_000_000,
  base_scale_usd: 20_000_000,
  growth_floor: -60,
  growth_cap: 120,
  growth_weight: 0.5,
  unknown_growth_pct: 0,
  maturity_floor: 0.65,
  maturity_range: 0.35,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_log_weight: 0.035,
  chain_bonus_cap: 0.14,
});

export interface ValueFactors {
  base_value_usd: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number;
  age_known: boolean;
  watchlist: boolean;
  token_status: 'records no token';
  implied_value_usd: number;
  model: ValueFactors;
  farm_steps: string[];
}

export interface RadarRow extends Omit<BoardRow, 'model'>, ValueFactors {}
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number;
  value_label: 'already trading — market value, not implied';
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: typeof MODEL;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(`snapshot: ${message}`);
    this.name = 'SnapshotError';
  }
}

function requireThat(ok: boolean, message: string): asserts ok {
  if (!ok) throw new SnapshotError(message);
}

function objectAt(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  requireThat(typeof value === 'object' && value !== null && !Array.isArray(value), `${path} must be an object`);
  const record = value as Record<string, unknown>;
  const missing = keys.filter((key) => !Object.hasOwn(record, key));
  const extra = Object.keys(record).filter((key) => !keys.includes(key));
  requireThat(!missing.length && !extra.length, `${path} fields: missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`);
  return record;
}

function textAt(value: unknown, path: string, max = 256): string {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value === value.trim(), `${path} must be a nonempty, trimmed string`);
  requireThat(value.length <= max && !/[\u0000-\u001f\u007f]/.test(value), `${path} is too long or contains control characters`);
  return value;
}

function dollarsAt(value: unknown, path: string, positive: boolean): number {
  requireThat(typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0), `${path} must be a ${positive ? 'positive' : 'nonnegative'} safe integer of dollars`);
  return value;
}

function dateAt(value: unknown, path: string): string {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), `${path} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  requireThat(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value, `${path} is not a real UTC date`);
  return value;
}

/** Reject malformed fields rather than silently coercing missing token metadata to null. */
export function parseSnapshot(text: string): Snapshot {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new SnapshotError('input is not valid JSON'); }
  const raw = objectAt(parsed, 'root', ['as_of', 'source', 'floor_usd', 'protocols', 'watchlist']);
  const as_of = dateAt(raw.as_of, 'as_of');
  const source = textAt(raw.source, 'source', 2048);
  const floor_usd = dollarsAt(raw.floor_usd, 'floor_usd', true);
  requireThat(Array.isArray(raw.protocols) && raw.protocols.length > 0, 'protocols must be a nonempty array');
  requireThat(Array.isArray(raw.watchlist) && raw.watchlist.length > 0, 'watchlist must be a nonempty array');
  const seen = new Set<string>();
  const protocols: SnapshotProtocol[] = raw.protocols.map((entry, index) => {
    const path = `protocols[${index}]`;
    const p = objectAt(entry, path, ['slug', 'name', 'category', 'chains', 'tvl_usd', 'change_7d', 'mcap_usd', 'listed_at', 'gecko_id', 'symbol']);
    const slug = textAt(p.slug, `${path}.slug`, 128);
    requireThat(!/\s/.test(slug), `${path}.slug must contain no whitespace`);
    requireThat(!seen.has(slug), `${path}.slug duplicates ${slug}`);
    seen.add(slug);
    const name = textAt(p.name, `${path}.name`, 128);
    const nullableText = (key: string) => p[key] === null ? null : textAt(p[key], `${path}.${key}`);
    const category = nullableText('category');
    const gecko_id = nullableText('gecko_id');
    const symbol = nullableText('symbol');
    requireThat(symbol !== '-', `${path}.symbol must use null for the placeholder`);
    requireThat(Array.isArray(p.chains), `${path}.chains must be an array`);
    const chains = p.chains.map((chain, i) => textAt(chain, `${path}.chains[${i}]`, 64));
    requireThat(new Set(chains).size === chains.length, `${path}.chains contains duplicates`);
    const tvl_usd = dollarsAt(p.tvl_usd, `${path}.tvl_usd`, true);
    // The sealed input contains -1 as an unavailable-market-cap sentinel. Preserve it:
    // turning it into null could misclassify a token-bearing record as pre-token.
    requireThat(p.mcap_usd === null || (typeof p.mcap_usd === 'number' && Number.isSafeInteger(p.mcap_usd) && p.mcap_usd >= -1), `${path}.mcap_usd must be null, a nonnegative safe integer, or the snapshot's -1 sentinel`);
    const mcap_usd = p.mcap_usd as number | null;
    requireThat(p.change_7d === null || (typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) && p.change_7d >= -100), `${path}.change_7d must be null or a finite percentage >= -100`);
    const listed_at = p.listed_at === null ? null : dateAt(p.listed_at, `${path}.listed_at`);
    requireThat(listed_at === null || listed_at <= as_of, `${path}.listed_at is later than as_of`);
    return { slug, name, category, chains, tvl_usd, change_7d: p.change_7d as number | null, mcap_usd, listed_at, gecko_id, symbol };
  });
  const index = new Map(protocols.map((p) => [p.slug, p]));
  const watched = new Set<string>();
  const watchlist = raw.watchlist.map((entry, i) => {
    const slug = textAt(entry, `watchlist[${i}]`, 128);
    requireThat(!watched.has(slug), `watchlist duplicates ${slug}`);
    watched.add(slug);
    const p = index.get(slug);
    requireThat(p !== undefined, `watchlist[${i}] names unknown slug ${slug}`);
    requireThat(isRankable(p) && p.tvl_usd >= floor_usd, `watchlist ${slug} must be rankable and at or above floor_usd`);
    return slug;
  });
  return { as_of, source, floor_usd, protocols, watchlist };
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null && p.mcap_usd === null;
}

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !/\s(?:v\d+(?:\.\d+)*|\d+\.\d+(?:\.\d+)*)$/i.test(p.name);
}

/** Listing age measures observed history, not time since launch or proof of token absence. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  return listedAt === null ? null : Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(listedAt)) / 86_400_000));
}

/**
 * base = $20m * ln(1 + TVL / $10m): increasing, with diminishing marginal weight for TVL.
 * growth = 1 + 0.5 * clamp(change_7d ?? 0, -60, 120) / 100, bounded 0.70..1.60.
 * maturity = 0.65 + 0.35 * min(age_days ?? 365, 1095) / 1095, bounded 0.65..1.
 * chains = 1 + min(0.14, 0.035 * log2(max(1, chain_count))), bounded 1..1.14.
 * implied = round(base * growth * maturity * chains), at least $1.
 * These are transparent heuristic scenario dollars, not market cap, FDV, a price target,
 * launch odds or expected rewards. No supply, fee revenue or token economics is in the input.
 * Only snapshot TVL, growth, listing age and chain count influence the value; identities never do.
 * Rounding is the only quantization: ties are sorted by slug, never manufactured by rank buckets.
 */
export function impliedValue(p: SnapshotProtocol, asOf: string) {
  const knownAge = ageDays(asOf, p.listed_at);
  const age = knownAge ?? MODEL.unknown_age_days;
  const growth_pct = Math.max(MODEL.growth_floor, Math.min(MODEL.growth_cap, p.change_7d ?? MODEL.unknown_growth_pct));
  const factors: ValueFactors = {
    base_value_usd: MODEL.base_scale_usd * Math.log1p(p.tvl_usd / MODEL.tvl_scale_usd),
    growth_pct,
    growth_multiplier: 1 + MODEL.growth_weight * growth_pct / 100,
    maturity_multiplier: MODEL.maturity_floor + MODEL.maturity_range * Math.min(age, MODEL.maturity_days) / MODEL.maturity_days,
    chain_multiplier: 1 + Math.min(MODEL.chain_bonus_cap, MODEL.chain_log_weight * Math.log2(Math.max(1, p.chains.length))),
  };
  const implied = Math.max(1, Math.round(factors.base_value_usd * factors.growth_multiplier * factors.maturity_multiplier * factors.chain_multiplier));
  return { implied, age, age_known: knownAge !== null, factors };
}

export function capitalFor(p: SnapshotProtocol): number {
  return p.tvl_usd >= 5_000_000_000 ? 250 : p.tvl_usd >= 1_000_000_000 ? 150 : p.tvl_usd >= 100_000_000 ? 100 : 50;
}

export function holdDaysFor(age: number | null): number {
  const days = age ?? MODEL.unknown_age_days;
  return days < 180 ? 60 : days < 365 ? 45 : 30;
}

/** Category templates specify a position and a repeatable action without inventing supported assets. */
function actionsFor(category: string | null, capital: number): { position: string; weekly: string } {
  const c = (category ?? '').toLowerCase();
  if (/lend|cdp|collateral/.test(c)) return {
    position: `Supply $${capital} of an asset supported in the app's documented lending or collateral market; leave borrowing disabled and record the withdrawal terms`,
    weekly: 'Add $5 to the same supplied position; record the receipt and updated balance',
  };
  if (/bridge/.test(c)) return {
    position: `Use the published route selector to bridge $${capital} from another supported chain to the chain below; verify the destination balance and keep the receipt`,
    weekly: 'Bridge $5 on the same supported route once; record both transaction receipts and the received amount',
  };
  if (/stak|restaked/.test(c)) return {
    position: `Stake $${capital} of the documented staking asset in the app; record the receipt balance, lock and unbonding delay`,
    weekly: 'Add $5 through the same staking flow and record the receipt balance; do not compound with borrowed funds',
  };
  if (/perp|derivative|options|synthetic|basis/.test(c)) return {
    position: `Fund the documented trading account with $${capital}; if supported, execute one unlevered trade of at most $5 and close it; retain the remaining collateral`,
    weekly: 'Execute and close one supported unlevered trade of at most $5; log realized costs and skip if leverage is mandatory',
  };
  if (/rwa/.test(c)) return {
    position: `Check eligibility, redemption windows and minimums; if eligible and the minimum allows it, subscribe $${capital} to a documented real-world-asset product`,
    weekly: 'Review the issuer statement and redemption status; add $5 only if the published minimum permits it, otherwise log a review without transacting',
  };
  if (/dex|liquidity/.test(c)) return {
    position: `Split $${capital} across the two assets of a documented liquid pool and add liquidity using the app's default range; record the receipt and pool fee`,
    weekly: 'Swap $5 through the same app at a maximum 0.5% slippage; record the receipt and pool position balance',
  };
  if (/yield|farm|curator|allocator|vault|index/.test(c)) return {
    position: `Deposit $${capital} into one documented unlevered vault or strategy; read the underlying exposure and withdrawal queue before approving`,
    weekly: 'Add $5 to the same vault or strategy; record shares received, fees and any withdrawal queue change',
  };
  if (/stable|reserve/.test(c)) return {
    position: `Use $${capital} in a documented mint or deposit flow, verify backing and redemption terms, and record the receipt balance`,
    weekly: 'Repeat the supported mint or deposit with $5 and record the resulting balance and redemption quote',
  };
  if (/prediction/.test(c)) return {
    position: `Set aside a $${capital} participation budget and buy at most $5 of one outcome using the documented market flow; leave the remainder uncommitted`,
    weekly: 'Review settlement terms and place at most one $5 outcome purchase if eligible; log the maximum possible loss',
  };
  return {
    position: `Reserve $${capital} for the app's documented participation flow; read eligibility, minimums and exit terms, test with $5, then commit the remainder only if the flow fits`,
    weekly: 'Repeat the same documented participation action with at most $5 and record the receipt; skip if the app offers no suitable action',
  };
}

/** Six planning steps; budgets are estimates, and activity does not establish reward eligibility. */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains[0] ?? 'the chain confirmed by the protocol documentation';
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionsFor(p.category, capital);
  return [
    `Create a fresh wallet for ${p.name} on ${chain}, keep its recovery phrase offline and verify the app through the protocol's own published link. The snapshot records no token. Cost: $${capital} reserved capital plus a $10 gas budget, not a fee quote. Time: 10 minutes.`,
    `${action.position}. Use ${chain}; if the documented asset, route or minimum is unavailable, skip the position. Cost: up to $${capital} capital plus a $5 gas/fee budget. Time: 20 minutes.`,
    `${action.weekly}. Treat it as a candidate qualifying action only when the protocol publishes matching eligibility rules; do not assume rewards. Cost: up to $5 extra capital plus $3 gas/fees per week. Time: 10 minutes every 7 days.`,
    `Maintain the documented position or bridged balance for a planned ${hold} days and inspect withdrawal terms each week; exit sooner if the exposure no longer fits. Holding does not guarantee eligibility. Cost: up to $${capital} capital remains exposed, plus weekly additions; $0 gas to hold. Time: ${hold} days and 5 minutes per weekly review.`,
    `Check ${p.name}'s own published eligibility or rewards link, if one exists. Claim only through that published link after checking permissions; if no program is published, log that fact and make no claim. Cost: $0 to check; budget at most $5 gas for a verified claim. Time: 10 minutes per check.`,
    `Keep a farm log for ${p.name}: wallet address, ${chain}, dates, transaction receipts, capital, gas, balances and exit or claim checks. Reconcile weekly and record the final withdrawal. Cost: $0 for the log; reserve $5 gas for exit. Time: 5 minutes now, 5 minutes weekly and 10 minutes to reconcile exit.`,
  ];
}

const slugOrder = (a: { slug: string }, b: { slug: string }) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;

function selection(snapshot: Snapshot): SnapshotProtocol[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watched = new Set(snapshot.watchlist);
  const required = snapshot.watchlist.map((slug) => {
    const p = index.get(slug);
    if (!p || !isRankable(p)) throw new SnapshotError(`watchlist ${slug} is missing or cannot be ranked`);
    return p;
  });
  const early = snapshot.protocols.filter((p) => !watched.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || slugOrder(a, b)).slice(0, EARLY_ROWS);
  requireThat(early.length === EARLY_ROWS, `need ${EARLY_ROWS} rankable protocols below the floor, found ${early.length}`);
  return [...required, ...early];
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const watched = new Set(snapshot.watchlist);
  const board: BoardRow[] = selection(snapshot).map((p) => {
    const score = impliedValue(p, snapshot.as_of);
    return {
      rank: 0, slug: p.slug, name: p.name, category: p.category, chains: [...p.chains],
      tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at,
      age_days: score.age, age_known: score.age_known, watchlist: watched.has(p.slug),
      token_status: 'records no token', implied_value_usd: score.implied, model: score.factors,
      farm_steps: farmSteps(p, ageDays(snapshot.as_of, p.listed_at)),
    };
  });
  board.sort((a, b) => b.implied_value_usd - a.implied_value_usd || slugOrder(a, b));
  board.forEach((row, i) => { row.rank = i + 1; });
  const live: LiveRow[] = snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd >= 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || slugOrder(a, b)).slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug, name: p.name, category: p.category, chains: [...p.chains],
      tvl_usd: p.tvl_usd, change_7d: p.change_7d, mcap_usd: p.mcap_usd!,
      value_label: 'already trading — market value, not implied',
    }));
  return { board, radar: {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
    model: MODEL, model_version: MODEL_VERSION, watchlist_size: watched.size,
    board_size: board.length, early_size: board.length - watched.size, live_size: live.length,
    rows: board.map(({ model, ...row }) => ({ ...row, ...model })), live,
  } };
}

/** Validate the submission contract and this model's stronger cohort and plan requirements. */
export function boardIssue(board: unknown, snapshot: Snapshot): string | null {
  if (!Array.isArray(board)) return 'board must be an array';
  const expectedSize = snapshot.watchlist.length + EARLY_ROWS;
  if (board.length !== expectedSize) return `expected ${expectedSize} rows, found ${board.length}`;
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const slugs = new Set<string>();
  const ranks = new Set<number>();
  const ordered: { rank: number; implied_value_usd: number }[] = [];
  for (const row of board) {
    if (!row || typeof row !== 'object') return 'board row must be an object';
    const p = index.get(row.slug);
    if (!p) return `unknown board slug ${String(row.slug)}`;
    if (slugs.has(row.slug)) return `duplicate board slug ${row.slug}`;
    slugs.add(row.slug);
    if (!isRankable(p)) return `${row.slug} is token-bearing, CEX or versioned`;
    if (row.name !== p.name) return `${row.slug} name differs from snapshot`;
    if (!Number.isSafeInteger(row.rank) || row.rank < 1 || row.rank > board.length || ranks.has(row.rank)) return `${row.slug} has invalid or duplicate rank ${row.rank}`;
    ranks.add(row.rank);
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd < 1 || row.implied_value_usd > 100_000_000_000_000) return `${row.slug} implied value must be a positive integer within the gate cap`;
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length !== 6) return `${row.slug} must have exactly six farm steps`;
    for (const [i, step] of row.farm_steps.entries()) {
      if (typeof step !== 'string' || step.trim().length < 20 || step.trim().length > 600) return `${row.slug} farm step ${i + 1} must have 20..600 trimmed characters`;
      if (!/Cost:.*\$\d/.test(step) || !/Time:.*\d+.*(?:minutes|days)/.test(step)) return `${row.slug} farm step ${i + 1} needs dollar cost and time`;
    }
    ordered.push(row);
  }
  for (const slug of snapshot.watchlist) if (!slugs.has(slug)) return `missing watchlist slug ${slug}`;
  try {
    for (const p of selection(snapshot)) if (!slugs.has(p.slug)) return `missing selected below-floor slug ${p.slug}`;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
  ordered.sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.rank !== i + 1) return `missing rank ${i + 1}`;
    if (i && ordered[i]!.implied_value_usd > ordered[i - 1]!.implied_value_usd) return `implied value rises at rank ${i + 1}`;
  }
  if (ordered.length > 1 && ordered[0]!.implied_value_usd === ordered.at(-1)!.implied_value_usd) return 'all implied values are equal';
  return null;
}

/** Safe both as a standalone local script and inside an HTML script element. */
export function dataScript(radar: RadarData): string {
  const escaped = JSON.stringify(radar).replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `window.RADAR=${escaped};\n`;
}
