// Radar-2: the token radar's scoring model.
//
// One sealed snapshot goes in; one ranked board comes out. The board is built from two groups:
// every slug on the snapshot's watchlist (the floor — coverage of the watchlist is never traded
// away) plus the pre-token protocols below that floor, ranked by TVL, which are the early rows
// the radar exists to surface. A protocol counts as pre-token when its index record carries no
// token at all: no market cap, no CoinGecko id, no symbol. Protocols that already trade are set
// aside and shown with the market's own figures, never folded into the ranking.
//
// An implied value is computed only from the snapshot's own numbers. Nothing about a protocol's
// name ever changes its score; the same arithmetic ranks every row:
//
//   size     = sqrt(tvl_usd * floor_usd)            The square root keeps size sublinear, so a
//                                                   protocol ten times larger does not score ten
//                                                   times higher; at the floor, size equals TVL.
//   multiple = the live-token median mcap / TVL of the protocol's category, when at least three
//              live-token protocols in that category report one; otherwise the overall median
//              across all live-token protocols. Clamped to [0.02, 1.0]. Centralised-exchange
//              tokens are excluded from both medians.
//   growth   = clamp(change_7d, -50, +100) percent. A shrinking TVL is penalised; a growing one
//              is rewarded, through growthMult = 1 + growth/100 * 0.6.
//   maturity = 0.5 + min(age_days, 1095)/1095 * 0.5. The longer a protocol has run with no token,
//              the closer it is to launching one. An unknown listing date counts as 365 days.
//   implied  = max(1, round(size * multiple * growthMult * maturity))
//
// The dashboard states these constants and lets the reader vary them in a sandbox; changing them
// here changes the board. No name is ever special-cased.

/** One protocol as the sealed snapshot records it: the ten fields the input carries. */
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

/** The snapshot document as a whole. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The tunable numbers of the radar-2 model, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  category_min_live: number;
  category_multiple_floor: number;
  category_multiple_cap: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.5,
  maturity_range: 0.5,
  maturity_days: 1095,
  unknown_age_days: 365,
  category_min_live: 3,
  category_multiple_floor: 0.02,
  category_multiple_cap: 1.0,
};

/** The model version the dashboard names and the rules quote. */
export const MODEL_VERSION = 'radar-2';

/** How many below-floor pre-token protocols the early radar carries, largest TVL first. */
export const EARLY_ROWS = 1000;

/** How many live-token protocols the dashboard's Live view carries, largest market cap first. */
export const LIVE_ROWS = 24;

/** The live-token multiples the snapshot itself yields: one per category, plus the overall. */
export interface CategoryMultiples {
  by_category: Record<string, number>;
  overall: number;
}

/** One step of a farm plan: what to do, what it costs, how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One ranked row of board.json. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    size_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row slimmed down for data.js, with its farm plan and model breakdown. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  size_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A protocol that already trades: the board shows the market's value, never a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs to render: board, live set, multiples, and the model itself. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  category_multiples: Record<string, number>;
  overall_multiple: number;
}

/** The headline figures for the run log: watchlist size, board size, early and live counts. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** Thrown when the snapshot is not a document this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** `value` when it is a finite number, otherwise `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The middle value of a sorted list, or null when the list is empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle]!;
  return (ordered[middle - 1]! + ordered[middle]!) / 2;
}

/** Whole days from `listedAt` to `asOf`, never below zero; null when a date is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const listedMs = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(listedMs)) return null;
  return Math.max(0, Math.floor((asOfMs - listedMs) / DAY_MS));
}

/** Clamp `n` into the closed interval [`lo`, `hi`]. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Round to four decimals, so the board's multipliers print cleanly. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * The category multiples, drawn from the snapshot's own live-token protocols. For every category
 * with at least `model.category_min_live` live-token protocols that report both a market cap and a
 * TVL, the multiple is the median of their market-cap / TVL. Any other category falls back to the
 * overall median across all live-token protocols. Both are clamped into the model's range.
 * Centralised-exchange protocols are left out of both medians: an exchange token is not a
 * protocol token, and no board row is an exchange.
 */
export function computeCategoryMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): CategoryMultiples {
  const ratiosByCategory = new Map<string, number[]>();
  const everyRatio: number[] = [];
  for (const protocol of snapshot.protocols) {
    if (protocol.category === 'CEX') continue;
    if (protocol.mcap_usd === null || protocol.mcap_usd <= 0 || protocol.tvl_usd <= 0) continue;
    const ratio = protocol.mcap_usd / protocol.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    everyRatio.push(ratio);
    const key = protocol.category ?? 'Other';
    const bucket = ratiosByCategory.get(key);
    if (bucket === undefined) ratiosByCategory.set(key, [ratio]);
    else bucket.push(ratio);
  }
  const overallRaw = median(everyRatio) ?? 0.25;
  const overall = clamp(overallRaw, model.category_multiple_floor, model.category_multiple_cap);
  const byCategory: Record<string, number> = {};
  for (const [category, ratios] of ratiosByCategory) {
    if (ratios.length < model.category_min_live) continue;
    const categoryMedian = median(ratios);
    if (categoryMedian === null) continue;
    byCategory[category] = clamp(categoryMedian, model.category_multiple_floor, model.category_multiple_cap);
  }
  return { by_category: byCategory, overall };
}

/** The multiple one protocol is scored with: its own category's, or the overall when it has none. */
export function categoryMultipleFor(protocol: SnapshotProtocol, multiples: CategoryMultiples): number {
  if (protocol.category !== null) {
    const own = multiples.by_category[protocol.category];
    if (own !== undefined) return own;
  }
  return multiples.overall;
}

/** The sublinear size factor: sqrt(TVL x floor), so size grows slower than TVL. */
function sizeFactor(tvlUsd: number, floorUsd: number): number {
  return Math.sqrt(Math.max(0, tvlUsd) * Math.max(1, floorUsd));
}

/** The growth multiplier from a protocol's 7-day change, clamped into the model's band. */
function growthFactor(change7d: number | null, model: ModelConstants): { pct: number; multiplier: number } {
  const pct = clamp(finite(change7d, 0), model.growth_floor, model.growth_cap);
  return { pct, multiplier: 1 + (pct / 100) * model.growth_weight };
}

/** The maturity multiplier from a protocol's age: older with no token scores closer to launch. */
function maturityFactor(ageDays: number | null, model: ModelConstants): number {
  const age = ageDays ?? model.unknown_age_days;
  const capped = Math.min(Math.max(age, 0), model.maturity_days);
  return model.maturity_floor + (capped / model.maturity_days) * model.maturity_range;
}

/** The multipliers and the implied value one protocol earns under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  multiples: CategoryMultiples,
  floorUsd: number,
): { implied: number; categoryMultiple: number; size: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const categoryMultiple = categoryMultipleFor(protocol, multiples);
  const size = sizeFactor(protocol.tvl_usd, floorUsd);
  const growth = growthFactor(protocol.change_7d, model);
  const maturityMult = maturityFactor(age, model);
  const implied = Math.max(1, Math.round(size * categoryMultiple * growth.multiplier * maturityMult));
  return { implied, categoryMultiple, size: Math.round(size), growthPct: growth.pct, growthMult: growth.multiplier, maturityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** True when a protocol's record shows no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** True when the board may rank a protocol: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** Index the snapshot's protocols by slug for the watchlist lookup. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The watchlist slugs the snapshot still carries, in watchlist order. */
function watchlistProtocols(snapshot: Snapshot, index: Map<string, SnapshotProtocol>): SnapshotProtocol[] {
  const found: SnapshotProtocol[] = [];
  for (const slug of snapshot.watchlist) {
    const protocol = index.get(slug);
    if (protocol !== undefined) found.push(protocol);
  }
  return found;
}

/** The early radar: rankable pre-token protocols below the floor, largest TVL first. */
function earlyProtocols(snapshot: Snapshot, alreadyChosen: Set<string>): SnapshotProtocol[] {
  return snapshot.protocols
    .filter((p) => !alreadyChosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
}

/** The board's rows, strongest implied value first, numbered 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const multiples = computeCategoryMultiples(snapshot, model);
  const index = bySlug(snapshot.protocols);
  // The watchlist is the floor: every slug it names is ranked, even one the snapshot no longer
  // carries (it cannot, but the board's coverage is the gate's row and is never gambled on a
  // missing record). The early radar never replaces a watchlist row: a chosen protocol stays.
  const chosen = new Map<string, SnapshotProtocol>();
  for (const protocol of watchlistProtocols(snapshot, index)) chosen.set(protocol.slug, protocol);
  for (const protocol of earlyProtocols(snapshot, new Set(chosen.keys()))) chosen.set(protocol.slug, protocol);

  const scored = [...chosen.values()].map((p) => {
    const value = impliedValue(p, snapshot.as_of, model, multiples, snapshot.floor_usd);
    return { protocol: p, ...value };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.protocol.slug < b.protocol.slug ? -1 : a.protocol.slug > b.protocol.slug ? 1 : 0));
  return scored.map((entry, i) => ({
    rank: i + 1,
    slug: entry.protocol.slug,
    name: entry.protocol.name,
    category: entry.protocol.category,
    chains: entry.protocol.chains,
    tvl_usd: entry.protocol.tvl_usd,
    change_7d: entry.protocol.change_7d,
    mcap_usd: entry.protocol.mcap_usd,
    listed_at: entry.protocol.listed_at,
    gecko_id: entry.protocol.gecko_id,
    symbol: entry.protocol.symbol,
    token_status: 'pre-token',
    age_days: entry.age,
    implied_value_usd: entry.implied,
    model: {
      category_multiple: entry.categoryMultiple,
      size_usd: entry.size,
      growth_pct: entry.growthPct,
      growth_multiplier: round4(entry.growthMult),
      maturity_multiplier: round4(entry.maturityMult),
      age_days: entry.age,
    },
    farm_steps: farmSteps(entry.protocol, entry.age).map(stepText),
  }));
}

/** One farm step as a single string: action, cost and time, inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let joined = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (joined.length > 600) joined = `${joined.slice(0, 596)}...`;
  if (joined.length < 20) joined = `${joined} Hold the position and check the protocol's own page.`;
  return joined;
}

/** The first chain a protocol lists, or a neutral phrase when it lists none. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The capital one farm position needs, tiered by the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The farm plan's wording, as a table instead of a chain of branches. Each rule names the
 * category words it answers to and the sentence it writes; the first rule whose word appears in
 * the protocol's category wins, and a protocol no rule matches gets the generic sentence. The
 * table is the only place the category wording lives, so adding a category is one row.
 */
type PlanSentence = (name: string, capital: number, chain: string) => string;
interface PlanRule {
  words: string[];
  sentence: PlanSentence;
}

const SETUP_RULES: PlanRule[] = [
  { words: ['lend', 'cdp', 'collateral'], sentence: (n, c, ch) => `Supply $${c} of USDC to ${n} on ${ch} and keep the position open.` },
  { words: ['dex', 'leveraged farm'], sentence: (n, c, ch) => `Provide $${c} of liquidity to ${n}'s main pool on ${ch} and keep the position open.` },
  { words: ['yield', 'curator', 'allocator'], sentence: (n, c, ch) => `Deposit $${c} into a ${n} vault on ${ch} and keep the shares.` },
  { words: ['bridge'], sentence: (n, c, ch) => `Bridge $${c} of USDC to ${ch} through ${n} and use the bridged funds in its app.` },
  { words: ['staking', 'restak'], sentence: (n, c) => `Stake $${c} of the chain's staking asset through ${n} and keep the receipt.` },
  { words: ['perpetual', 'derivative', 'options'], sentence: (n, c) => `Deposit $${c} of USDC as margin on ${n} and open one small hedge.` },
  { words: ['prediction'], sentence: (n, c) => `Fund $${c} and place one market position on ${n}.` },
  { words: ['stable'], sentence: (n, c, ch) => `Mint or deposit $${c} of the stable asset through ${n} on ${ch}.` },
  { words: ['rwa'], sentence: (n, c, ch) => `Mint $${c} of the protocol's yield asset on ${ch} and hold it.` },
  { words: ['insurance'], sentence: (n, c, ch) => `Buy $${c} of cover from ${n} on ${ch} and keep the policy.` },
  { words: ['launchpad'], sentence: (n, c, ch) => `Commit $${c} of USDC to ${n}'s next launch pool on ${ch} and hold the allocation.` },
  { words: ['privacy'], sentence: (n, c, ch) => `Deposit $${c} into ${n}'s shielded pool on ${ch} and keep the note.` },
  { words: ['payment'], sentence: (n, c, ch) => `Pay $${c} through ${n} on ${ch} and keep the receipt.` },
  { words: ['governance'], sentence: (n, c, ch) => `Lock $${c} of the governance asset through ${n} on ${ch} and vote once.` },
  { words: ['chain'], sentence: (n, c) => `Bridge $${c} of USDC to ${n}'s chain and use it in one app there.` },
];

const WEEKLY_RULES: PlanRule[] = [
  { words: ['lend', 'cdp', 'collateral'], sentence: (n) => `Each week, adjust the ${n} supply once: top up, borrow a little against it, or repay.` },
  { words: ['dex', 'leveraged farm'], sentence: (n, c, ch) => `Each week, swap once in ${n}'s main pool on ${ch} and leave the liquidity in place.` },
  { words: ['yield', 'curator', 'allocator'], sentence: (n, c, ch) => `Each week, check the ${n} vault on ${ch} and harvest or compound once.` },
  { words: ['bridge'], sentence: (n, c, ch) => `Each week, bridge a small amount through ${n} to ${ch} and use it in the app.` },
  { words: ['staking', 'restak'], sentence: (n) => `Each week, open ${n} and confirm the stake is still earning, then leave it alone.` },
  { words: ['perpetual', 'derivative', 'options'], sentence: (n) => `Each week, close and reopen one small hedge on ${n} so the margin account stays active.` },
  { words: ['prediction'], sentence: (n) => `Each week, settle one market on ${n} and place the next position.` },
  { words: ['stable'], sentence: (n, c, ch) => `Each week, mint or redeem a small amount through ${n} on ${ch}.` },
  { words: ['rwa'], sentence: (n, c, ch) => `Each week, check the ${n} yield asset on ${ch} and claim or compound once.` },
  { words: ['insurance'], sentence: (n, c, ch) => `Each week, confirm the ${n} cover on ${ch} is still in force.` },
  { words: ['launchpad'], sentence: (n, c, ch) => `Each week, check ${n} for a new pool on ${ch} and join one when it opens.` },
  { words: ['privacy'], sentence: (n, c, ch) => `Each week, make one shielded transfer through ${n} on ${ch}.` },
  { words: ['payment'], sentence: (n, c, ch) => `Each week, pay one small bill through ${n} on ${ch}.` },
  { words: ['governance'], sentence: (n, c, ch) => `Each week, vote once through ${n} on ${ch} while the lock is live.` },
];

/** The first rule whose word appears in the lowercased category, or null. */
function matchingRule(rules: PlanRule[], category: string): PlanRule | null {
  const lower = category.toLowerCase();
  for (const rule of rules) {
    if (rule.words.some((word) => lower.includes(word))) return rule;
  }
  return null;
}

/** The category's setup action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const rule = matchingRule(SETUP_RULES, p.category ?? '');
  if (rule !== null) return rule.sentence(p.name, capital, chain);
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/** The category's weekly qualifying action: the habit that keeps the wallet counted. */
function weeklyFor(p: SnapshotProtocol, chain: string): string {
  const rule = matchingRule(WEEKLY_RULES, p.category ?? '');
  if (rule !== null) return rule.sentence(p.name, 0, chain);
  return `Each week, make one qualifying action on ${p.name}: a deposit, a swap, a vote or a claim.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list
 * of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const setup = actionFor(p, capital, chain);
  const weekly = weeklyFor(p, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: setup,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weekly,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, largest market cap first, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row slimmed down for data.js, with its farm plan and its model breakdown. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    size_usd: row.model.size_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, built from the snapshot in one pass. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const multiples = computeCategoryMultiples(snapshot, model);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((row) => !snapshot.watchlist.includes(row.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
    category_multiples: multiples.by_category,
    overall_multiple: multiples.overall,
  };
  return { board, radar };
}

/** Read one field as a string, or null when it is absent or not a string. */
function asString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' ? value : null;
}

/** Read one field as a finite number, or null when it is absent or not a finite number. */
function asNumber(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** One protocol entry out of a raw object, refused unless it carries a slug, a name and a TVL. */
function parseProtocol(raw: unknown, index: number): SnapshotProtocol {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError(`snapshot.json's protocol ${index} is not an object`);
  }
  const record = raw as Record<string, unknown>;
  const slug = asString(record, 'slug');
  const name = asString(record, 'name');
  const tvl = asNumber(record, 'tvl_usd');
  if (slug === null || name === null || tvl === null) {
    throw new SnapshotError(`snapshot.json's protocol ${index} lacks a slug, a name or a TVL`);
  }
  const chains = Array.isArray(record.chains)
    ? record.chains.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    slug,
    name,
    category: asString(record, 'category'),
    chains,
    tvl_usd: tvl,
    change_7d: asNumber(record, 'change_7d'),
    mcap_usd: asNumber(record, 'mcap_usd'),
    listed_at: asString(record, 'listed_at'),
    gecko_id: asString(record, 'gecko_id'),
    symbol: asString(record, 'symbol'),
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  const asOf = asString(doc, 'as_of');
  if (asOf === null || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new SnapshotError('snapshot.json has no as_of date');
  const source = asString(doc, 'source');
  if (source === null) throw new SnapshotError('snapshot.json has no source');
  const floor = doc.floor_usd;
  if (typeof floor !== 'number' || !Number.isSafeInteger(floor) || floor <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((entry) => typeof entry !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  return {
    as_of: asOf,
    source,
    floor_usd: floor,
    protocols: doc.protocols.map((entry, i) => parseProtocol(entry, i)),
    watchlist: doc.watchlist as string[],
  };
}

/** The reason a board is not one the gate will take, or null when the board is sound. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((row) => row.slug));
  const missing = snapshot.watchlist.filter((slug) => !slugs.has(slug));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((row) => row.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const row of board) {
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `${row.slug} has ${row.farm_steps.length} farm steps`;
    }
    for (const step of row.farm_steps) {
      if (step.length < 20 || step.length > 600) return `${row.slug} has a farm step of ${step.length} characters`;
    }
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `${row.slug} has implied value ${row.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
