# EdgeForge Sports

A private, read-only sports market research site with a combo generator that accepts 1–10 legs, several sports and an inclusive date range of up to 31 days.

## What the generator ranks

The current optimizer compares binary market-implied probabilities from the available quote book. It normalizes affirmative and negative bid/ask midpoints, chooses at most one selection per game/event, and returns up to three candidates in descending product probability order. Its dynamic program is checked against exhaustive enumeration. It does not apply an edge or payout filter, so the requested number of legs can be returned even when the estimated chance of all legs winning is low.

These values are a ranking proxy, not a trained sports forecast. The displayed Frechet bounds describe possible dependence among the quoted marginal probabilities; they do not cover errors in those market probabilities. Distinct game outcomes may still be correlated, including repeat teams on different dates. The result is marked hypothetical because Kalshi combo RFQs and Polymarket combo execution are not obtained. No trades are placed.

The **Game combos** page prepares one two-leg research candidate for each scheduled matchup across MLB, NFL, NCAAF, NBA and NCAAB. Each candidate is anchored to its displayed game and pairs it with the highest ranked eligible selection from a different verified game. It uses the same market-implied winning-probability ranking as the main generator. The slate loads 24 games at a time and batches candidate generation; missing or stale market matches produce an empty state instead of fabricated selections.

## Data and limits

The application reads public venue and schedule endpoints. It keeps Kalshi, Polymarket US and optional Polymarket Global separate. Sources return status, count, freshness and errors. Provider failures do not substitute invented markets. The supported leagues are MLB, NFL, NCAAF, NBA and NCAAB; actual coverage depends on what the selected provider lists. Event matching remains unverified when team and date information cannot uniquely identify a scheduled game.

Player prop history, injury reporting and a calibrated, trained sport model are not currently connected. The interface labels these limits. Data-source terms and geographical eligibility should be checked before use. Market snapshots are read-only.

## Local development on Windows

Requirements: Node.js 22.13 or later and npm.

From this folder:

```powershell
npm ci
npm run dev
```

The preview opens at `http://localhost:5173`. The starter in this environment required invoking npm's CLI directly because the Windows npm shim could not find its own prefix; when needed, use:

```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' ci --workspaces=false --include=dev --include=optional --prefer-offline --no-audit --no-fund
```

The Sites starter provides a local signed-in development identity at `/signin-with-chatgpt?return_to=/`. Hosted Sites authentication is owned by the Sites runtime. Saved research is user-scoped in D1 when signed in, with a browser-local fallback for the unauthenticated preview.

## Validation

```powershell
node --test tests\optimizer.test.mjs
npx tsc --noEmit
```

The optimizer tests cover winning-probability ranking independent of standalone price, yes/no selection, freshness and settlement filtering, date boundaries in New York, sports and event constraints, dependence bounds, exact 1–10 leg outputs, API validation and exact top-three enumeration (19 passing tests).

## Architecture

- `app/`: Vinext UI and API routes
- `app/api/catalog`: verified market and game catalog
- `app/api/combos`: validated generation request and ranked output
- `app/api/saved`: authenticated D1 saved-research and paper-result records
- `lib/providers.ts`: read-only public data adapters, identity matching and freshness
- `lib/models.ts`: market-implied estimates and dependence bounds
- `lib/optimizer.ts`: exact k-best combo search
- `db/`: D1 schema and generated migration
- `tests/optimizer.test.mjs`: numerical and constraint tests
- `docs/design-concept.png`: accepted primary-screen design concept

## Reference research

The requested [anti-slop](https://github.com/miqdadbadjuber/anti-slop), [replica-skill](https://github.com/Jakeschincariol/replica-skill) and [sports-betting-claude](https://github.com/magicjordan33/sports-betting-claude) repositories are retained outside this app in the workspace `references/` folder. We used their design, workflow and data-quality ideas as guidance. They do not supply verified live data or trained models. See `../references/RESEARCH.md` for the findings and specific limits.

Official venue references: [Kalshi developer documentation](https://docs.kalshi.com/) and [Polymarket US API documentation](https://docs.polymarket.us/).
