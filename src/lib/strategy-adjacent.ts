import type { CategoryId } from "./strategies-db";

/**
 * Methods that belong to each category but are not in the workbook.
 *
 * The sheet's list is heavy on arbitrage and thin on several whole families of
 * investment (there is no closed-end fund trade, no CLO, no land banking, no
 * power purchase agreement). These entries exist so a reader can see the shape
 * of the category rather than only the strategies that happened to be listed.
 *
 * They carry **no** return, risk or score: the workbook never assessed them, and
 * inventing a figure for a method nobody has priced would be worse than leaving
 * it out. `how` describes the trade; `why` says what edge or gap it represents.
 */
export interface AdjacentMethod {
  name: string;
  how: string;
  why: string;
}

export const ADJACENT_METHODS: Record<CategoryId, AdjacentMethod[]> = {
  income: [
    {
      name: "Ground leases",
      how: "Own the land under a long-leased building and collect rent from the building owner for decades.",
      why: "Bond-like duration with a property covenant, and no operating exposure to the building itself.",
    },
    {
      name: "Equipment and vehicle leasing notes",
      how: "Fund equipment leases through a fund or note programme and collect the lease payments until the asset is returned or bought.",
      why: "Short-duration credit backed by movable collateral that can be re-leased or sold if the borrower defaults.",
    },
    {
      name: "Royalty income funds",
      how: "Buy a stream of royalty payments from music catalogues, mineral rights, pharmaceutical patents or energy production.",
      why: "Contracted cash flow from intellectual or natural property, with a driver unrelated to corporate earnings.",
    },
    {
      name: "Solar and PPA receivable funds",
      how: "Fund residential or commercial solar installations and collect the contracted payment stream from the power-purchase agreements.",
      why: "Long-dated, signed cash flows on installed physical assets, distinct from building or operating them.",
    },
  ],
  cash: [
    {
      name: "T-bill futures basis",
      how: "Hold the cheapest-to-deliver bill against a short futures position and carry it into the delivery month.",
      why: "Turns the cash market's collateral scarcity into a yield that is not visible in the quoted bill rate.",
    },
    {
      name: "Municipal tender-option bonds",
      how: "Buy short-put municipal paper and earn the tax-exempt coupon until the tender date.",
      why: "Tax-exempt income with a put, which the workbook's taxable-only cash rows ignore.",
    },
    {
      name: "FX-hedged foreign government bills",
      how: "Buy a higher-yielding sovereign bill and hedge the currency back to the base currency with a forward.",
      why: "The hedge usually removes most of the yield advantage — measuring the residual is the trade.",
    },
    {
      name: "General-collateral repo specials",
      how: "Lend cash against a specific bond that is in demand, and earn the special rate rather than the general rate.",
      why: "A money-market trade that only exists when a particular issue is scarce.",
    },
  ],
  growth: [
    {
      name: "Build-to-rent development",
      how: "Develop residential stock to hold for rent rather than sell, refinancing the build once stabilised.",
      why: "Converts a development margin into a recurring income asset instead of a one-off exit.",
    },
    {
      name: "Land banking with planning uplift",
      how: "Buy undeveloped land, secure a change of use, and sell it to a housebuilder rather than building.",
      why: "The return comes from the planning decision, not from construction — a different skill and risk set.",
    },
    {
      name: "Development co-investment SPVs",
      how: "Take a minority stake in a single-project SPV alongside a sponsor who runs the build.",
      why: "Project-level exposure with an aligned operator, instead of a blind fund commitment.",
    },
    {
      name: "PIK and preferred equity in real estate",
      how: "Fund the gap between senior debt and sponsor equity, paid partly in kind until the asset stabilises.",
      why: "A contractual return above senior debt without taking the sponsor's full downside.",
    },
    {
      name: "Distressed receivables and NPL portfolios",
      how: "Buy non-performing loan pools at a discount and work them out, or restructure them into performing paper.",
      why: "Priced off servicing cost and recovery timing rather than off the property market.",
    },
  ],
  venture: [
    {
      name: "Revenue-based financing",
      how: "Advance capital against a share of future revenue, repaid as a percentage until a cap is reached.",
      why: "Venture-scale risk without a priced equity round, and no dilution event for the founder.",
    },
    {
      name: "Rolling and syndicated funds",
      how: "Commit through vehicles that deploy continuously rather than in a single vintage year.",
      why: "Removes the vintage concentration that makes a single fund a single bet on one entry-price year.",
    },
    {
      name: "Convertible notes and SAFEs",
      how: "Lend now on terms that convert into equity at the next priced round, usually with a discount or a cap.",
      why: "The most common early-stage instrument, and a different risk from buying priced equity.",
    },
    {
      name: "Venture debt funds",
      how: "Lend to venture-backed companies on terms that add warrants or fees on top of a normal interest coupon.",
      why: "Credit exposure to the startup economy without taking the equity's last-money downside.",
    },
  ],
  rwa: [
    {
      name: "Tokenised commodity vaults",
      how: "Hold tokens backed by vaulted physical gold or other metals, redeemable into the metal or its cash value.",
      why: "Commodity exposure that settles on-chain, without a futures roll or a mining equity's idiosyncratic risk.",
    },
    {
      name: "Carbon and renewable certificates",
      how: "Buy a verified carbon or renewable-energy certificate in one registry and retire or sell it in another.",
      why: "A commodity-style spread that exists only because compliance schemes differ.",
    },
    {
      name: "Property rent-strip tokenisation",
      how: "Buy the tokenised right to a property's rent for a fixed term, without owning the title.",
      why: "Income exposure with a maturity date — cleaner than holding the asset and selling it later.",
    },
    {
      name: "Sukuk-backed tokens",
      how: "Hold a token whose underlying is a sukuk SPV, so the cash flow is rent rather than interest.",
      why: "The compliant route into tokenised fixed income, and the one the workbook does not mention.",
    },
  ],
  equities: [
    {
      name: "Closed-end fund discount capture",
      how: "Buy a closed-end fund at a discount to NAV and hold for the discount to narrow or for an activist to force a tender.",
      why: "A discount is a structural mispricing that does not require a view on the assets.",
    },
    {
      name: "Index rebalance front-running",
      how: "Buy announced index additions ahead of the effective date and sell into the tracker demand at the close.",
      why: "Mechanical, pre-announced demand — the closest thing to a scheduled trade in equities.",
    },
    {
      name: "Convertible arbitrage",
      how: "Buy a convertible bond and short the underlying stock to isolate the embedded option's volatility.",
      why: "A credit-plus-volatility position that behaves unlike either the bond or the stock.",
    },
    {
      name: "Dividend recapture with options",
      how: "Hold through the ex-date with an offsetting option position that removes the price drop.",
      why: "Isolates the withholding-tax treatment as the source of return — often negative, which is the point of measuring it.",
    },
    {
      name: "Warrant and rights arbitrage",
      how: "Trade the warrant or rights entitlement against the underlying while the exercise window is open.",
      why: "A live corporate-action edge that closes at the expiry of the window.",
    },
  ],
  crypto: [
    {
      name: "Dated-futures basis on regulated venues",
      how: "Buy spot and sell a dated contract on a CFTC-regulated venue, holding to convergence.",
      why: "Removes exchange counterparty risk, which is the main hazard in the workbook's basis rows.",
    },
    {
      name: "Perp funding carry with a hedged spot leg",
      how: "Short the perpetual against a long spot position and collect funding whenever it is positive.",
      why: "The most repeatable crypto carry, and the one most exposed to a funding flip.",
    },
    {
      name: "Bitcoin-backed lending",
      how: "Borrow against bitcoin held in a platform or vault instead of selling it, and repay on your own schedule.",
      why: "Liquidity without a taxable disposal — and a liquidation line that moves faster than in any collateral market.",
    },
    {
      name: "DEX liquidity provision with a delta hedge",
      how: "Supply two-sided liquidity and short the volatile leg in perps to keep the position neutral.",
      why: "Converts impermanent loss into a fee-carry calculation, which is the only way to compare it with lending.",
    },
  ],
  sports: [
    {
      name: "Asian handicap scalping",
      how: "Take the best Asian line on one book and lay the same line on an exchange as it moves before kick-off.",
      why: "Asian books tolerate volume that European books do not, which changes how long the edge survives.",
    },
    {
      name: "Exchange trading without a bookmaker",
      how: "Back and lay on the same exchange as the price moves, never holding a position to settlement.",
      why: "No account limiting and no book margin — the edge has to come from the price alone.",
    },
    {
      name: "Lower-league and niche-market gaps",
      how: "Arb or value-bet markets the sharp books price thinly, taking the soft side before limits fall.",
      why: "The gaps are wider where the market is smaller, and so is the capacity.",
    },
    {
      name: "Closing-line value modelling",
      how: "Bet early at prices that beat the eventual closing line and measure the edge as CLV rather than as profit.",
      why: "The only honest way to tell skill from variance over a small sample.",
    },
    {
      name: "Prediction-market versus bookmaker",
      how: "Trade the same event on an exchange and a sportsbook when the two disagree beyond fees.",
      why: "Two different populations price the same outcome — that gap is the trade.",
    },
  ],
  retail: [
    {
      name: "Sneaker and collectible flipping",
      how: "Buy limited releases at retail and resell into the secondary market within days.",
      why: "Demand is created by scarcity, so the risk is a restock rather than a change in taste.",
    },
    {
      name: "Freight and container arbitrage",
      how: "Buy goods in one region and ship where the landed cost still undercuts the local price.",
      why: "The edge is logistics and duty, not retail price — a different skill from the workbook's clearance rows.",
    },
    {
      name: "Amazon FBA / marketplace arbitrage",
      how: "Source stock locally, ship it into a marketplace's fulfilment network and sell against its buy box.",
      why: "The marketplace handles delivery, so the trade is sourcing plus fee arithmetic.",
    },
    {
      name: "Grocery coupon stacking",
      how: "Combine manufacturer coupons, store promotions and loyalty multipliers on the same basket.",
      why: "A pure rule-stacking edge with a hard cap per household.",
    },
    {
      name: "Returns and liquidation pallets",
      how: "Buy a sealed pallet of returned goods at a fraction of retail and resell item by item.",
      why: "Priced on average value, so the profit depends on how well you sort — and on the tail of unsellable stock.",
    },
  ],
  events: [
    {
      name: "Cross-venue event arbitrage",
      how: "Buy the same contract on two prediction venues and sell the other side when their prices diverge.",
      why: "The venues draw different audiences, so the same probability can trade at two prices.",
    },
    {
      name: "Weather derivatives",
      how: "Trade heating-degree or rainfall contracts against a seasonal forecast.",
      why: "A genuinely uncorrelated exposure that most portfolios cannot access any other way.",
    },
    {
      name: "Awards-season markets",
      how: "Trade Oscar, Grammy and league-award contracts against precursor award results.",
      why: "Short, information-rich windows where public data moves the price before the market reacts.",
    },
    {
      name: "Resolution-criteria arbitrage",
      how: "Trade two contracts on the same event whose settlement wording differs.",
      why: "The same outcome can resolve differently on two venues — that gap is structural, not probabilistic.",
    },
  ],
  commodities: [
    {
      name: "Location and spatial arbitrage",
      how: "Buy a commodity in one delivery point and sell it in another, paying transport and storage.",
      why: "The spread is set by logistics, so it moves when a pipeline or a port does.",
    },
    {
      name: "LNG and gas-basis trades",
      how: "Hold a position between two regional gas benchmarks, hedged for shipping and regasification.",
      why: "Regional gas prices decouple for months at a time, which no single-hub exposure captures.",
    },
    {
      name: "Metals lease rates",
      how: "Lend physical metal at a lease rate and hedge the price in futures.",
      why: "A secured, short-dated yield that spikes exactly when physical metal is scarce.",
    },
    {
      name: "Agricultural basis contracts",
      how: "Buy grain at a local elevator basis and sell the futures, carrying the storage.",
      why: "The basis, not the price, is what the trade earns — and it is driven by local supply.",
    },
    {
      name: "Refinery and crush-margin ownership",
      how: "Own the processing margin directly through a spread of inputs against outputs.",
      why: "The workbook lists the spread but not the physical optionality that comes with owning capacity.",
    },
  ],
  quant: [
    {
      name: "Cointegration pairs with a regime filter",
      how: "Only trade a pair when a rolling test says the relationship is stable, and stand down when it is not.",
      why: "Most pair-trading losses come from trading a broken relationship; the filter is the strategy.",
    },
    {
      name: "Options market making",
      how: "Quote both sides of a listed option, hedge the delta, and earn the spread against inventory risk.",
      why: "A volatility-spread business rather than a directional one, and the workbook has no market-making row.",
    },
    {
      name: "Filings and disclosure signals",
      how: "Parse regulatory filings for changes in ownership or guidance and trade before the narrative forms.",
      why: "Public, timestamped information that is slow to be priced by discretionary money.",
    },
    {
      name: "Sentiment nowcasting on retail flow",
      how: "Aggregate social and search data into a daily signal and trade the short-horizon drift.",
      why: "The data is public but the aggregation is the work — and it decays quickly.",
    },
    {
      name: "Execution algorithms as a return source",
      how: "Beat the arrival price on your own orders with schedule and venue choice, and count that as return.",
      why: "For a large book, implementation shortfall is often larger than the alpha being chased.",
    },
  ],
};

/** Methods for one category, or every category's list in catalogue order. */
export function adjacentFor(category: CategoryId): AdjacentMethod[] {
  return ADJACENT_METHODS[category] ?? [];
}

export function adjacentCount(): number {
  return Object.values(ADJACENT_METHODS).reduce((n, list) => n + list.length, 0);
}
