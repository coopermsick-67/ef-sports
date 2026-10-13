"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowRight, ArrowUpRight, BarChart3, Bookmark, CalendarDays, Check,
  ChevronDown, CircleAlert, CircleCheck, FileSearch, Home, Info, ListFilter,
  Menu, RefreshCw, Search, Settings2, SlidersHorizontal, Ticket, UserRound,
  Waypoints, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SPORTS } from "../lib/types";
import type { Catalog, Game, Market, MarketCategory, SourceStatus, Sport, Venue } from "../lib/types";
import type { Combo, ComboResult } from "../lib/optimizer";

type View = "dashboard" | "generator" | "game-combos" | "scanner" | "games" | "players" | "saved" | "health";
type SaveStatus = "research" | "paper-open" | "paper-won" | "paper-lost";
type StorageMode = "checking" | "account" | "browser";
interface SavedItem { id: string; combo: Combo; status: SaveStatus; stake: number; entryCost: number | null; savedAt: string; updatedAt: string }
const NAV: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "dashboard", label: "Dashboard", icon: Home },
  { id: "generator", label: "Combo generator", icon: Waypoints },
  { id: "game-combos", label: "Game combos", icon: Ticket },
  { id: "scanner", label: "Market scanner", icon: Search },
  { id: "games", label: "Game analysis", icon: BarChart3 },
  { id: "players", label: "Player research", icon: UserRound },
  { id: "saved", label: "Saved combos", icon: Bookmark },
];
const LABELS: Record<View, string> = { dashboard: "Dashboard", generator: "Combo generator", "game-combos": "Game combos", scanner: "Market scanner", games: "Game analysis", players: "Player research", saved: "Saved combos", health: "Settings & data health" };
const VENUES: { id: Venue; label: string }[] = [
  { id: "kalshi", label: "Kalshi" }, { id: "polymarket-us", label: "Polymarket US" },
  { id: "polymarket-global", label: "Global (read-only)" },
];
const CATEGORIES: { id: MarketCategory; label: string }[] = [
  { id: "moneyline", label: "Winners" }, { id: "spread", label: "Spreads" },
  { id: "total", label: "Totals" }, { id: "team-total", label: "Team totals" },
  { id: "player-prop", label: "Player props" }, { id: "period", label: "Periods" },
  { id: "other", label: "Other" },
];
const STORAGE_KEY = "edgeforge-saved-combos-v1";
function dateET(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return get("year") + "-" + get("month") + "-" + get("day");
}
function plusDays(date: string, days: number) { const value = new Date(date + "T12:00:00Z"); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function when(iso: string, time = true) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", ...(time ? { hour: "numeric", minute: "2-digit" } : {}) }).format(date) + (time ? " ET" : "");
}
function pct(value: number | null | undefined) { return typeof value === "number" && Number.isFinite(value) ? (value * 100).toFixed(1) + "%" : "—"; }
function cents(value: number | null | undefined) { return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) + "¢" : "—"; }
function compact(value: number | null | undefined) { return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat("en-US", { notation: "compact" }).format(value) : "—"; }
function venueName(value: Venue) { return VENUES.find((item) => item.id === value)?.label ?? value; }
function legEvent(leg: Combo["legs"][number], games: Game[] = []) {
  return (leg.gameId ? games.find((game) => game.id === leg.gameId)?.title : undefined)
    || leg.providerEventTitle?.trim() || leg.title;
}
async function json(response: Response) { try { return await response.json(); } catch { return null; } }
function message(data: unknown, fallback: string) { if (data && typeof data === "object") { const item = data as { error?: unknown; message?: unknown }; if (typeof item.error === "string") return item.error; if (typeof item.message === "string") return item.message; } return fallback; }
function browserSaved(): SavedItem[] { try { const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); return Array.isArray(data) ? data.filter((item) => item && typeof item.id === "string" && Array.isArray(item.combo?.legs)) : []; } catch { return []; } }
function fresh(iso?: string | null) { if (!iso) return false; const age = Date.now() - Date.parse(iso); return Number.isFinite(age) && age >= -60000 && age < 300000; }
function Empty({ icon: Icon, title, copy, action }: { icon: LucideIcon; title: string; copy: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={28} strokeWidth={1.5} /></div><h3>{title}</h3><p>{copy}</p>{action}</div>;
}
function Intro({ title, copy, aside }: { title: string; copy: string; aside?: string }) {
  return <div className="page-intro"><div><h1>{title}</h1><p>{copy}</p></div>{aside && <span className="research-label">{aside}</span>}</div>;
}

export default function HomePage() {
  const today = dateET(new Date());
  const [view, setView] = useState<View>("generator");
  const [menuOpen, setMenuOpen] = useState(false);
  const [venue, setVenue] = useState<Venue>("kalshi");
  const [sports, setSports] = useState<Sport[]>([]);
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(plusDays(today, 6));
  const [legs, setLegs] = useState(3);
  const [featuredSport, setFeaturedSport] = useState<Sport>("MLB");
  const [featuredLimit, setFeaturedLimit] = useState(24);
  const [featuredResults, setFeaturedResults] = useState<Record<string, ComboResult>>({});
  const [featuredBusy, setFeaturedBusy] = useState(false);
  const [featuredError, setFeaturedError] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [categories, setCategories] = useState<MarketCategory[]>([]);
  const [minLiquidity, setMinLiquidity] = useState("");
  const [maxSpread, setMaxSpread] = useState("");
  const [stake, setStake] = useState("10");
  const [gameIds, setGameIds] = useState<string[]>([]);
  const [requireEachSport, setRequireEachSport] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [result, setResult] = useState<ComboResult | null>(null);
  const [comboIndex, setComboIndex] = useState(0);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [search, setSearch] = useState("");
  const [scannerCategory, setScannerCategory] = useState<MarketCategory | "all">("all");
  const [sort, setSort] = useState("soonest");
  const [marketLimit, setMarketLimit] = useState(20);
  const [selectedGame, setSelectedGame] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedItem[]>([]);
  const [storageMode, setStorageMode] = useState<StorageMode>("checking");
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");

  const validDates = Boolean(start && end && start <= end);
  const catalogSportsKey = (view === "game-combos"
    ? [featuredSport]
    : sports.length ? sports : [featuredSport]).join(",");
  const refresh = useCallback(() => setRefreshIndex((n) => n + 1), []);
  const navigate = (next: View) => { setView(next); setMenuOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); };
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      if (!validDates) { setCatalog(null); setCatalogError("Choose a valid date range."); setCatalogBusy(false); return; }
      setCatalogBusy(true); setCatalogError("");
      const params = new URLSearchParams({ sports: catalogSportsKey, start, end, venue });
      try {
        const response = await fetch("/api/catalog?" + params.toString(), { cache: "no-store", signal: controller.signal });
        const data = await json(response);
        if (!response.ok) throw new Error(message(data, "Could not load market data."));
        if (active) {
          setCatalog(data as Catalog);
          setMarketLimit(20);
          setGameIds((current) => current.filter((id) => (data as Catalog).games.some((game) => game.id === id)));
        }
      } catch (error) {
        if (active && !controller.signal.aborted) { setCatalog(null); setCatalogError(error instanceof Error ? error.message : "Could not load market data."); }
      } finally { if (active) setCatalogBusy(false); }
    }, 150);
    return () => { active = false; controller.abort(); window.clearTimeout(timer); };
  }, [catalogSportsKey, start, end, venue, refreshIndex, validDates]);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch("/api/saved", { cache: "no-store" });
        if (response.ok) {
          const data = await json(response) as { items?: SavedItem[] } | null;
          if (active) { setSaved(Array.isArray(data?.items) ? data.items : []); setStorageMode("account"); }
          return;
        }
      } catch { /* Local previews may be unauthenticated. */ }
      if (active) { setSaved(browserSaved()); setStorageMode("browser"); }
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => { if (notice) { const timer = window.setTimeout(() => setNotice(""), 4000); return () => window.clearTimeout(timer); } }, [notice]);

  const toggleSport = (sport: Sport) => { setSports((current) => current.includes(sport) ? current.filter((item) => item !== sport) : SPORTS.filter((item) => [...current, sport].includes(item))); setResult(null); };
  const toggleCategory = (category: MarketCategory) => setCategories((current) => current.includes(category) ? current.filter((item) => item !== category) : [...current, category]);
  const toggleGame = (id: string) => setGameIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const generate = async () => {
    setGenerateError(""); setResult(null);
    if (!validDates) { setGenerateError("Choose a valid start and end date."); return; }
    if (venue === "polymarket-global") { setGenerateError("Global markets are read-only. Choose Kalshi or Polymarket US for combos."); return; }
    setGenerateBusy(true);
    try {
      const body = {
        sports: sports.length ? sports : [...SPORTS], start, end, venue, legs, stake: Number(stake) || 0, requireEachSport,
        ...(categories.length ? { marketCategories: categories } : {}),
        ...(minLiquidity !== "" ? { minLiquidity: Number(minLiquidity) } : {}),
        ...(maxSpread !== "" ? { maxSpread: Number(maxSpread) / 100 } : {}),
        ...(gameIds.length ? { gameIds } : {}),
      };
      const response = await fetch("/api/combos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
      const data = await json(response);
      if (!response.ok) throw new Error(message(data, "Could not generate combinations."));
      setResult(data as ComboResult); setComboIndex(0); refresh();
    } catch (error) { setGenerateError(error instanceof Error ? error.message : "Could not generate combinations."); }
    finally { setGenerateBusy(false); }
  };
  const saveCombo = async (combo: Combo, status: SaveStatus) => {
    setSaveError("");
    const previous = saved.find((item) => item.combo.id === combo.id);
    const now = new Date().toISOString();
    const storedCombo: Combo = { ...combo, legs: combo.legs.map((leg) => ({ ...leg, providerEventTitle: legEvent(leg, catalog?.games ?? []) })) };
    const item: SavedItem = { id: previous?.id ?? crypto.randomUUID(), combo: storedCombo, status, stake: Number(stake) || combo.stake, entryCost: previous?.entryCost ?? null, savedAt: previous?.savedAt ?? now, updatedAt: now };
    try {
      if (storageMode === "account") {
        const response = await fetch("/api/saved", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) });
        const data = await json(response) as { item?: SavedItem } | null;
        if (!response.ok) throw new Error(message(data, "Could not save combo."));
        setSaved((current) => [data?.item ?? item, ...current.filter((savedItem) => savedItem.id !== item.id)]);
      } else {
        const next = [item, ...saved.filter((savedItem) => savedItem.id !== item.id)];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); setSaved(next);
      }
      setNotice(status === "research" ? "Combination saved." : "Added to your paper tracker.");
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Could not save combo."); }
  };
  const updateSaved = async (id: string, changes: Partial<Pick<SavedItem, "status" | "stake" | "entryCost">>) => {
    setSaveError("");
    try {
      if (storageMode === "account") {
        const response = await fetch("/api/saved/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
        if (!response.ok) throw new Error(message(await json(response), "Could not update saved combo."));
      }
      const next = saved.map((item) => item.id === id ? { ...item, ...changes, updatedAt: new Date().toISOString() } : item);
      if (storageMode === "browser") localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setSaved(next);
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Could not update saved combo."); }
  };
  const removeSaved = async (id: string) => {
    setSaveError("");
    try {
      if (storageMode === "account") {
        const response = await fetch("/api/saved/" + encodeURIComponent(id), { method: "DELETE" });
        if (!response.ok) throw new Error(message(await json(response), "Could not remove saved combo."));
      }
      const next = saved.filter((item) => item.id !== id);
      if (storageMode === "browser") localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setSaved(next); setNotice("Saved combination removed.");
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Could not remove saved combo."); }
  };
  const markets = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (catalog?.markets ?? []).filter((market) =>
      (scannerCategory === "all" || scannerCategory === market.category) &&
      (!query || [market.title, market.selection, market.sport, market.venue, market.providerEventTitle].some((text) => text?.toLowerCase().includes(query))))
      .sort((a, b) => sort === "probability" ? (b.probability ?? -1) - (a.probability ?? -1)
        : sort === "volume" ? (b.volume ?? -1) - (a.volume ?? -1)
          : sort === "name" ? a.title.localeCompare(b.title) : a.startsAt.localeCompare(b.startsAt));
  }, [catalog, search, scannerCategory, sort]);
  const games = useMemo(() => (catalog?.games ?? []).filter((game) => game.status === "scheduled" || game.status === "live").sort((a, b) => a.startsAt.localeCompare(b.startsAt)), [catalog]);
  const featuredGames = useMemo(() => games.filter((game) => game.sport === featuredSport), [games, featuredSport]);
  const visibleFeaturedGames = useMemo(() => featuredGames.slice(0, featuredLimit), [featuredGames, featuredLimit]);
  const featuredResultKey = useCallback((game: Game) => `${catalog?.fetchedAt ?? "loading"}:${venue}:${game.id}`, [catalog?.fetchedAt, venue]);
  useEffect(() => {
    if (view !== "game-combos" || !visibleFeaturedGames.length || venue === "polymarket-global") return;
    const anchorGameIds = visibleFeaturedGames.filter((game) => !featuredResults[featuredResultKey(game)]).slice(0, 48).map((game) => game.id);
    if (!anchorGameIds.length) return;
    const controller = new AbortController();
    const load = async () => {
      setFeaturedBusy(true); setFeaturedError("");
      try {
        const requestSlate = async (sourceVenue: Venue) => {
          const body = { sports: [featuredSport], start, end, venue: sourceVenue, legs: 2, anchorGameIds };
          const response = await fetch("/api/combos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: controller.signal });
          const data = await json(response);
          if (!response.ok) throw new Error(message(data, "Could not prepare game combos."));
          const results = (data as { gameCombos?: Record<string, ComboResult> }).gameCombos;
          if (!results || typeof results !== "object") throw new Error("The combo service returned an invalid game slate.");
          return results;
        };
        const results = await requestSlate(venue);
        const missingAnchors = anchorGameIds.filter((gameId) => !results[gameId]?.combos.length);
        // Kalshi may throttle a hosted worker. Fill empty matchup cards from the
        // other US venue, and search all supported sports for a companion event.
        if (venue === "kalshi" && missingAnchors.length) {
          const fallback = await requestSlate("polymarket-us");
          for (const gameId of missingAnchors) {
            if (fallback[gameId]?.combos.length) results[gameId] = fallback[gameId];
          }
        }
        setFeaturedResults((current) => ({ ...current, ...Object.fromEntries(Object.entries(results).map(([gameId, result]) => {
          const game = visibleFeaturedGames.find((item) => item.id === gameId);
          return [game ? featuredResultKey(game) : gameId, result];
        })) }));
      } catch (error) {
        if (!controller.signal.aborted) setFeaturedError(error instanceof Error ? error.message : "Could not prepare game combos.");
      } finally { if (!controller.signal.aborted) setFeaturedBusy(false); }
    };
    void load();
    return () => controller.abort();
  }, [view, featuredSport, venue, start, end, catalog?.fetchedAt, featuredLimit, featuredResults, visibleFeaturedGames, featuredResultKey]);
  const combo = result?.combos[comboIndex] ?? null;
  const dataFresh = fresh(catalog?.fetchedAt);
  const playerMarkets = (catalog?.markets ?? []).filter((market) => market.category === "player-prop");

  return <div className="app-shell">
    <aside className={"sidebar" + (menuOpen ? " sidebar-open" : "")}>
      <button className="brand" onClick={() => navigate("dashboard")} aria-label="EdgeForge Sports dashboard"><span className="brand-mark"><i>E</i><i>F</i></span><span className="brand-copy"><strong>EDGEFORGE</strong><small>SPORTS</small></span></button>
      <nav className="side-nav" aria-label="Main navigation">{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={"nav-item" + (view === id ? " active" : "")} onClick={() => navigate(id)}><Icon size={21} strokeWidth={1.8} /><span>{label}</span></button>)}</nav>
      <button className={"nav-item side-bottom" + (view === "health" ? " active" : "")} onClick={() => navigate("health")}><Settings2 size={21} strokeWidth={1.8} /><span>Settings & data health</span></button>
    </aside>
    {menuOpen && <button className="mobile-shade" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <div className="main-shell">
      <header className="topbar"><div className="topbar-left"><button className="mobile-menu-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={21} /></button><span className="breadcrumb-muted">Workspace</span><span className="breadcrumb-slash">/</span><span>{LABELS[view]}</span></div><div className="topbar-actions">{catalog && <span className={"freshness" + (dataFresh ? " fresh" : "")}><span className="freshness-dot" />{dataFresh ? "Current snapshot" : "Snapshot aging"}</span>}<button className="refresh-button" onClick={refresh} disabled={catalogBusy}><RefreshCw size={17} className={catalogBusy ? "spin" : ""} /><span>{catalogBusy ? "Refreshing" : "Refresh data"}</span></button></div></header>
      <main className="workspace">
        {view === "generator" && <>
          <Intro title="Build a smarter combo." copy="Choose multiple sports, games, and days. Rank for the best chance of winning." aside="Research only" />
          <div className="generator-grid">
            <section className="panel generator-panel"><h2>Find your next combination</h2>
              <div className="form-block"><label className="field-label">Prediction market venue</label><div className="venue-options">{VENUES.map((item) => <button key={item.id} className={"select-chip venue-chip" + (venue === item.id ? " selected" : "")} onClick={() => { setVenue(item.id); setResult(null); }}>{item.label}</button>)}</div><p className="field-hint">Global markets are read-only and cannot be added to combos.</p></div>
              <div className="form-block"><div className="field-label-row"><label className="field-label">Sports</label><button className="text-action" onClick={() => { setSports(sports.length === SPORTS.length ? [] : [...SPORTS]); setResult(null); }}>{sports.length === SPORTS.length ? "Clear all" : "Select all"}</button></div><div className="sport-options">{SPORTS.map((sport) => <button key={sport} aria-pressed={sports.includes(sport)} className={"select-chip sport-chip" + (sports.includes(sport) ? " selected" : "")} onClick={() => toggleSport(sport)}>{sport}</button>)}</div></div>
              <div className="date-grid"><label><span className="field-label">Start date</span><span className="input-wrap"><CalendarDays size={18} /><input type="date" value={start} onChange={(event) => { setStart(event.target.value); setResult(null); }} aria-label="Start date" /></span></label><label><span className="field-label">End date</span><span className="input-wrap"><CalendarDays size={18} /><input type="date" value={end} min={start} onChange={(event) => { setEnd(event.target.value); setResult(null); }} aria-label="End date" /></span></label></div>
              <div className="form-block legs-block"><label className="field-label">Number of legs</label><div className="leg-options">{Array.from({ length: 10 }, (_, n) => n + 1).map((count) => <button key={count} aria-pressed={legs === count} className={"select-chip leg-chip" + (legs === count ? " selected" : "")} onClick={() => { setLegs(count); setResult(null); }}>{count}</button>)}</div></div>
              <p className="optimization-note"><Info size={17} />Ranked by market-implied win probability, even when the estimated chance is low.</p>
              <div className="filters"><button className="filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}><span><SlidersHorizontal size={20} />Market filters{categories.length + gameIds.length > 0 && <em>{categories.length + gameIds.length} active</em>}</span><ChevronDown size={19} className={filtersOpen ? "rotated" : ""} /></button>{filtersOpen && <div className="filters-body">
                <div className="filter-group"><div className="field-label-row"><label className="field-label">Market categories</label><button className="text-action" onClick={() => setCategories([])}>Any category</button></div><div className="category-options">{CATEGORIES.map((category) => <button key={category.id} className={"small-chip" + (categories.includes(category.id) ? " selected" : "")} onClick={() => toggleCategory(category.id)}>{category.label}</button>)}</div></div>
                <div className="filter-number-grid"><label><span className="field-label">Minimum liquidity</span><span className="input-wrap small-input"><b>$</b><input type="number" min="0" step="1" placeholder="Any" value={minLiquidity} onChange={(event) => setMinLiquidity(event.target.value)} /></span></label><label><span className="field-label">Maximum spread</span><span className="input-wrap small-input"><input type="number" min="0" max="100" step="0.1" placeholder="Any" value={maxSpread} onChange={(event) => setMaxSpread(event.target.value)} /><b>¢</b></span></label><label><span className="field-label">Research stake</span><span className="input-wrap small-input"><b>$</b><input type="number" min="0" step="1" value={stake} onChange={(event) => setStake(event.target.value)} /></span></label></div>
                <div className="filter-group"><div className="field-label-row"><label className="field-label">Specific games</label><button className="text-action" onClick={() => setGameIds([])}>Any game</button></div>{games.length ? <div className="game-checklist">{games.slice(0, 50).map((game) => <label key={game.id} className="game-check"><input type="checkbox" checked={gameIds.includes(game.id)} onChange={() => toggleGame(game.id)} /><span><strong>{game.title}</strong><small>{game.sport} · {when(game.startsAt)}</small></span></label>)}</div> : <p className="field-hint">Games appear when a schedule source responds.</p>}</div>
                <label className="checkbox-line"><input type="checkbox" checked={requireEachSport} onChange={(event) => setRequireEachSport(event.target.checked)} /><span>Include at least one leg from each selected sport</span></label>
              </div>}</div>
              {generateError && <div className="inline-alert error"><CircleAlert size={17} />{generateError}</div>}
              <button className="generate-button" disabled={generateBusy || venue === "polymarket-global"} onClick={generate}>{generateBusy ? <><RefreshCw size={18} className="spin" />Analyzing real markets…</> : <>Generate combos <ArrowRight size={20} /></>}</button>
              {venue === "polymarket-global" && <p className="field-hint global-note">Select Kalshi or Polymarket US to generate. Global markets remain visible in the scanner.</p>}
            </section>
            <section className="panel combo-panel"><h2>Your combo</h2>{generateBusy ? <Empty icon={Activity} title="Evaluating available contracts" copy="Checking current markets against your sports, dates, and leg count." /> : combo ? <div className="combo-result">
              <div className="combo-result-header"><span className="result-kicker">RANK #{combo.rank} · {combo.legs.length} LEGS</span><strong>{pct(combo.probability)}</strong></div><h3>Highest market-implied win probability</h3><p className="basis-label">Distinct events treated as independent for ranking</p>
              <div className="combo-leg-list">{combo.legs.map((leg, n) => <div className="combo-leg" key={leg.id}><span className="leg-index">{String(n + 1).padStart(2, "0")}</span><div><strong>{leg.selection}</strong><span className="event-title">{legEvent(leg, catalog?.games ?? [])}</span><small>{leg.sport} · {when(leg.startsAt)} · {venueName(leg.venue)}</small></div><strong>{pct(leg.probability)}</strong></div>)}</div>
              <div className="combo-detail-line"><span>Dependence bounds</span><strong>{pct(combo.lowerBound)} – {pct(combo.upperBound)}</strong></div><div className="combo-detail-line"><span>Distinct games</span><strong>{combo.independentEvents}</strong></div>
              <div className="combo-action-row"><button className="secondary-button" onClick={() => saveCombo(combo, "research")}><Bookmark size={16} />{saved.some((item) => item.combo.id === combo.id) ? "Update saved" : "Save combo"}</button><button className="secondary-button" onClick={() => saveCombo(combo, "paper-open")}><Ticket size={16} />Paper track</button></div>
              <p className="result-caveat">Research estimate only. No executable venue combo quote is available.</p><details className="result-details"><summary>Assumptions and warnings</summary><ul>{[...combo.assumptions, ...combo.warnings].map((warning, n) => <li key={n}>{warning}</li>)}</ul></details>
            </div> : result ? <Empty icon={FileSearch} title="No eligible combination found." copy={result.warnings[result.warnings.length - 1] ?? "Try more dates, sports, or fewer legs."} /> : <Empty icon={Ticket} title="The best available fit, for your criteria." copy="Generate to compare eligible combinations." />}
              {saveError && <div className="inline-alert error"><CircleAlert size={17} />{saveError}</div>}
              <div className="rank-method"><h3>How we rank</h3><div><b>01</b><span>Market-implied win probability</span></div><div><b>02</b><span>One leg per event</span></div><div><b>03</b><span>Verified market data</span></div></div>
            </section>
          </div>
          {result && result.combos.length > 1 && <section className="alternatives-section"><div className="section-heading"><h2>Alternative combinations</h2><span>Ranked by market-implied win probability</span></div><div className="alternative-list">{result.combos.map((item, n) => <button key={item.id} className={"alternative-item" + (comboIndex === n ? " active" : "")} onClick={() => setComboIndex(n)}><span>#{item.rank}</span><span>{item.legs.map((leg) => leg.selection + " — " + legEvent(leg, catalog?.games ?? [])).join(" · ")}</span><strong>{pct(item.probability)}</strong><ArrowRight size={17} /></button>)}</div></section>}
          {result?.warnings.length ? <div className="analysis-warning"><CircleAlert size={17} />{result.warnings.join(" ")}</div> : null}
          <MarketsPanel markets={markets} total={catalog?.markets.length ?? 0} search={search} setSearch={setSearch} limit={marketLimit} setLimit={setMarketLimit} loading={catalogBusy} error={catalogError} compact onRefresh={refresh} />
        </>}
        {view === "game-combos" && <>
          <Intro title="Pre-generated combos by game." copy="Browse matchup-by-matchup research candidates across every supported sport. Each slate is prepared from current, schedule-matched contracts." aside={catalog?.fetchedAt ? "Snapshot " + when(catalog.fetchedAt) : "Awaiting data"} />
          <div className="featured-toolbar panel">
            <div className="featured-date-fields"><label>From<input type="date" value={start} max={end} onChange={(event) => setStart(event.target.value)} /></label><label>Through<input type="date" value={end} min={start} onChange={(event) => setEnd(event.target.value)} /></label></div>
            <div className="venue-options" role="group" aria-label="Combo venue">{VENUES.map((item) => <button key={item.id} className={"select-chip venue-chip" + (venue === item.id ? " selected" : "")} aria-pressed={venue === item.id} onClick={() => setVenue(item.id)}>{item.label}</button>)}</div>
            <button className="secondary-button" onClick={() => { setFeaturedResults({}); setFeaturedError(""); setFeaturedLimit(24); refresh(); }} disabled={catalogBusy || featuredBusy}><RefreshCw size={15} className={featuredBusy ? "spin" : ""} /> Refresh slate</button>
          </div>
          <div className="featured-sports" role="group" aria-label="Choose sport">{SPORTS.map((sport) => <button key={sport} className={"select-chip" + (featuredSport === sport ? " selected" : "")} aria-pressed={featuredSport === sport} onClick={() => { setFeaturedSport(sport); setFeaturedLimit(24); setFeaturedError(""); }}>{sport}<span>{games.filter((game) => game.sport === sport).length}</span></button>)}</div>
          {venue === "polymarket-global" ? <section className="panel featured-empty"><Empty icon={Info} title="Choose a supported venue" copy="Global Polymarket markets are read-only. Pick Kalshi or Polymarket US to prepare and save game combos." /></section> : featuredError ? <div className="inline-alert error"><CircleAlert size={17} />{featuredError}</div> : catalogError ? <div className="inline-alert error"><CircleAlert size={17} />{catalogError}</div> : visibleFeaturedGames.length ? <>
            <div className="slate-heading"><div><h2>{featuredSport} matchup slate</h2><p>{Math.min(featuredLimit, featuredGames.length)} of {featuredGames.length} scheduled or live games · one candidate per game</p></div><span className="slate-target">2 legs · strongest available pair</span></div>
            <div className="game-combo-grid">{visibleFeaturedGames.map((game) => {
              const gameResult = featuredResults[featuredResultKey(game)];
              const item = gameResult?.combos[0];
              return <article className="panel game-combo-card" key={game.id}>
                <header className="game-combo-header"><div><span className="game-combo-time">{when(game.startsAt)}</span><h3>{game.title}</h3></div><span className="sport-square">{game.sport}</span></header>
                {featuredBusy && !gameResult ? <div className="game-combo-loading"><Activity size={17} className="spin" /> Preparing market matches…</div> : item ? <>
                  <div className="game-combo-metrics"><div><small>Market-implied combo chance</small><strong>{pct(item.probability)}</strong></div><div><small>Standalone asks</small><strong>{item.legs.map((leg) => cents(leg.entryPrice)).join(" + ")}</strong></div></div>
                  <div className="featured-combo-legs">{item.legs.map((leg) => <div key={leg.id} className={leg.gameId === game.id ? "anchor-leg" : "support-leg"}><span>{leg.selection}</span><small>{leg.gameId === game.id ? "This matchup" : legEvent(leg, catalog?.games ?? [])} · {venueName(leg.venue)} · {cents(leg.entryPrice)} standalone ask</small></div>)}</div>
                  <div className="game-combo-footer"><span>2 verified games · no combo quote</span><button className="secondary-button" onClick={() => saveCombo(item, "research")}><Bookmark size={15} /> Save</button></div>
                </> : gameResult ? <div className="game-combo-empty"><FileSearch size={18} /><div><strong>No qualifying candidate</strong><p>{gameResult.warnings.at(-1) || "No two-leg combination met the selected screen."}</p></div></div> : <div className="game-combo-loading"><Activity size={17} className="spin" /> Preparing market matches…</div>}
              </article>;
            })}</div>
            {featuredGames.length > featuredLimit && <div className="slate-more"><button className="secondary-button" onClick={() => setFeaturedLimit((limit) => Math.min(limit + 24, featuredGames.length))} disabled={featuredBusy}>Show next {Math.min(24, featuredGames.length - featuredLimit)} games <ArrowRight size={16} /></button></div>}
          </> : <section className="panel featured-empty"><Empty icon={CalendarDays} title={catalogBusy ? "Checking schedules" : "No upcoming games in this sport"} copy="Try another sport or widen the date range above." /></section>}
          <p className="featured-note">Each matchup is paired with the strongest available market from another scheduled or live game in the selected sport. If Kalshi has no eligible pair, Polymarket US is checked as a fallback. Leg venues are shown separately; these are research estimates, not calibrated forecasts or executable combo quotes.</p>
        </>}
        {view === "dashboard" && <>
          <Intro title="Sports market overview." copy="Real schedules, contract availability, and your latest research in one place." aside={when(new Date().toISOString(), false)} />
          <div className="metric-grid"><Metric label="Upcoming games" value={catalog ? String(games.length) : "—"} detail={catalog ? games.filter((game) => dateET(new Date(game.startsAt)) === today).length + " today" : "Waiting for schedule"} icon={CalendarDays} /><Metric label="Available markets" value={catalog ? String(catalog.markets.length) : "—"} detail={venueName(venue)} icon={Activity} /><Metric label="Connected sources" value={catalog ? catalog.sources.filter((source) => source.status === "connected").length + "/" + catalog.sources.length : "—"} detail={dataFresh ? "Current snapshot" : "Check source health"} icon={CircleCheck} /><Metric label="Saved research" value={String(saved.length)} detail={saved.filter((item) => item.status === "paper-open").length + " open paper records"} icon={Bookmark} /></div>
          <div className="dashboard-grid"><section className="panel dashboard-card"><div className="section-heading"><h2>Upcoming games</h2><button className="text-action" onClick={() => navigate("games")}>View all <ArrowRight size={14} /></button></div>{games.length ? <div className="simple-list">{games.slice(0, 6).map((game) => <button className="simple-row" key={game.id} onClick={() => { setSelectedGame(game.id); navigate("games"); }}><span className="sport-square">{game.sport.slice(0, 2)}</span><span><strong>{game.title}</strong><small>{game.sport} · {when(game.startsAt)}</small></span><ArrowRight size={17} /></button>)}</div> : <Empty icon={CalendarDays} title={catalogBusy ? "Loading schedules" : "No upcoming games found"} copy={catalogError || "Expand the date range or check source health."} />}</section><section className="panel dashboard-card"><div className="section-heading"><h2>Source status</h2><button className="text-action" onClick={() => navigate("health")}>Data health <ArrowRight size={14} /></button></div>{catalog?.sources.length ? <div className="source-mini-list">{catalog.sources.map((source) => <div className="source-mini" key={source.id}><span className={"status-dot " + source.status} /><span>{source.name}</span><small>{source.status}</small></div>)}</div> : <Empty icon={Activity} title="Sources are loading" copy={catalogError || "The catalog is checking available feeds."} />}</section></div>
          <section className="panel dashboard-card"><div className="section-heading"><h2>Current market snapshot</h2><button className="text-action" onClick={() => navigate("scanner")}>Open scanner <ArrowRight size={14} /></button></div><MarketRows markets={markets.slice(0, 5)} empty="No markets were returned for this scope." /></section>
          <div className="dashboard-action"><div><h2>Ready to build?</h2><p>Choose a payout target and find the strongest qualifying market-price combination.</p></div><button className="generate-button" onClick={() => navigate("generator")}>Open combo generator <ArrowRight size={18} /></button></div>
        </>}
        {view === "scanner" && <>
          <Intro title="Market scanner." copy="Search current contracts and inspect venue prices." aside={catalog?.fetchedAt ? "Fetched " + when(catalog.fetchedAt) : "Awaiting data"} />
          <section className="panel scanner-toolbar"><div className="scanner-toolbar-row"><div className="venue-options">{VENUES.map((item) => <button key={item.id} className={"select-chip venue-chip" + (venue === item.id ? " selected" : "")} onClick={() => setVenue(item.id)}>{item.label}</button>)}</div><label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search markets, teams, or keywords…" /></label></div><div className="scanner-toolbar-row"><div className="category-options"><button className={"small-chip" + (scannerCategory === "all" ? " selected" : "")} onClick={() => setScannerCategory("all")}>All types</button>{CATEGORIES.map((item) => <button key={item.id} className={"small-chip" + (scannerCategory === item.id ? " selected" : "")} onClick={() => setScannerCategory(item.id)}>{item.label}</button>)}</div><label className="sort-control"><ListFilter size={16} /><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="soonest">Soonest event</option><option value="probability">Highest implied probability</option><option value="volume">Most volume</option><option value="name">Market name</option></select></label></div></section>
          <MarketsPanel markets={markets} total={catalog?.markets.length ?? 0} search={search} setSearch={setSearch} limit={marketLimit} setLimit={setMarketLimit} loading={catalogBusy} error={catalogError} onRefresh={refresh} />
        </>}
        {view === "games" && <>
          <Intro title="Game analysis." copy="Verified schedules and the contracts matched to each game." aside={games.length + " upcoming"} />
          <div className="games-layout"><section className="panel game-list-panel"><div className="section-heading"><h2>Upcoming games</h2><span>{start} to {end}</span></div>{games.length ? <div className="game-list">{games.map((game) => <button key={game.id} className={"game-list-item" + (selectedGame === game.id ? " selected" : "")} onClick={() => setSelectedGame(game.id)}><span className="sport-square">{game.sport.slice(0, 2)}</span><span><strong>{game.title}</strong><small>{when(game.startsAt)} · {game.status}</small></span><ArrowRight size={17} /></button>)}</div> : <Empty icon={CalendarDays} title={catalogBusy ? "Checking schedules" : "No matching games"} copy={catalogError || "Change the dates or sports in the combo generator."} />}</section><GameDetail game={games.find((game) => game.id === selectedGame) ?? games[0]} markets={catalog?.markets ?? []} onUse={(id) => { setGameIds([id]); setFiltersOpen(true); navigate("generator"); }} /></div>
        </>}
        {view === "players" && <>
          <Intro title="Player research." copy="Explore verified player contracts when supported by the connected venue." aside={playerMarkets.length + " player markets"} />
          <section className="panel research-panel"><div className="section-heading"><h2>Available player props</h2><button className="text-action" onClick={() => navigate("scanner")}>Open scanner <ArrowRight size={14} /></button></div>{playerMarkets.length ? <MarketRows markets={playerMarkets.slice(0, 30)} empty="No player props were returned." /> : <Empty icon={UserRound} title={catalogBusy ? "Checking player markets" : "No verified player props in this scope"} copy="The connected feed has not returned player contracts. Expand your dates or change venue to check again." />}<p className="research-footnote"><Info size={16} />Player hit rates and projections require completed game logs; none are inferred from contract prices.</p></section>
        </>}
        {view === "saved" && <>
          <Intro title="Saved combos." copy="Keep research and paper outcomes together." aside={storageMode === "account" ? "Saved to your account" : storageMode === "browser" ? "Saved in this browser" : "Checking storage"} />
          {saveError && <div className="inline-alert error"><CircleAlert size={17} />{saveError}</div>}
          {saved.length ? <div className="saved-list">{saved.map((item) => <section className="panel saved-card" key={item.id}><div className="saved-header"><div><span className="result-kicker">{item.combo.legs.length} LEGS · SAVED {when(item.savedAt)}</span><h2>{pct(item.combo.probability)} estimated win probability</h2><p>Market-implied independence estimate · no executable quote</p></div><button className="icon-button" title="Remove saved combo" aria-label="Remove saved combo" onClick={() => removeSaved(item.id)}><X size={18} /></button></div><div className="saved-legs">{item.combo.legs.map((leg) => <div key={leg.id}><span className="sport-square">{leg.sport.slice(0, 2)}</span><span className="saved-leg-copy"><strong>{leg.selection}</strong><small>{legEvent(leg)}</small></span><strong>{pct(leg.probability)}</strong></div>)}</div><div className="saved-controls"><label><span>Status</span><select value={item.status} onChange={(event) => updateSaved(item.id, { status: event.target.value as SaveStatus })}><option value="research">Research</option><option value="paper-open">Paper · open</option><option value="paper-won">Paper · won</option><option value="paper-lost">Paper · lost</option></select></label><label><span>Paper stake</span><span className="saved-number">$<input type="number" min="0" step="0.01" value={item.stake} onChange={(event) => updateSaved(item.id, { stake: Number(event.target.value) || 0 })} /></span></label><label><span>Manual entry cost</span><span className="saved-number">$<input type="number" min="0" step="0.01" placeholder="Not entered" value={item.entryCost ?? ""} onChange={(event) => updateSaved(item.id, { entryCost: event.target.value === "" ? null : Number(event.target.value) })} /></span></label></div><p className="paper-note">Paper status is manually recorded. It is not a venue settlement or actual return.</p></section>)}</div> : <section className="panel"><Empty icon={Bookmark} title="No combos saved yet" copy="Generate a combination, then save it or add it to the paper tracker." action={<button className="secondary-button" onClick={() => navigate("generator")}>Open generator <ArrowRight size={16} /></button>} /></section>}
        </>}
        {view === "health" && <>
          <Intro title="Settings & data health." copy="See exactly which sources responded and when their data was fetched." aside={catalog?.fetchedAt ? "Snapshot " + when(catalog.fetchedAt) : "No snapshot"} />
          <div className="health-summary"><div><span>Market snapshot</span><strong>{catalog ? catalog.markets.length + " contracts" : "Unavailable"}</strong><small>{catalog?.fetchedAt ? when(catalog.fetchedAt) : catalogError || "Loading"}</small></div><div><span>Schedule</span><strong>{catalog ? catalog.games.length + " games" : "Unavailable"}</strong><small>{start} to {end}</small></div><div><span>Probability model</span><strong>Not connected</strong><small>Market-implied estimates only</small></div></div>
          <section className="panel health-panel"><div className="section-heading"><h2>Data sources</h2><button className="text-action" onClick={refresh}><RefreshCw size={14} /> Recheck</button></div>{catalog?.sources.length ? <div className="source-list">{catalog.sources.map((source) => <SourceRow source={source} key={source.id} />)}</div> : <Empty icon={Activity} title={catalogBusy ? "Checking sources" : "No source status available"} copy={catalogError || "Refresh to inspect source connectivity."} />}</section>
          <section className="panel health-panel"><div className="section-heading"><h2>Method and limitations</h2></div><div className="method-grid"><div><b>01</b><strong>Market-implied probabilities</strong><p>Contract prices are normalized into marginal probabilities. They are not calibrated sports forecasts.</p></div><div><b>02</b><strong>Payout-constrained ranking</strong><p>We screen by standalone asks, then rank qualifying distinct-game combinations by market-implied chance. The bucketed search is approximate.</p></div><div><b>03</b><strong>Research, not a quote</strong><p>Venue combo prices are unavailable here. A theoretical multiplier is not an executable payout or proof of positive value.</p></div></div>{catalog?.warnings.length ? <div className="health-warnings"><h3>Current feed warnings</h3>{catalog.warnings.map((warning, n) => <p key={n}><CircleAlert size={15} />{warning}</p>)}</div> : null}</section>
        </>}
        <footer className="page-footer">Probabilities are estimates. Analytical combinations require a venue quote.</footer>
      </main>
    </div>
    {notice && <div className="toast" role="status"><Check size={17} />{notice}</div>}
  </div>;
}

function Metric({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: LucideIcon }) {
  return <div className="panel metric"><div><span>{label}</span><Icon size={19} /></div><strong>{value}</strong><small>{detail}</small></div>;
}
function SourceRow({ source }: { source: SourceStatus }) {
  return <div className="source-row"><span className={"status-dot " + source.status} /><div><strong>{source.name}</strong><p>{source.message}</p><small>{source.error && <>{source.error} · </>}{source.fetchedAt ? "Fetched " + when(source.fetchedAt) : "No fetch time"} · {source.count} records{source.cached ? " · cached" : ""}</small></div><span className={"source-status " + source.status}>{source.status}</span></div>;
}
function GameDetail({ game, markets, onUse }: { game?: Game; markets: Market[]; onUse: (id: string) => void }) {
  if (!game) return <section className="panel game-detail-panel"><Empty icon={BarChart3} title="Select a game" copy="Game details appear when the schedule returns an upcoming matchup." /></section>;
  const matched = markets.filter((market) => market.gameId === game.id);
  return <section className="panel game-detail-panel"><span className="result-kicker">{game.sport} · {game.status.toUpperCase()}</span><h2>{game.title}</h2><p className="detail-subtitle">{when(game.startsAt)} · Source: {game.source.toUpperCase()}</p><div className="matchup"><div><span>AWAY</span><strong>{game.away.name}</strong></div><span>vs</span><div><span>HOME</span><strong>{game.home.name}</strong></div></div><div className="detail-stat-row"><span>Matched contracts</span><strong>{matched.length}</strong></div><div className="detail-stat-row"><span>Schedule fetched</span><strong>{when(game.fetchedAt)}</strong></div><h3>Related markets</h3>{matched.length ? <div className="related-markets">{matched.slice(0, 8).map((market) => <a key={market.venue + market.id} href={market.url} target="_blank" rel="noopener noreferrer"><span>{market.title}<small>{venueName(market.venue)} · {market.category}</small></span><ArrowUpRight size={16} /></a>)}</div> : <p className="muted-copy">No verified market has been matched to this schedule entry.</p>}<button className="secondary-button detail-action" onClick={() => onUse(game.id)}>Use this game in a combo <ArrowRight size={17} /></button><p className="muted-copy">Team statistics, injuries, and projections appear only when a verified source is connected.</p></section>;
}
function MarketRows({ markets, empty }: { markets: Market[]; empty: string }) {
  return markets.length ? <div className="market-table-wrap"><table className="market-table"><thead><tr><th>Market</th><th>Venue</th><th>Yes ask</th><th>No ask</th><th>Probability</th><th>Volume</th><th>Event</th><th></th></tr></thead><tbody>{markets.map((market) => <tr key={market.venue + ":" + market.id}><td><div className="market-name"><strong>{market.title}</strong><span>{market.sport} · {market.selection} · {market.category}</span></div></td><td>{venueName(market.venue)}</td><td>{cents(market.yesAsk)}</td><td>{cents(market.noAsk)}</td><td>{pct(market.probability)}</td><td>{compact(market.volume)}</td><td>{when(market.startsAt)}</td><td>{market.url ? <a href={market.url} target="_blank" rel="noopener noreferrer" aria-label={"Open " + market.title + " on " + venueName(market.venue)}><ArrowUpRight size={17} /></a> : "—"}</td></tr>)}</tbody></table></div> : <div className="table-empty"><FileSearch size={29} strokeWidth={1.5} /><strong>{empty}</strong></div>;
}
function MarketsPanel({ markets, total, search, setSearch, limit, setLimit, loading, error, compact: compactView, onRefresh }: {
  markets: Market[]; total: number; search: string; setSearch: (value: string) => void; limit: number;
  setLimit: (value: number) => void; loading: boolean; error: string; compact?: boolean; onRefresh: () => void;
}) {
  return <section className="panel markets-panel"><div className="markets-heading"><div><h2>Available markets</h2>{!compactView && <span>{markets.length} matching · {total} in snapshot</span>}</div>{compactView && <label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search markets, teams, or keywords…" aria-label="Search available markets" /></label>}</div>{error && <div className="inline-alert error"><CircleAlert size={17} />{error}<button onClick={onRefresh}>Retry</button></div>}{loading && !total ? <div className="table-empty"><RefreshCw size={25} className="spin" /><strong>Checking real market data…</strong></div> : <MarketRows markets={markets.slice(0, limit)} empty={search ? "No markets match your search." : "Refresh to discover real sports markets."} />}{markets.length > limit && <button className="show-more" onClick={() => setLimit(limit + 20)}>Show more markets <ChevronDown size={16} /></button>}{compactView && !total && !loading && !error && <p className="market-empty-caption">Use the controls above and click Generate combos to load available markets.</p>}</section>;
}
