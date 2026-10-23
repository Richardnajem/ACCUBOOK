import type { CategoryId, Strategy } from "./strategies-db";

/**
 * Mechanism-level research for the rows the workbook only names.
 *
 * The workbook gives 158 of its 186 strategies nothing but a name, a category,
 * a return range and a risk level — and fills their 40 research columns with one
 * copied template, so "Sample size: 1000+ protocols" sits on an Asian handicap
 * betting strategy. This module replaces that with research about the mechanism
 * itself: how the trade is put on, where it trades, what it costs, what breaks.
 *
 * Rules that keep it honest:
 *  - nothing here is a forecast or a measured result for the named strategy;
 *  - a figure appears only inside a sentence that starts "Typical:", so a range
 *    can never be mistaken for the workbook's own data;
 *  - mechanism facts are true of the trade structure, not of one venue's terms —
 *    a specific venue is named only when the structure depends on it.
 */

export interface MechanismResearch {
  id: string;
  label: string;
  /** The trade in one sentence. */
  what: string;
  /** How it is put on, and what closes it out. */
  how: string;
  /** Instruments, venues, counterparties. */
  venues: string;
  /** Liquidity, settlement and exit. */
  liquidity: string;
  /** Capital and operational requirements. */
  capital: string;
  /** Cost structure, always prefixed "Typical:". */
  costs: string;
  /** What actually breaks it. */
  risks: string[];
  /** Access, licensing, jurisdiction. */
  regulatory: string;
  /** Shariah screen pointer. */
  shariah: string;
  /** How hands-on the strategy is. */
  effort: string;
  /** Expected holding period. */
  horizon: string;
  /** What to watch per position. */
  monitor: string[];
}

const FAMILY_LIST: MechanismResearch[] = [
  {
    id: "crypto-funding-basis",
    label: "Crypto basis & funding carry",
    what: "Hold one leg in spot or on one venue and the opposite leg in a dated or perpetual future, collecting the gap between the two prices.",
    how: "The futures leg is sold against a bought spot leg. With perps the position is rolled and the funding payment is collected or paid every few hours; with dated futures the two legs converge at expiry and the profit is the basis captured at entry.",
    venues: "Spot and derivatives on the same exchange (Binance, OKX, Bybit, Deribit), or spot on one venue against futures on another; some desks use the cash-and-carry structure through regulated futures.",
    liquidity: "Both legs are exchange-traded and can be unwound intraday; the constraint is depth on the futures leg near expiry, not settlement time.",
    capital: "Typical: capital split across two accounts or two venues, plus margin buffer on the short leg for mark-to-market calls; unified-margin accounts reduce the buffer.",
    costs: "Typical: 2–6 bp per side in taker fees, less with maker rebates, plus borrow or funding paid when the basis inverts.",
    risks: [
      "A basis blow-out marks the short leg against you before convergence.",
      "Funding can flip sign and turn the carry into a running cost.",
      "Exchange or counterparty failure strands one leg while the other is elsewhere.",
    ],
    regulatory: "Derivatives access depends on the venue's jurisdiction and the investor's residency; several jurisdictions restrict retail perpetuals outright.",
    shariah: "Conventional futures and funding payments usually screen as non-compliant (riba and gharar); a murabaha or wa'd structure is the workaround.",
    effort: "Monitored repeatedly through the day unless the roll is automated.",
    horizon: "Days to the futures expiry, rolled if the basis persists.",
    monitor: ["Basis in basis points", "Funding rate and its next reset", "Margin ratio on the short leg"],
  },
  {
    id: "crypto-cross-venue",
    label: "Cross-venue and cross-chain arbitrage",
    what: "Buy the same asset where it is cheap and sell it where it is dear, netting the difference after transfer and fees.",
    how: "The two quotes are hit simultaneously and inventory is rebalanced afterwards, or a bridge is used to move the asset between chains. Multi-hop routes chain several pools together when no single pair closes the gap.",
    venues: "Centralised exchanges against each other, automated market makers against order books, and bridges between chains for the cross-chain version.",
    liquidity: "Proportional to transfer time: seconds across L2s, minutes across L1 bridges, and a bridge withdrawal queue in the worst case.",
    capital: "Typical: pre-funded inventory on every venue you quote, because the profit disappears while the transfer settles.",
    costs: "Typical: 2–10 bp per leg in fees, plus gas or bridge fees of a few dollars to tens of dollars per move.",
    risks: [
      "The gap closes while the transfer is in flight, leaving a naked position.",
      "Network congestion or a bridge failure delays the second leg indefinitely.",
      "Withdrawal limits and KYC tiers cap how much can be moved per day.",
    ],
    regulatory: "Cross-border transfers trigger travel-rule and KYC obligations; some venues geo-block the jurisdictions that make the trade attractive.",
    shariah: "Spot-for-spot exchange of the same asset at two prices is generally acceptable; leverage or futures legs are not.",
    effort: "Fully automated in practice — the edge is measured in seconds.",
    horizon: "Intraday; inventory is flattened as soon as the transfer lands.",
    monitor: ["Quote gap net of fees and gas", "Withdrawal queue depth", "Bridge TVL and finality time"],
  },
  {
    id: "crypto-mev",
    label: "MEV, flash loans and block-level extraction",
    what: "Capture value created by ordering or by a single-transaction, no-collateral loan inside one block.",
    how: "A searcher watches the mempool for a pending swap, then submits a bundle that sandwiches it, back-runs it, or liquidates it; the flash loan supplies the capital and is repaid in the same transaction, so no balance sheet is committed.",
    venues: "Ethereum and other EVM chains through block builders and relay auctions (Flashbots-style), plus DEX pools and lending protocols as the liquidity source.",
    liquidity: "Instant by construction — the loan and the trade settle atomically in one block or not at all.",
    capital: "Typical: near-zero balance-sheet capital for flash-loan routes; real capital is spent on infrastructure, searcher reputation and priority fees.",
    costs: "Typical: 70–95% of extracted value can go to the block builder as a bid in competitive auctions, plus gas and failed-bundle costs.",
    risks: [
      "Builder centralisation means a handful of parties decide which bundle lands.",
      "A failed bundle still costs gas, and competition can push bids to break-even.",
      "Protocols and RPCs increasingly detect and censor sandwich patterns.",
    ],
    regulatory: "Treatment varies by jurisdiction and is unsettled; some regulators have characterised certain MEV patterns as market abuse.",
    shariah: "Front-running other participants for a fee is generally treated as exploitative; most scholars would not accept it as a compliant edge.",
    effort: "Engineering-heavy: custom infrastructure, continuous deployment, active monitoring.",
    horizon: "One block — seconds.",
    monitor: ["Bundle inclusion rate", "Bid-to-value ratio", "Gas spent on failed bundles"],
  },
  {
    id: "crypto-staking",
    label: "Staking, restaking and liquid staking",
    what: "Earn the protocol's staking reward, optionally layered with restaking points or liquidity-provider fees.",
    how: "Native tokens are delegated to validators, or swapped for a liquid staking token that accrues rewards and can be used as collateral elsewhere. The loop repeats where a restaking layer accepts the receipt token again.",
    venues: "Validator operators and liquid staking protocols (Lido, Rocket Pool, Jito), restaking layers (EigenLayer-style), and DEX pools that price the receipt token.",
    liquidity: "The receipt token is liquid and tradeable; native unstaking carries the protocol's exit queue, which can be days to weeks.",
    capital: "Typical: any amount through liquid staking, 32 ETH-equivalent for a solo validator; slashing insurance and a second signer are the usual operational add-ons.",
    costs: "Typical: 5–15% of staking rewards as a protocol or operator fee, plus gas to enter and exit.",
    risks: [
      "Slashing or a validator outage costs principal, not just yield.",
      "A liquid staking token can trade below its underlying during stress.",
      "Restaking adds shared-security risk: a fault elsewhere can hit the same capital.",
    ],
    regulatory: "Staking-as-a-service is treated as a security in some jurisdictions; tax treatment of reward accrual differs from realisation.",
    shariah: "Reward for validating and securing a network is closer to a service fee than to riba; the underlying token's permissibility is the binding question.",
    effort: "Passive once delegated, with periodic checks on validator performance and peg.",
    horizon: "Open-ended; measured in epochs, not quarters.",
    monitor: ["Real yield net of fee", "Receipt-token peg", "Slashing and downtime events"],
  },
  {
    id: "crypto-defi-credit",
    label: "On-chain credit, stablecoin and LP carry",
    what: "Lend stablecoins or provide two-sided liquidity and collect the interest or fee the pool pays.",
    how: "Capital is deposited into a lending market or an AMM pool; the yield is the borrow rate plus incentives, or the trading fees earned by the pool, minus impermanent loss. Delta-neutral variants hedge the volatile leg with a perp.",
    venues: "Lending markets (Aave, Compound), stablecoin AMMs (Curve), and tokenised treasury or credit pools for the real-world version.",
    liquidity: "Withdrawable while the pool still has free liquidity; in a stressed market it can be fully borrowed and withdrawals queue.",
    capital: "Typical: no minimum beyond gas, but position size must stay small relative to pool depth to avoid moving the rate.",
    costs: "Typical: 0.01–0.3% per swap plus a 5–20% performance fee on managed vaults; gas is trivial on L2s.",
    risks: [
      "Smart-contract or oracle failure can take the whole deposit.",
      "Stablecoin depeg turns a 'risk-free' carry into a principal loss.",
      "Utilisation spikes freeze withdrawals exactly when you want out.",
    ],
    regulatory: "Tokenised credit and yield products are being pulled into securities and e-money regimes; the issuer's licensing is the thing to verify.",
    shariah: "Interest paid on a stablecoin loan is riba; a murabaha or asset-backed profit-share structure is needed for compliance.",
    effort: "Light monitoring of rates, utilisation and collateral health.",
    horizon: "Weeks to months; the position is rate-driven, not dated.",
    monitor: ["Net supply rate after incentives", "Pool utilisation", "Collateral and oracle health"],
  },
  {
    id: "crypto-intent",
    label: "Intent solving and order-flow auctions",
    what: "Sell the right to execute a user's trade to the solver that offers the best fill, and keep the difference.",
    how: "Users sign an intent rather than a transaction; solvers compete in an auction to satisfy it, and the winner captures any surplus between the user's limit and the executed price.",
    venues: "Intent and solver networks (CoW-style batch auctions), aggregators, and private order-flow channels.",
    liquidity: "Execution is per-intent and atomic; settlement is on-chain in the same block as the winning solution.",
    capital: "Typical: solver inventory and bonding capital to guarantee fills; infrastructure spend dominates the balance sheet.",
    costs: "Typical: a share of surplus paid to the user as a rebate, plus gas and bonding costs.",
    risks: [
      "Solver competition compresses surplus to the user's limit price.",
      "A solver that fails to settle is slashed, but the opportunity cost is the flow.",
      "Flow is concentrated in a few wallets and aggregators.",
    ],
    regulatory: "Order-flow auctions sit close to best-execution rules; the operator's status as a broker or venue is jurisdiction-specific.",
    shariah: "A fee for improving an execution price is a service fee and generally acceptable; the underlying traded asset still needs to pass the screen.",
    effort: "Engineering-led, with 24/7 infrastructure.",
    horizon: "Continuous; each auction is seconds.",
    monitor: ["Auction win rate", "Surplus retained per intent", "Settlement failure rate"],
  },
  {
    id: "crypto-nft-gov",
    label: "NFT, governance and event-token arbitrage",
    what: "Trade a non-fungible or governance token against its floor, its underlying asset, or a governance right that is about to be paid for.",
    how: "Buy at or below floor on one marketplace and sell into a bid or a higher floor elsewhere, or accumulate governance tokens ahead of a vote or buyout and exit into the demand it creates. Sweeping a floor and re-listing is the retail-scale version.",
    venues: "NFT marketplaces (OpenSea, Blur, Magic Eden) with their bid pools, DAO governance contracts, and OTC desks for size.",
    liquidity: "Thin and gappy: floor depth is often a handful of items, and exit depends on a bid existing at the moment you want it.",
    capital: "Typical: from a few hundred dollars for a single item to seven figures to move a floor; gas and marketplace fees are paid per leg.",
    costs: "Typical: 0.5–2.5% marketplace fee per side plus gas, and a royalty on some collections.",
    risks: [
      "Floor prices can halve between listing and sale.",
      "A governance vote can be reversed or the token's value diluted by the outcome.",
      "Wash trading has distorted most published floor and volume data.",
    ],
    regulatory: "Collectibles are treated as property in most tax regimes; a token sold as an investment may be a security.",
    shariah: "Collectibles and utility tokens are generally acceptable if the collection has legitimate use; governance tokens tied to lending or gambling protocols are not.",
    effort: "Manual and time-sensitive; bots dominate the floor sweeps.",
    horizon: "Hours to weeks — this is a trade, not a hold.",
    monitor: ["Real floor depth vs listed floor", "Bid-ask spread", "Upcoming votes and unlocks"],
  },
  {
    id: "equity-merger",
    label: "Merger, tender and event arbitrage",
    what: "Buy the target of an announced deal and hold it to the closing price, or exit when the spread narrows.",
    how: "The target trades below the offer because closing is uncertain and time has a cost. Long target against a short acquirer (in a stock deal) isolates the deal spread from market direction; the position unwinds on completion, break, or a higher bid.",
    venues: "Listed equities and options on the target and the acquirer, plus credit where the deal is debt-financed.",
    liquidity: "Liquid on the day of announcement, thinner on small-cap targets; the exit gap widens precisely when the deal looks at risk.",
    capital: "Typical: fully funded long stock, plus a margin buffer on the acquirer short; stock deals require borrow, which can be scarce.",
    costs: "Typical: 1–3 bp per side in commission and spread, plus financing on the long and borrow fees on the short.",
    risks: [
      "Regulatory or shareholder rejection breaks the deal, and the target gives back the entire spread.",
      "A long closing timetable turns a wide spread into a poor annualised return.",
      "Financing conditions in the offer can fail before the vote does.",
    ],
    regulatory: "Anti-trust review in each relevant jurisdiction is the usual binding condition; insider-dealing rules govern what you can trade before announcement.",
    shariah: "Holding the target is a normal share position and screens like any equity; shorting the acquirer is the non-compliant part.",
    effort: "Event-driven monitoring: filings, votes, regulatory calendars.",
    horizon: "Months — from announcement to close.",
    monitor: ["Spread in basis points", "Annualised spread vs financing cost", "Regulatory milestones"],
  },
  {
    id: "equity-options",
    label: "Listed-option arbitrage and volatility structures",
    what: "Trade a mispricing between an option and its replication — box, conversion, skew or a spread across expiries.",
    how: "The arbitrageur builds the same payoff two ways and buys the cheaper while selling the dearer. Box spreads lock a synthetic rate; conversions and reversals lock the put-call parity gap; gamma and skew trades take a view on volatility rather than direction.",
    venues: "Listed options on regulated exchanges (Cboe, Nasdaq PHLX, Eurex), where clearing removes counterparty risk.",
    liquidity: "Depends entirely on the strikes used: front-month index options are deep, single-name LEAPS are not. Early assignment can force an unwind before expiry.",
    capital: "Typical: margin equal to the maximum loss of the spread, which is small for boxes but large for naked volatility; portfolio margin accounts need far less than Reg-T.",
    costs: "Typical: 0.65–1.00 USD per contract per leg in commission, plus 1–5 cents of bid-ask per leg and exchange fees.",
    risks: [
      "Pin risk and early assignment on the short leg at expiry.",
      "The 'risk-free' box rate is only risk-free if you can hold to expiry.",
      "A skew or gamma position can lose its edge to a single volatility event.",
    ],
    regulatory: "Options approval levels are set by the broker; index options settle in cash, single-name options may settle in shares.",
    shariah: "Options are treated as gharar by most scholars and are widely screened out; the underlying-equity screen is not enough on its own.",
    effort: "Active: positions are monitored against assignment and expiry.",
    horizon: "Days to expiry for boxes and conversions; weeks for skew.",
    monitor: ["Spread vs theoretical value", "Implied vs realised volatility", "Assignment and dividend calendar"],
  },
  {
    id: "equity-etf-nav",
    label: "ETF, ADR and listing arbitrage",
    what: "Trade an ETF against the basket it holds, or the same security against its twin listing in another market or currency.",
    how: "When the ETF trades away from net asset value, an authorised participant creates or redeems shares against the basket and captures the gap. Dual-listed and ADR versions buy the cheap listing and sell the dear one, hedging the currency.",
    venues: "ETF primary market through authorised participants, the secondary market, and both listings for the cross-border version.",
    liquidity: "Usually deep in the ETF, thin in the underlying basket for niche funds; creation and redemption settle on the fund's cycle, typically T+1 to T+2.",
    capital: "Typical: creation units are large (often 25,000–100,000 shares), so this is a desk trade; the ADR version works at retail size.",
    costs: "Typical: 1–5 bp per leg plus FX conversion of 5–20 bp, and a conversion fee for ADRs.",
    risks: [
      "Creation can be suspended exactly when the premium is widest.",
      "FX moves can erase the listing gap between trade and settlement.",
      "Leveraged and inverse ETFs decay structurally, which is a different trade from a mispricing.",
    ],
    regulatory: "Creation and redemption are restricted to authorised participants; cross-border holdings trigger withholding and reporting.",
    shariah: "The screen passes through to the basket — a treasury or conventional-bond ETF fails even when the wrapper is clean.",
    effort: "Low once the leg is on; the risk is operational, not analytical.",
    horizon: "Days, or one creation cycle.",
    monitor: ["Premium/discount to NAV", "Creation availability", "FX hedge cost"],
  },
  {
    id: "equity-carry",
    label: "Carry, dividend and capital-structure arbitrage",
    what: "Collect a contractual or scheduled cash flow while hedging the price exposure that comes with it.",
    how: "Dividend and coupon events are captured by holding through the record date with the price risk hedged; capital-structure trades buy the cheap part of a company's capital stack against the dear part. Rate and FX carry versions fund in the low-yielding currency and lend in the high-yielding one.",
    venues: "Cash equities, preferreds, convertibles, corporate and government bonds, repo, and FX forwards.",
    liquidity: "The cash flow is certain; the exit is not. Repo and short-dated bills are the liquid end, convertibles and preferreds the illiquid end.",
    capital: "Typical: fully funded at the long end; carry trades need collateral and a margin buffer for mark-to-market.",
    costs: "Typical: 2–10 bp per leg in spread, plus financing and a borrow fee where the hedge is short.",
    risks: [
      "A dividend-capture trade is taxed at the withholding rate you did not model.",
      "Carry unwinds violently when the funding currency rallies.",
      "Capital-structure trades fail when the covenant that made one tranche senior is amended.",
    ],
    regulatory: "Withholding tax and treaty rates decide whether a dividend trade is profitable at all; short selling may be restricted.",
    shariah: "Conventional coupons, preferred dividends and FX carry are riba-based; sukuk and murabaha are the compliant substitutes.",
    effort: "Calendar-driven: ex-dates, coupon dates, roll dates.",
    horizon: "Days around an event, or months for carry.",
    monitor: ["Net cash flow after withholding", "Hedge ratio drift", "Funding spread"],
  },
  {
    id: "equity-index-event",
    label: "Index events, rebalances and flow trades",
    what: "Position ahead of a mechanical change in an index or a fund's holdings and exit into the demand it creates.",
    how: "Additions and deletions are announced before they take effect, so the price impact is predictable: buy the addition (or short the deletion) ahead of the effective date and unwind into the closing auction that tracks the index.",
    venues: "The constituent stocks, index futures, and the closing auction of the primary exchange where index funds execute.",
    liquidity: "Concentrated in the closing print on the effective date, which is where the trade is exited; the stock itself can be thin for small-cap additions.",
    capital: "Typical: full stock notional, or index futures as a cheaper proxy; borrow is needed for the deletion side.",
    costs: "Typical: 5–20 bp of spread and commission, with the closing auction as the largest implicit cost.",
    risks: [
      "The trade is crowded; the pre-event run-up can exceed the realised index demand.",
      "Index providers change methodology or delay the effective date.",
      "Shorting a deletion fails if borrow is unavailable.",
    ],
    regulatory: "Trading on index announcements is legal but watched; some providers restrict communication with the committee.",
    shariah: "A plain long position passes or fails on the constituent's business; shorting and futures are the non-compliant legs.",
    effort: "Event calendar driven, with heavy activity on the effective date.",
    horizon: "Days to weeks around the rebalance.",
    monitor: ["Announced vs expected weights", "Closing-auction imbalance", "Crowding in the name"],
  },
  {
    id: "sports-book",
    label: "Book-to-book and exchange arbitrage",
    what: "Back every outcome of an event at prices whose implied probabilities sum to less than one, so the payout exceeds the total stake whichever result lands.",
    how: "The best price for each outcome is taken at a different bookmaker, with stakes sized so each returns the same amount. The bet is placed close to kick-off, when prices are sharpest and limits are highest, and the arb is closed by the event itself.",
    venues: "Traditional bookmakers, Asian handicap books, and betting exchanges where you can lay as well as back.",
    liquidity: "Settlement is at the event's conclusion; the operational constraint is stake limits, which fall sharply for accounts that arb.",
    capital: "Typical: the full stake on every outcome is committed simultaneously, so bankroll must cover all legs; accounts at five or more books are the norm.",
    costs: "Typical: 2–5% margin per book plus a 2–5% exchange commission on net winnings; currency conversion adds 0.5–2%.",
    risks: [
      "One leg is voided or a price is palped after placement, leaving an open position.",
      "Accounts are limited or closed once flagged as arbitrage.",
      "Withdrawals are delayed exactly when the next arb needs the capital.",
    ],
    regulatory: "Licensed bookmakers only; arbitrage is not illegal but breaches most operators' terms and gets accounts restricted.",
    shariah: "Wagering is maysir and is not permissible under any mainstream screen.",
    effort: "High: prices are checked continuously and every leg is placed by hand or by bot.",
    horizon: "Minutes to a few days until the event settles.",
    monitor: ["Ark percentage net of commission", "Stake limits per book", "Account health and withdrawal speed"],
  },
  {
    id: "sports-promo",
    label: "Promotion, bonus and matched-betting extraction",
    what: "Convert a bookmaker's free bet, bonus or price boost into cash by laying the same outcome on an exchange.",
    how: "The qualifying bet is covered with an exchange lay so the outcome is neutral; the free bet is then laid at a shorter price than it was backed, which leaves a fixed slice of the bonus regardless of result.",
    venues: "Bookmaker promotions against a betting exchange (Betfair-style) that accepts the lay side.",
    liquidity: "Each promotion settles at its event; exchange markets are liquid enough on major football and racing, thin on niche sports.",
    capital: "Typical: a bankroll that covers the qualifying stake several times over, because winnings sit in the book while the lay is settled on the exchange.",
    costs: "Typical: 2–5% exchange commission on net winnings, plus qualifying losses of 1–5% of stake per offer.",
    risks: [
      "A rule change — minimum odds, eligible markets, stake-not-returned — voids the extraction.",
      "Account gating (one bonus per household, IP or payment method) blocks the next offer.",
      "The exchange lay and the book bet can be mismatched by a late price move.",
    ],
    regulatory: "Licensed operators only; the promotion terms are contractual and are enforced against the customer.",
    shariah: "Wagering is maysir, and the lay leg is wagering too; not permissible.",
    effort: "High and repetitive; a spreadsheet plus exchange account is the minimum.",
    horizon: "Days, matching each offer's qualifying period.",
    monitor: ["Extraction per offer", "Qualifying loss", "Account and bonus eligibility"],
  },
  {
    id: "sports-line",
    label: "Line movement and in-play timing",
    what: "Trade the gap between a stale price and the price the market is about to move to.",
    how: "The position is taken before a known information event — team news, a sharp book's move, kick-off — and exited once the line has repriced. In-play versions exploit the delay between an event on the pitch and the suspension or repricing of the market.",
    venues: "Bookmakers and exchanges, plus the sharp books whose prices the market follows.",
    liquidity: "Minutes to hours; in-play liquidity thins dramatically in the seconds after a goal.",
    capital: "Typical: a bankroll large enough to take several positions at once, since limits are small and the edge per bet is thin.",
    costs: "Typical: 2–5% margin per bet and exchange commission on winning lays.",
    risks: [
      "The line moves against you and there is no exit at the original price.",
      "Courtsiding — faster information than the market — is against exchange terms.",
      "In-play markets suspend without notice, trapping the position.",
    ],
    regulatory: "Depends on the operator's terms; some venues ban automated or latency-based play outright.",
    shariah: "Wagering; not permissible.",
    effort: "Very high, in real time.",
    horizon: "Minutes to hours.",
    monitor: ["Closing-line value", "Hit rate vs break-even", "Market suspension patterns"],
  },
  {
    id: "sports-prop",
    label: "Prop, handicap and outright books",
    what: "Price a specific event — a player's stat line, a handicap, a tournament winner — and bet the side the book has mispriced.",
    how: "The bettor models the distribution of the underlying event (minutes played, goals, corners, points) and compares it to the book's implied probability; the trade is a single bet or a hedge across books and exchanges.",
    venues: "Bookmakers' prop and handicap markets, exchanges, and player-stat markets that are increasingly offered by specialist venues.",
    liquidity: "Settles when the stat is confirmed, sometimes hours after the match; limits are small and fall fast.",
    capital: "Typical: modest bankroll, but many small positions to average out the variance.",
    costs: "Typical: 4–8% margin on props, wider than on main markets.",
    risks: [
      "Stat rulings (a deflection credited as an own goal) can void or flip the bet.",
      "Prop lines are the first to be limited and the last to be sharp.",
      "Model error on player minutes is the dominant loss source.",
    ],
    regulatory: "Prop bets on amateur or collegiate events are restricted in several jurisdictions.",
    shariah: "Wagering; not permissible.",
    effort: "Modelling-heavy, with per-event research.",
    horizon: "A single event — from kick-off to settlement.",
    monitor: ["Model probability vs implied", "Line movement after team news", "Settlement rules for the stat"],
  },
  {
    id: "sports-rules",
    label: "Rule, settlement and market-structure gaps",
    what: "Exploit a difference between two books' settlement rules — void conditions, dead-heat, push, odds format — rather than their opinion of the result.",
    how: "The same outcome is backed where it settles favourably and laid where it settles differently; the profit exists even if both books agree on the probability. Odds-format and market-suspension versions exploit conversion or timing rules instead.",
    venues: "Any pair of books whose terms differ on the same event, plus exchanges for the lay leg.",
    liquidity: "Event-driven; settlement can be delayed by a stewards' enquiry or a rule dispute.",
    capital: "Typical: full stake on both legs plus a reserve for a disputed settlement.",
    costs: "Typical: 2–5% margin per leg, with no extra cost for the rule edge itself.",
    risks: [
      "The book applies a house rule that overrides the published terms.",
      "A void on one leg leaves the other naked.",
      "Disputes take weeks and the capital is frozen meanwhile.",
    ],
    regulatory: "Consumer-protection rules and the operator's terms decide the dispute; an ombudsman or regulator is the only recourse.",
    shariah: "Wagering; not permissible.",
    effort: "Research-heavy per event, low once placed.",
    horizon: "Until the event settles.",
    monitor: ["Each book's printed terms", "Void and dead-heat history", "Dispute resolution time"],
  },
  {
    id: "retail-goods",
    label: "Physical and marketplace goods arbitrage",
    what: "Buy stock below the price it will clear at elsewhere and sell it there, absorbing fees, shipping and time.",
    how: "A gap is identified between a clearance or wholesale price and the going marketplace price, then stock is bought, listed and shipped; the profit is the spread minus fees, freight and returns.",
    venues: "Retail clearance, wholesale and liquidation lots, and marketplaces (Amazon, eBay, regional equivalents).",
    liquidity: "Weeks per turn: listing, sale and payout. Capital is tied up in inventory and in the marketplace's payout cycle.",
    capital: "Typical: the whole purchase in cash up front plus storage; a first order of a few thousand dollars is enough to test a category.",
    costs: "Typical: 8–20% marketplace referral and payment fees, plus freight, storage and 2–10% returns.",
    risks: [
      "Demand evaporates and the stock becomes dead inventory.",
      "The marketplace changes fees, gating or brand restrictions.",
      "Counterfeit or grey-market stock gets the account suspended.",
    ],
    regulatory: "Product safety, labelling and import duty rules apply; brand gating restricts who may sell certain lines.",
    shariah: "A straightforward sale with a real good is permissible; forward buying of stock you do not own, or selling what you cannot deliver, is not.",
    effort: "Operational: sourcing, listing, fulfilment, returns.",
    horizon: "Weeks to a season.",
    monitor: ["Sell-through rate", "Landed cost vs sale price", "Return rate"],
  },
  {
    id: "retail-travel",
    label: "Travel, ticket and points arbitrage",
    what: "Buy a travel or event entitlement cheaply under one set of rules and realise it under another — resale, redemption or cancellation.",
    how: "Mistake fares, award redemptions and refundable ticket holds are acquired where the rules are loose and monetised where they are strict; ticket resale buys at face value and sells into demand. Domain and collectible versions buy an underpriced asset in a thin market.",
    venues: "Airline and hotel programmes, ticket primary and resale platforms, domain aftermarkets.",
    liquidity: "Uncertain and rule-bound: redemption availability, transfer restrictions and resale windows all cap the exit.",
    capital: "Typical: the ticket or fare plus a reserve for non-refundable losses; award inventory is bought with points, not cash.",
    costs: "Typical: 10–25% resale platform fee, change and cancellation fees, and programme taxes.",
    risks: [
      "The programme changes the rules retroactively or cancels the booking.",
      "Resale inventory is unsold when the event date passes.",
      "Points devalue between acquisition and redemption.",
    ],
    regulatory: "Consumer and aviation rules govern cancellation; resale of tickets is restricted or illegal in some jurisdictions.",
    shariah: "Buying and reselling a genuine entitlement is acceptable; selling a booking you cannot honour is not.",
    effort: "Manual and opportunistic.",
    horizon: "Days to months, bounded by the travel or event date.",
    monitor: ["Redemption availability", "Resale price vs face", "Programme rule changes"],
  },
  {
    id: "retail-platform",
    label: "Platform, coupon and reputation arbitrage",
    what: "Arbitrage two platforms' rules — fees, credits, referral bonuses, price of the same service — rather than the goods themselves.",
    how: "Work is sourced where supply is cheap (a freelance marketplace, a discount region) and delivered where the price is set (a premium platform), or stored credit and coupons are converted into goods at below market cost.",
    venues: "Freelance marketplaces (Fiverr, Upwork), app stores and gift-card resellers, ad platforms, and loyalty schemes.",
    liquidity: "Per transaction; payouts are held by the platform for days and credits are not always cashable.",
    capital: "Typical: little capital, more account equity and reputation than money.",
    costs: "Typical: 5–20% platform commission on both sides, plus payment-processing fees.",
    risks: [
      "The account is banned and the balance is forfeited.",
      "Terms prohibit reselling or arbitraging the platform's credits.",
      "Reputation, not price, is what makes the demand exist.",
    ],
    regulatory: "Consumer and platform terms apply; cross-border service supply can create a permanent establishment and VAT liability.",
    shariah: "A service fee is permissible; manufacturing reviews or misrepresenting who delivers the work is not.",
    effort: "Operational, with account management.",
    horizon: "Weeks per cycle, from sourcing to payout.",
    monitor: ["Margin after both commissions", "Payout hold", "Account standing"],
  },
  {
    id: "event-odds",
    label: "Prediction and event markets",
    what: "Take a position on a binary event at a price that differs from a defensible probability, and hold or hedge to resolution.",
    how: "The contract pays a fixed amount if the event resolves true. The trader compares the quoted price to a modelled or cross-venue probability, buys the cheap side and either holds to resolution or hedges once the market converges.",
    venues: "Regulated prediction exchanges and event-derivative venues, plus bookmakers for the same event when they will take it.",
    liquidity: "Resolution-bound: capital is locked until the event settles, which can be months for political markets; secondary trading exists but is thin.",
    capital: "Typical: the full contract price committed until resolution, so the return has to be judged per unit of locked capital.",
    costs: "Typical: 1–10% venue fee on winnings, plus withdrawal fees and a spread that widens as resolution approaches.",
    risks: [
      "Resolution criteria can be read differently from the headline the market traded on.",
      "A venue can be shut down or restricted before resolution.",
      "Thin books let a single participant move the price for weeks.",
    ],
    regulatory: "Event contracts are restricted or banned in several jurisdictions; the venue's licence determines who may trade them.",
    shariah: "Betting on an uncertain event for a payoff is maysir; most event contracts fail.",
    effort: "Research per event, then passive until resolution.",
    horizon: "Weeks to months, until the event resolves.",
    monitor: ["Price vs your probability", "Resolution wording", "Venue liquidity and legal status"],
  },
  {
    id: "commodity-spread",
    label: "Commodity and calendar spreads",
    what: "Trade the relationship between two contract months or two related commodities instead of the outright price.",
    how: "The spread is bought when the processing or storage margin is below its normal range and sold when it returns; calendar versions hold the same commodity across two expiries. The position is directional only in the spread, not in the commodity.",
    venues: "Regulated futures exchanges (CME, ICE, DCE) for calendar and processing spreads; physical contracts for the locational version.",
    liquidity: "Deep in the front months of major contracts, thin and gappy in the back months where the spread usually lives; delivery obligations can force an exit.",
    capital: "Typical: margin on each leg plus a buffer for spread volatility, which is smaller than outright but not small.",
    costs: "Typical: exchange and clearing fees of 1–3 USD per contract per leg, plus full-service commission if not self-directed.",
    risks: [
      "A spread can widen far beyond its historical range before it converges.",
      "Storage Tank capacity constraints break the relationship the trade assumes.",
      "First-notice day can force delivery on the leg you meant to hold as a hedge.",
    ],
    regulatory: "Position limits and reporting thresholds apply; some spreads are only accessible to commercial hedgers.",
    shariah: "Exchange-traded futures are gharar-heavy and mostly screened out; physical forward sale with immediate possession is the compliant structure.",
    effort: "Daily monitoring of both legs and the delivery calendar.",
    horizon: "Weeks to months, bounded by the contract.",
    monitor: ["Spread vs seasonal range", "Inventories and storage", "First-notice and expiry dates"],
  },
  {
    id: "energy-cert",
    label: "Power and certificate arbitrage",
    what: "Trade the gap between fuel cost and electricity price, or between a renewable obligation and the certificate that satisfies it.",
    how: "The spark spread buys fuel and sells power for the same delivery period; certificate versions buy a renewable attribute cheaply in one compliance market and sell it into another that demands it.",
    venues: "Power exchanges and bilateral PPAs for electricity, gas hubs for fuel, and compliance registries for certificates.",
    liquidity: "Delivery-period bound and often bilateral; certificates trade in thin, broker-intermediated markets with wide spreads.",
    capital: "Typical: margin for the power leg plus collateral or a PPA commitment; certificate trades need registry accounts and registrants in both markets.",
    costs: "Typical: 1–3% broker and registry fees per transaction, plus imbalance and shaping costs on the power side.",
    risks: [
      "Weather moves demand and breaks the spread in a single week.",
      "A compliance deadline changes and the certificate becomes worthless.",
      "Grid or interconnector constraints make the physical delivery impossible.",
    ],
    regulatory: "Power trading requires a supply or trading licence in most markets; certificate schemes are set by regulation and can be retroactively amended.",
    shariah: "A forward sale of power you do not yet own is not compliant; a murabaha-style fuel purchase that is then sold on is.",
    effort: "Daily, with delivery scheduling.",
    horizon: "Delivery period — usually a month to a quarter.",
    monitor: ["Spark or dark spread", "Certificate vintage and compliance deadline", "Outage and weather forecasts"],
  },
  {
    id: "quant-latency",
    label: "Latency and information arbitrage",
    what: "Act on a public price or data point before the venue you trade on has repriced it.",
    how: "A fast data feed is compared against a slower venue's quote; when the two disagree beyond fees, the slower venue is hit and the position is unwound on the venue that already moved. The edge is speed and plumbing, not forecasting.",
    venues: "The two venues involved, colocated servers, and the data vendors that publish the slower print.",
    liquidity: "Seconds, and only at the top of book; size is capped by what the slow venue has posted.",
    capital: "Typical: inventory on both venues, plus infrastructure spend on colocation and market data that dwarfs the trading capital.",
    costs: "Typical: exchange fees of 1–3 bp per side, market-data subscriptions, and colocation of thousands of dollars a month.",
    risks: [
      "The slow venue cancels the quote while your order is in flight.",
      "A vendor outage or clock drift turns the signal into noise.",
      "Exchange rule changes (speed bumps, maker-taker changes) remove the edge overnight.",
    ],
    regulatory: "Direct market access and colocation require sponsored membership; latency arbitrage is scrutinised in some jurisdictions.",
    shariah: "A plain buy-and-sell on two venues is acceptable in form; the underlying asset and any short leg decide compliance.",
    effort: "Engineering-led, 24/7.",
    horizon: "Milliseconds to minutes.",
    monitor: ["Fill ratio on the slow venue", "Latency percentiles", "Adverse selection after fill"],
  },
  {
    id: "quant-stat",
    label: "Statistical and behavioural arbitrage",
    what: "Trade the expected reversion of a spread, a pair or a sentiment extreme, rather than a single price.",
    how: "A relationship is estimated from history — cointegrated pairs, factor residuals, sentiment scores — and the position is taken when the current spread deviates by a threshold. It closes when the spread reverts or the model's stop is hit.",
    venues: "Cash equities, futures and ETFs; the sentiment versions read social and news feeds and trade the underlying.",
    liquidity: "Usually liquid in the instruments, but crowding means the exit is shared with everyone running the same signal.",
    capital: "Typical: both legs funded with a margin buffer; a dozen or more positions are needed for the statistics to show up.",
    costs: "Typical: 1–5 bp per leg plus borrow on the short side; turnover is the dominant cost, not the spread.",
    risks: [
      "The relationship breaks and the 'cheap' leg keeps getting cheaper.",
      "A crowded signal unwinds violently, as in an August-style quant drawdown.",
      "Look-ahead bias in the backtest, which the live market removes for free.",
    ],
    regulatory: "Short-selling and disclosure rules apply; automated strategies may need to be notified to the venue.",
    shariah: "The pair is only compliant if both legs pass the screen and neither is short.",
    effort: "Systematic: re-estimate, rebalance, monitor for regime change.",
    horizon: "Days to weeks per position.",
    monitor: ["Spread z-score", "Hit rate and average win/loss", "Crowding and borrow cost"],
  },
  {
    id: "quant-structural",
    label: "Structural, cross-border and rule-based edges",
    what: "Exploit a difference in rules, tax, geography or market structure rather than a difference in price.",
    how: "The same cash flow or asset is held where it is taxed, regulated or priced advantageously, and the benefit is taken at the entity, jurisdiction or documentation level. Time-zone and micro-market versions trade the predictable behaviour of a market at a specific hour or size.",
    venues: "Multiple jurisdictions or entities, plus the local venues whose rules differ; often an OTC or fund structure rather than a listed trade.",
    liquidity: "Slow: entity set-up, documentation and tax residence take months, and the benefit is realised on an annual or exit basis.",
    capital: "Typical: professional fees and a permanent establishment in each jurisdiction; this is a structuring trade, not a click trade.",
    costs: "Typical: 0.5–2% a year in administration, plus 5–20k in legal and accounting per jurisdiction.",
    risks: [
      "A change in tax or regulatory treatment removes the benefit retroactively.",
      "Substance requirements mean the structure must actually operate, not just exist.",
      "Cross-border reporting failures carry penalties larger than the edge.",
    ],
    regulatory: "This is the category where the regulation is the strategy; a ruling or opinion should precede the trade.",
    shariah: "Structuring is neutral in itself; the underlying assets and any interest-based financing decide compliance.",
    effort: "Advisory-led, with an annual review.",
    horizon: "Years — a structuring decision, not a trade.",
    monitor: ["Legislative change", "Treaty and residency status", "Substance and reporting obligations"],
  },
  {
    id: "rwa-tokenised",
    label: "Tokenised real-world assets",
    what: "Trade a token that represents a treasury bill, private credit or property against the asset it represents, or hold it for the coupon.",
    how: "The token trades on-chain while the underlying settles off-chain through a custodian or SPV. Arbitrage appears when the token's price drifts from NAV, when the redemption window is binding, or when a DeFi pool prices it against a stablecoin.",
    venues: "Tokenisation platforms (tokenised treasury and credit issuers), their secondary venues, and DeFi lending pools that accept the token as collateral.",
    liquidity: "The token quotes continuously but the redemption behind it is gated: T+0 to T+2 for treasuries, 30 days or more for private credit and property.",
    capital: "Typical: whitelisting and KYC in each issuer, plus a stablecoin balance on-chain; some issuers enforce minimum tickets of 5–100k.",
    costs: "Typical: 0.15–0.75% annual management fee on treasury products, higher on private credit, plus gas and redemption fees.",
    risks: [
      "The token trades at a discount that persists because redemption is closed.",
      "Custodian or SPV failure severs the token from the asset.",
      "Regulatory action against the issuer can freeze transfers.",
    ],
    regulatory: "Issuers are licensed in a specific jurisdiction; the token's transferability is restricted to eligible investors in most cases.",
    shariah: "Treasury and conventional-credit tokens are riba-based; a sukuk-backed token is the compliant version, and the SPV structure must be checked.",
    effort: "Light after onboarding; the work is due diligence on the issuer.",
    horizon: "Weeks to months, or held to maturity for the coupon.",
    monitor: ["Token price vs NAV", "Redemption window and queue", "Issuer and custodian health"],
  },
  {
    id: "property-income",
    label: "Property income and development economics",
    what: "Buy or fund a property interest for the income it produces, or develop it for the margin between land, build cost and exit value.",
    how: "Income strategies underwrite rent against financing cost and void periods; development underwrites land cost plus construction plus contingency against the exit price, and carries the asset through the build.",
    venues: "Direct title, fractional platforms, REITs, and private debt or mezzanine funds secured on the asset.",
    liquidity: "Illiquid at the asset level: a sale takes months, and fractional platforms gate redemptions or provide only a secondary bulletin board.",
    capital: "Typical: 20–35% equity on a financed purchase, plus 10–15% of build cost as contingency on a development.",
    costs: "Typical: 1–3% acquisition costs, 4–6% selling costs, and 0.5–2% a year in management and maintenance.",
    risks: [
      "Voids and arrears arrive when the local job market weakens.",
      "Construction overruns and rate resets erode the development margin.",
      "Exit pricing assumes a buyer who may not exist at the assumed yield.",
    ],
    regulatory: "Title, planning and tenancy law are jurisdiction-specific; foreign ownership is restricted in many markets.",
    shariah: "Direct property and rent are compliant; a conventional mortgage or interest-bearing mezzanine is not.",
    effort: "Active on development, light on a managed income asset.",
    horizon: "3–10 years for income; 12–36 months for development.",
    monitor: ["Net operating income and occupancy", "Loan-to-value and refinancing date", "Build cost vs budget"],
  },
  {
    id: "cross-market",
    label: "Cross-market arbitrage",
    what: "Two venues, one asset, two prices — buy where it is offered and sell where it is bid.",
    how: "Quotes are compared after fees, and both legs are executed close to simultaneously; the residual exposure is the time between the two fills. Variants trade a related instrument (an ETF against its basket, a certificate against its claim) rather than the identical asset.",
    venues: "Two or more venues trading the same or a directly convertible instrument.",
    liquidity: "Usually immediate; the binding constraint is depth at the top of book, not settlement.",
    capital: "Typical: capital on both venues so neither leg waits for a transfer.",
    costs: "Typical: 1–10 bp per leg in fees and spread, which is also the size of the gaps worth taking.",
    risks: [
      "Execution risk: one leg fills and the other does not.",
      "Fees and transfer costs consume a gap that looked wide.",
      "Venue rules change and the two instruments stop being fungible.",
    ],
    regulatory: "Access rules differ per venue; some are restricted to professional or resident investors.",
    shariah: "Spot-for-spot is compliant in form; leverage, shorting or a futures leg decides the rest.",
    effort: "Automated in practice.",
    horizon: "Intraday; the position is shut in the same session.",
    monitor: ["Net gap after costs", "Fill rate on both legs", "Fungibility and transfer rules"],
  },
];

export const MECHANISMS: MechanismResearch[] = FAMILY_LIST;

const BY_ID = new Map(FAMILY_LIST.map((f) => [f.id, f]));

/**
 * Ordered matcher. The first rule that fits the name wins, so the specific
 * mechanisms are tested before the generic ones. Category is used as a guard
 * where the same words mean different trades in different categories (an
 * "index arbitrage" in DeFi is not an equity index trade).
 */
const RULES: { family: string; re: RegExp; categories?: CategoryId[] }[] = [
  // crypto
  { family: "crypto-mev", re: /\b(flash ?loan|sandwich|frontrun|jit|mev|oracle)\b/i },
  { family: "crypto-intent", re: /\bintent\b/i },
  { family: "crypto-staking", re: /\b(staking|lst|lrt|restak|yield aggregator|rebase)\b/i },
  { family: "crypto-nft-gov", re: /\b(nft|collectible|governance)\b/i },
  { family: "crypto-funding-basis", re: /\b(funding rate|basis|spot.*futures|cash & carry|carry)\b/i, categories: ["crypto", "equities"] },
  { family: "crypto-defi-credit", re: /\b(stablecoin|delta-neutral|liquidity provider|lp\b|credit)\b/i },
  { family: "rwa-tokenised", re: /\brwa\b|\brent\b.*airbnb|airbnb/i },
  { family: "crypto-cross-venue", re: /\b(cross-exchange|cross-chain|dex|cex|index arbitrage|multi-hop|multi-hop ai)\b/i },
  // equities
  { family: "equity-merger", re: /\b(merger|m&a|tender|spin-?off|rights offering|buyback|stub|distressed|bankruptcy|capital structure)\b/i },
  { family: "equity-options", re: /\b(box spread|conversion|reversal|gamma|calendar|volatility|stat arb|pairs|skew|options?)\b/i },
  { family: "equity-etf-nav", re: /\b(etf|nav|creation|redemption|adr|dual listing|index reconstitution|leveraged etf|sector etf)\b/i },
  { family: "equity-index-event", re: /\b(index|reconstitution|sector rotation|earnings)\b/i },
  { family: "equity-carry", re: /\b(dividend|yield curve|repo|treasury|rate differential|fx|credit|bond|preferred|convertible|carry|term structure|roll yield)\b/i },
  // sports
  { family: "sports-promo", re: /\b(matched betting|bonus|free bet|reload|deposit match|stakeback|cashback|risk-free|insurance bet|white-label|promotion|early payout)\b/i },
  { family: "sports-rules", re: /\b(rule|void|push|settlement|odds format|suspension|cross-rule)\b/i },
  { family: "sports-prop", re: /\b(props?|player prop|totals|outrights|handicap|season markets)\b/i },
  { family: "sports-line", re: /\b(line|steam|clv|closing|opening|in-play|half-time|cashout|reverse line|live delay|league)\b/i },
  { family: "sports-book", re: /\b(surebet|book|multi-entity|back.?lay|lay|exchange|hedged betting)\b/i },
  // retail
  { family: "retail-travel", re: /\b(flight|hotel|travel|ticket|domain|points|miles)\b/i },
  { family: "retail-platform", re: /\b(coupon|gift card|app store|social media|cpc|fiverr|upwork|outsourcing|licens|ip\b|vip|loyalty|platform)\b/i },
  { family: "retail-goods", re: /\b(retail|inventory|clearance|marketplace|bundling|resale)\b/i },
  // events
  { family: "event-odds", re: /\b(prediction|election|political|awards?|oscars?|grammys?|reality tv|entertainment|weather|financial event|macro event|season)\b/i },
  // commodities
  { family: "energy-cert", re: /\b(electricity|energy|renewable|certificate)\b/i },
  { family: "commodity-spread", re: /\b(commodity|crack|crush|spark|calendar spread|roll yield|term structure)\b/i },
  // quant
  { family: "quant-latency", re: /\b(latency|algorithm lag|api price feed|news latency|live delay)\b/i },
  { family: "quant-stat", re: /\b(stat arb|pairs|sentiment|pattern|bias|behaviou?r|multi-hop ai|ai masked|flow-driven|predictive)\b/i },
  { family: "quant-structural", re: /\b(structural|rules-based|cross-rule|synthetic|correlation|skew|capital pooling|micro-market|geographic|time-zone|seasonal|tax|jurisdiction|account farming|overreaction)\b/i },
  // property / income
  { family: "property-income", re: /\b(reit|private debt|mezzanine|preferred|real estate|property|crowdfunding|flip|development)\b/i },
];

const CATEGORY_FALLBACK: Record<CategoryId, string> = {
  crypto: "crypto-cross-venue",
  equities: "equity-carry",
  sports: "sports-line",
  retail: "retail-goods",
  events: "event-odds",
  commodities: "commodity-spread",
  quant: "quant-structural",
  rwa: "rwa-tokenised",
  income: "property-income",
  cash: "equity-carry",
  growth: "property-income",
  venture: "property-income",
};

/** The mechanism a strategy belongs to, or null only if nothing matches. */
export function mechanismFor(strategy: Strategy): MechanismResearch {
  for (const rule of RULES) {
    if (rule.categories && !rule.categories.includes(strategy.category)) continue;
    if (rule.re.test(strategy.name)) {
      const hit = BY_ID.get(rule.family);
      if (hit) return hit;
    }
  }
  return BY_ID.get(CATEGORY_FALLBACK[strategy.category]) ?? BY_ID.get("cross-market")!;
}

/** The strategy's own research, minus the cells the workbook copied across rows. */
export function ownFacts(strategy: Strategy) {
  return strategy.facts.filter((f) => !f.template);
}

/** The template cells the workbook repeated, kept apart from real research. */
export function templateFacts(strategy: Strategy) {
  return strategy.facts.filter((f) => f.template);
}

/** True when the workbook carried no research specific to this strategy. */
export function isThin(strategy: Strategy): boolean {
  return ownFacts(strategy).length === 0;
}
