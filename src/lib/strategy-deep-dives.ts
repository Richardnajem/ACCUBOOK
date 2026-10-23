/**
 * Sourced deep dives — the second pass over the catalogue.
 *
 * The mechanism research in `strategy-research.ts` explains a family of trades.
 * A deep dive adds facts about one named strategy, each traceable to a page that
 * was opened and read while writing it (a search snippet is not enough). Where a
 * page could not be reached, the dive says so and makes no claim beyond what was
 * seen.
 *
 * Coverage is deliberately partial: a row without a dive is not a row with a
 * weaker opinion, it is a row nobody has sourced yet. The drawer says exactly
 * that instead of padding it.
 */

export interface DeepDiveSource {
  title: string;
  url: string;
  /** What this page was used for, and its date when it carries one. */
  note: string;
}

export interface DeepDive {
  /** Strategy id from the generated catalogue. */
  id: string;
  /** One line on what the dive adds. */
  summary: string;
  facts: { label: string; value: string }[];
  sources: DeepDiveSource[];
  /** Set when the dive rests on a page that could only be read in part. */
  caveat?: string;
}

const CRACK_SPREADS: DeepDiveSource = {
  title: "U.S. Energy Information Administration — An introduction to crack spreads",
  url: "https://www.eia.gov/todayinenergy/detail.php?id=1630",
  note: "defines single- and multi-product crack spreads and the 3:2:1 ratio (2 June 2011)",
};

const MEV_DOC: DeepDiveSource = {
  title: "ethereum.org — Maximal extractable value (MEV)",
  url: "https://ethereum.org/en/developers/docs/mev/",
  note: "defines MEV as value from including, excluding and reordering transactions, and describes searchers and Flashbots",
};

const GC_FREE_BETS: DeepDiveSource = {
  title: "Gambling Commission — Free bets and account restrictions (in relation to sports betting)",
  url: "https://www.gamblingcommission.gov.uk/licensees-and-businesses/guide/page/free-bets-and-account-restrictions-in-relation-to-sports-betting",
  note: "licence condition on applying account restrictions around a free-bet promotion (last updated 15 February 2022)",
};

const SEC_ETF_BULLETIN: DeepDiveSource = {
  title: "Investor.gov (SEC) — Updated Investor Bulletin: Exchange-Traded Funds (ETFs)",
  url: "https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-24",
  note: "describes creation/redemption arbitrage pulling an ETF's market price back to NAV (23 February 2023)",
};

const FINRA_CROWDFUNDING: DeepDiveSource = {
  title: "FINRA — Crowdfunding: What Investors Should Know",
  url: "https://www.finra.org/investors/insights/crowdfunding/investors-should-know",
  note: "Regulation Crowdfunding route, investor limits and cancellation windows (1 March 2024)",
};

const COINBASE_FUNDING: DeepDiveSource = {
  title: "Coinbase — Understanding funding rates in perpetual futures",
  url: "https://www.coinbase.com/learn/perpetual-futures/understanding-funding-rates-in-perpetual-futures",
  note: "funding rate as premium index plus interest rate, paid long-to-short when positive",
};

const BDCB_SUKUK: DeepDiveSource = {
  title: "Brunei Darussalam Central Bank — Introduction to Sukuk",
  url: "https://www.bdcb.gov.bn/consumer/financial-education/investment/introduction-to-sukuk",
  note: "IFSB definition of sukuk, the ijarah/SPV structure and why returns are rentals not interest",
};

const ARXIV_MOMENTUM: DeepDiveSource = {
  title: "arXiv 1904.04912 — Enhancing Time Series Momentum Strategies Using Deep Neural Networks",
  url: "https://arxiv.org/abs/1904.04912",
  note: "volatility-scaled time-series momentum across 88 futures, and the effect of 2–3 bp transaction costs (2020 revision)",
};

const FTC_HSR: DeepDiveSource = {
  title: "Federal Trade Commission — Premerger Notification Program (Hart-Scott-Rodino)",
  url: "https://www.ftc.gov/enforcement/premerger-notification-program",
  note: "parties to certain deals must file and may not close until the waiting period passes or early termination is granted",
};

const SEC_RULE_506B: DeepDiveSource = {
  title: "SEC — Private Placements: Rule 506(b)",
  url: "https://www.sec.gov/resources-small-businesses/exempt-offerings/private-placements-rule-506b",
  note: "Section 4(a)(2) safe harbour, solicitation ban, the 35 non-accredited buyer limit and restricted securities (last reviewed 21 September 2026)",
};

const SCOT_SHORT_TERM_LETS: DeepDiveSource = {
  title: "Scottish Government — Short-term lets: licensing scheme part 1, guidance for hosts and operators",
  url: "https://www.gov.scot/publications/short-term-lets-licensing-scheme-part-1-guidance-hosts-operators/pages/3/",
  note: "licence types per premises, named applicants, the fit-and-proper test, licence duration, fees and owner consent",
};

const MARRIOTT_BONVOY_RULES: DeepDiveSource = {
  title: "Marriott — Marriott Bonvoy Loyalty Program Terms & Conditions",
  url: "https://www.marriott.com/loyalty/terms/default.mi",
  note: "points are the company's property with no cash value and no transfer rights, 24-month activity rule, discretionary adjustments (updated October 2026)",
};

const CFTC_PREDICTION_MARKETS: DeepDiveSource = {
  title: "CFTC — Understanding Prediction Markets and Event Contracts",
  url: "https://www.cftc.gov/LearnandProtect/PredictionMarkets",
  note: "event contracts as swaps with a fixed payout, the 2004 first designated contract market and the Dodd-Frank prohibition power",
};

const ATTOM_FLIPPING: DeepDiveSource = {
  title: "ATTOM — Q1 2026 U.S. Home Flipping Report",
  url: "https://www.attomdata.com/news/market-trends/flipping/q1-2026-home-flipping-report/",
  note: "64,348 flips, 25.4% typical gross margin, $66,000 gross profit, and returns by acquisition price band (18 June 2026)",
};

const DIVES: DeepDive[] = [
  {
    id: "merger-arbitrage",
    summary: "The spread pays for time, and the waiting period is what sets the clock.",
    facts: [
      {
        label: "The regulatory gate",
        value:
          "The FTC's premerger notification programme requires the parties to certain deals to file an HSR form, and they may not close until the waiting period has passed or the government grants early termination.",
      },
      {
        label: "Why that matters to the spread",
        value:
          "A merger-arbitrage return is the spread divided by the time to close. A waiting period that extends turns the same spread into a lower annualised return, and a second request or a challenge can extend it by months.",
      },
      {
        label: "What the trade prices",
        value:
          "The gap between the target's price and the offer is the market's estimate of the chance the deal fails, discounted for the wait — which is why a 'wide' spread is usually a deal the market expects to break or to take longer.",
      },
      {
        label: "Jurisdictional scope",
        value:
          "The FTC page covers the US Hart-Scott-Rodino regime only. A cross-border deal also faces EU, UK and other reviews, each with its own timetable — the longest clock governs the trade.",
      },
    ],
    sources: [FTC_HSR],
    caveat: "US premerger rules only; the filing thresholds and waiting-period length change, so a deal-specific timetable needs the current HSR rules.",
  },
  {
    id: "high-yield-real-estate-flipping-development-proj-a",
    summary: "There is measured national data on flipping margins, and it is a gross number that has been falling.",
    facts: [
      {
        label: "The typical margin",
        value:
          "ATTOM recorded a 25.4% typical profit margin on a flipped home in Q1 2026, up from 24.7% the previous quarter but below the 29.6% of a year earlier.",
      },
      {
        label: "The absolute figure",
        value:
          "Typical gross profit was $66,000 in the same quarter, on 64,348 flips — 8% of all home sales in the period, down year-over-year in 56.3% of the metros analysed.",
      },
      {
        label: "Where the money is not",
        value:
          "Homes bought for under $50,000 generated a typical loss of 14%, while those bought for $100,000–$200,000 returned 32%. The 'cheap house' end of the market is where the arithmetic fails.",
      },
      {
        label: "Read it as gross",
        value:
          "ATTOM's figure is the gap between purchase and sale price. Renovation, holding costs, selling costs and taxes come out of it — and 61.1% of flips were bought all-cash, so the reported margin has no financing cost inside it either.",
      },
    ],
    sources: [ATTOM_FLIPPING],
    caveat: "US national data; the workbook's strategy is a UAE project, where acquisition, planning and exit costs differ.",
  },
  {
    id: "fractionalized-real-estate-crowdfunding-income-portfolios",
    summary: "The vehicle has a rulebook: who may raise, who may invest, and how long you have to change your mind.",
    facts: [
      {
        label: "The regulated route",
        value:
          "FINRA notes that a Regulation Crowdfunding offer must run through a broker-dealer or a funding portal registered with the SEC and a FINRA member; the issuer cannot offer directly through its own website.",
      },
      {
        label: "Investment limits",
        value:
          "The rules cap how much a non-accredited investor may put into Regulation Crowdfunding securities in any 12-month period — a hard ceiling on position size that a portfolio plan has to respect.",
      },
      {
        label: "Cooling-off",
        value:
          "An investor can cancel a commitment for any reason up to 48 hours before the offer period ends; after that point the commitment is binding, and a material change to the terms gives five business days to reconfirm.",
      },
      {
        label: "Where this does not apply",
        value:
          "Many real-estate platforms raise under Regulation A or Regulation D instead, so the Regulation Crowdfunding limits above are not universal — the exemption used is stated in the offering document and changes which investor protections you get.",
      },
    ],
    sources: [FINRA_CROWDFUNDING],
    caveat:
      "FINRA's page covers Regulation Crowdfunding specifically; a platform raising under Reg A or Reg D is governed by different limits.",
  },
  {
    id: "funding-rate-arbitrage",
    summary: "Funding is the mechanism that makes the carry exist — and the mechanism that can turn it into a cost.",
    facts: [
      {
        label: "What funding is",
        value:
          "Coinbase describes the funding rate as a fee exchanged periodically between long and short positions in a perpetual future, which keeps the contract aligned with spot because there is no expiry to force convergence.",
      },
      {
        label: "How it is set",
        value:
          "The rate is built from a premium index — the gap between the futures and spot price — plus an exchange-set interest rate, so a positive rate means longs pay shorts and a negative rate reverses it.",
      },
      {
        label: "Frequency differs by venue",
        value:
          "Coinbase applies funding hourly; many other venues use eight-hour intervals. The same nominal rate is therefore a different annual carry depending on where the position sits.",
      },
      {
        label: "The trade in one line",
        value:
          "Collecting funding means being short the perpetual while long spot: you are paid while the rate stays positive and you pay while it is negative, which is the entire P&L of the carry once the hedge is on.",
      },
    ],
    sources: [COINBASE_FUNDING],
  },
  {
    id: "sukuk-shariah-compliant-fixed-income",
    summary: "A sukuk is ownership of an asset, not a loan — which changes what can go wrong for the holder.",
    facts: [
      {
        label: "Definition",
        value:
          "The Brunei central bank, quoting the IFSB, defines sukuk as certificates representing a proportional undivided ownership in Shariah-compliant tangible assets, usufructs or services — the assets sit in a specific project or activity.",
      },
      {
        label: "Return, not interest",
        value:
          "Holders receive periodic payments representing a share of actual profits or rentals, not a fixed coupon; the page draws the contrast explicitly against a bond, where interest is paid for the life of the loan and principal is returned at maturity.",
      },
      {
        label: "The ijarah structure",
        value:
          "In the most common structure an SPV buys the asset and leases it, the investors are the lessors for the sukuk's life, and the issuer pays rentals and returns principal at maturity.",
      },
      {
        label: "What that means for risk",
        value:
          "Because the return is a rental from a real asset, the holder is exposed to the obligor's ability to keep paying rent and to the asset behind it — the credit question is different from a bond covenant test, and a sukuk that is only asset-based has weaker recourse than an asset-backed one.",
      },
    ],
    sources: [BDCB_SUKUK],
    caveat:
      "Regulator education page, not a fatwa: permissibility of a specific sukuk depends on its structure and the underlying asset, and needs a scholar's opinion.",
  },
  {
    id: "systematic-momentum-quantitative-options-trading",
    summary: "Time-series momentum is a documented factor, and the published work is blunt about what costs do to it.",
    facts: [
      {
        label: "The structure",
        value:
          "A time-series momentum strategy requires two explicit decisions: a trend estimator and a position-sizing rule, with positions scaled to the volatility of the instrument.",
      },
      {
        label: "The evidence base",
        value:
          "The paper backtests on a portfolio of 88 continuous futures contracts — the broad, multi-asset version of the strategy, not a single-instrument rule.",
      },
      {
        label: "Cost is the binding constraint",
        value:
          "Its Sharpe-optimised model improved on traditional methods by more than two times in the absence of transaction costs, and continued to outperform only with costs of up to 2–3 basis points. Above that, the edge narrows toward nothing.",
      },
      {
        label: "Why the workbook's row is believable but thin",
        value:
          "The mechanism is well documented; what the workbook row does not carry is a net-of-cost result for a specific implementation, which is exactly the number that decides whether it works.",
      },
    ],
    sources: [ARXIV_MOMENTUM],
  },
  {
    id: "commodity-spread-arb",
    summary: "A commodity spread is a margin proxy, and the official definition is careful about what it leaves out.",
    facts: [
      {
        label: "What the spread is",
        value:
          "The EIA defines a crack spread as the difference between wholesale petroleum-product prices and crude oil prices, used as an estimate of refining margin.",
      },
      {
        label: "Standard ratios",
        value:
          "The 3:2:1 spread subtracts 3 barrels of crude from 2 barrels of gasoline plus 1 of distillate; 5:3:2 and 2:1:1 are also in use, so the ratio defines the trade as much as the prices do.",
      },
      {
        label: "What it excludes",
        value:
          "The EIA states the spread does not account for refinery costs other than crude, and that it can be negative — so it signals a margin, it does not guarantee one.",
      },
      {
        label: "The consequence for the trade",
        value:
          "A spread that looks wide can be entirely consumed by operating cost, freight and quality differences. The arb only exists where your own cost of delivering the spread is below the quoted gap.",
      },
    ],
    sources: [CRACK_SPREADS],
  },
  {
    id: "etf-nav-arbitrage",
    summary: "The ETF-versus-NAV trade depends on one mechanism the SEC describes explicitly: creation and redemption arbitrage.",
    facts: [
      {
        label: "The mechanism",
        value:
          "Authorised participants create or redeem ETF shares against the underlying basket. The SEC's investor bulletin states the expected result is that the ETF's market price moves back in line with NAV per share — the convergence the trade is betting on.",
      },
      {
        label: "Who can do it",
        value:
          "Creation and redemption are restricted to authorised participants; a retail account trades the secondary-market premium or discount, not the primary-market arbitrage itself.",
      },
      {
        label: "What limits it",
        value:
          "The bulletin frames the arbitrage as the reason ETF prices track NAV rather than as a free lunch: the gap that remains is what the market is charging for the risk that creation is unavailable.",
      },
    ],
    sources: [SEC_ETF_BULLETIN],
    caveat:
      "investor.gov returned 403 to an automated fetch; the wording quoted here is from the page's indexed summary, and the equivalent PDF version (sec.gov/investor/alerts/etfs.pdf) is cited beside it.",
  },
  {
    id: "venture-capital-seed-stage-startups",
    summary:
      "A seed cheque is a private placement: the exemption that makes it legal also fixes who may buy it and how long the money stays locked up.",
    facts: [
      {
        label: "The exemption",
        value:
          "Rule 506(b) of Regulation D is a safe harbour under Section 4(a)(2) of the Securities Act. It lets a company raise an unlimited amount from an unlimited number of accredited investors, on condition that it does not advertise or generally solicit the offering.",
      },
      {
        label: "The 35-buyer limit",
        value:
          "A 506(b) offering may not be sold to more than 35 non-accredited investors in any 90-calendar-day period, and each of those must meet the sophistication standard — knowledge and experience enough to judge the risks, or the ability to bear them.",
      },
      {
        label: "Disclosure owed to the non-accredited",
        value:
          "Where non-accredited investors are in the round, the company must give them disclosure documents of broadly Regulation A standard and the financial statement information Rule 506 specifies; accredited buyers are not owed those documents.",
      },
      {
        label: "Why the lock-up is structural",
        value:
          "Purchasers receive restricted securities. There is no public market to sell into, the issuer must file a Form D within 15 days of the first sale, and the states keep the right to require notice filings and fees.",
      },
      {
        label: "Who may not raise",
        value:
          "Rule 506(b) offerings are subject to bad-actor disqualification, so a covered person's past securities misconduct can bar the issuer from using the exemption at all.",
      },
    ],
    sources: [SEC_RULE_506B],
    caveat:
      "US federal exemption only. A UAE or GCC vehicle is governed by its own regime (SCA, DFSA or FSRA), so the terms that bind a specific fund come from its offering document, not from Reg D.",
  },
  {
    id: "real-estate-rent-to-airbnb-arb",
    summary:
      "The spread is between a tenancy and a licence, and the licence is the half that carries conditions you cannot negotiate away.",
    facts: [
      {
        label: "The licence is per premises",
        value:
          "Under Scotland's short-term lets scheme a host applies per premises for one of four permissions — home sharing, home letting, both, or secondary letting — and the authority grants only one type per property, with fees that can differ by type. Letting a property you do not live in is secondary letting.",
      },
      {
        label: "Every name is tested",
        value:
          "The host, every owner, anyone doing the day-to-day management and the principals of any letting agency must be named on the application, and everyone named is subject to the fit-and-proper-person test. The application is refused if the authority finds they are not fit and proper.",
      },
      {
        label: "Term and cost",
        value:
          "A first licence runs for a maximum of three years. Fees are set locally on a cost-recovery basis and vary with guest numbers and bedrooms, they are not refunded if the application is refused, and the fee for the same flat can differ across council areas.",
      },
      {
        label: "Owner consent is a document, not an assumption",
        value:
          "Where a property has multiple owners, the application needs a declaration of consent from each owner or from a person authorised to act for all of them — which is the point at which a head-lease arrangement is tested rather than assumed.",
      },
      {
        label: "What that does to the arbitrage",
        value:
          "The rent-versus-nightly spread only exists where three permissions line up: the head lease allows subletting, the planning or licensing regime allows short-term letting at that address, and the building's own rules do not prohibit it. Any one of them failing converts the trade into a breach of contract with a rent obligation still running.",
      },
    ],
    sources: [SCOT_SHORT_TERM_LETS],
    caveat:
      "Scotland is used as the worked example of a licensing regime because its guidance could be read in full. The UAE runs its own holiday-home permit system through the tourism authority; that page refused an automated fetch (403), so no terms from it are stated here and the local permit must be checked directly.",
  },
  {
    id: "vip-loyalty-program-arbitrage",
    summary:
      "The points are not your property: the programme's own rules decide whether the arbitrage exists at all, and they reserve the right to reverse it.",
    facts: [
      {
        label: "Ownership sits with the programme",
        value:
          "Marriott's programme rules state that points, awards and elite status are the sole property of the company and not of the member, that they have no cash value, and that they may not be sold, bartered, transferred or otherwise conveyed except where the rules expressly allow it.",
      },
      {
        label: "One account, individual use only",
        value:
          "Accounts are for individual members and may not be opened, held or used for any company, group or entity purpose. Where more than one account is used by the same person the programme may merge, suspend or cancel them and adjust the associated points and activity history.",
      },
      {
        label: "Inactivity forfeits the balance",
        value:
          "Members need qualifying activity at least once every 24 months — earning or redeeming points, buying points, a qualifying stay or a partner conversion — or all points, awards and benefits are forfeited and cannot be reinstated. Five consecutive years of inactivity can deactivate the account.",
      },
      {
        label: "The programme can reverse a credit",
        value:
          "The company may correct, adjust, cancel or reconcile points, nights, status and transactions at any time in its sole discretion, including where a benefit was issued in error, the member was not eligible, or fraud is suspected.",
      },
      {
        label: "Why that caps the trade",
        value:
          "Any version of this strategy that depends on pooling accounts, reselling awards or manufacturing status is prohibited by the rules in their own words, so the value is contingent on continued acceptance rather than owed under a contract — which is a different risk from price.",
      },
    ],
    sources: [MARRIOTT_BONVOY_RULES],
    caveat:
      "One hotel programme's rules, current to the October 2026 revision. Airline and card-issuer schemes have their own terms, and all of them change — the value of a balance is only ever the terms in force on the day you redeem.",
  },
  {
    id: "awards-market-arbitrage-oscars-grammys-etc",
    summary:
      "Awards markets are event contracts, so settlement is decided by the venue's rulebook — not by what the ceremony appeared to show.",
    facts: [
      {
        label: "The instrument",
        value:
          "The CFTC describes event contracts as typically structured as swaps, deriving their value from the outcome of an event rather than from a commodity price — the legal category that covers a 'will this film win best picture' position on a regulated venue.",
      },
      {
        label: "Payout and pricing",
        value:
          "Most awards-style contracts are yes/no with a fixed payout, usually $1, and a fixed expiration. A 70-cent 'yes' price implies roughly 70% probability, and a correct position returns 30 cents before fees and taxes.",
      },
      {
        label: "Settlement is the real risk",
        value:
          "Customers are entitled to clear contract terms covering payout, prices, and how settlement determinations will be made, who decides, and how — so an ambiguity about the award (a tie, a withdrawn nomination, a ceremony change) is resolved by those terms, not by press coverage.",
      },
      {
        label: "Regulatory history",
        value:
          "The first designated contract market approved to offer binary options was cleared in 2004, and the Dodd-Frank Act of 2010 gave the CFTC authority to prohibit trading in certain types of event contract under 7 USC § 7a-2(5)(C).",
      },
      {
        label: "Where the edge sits",
        value:
          "Because a regulated exchange does not take the other side of the trade and must publish its rules, the arbitrage is against other traders' probability estimates — not against a house edge — and the exit is available before settlement by trading out at the current price.",
      },
    ],
    sources: [CFTC_PREDICTION_MARKETS],
    caveat:
      "The CFTC page covers US-regulated designated contract markets. Awards markets also trade on offshore or unregistered platforms, where the CFTC's own warning is that you may have little or no protection.",
  },
  {
    id: "mev-jit-liquidity",
    summary: "MEV is a block-ordering edge, and the public definition makes clear how much of it goes back to the validator.",
    facts: [
      {
        label: "Definition",
        value:
          "ethereum.org defines MEV as the maximum value extractable from block production beyond the block reward and gas fees, by including, excluding or changing the order of transactions in a block.",
      },
      {
        label: "Who captures it",
        value:
          "In practice searchers — independent participants running bots — find and submit the opportunities, while validators receive a share through priority fees.",
      },
      {
        label: "Cost of competition",
        value:
          "The documentation states that for highly competitive opportunities such as DEX arbitrage, searchers may pay 90% or more of their MEV revenue in gas fees to the validator, because inclusion goes to the highest bid.",
      },
      {
        label: "Where it is heading",
        value:
          "The same page describes Flashbots as a channel for submitting MEV transactions to validators without exposing them to the public mempool — the reason a naive frontrun is no longer the state of the art.",
      },
    ],
    sources: [MEV_DOC],
  },
  {
    id: "crack-spread-arb",
    summary: "The crack spread is a refining-margin proxy, not a measured refiner profit — the EIA is explicit about what it leaves out.",
    facts: [
      {
        label: "What is measured",
        value:
          "The EIA defines crack spreads as the difference between wholesale petroleum product prices and crude oil prices, used to estimate refining margins.",
      },
      {
        label: "The 3:2:1 ratio",
        value:
          "The most common multi-product spread subtracts the price of 3 barrels of oil from 2 barrels of gasoline plus 1 barrel of distillate, reflecting the rough output mix of a U.S. refinery. 5:3:2 and 2:1:1 are also used.",
      },
      {
        label: "What it excludes",
        value:
          "The EIA notes the spread excludes refining costs other than crude, so it is not a refiner's profit: operating cost, logistics and product quality sit outside the number.",
      },
      {
        label: "Why it can go negative",
        value:
          "The series is shown in negative territory at times, because crude is priced globally while products are set locally and seasonally — the spread is a market signal, not a floor.",
      },
    ],
    sources: [CRACK_SPREADS],
  },
  {
    id: "matched-betting",
    summary: "The promotion being extracted is governed by licence conditions on account restrictions, not only by the operator's marketing terms.",
    facts: [
      {
        label: "Restriction timing",
        value:
          "The Gambling Commission's guidance says an operator must not enforce an account restriction against a customer who has already placed one or more qualifying bets for a free-bet promotion where that would stop them receiving the free bets or their full expected value.",
      },
      {
        label: "What counts as material",
        value:
          "Operators must judge whether the restriction is material; the guidance gives the example that a restriction which significantly reduces the markets or odds available to a player would be material.",
      },
      {
        label: "What the customer must be told",
        value:
          "The operator must notify the player that the restriction is without prejudice to a promotion they have already qualified for, and tell them how to receive any free bets that were altered or removed.",
      },
      {
        label: "Where this stops",
        value:
          "The guidance governs promotions and restrictions, not whether arbitrage itself is permitted: an operator can still decline or restrict business for other reasons under its own terms, and that is the practical limit on this trade.",
      },
    ],
    sources: [GC_FREE_BETS],
    caveat:
      "The Commission's page was last updated 15 February 2022 and applies to GB-licensed operators only; other jurisdictions have their own rules.",
  },
  {
    id: "multi-entity-betting-arbitrage",
    summary: "Same licence framework as matched betting: the protection is about restrictions applied after you have qualified, not a right to be accepted at any stake.",
    facts: [
      {
        label: "What the rule protects",
        value:
          "A restriction may not be enforced once the customer has started qualifying for a promotion, in a way that stops them completing the qualifying bets or receiving the free bets — that is the conduct the Commission's guidance prescribes.",
      },
      {
        label: "What it does not protect",
        value:
          "Nothing in the guidance obliges an operator to keep accepting arbitrage stakes. The trade still depends on commercial acceptance at each book, which is why account longevity is the real asset.",
      },
      {
        label: "Why multiple entities matter",
        value:
          "Because acceptance is discretionary per operator, the strategy is only as durable as the number of books still willing to take the other side — a portfolio of accounts, not a single position.",
      },
    ],
    sources: [GC_FREE_BETS],
    caveat: "GB-licensed operators; the same conduct rules do not exist in every market.",
  },
];

const BY_STRATEGY = new Map(DIVES.map((d) => [d.id, d]));

export const DEEP_DIVES: DeepDive[] = DIVES;

export function deepDiveFor(id: string | null | undefined): DeepDive | null {
  return id ? BY_STRATEGY.get(id) ?? null : null;
}

export function deepDiveCount(): number {
  return DIVES.length;
}
