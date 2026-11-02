require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { neon } = require('@neondatabase/serverless');

const app = express();
const port = Number(process.env.PORT) || 3000;
const databaseUrl = process.env.DATABASE_URL;
const adminPassword = process.env.ADMIN_PASSWORD;
const sessions = new Map();
const SCHEDULE_TIME_ZONE = 'Europe/Amsterdam';
const DAY_MS = 24 * 60 * 60 * 1000;
const REGULAR_INTERVAL_DAYS = 14;
const INITIAL_CANDIDATES = [
	{ name: 'Jayden', party: 'PVDF' },
	{ name: 'Milan', party: 'MDM' },
	{ name: 'Sem', party: 'PZH' },
	{ name: 'Martijn', party: 'SVV' },
	{ name: 'Yairo', party: 'VOC' }
];
const INITIAL_PLAYERS = ['jayden', 'sem', 'milan', 'Jarno', 'raizo', 'yairo', 'dion', 'martijn', 'koen', 'laurens', 'tijs', 'elize'];

if (!databaseUrl) {
	console.error('DATABASE_URL ontbreekt. Zet je Neon connection string in .env.');
	process.exit(1);
}
if (!adminPassword) {
	console.error('ADMIN_PASSWORD ontbreekt. Stel een sterk beheerderswachtwoord in .env in.');
	process.exit(1);
}

const sql = neon(databaseUrl);
app.use(express.json({ limit: '100kb' }));
app.use(express.static(__dirname));

async function initializeDatabase() {
	await sql`CREATE TABLE IF NOT EXISTS elections (
		id SERIAL PRIMARY KEY,
		election_at TIMESTAMPTZ NOT NULL UNIQUE,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`;
	await sql`CREATE TABLE IF NOT EXISTS election_settings (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		first_election_at TIMESTAMPTZ NOT NULL
	)`;
	await sql`CREATE TABLE IF NOT EXISTS app_seeds (
		seed_key TEXT PRIMARY KEY,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`;
	await sql`INSERT INTO election_settings (id, first_election_at)
		VALUES (1, NOW() + INTERVAL '7 days') ON CONFLICT (id) DO NOTHING`;
	await sql`CREATE TABLE IF NOT EXISTS players (
		id SERIAL PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		active BOOLEAN NOT NULL DEFAULT TRUE
	)`;
	await sql`CREATE TABLE IF NOT EXISTS candidates (
		id SERIAL PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		party TEXT NOT NULL DEFAULT '',
		active BOOLEAN NOT NULL DEFAULT TRUE
	)`;
	await sql`CREATE TABLE IF NOT EXISTS votes (
		id SERIAL PRIMARY KEY,
		player_id INTEGER NOT NULL UNIQUE REFERENCES players(id),
		candidate_id INTEGER NOT NULL REFERENCES candidates(id),
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`;
	await sql`ALTER TABLE votes ADD COLUMN IF NOT EXISTS election_id INTEGER REFERENCES elections(id)`;
	await sql`INSERT INTO elections (election_at) VALUES ('1970-01-01T00:00:00Z') ON CONFLICT (election_at) DO NOTHING`;
	await sql`UPDATE votes SET election_id = (SELECT id FROM elections WHERE election_at = '1970-01-01T00:00:00Z') WHERE election_id IS NULL`;
	await sql`ALTER TABLE votes DROP CONSTRAINT IF EXISTS votes_player_id_key`;
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS votes_election_player_unique ON votes (election_id, player_id)`;
	const [scheduleSeed] = await sql`SELECT seed_key FROM app_seeds WHERE seed_key = 'first_ballot_schedule_v1'`;
	if (!scheduleSeed) {
		await sql`UPDATE election_settings SET first_election_at = '2026-11-02T18:00:00Z' WHERE id = 1`;
		await sql`INSERT INTO app_seeds (seed_key) VALUES ('first_ballot_schedule_v1') ON CONFLICT (seed_key) DO NOTHING`;
	}
	const [seed] = await sql`SELECT seed_key FROM app_seeds WHERE seed_key = 'initial_roster_v1'`;
	if (!seed) {
		for (const candidate of INITIAL_CANDIDATES) {
			await sql`INSERT INTO candidates (name, party) VALUES (${candidate.name}, ${candidate.party}) ON CONFLICT (name) DO NOTHING`;
		}
		for (const player of INITIAL_PLAYERS) {
			await sql`INSERT INTO players (name) VALUES (${player}) ON CONFLICT (name) DO NOTHING`;
		}
		await sql`INSERT INTO app_seeds (seed_key) VALUES ('initial_roster_v1') ON CONFLICT (seed_key) DO NOTHING`;
	}
}

function safeEqual(a, b) {
	const left = Buffer.from(String(a));
	const right = Buffer.from(String(b));
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAdmin(req, res, next) {
	const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
	const expiresAt = sessions.get(token);
	if (!expiresAt || expiresAt < Date.now()) {
		sessions.delete(token);
		return res.status(401).json({ error: 'Log opnieuw in als beheerder.' });
	}
	next();
}

const amsterdamDateTime = new Intl.DateTimeFormat('en-CA', {
	timeZone: SCHEDULE_TIME_ZONE,
	year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
	hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function zonedParts(date) {
	const values = Object.fromEntries(amsterdamDateTime.formatToParts(date).map(part => [part.type, part.value]));
	return {
		year: Number(values.year), month: Number(values.month), day: Number(values.day),
		weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday),
		hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second)
	};
}

function amsterdamDateTimeToUtc(year, month, day, hour, minute) {
	const target = Date.UTC(year, month - 1, day, hour, minute);
	let guess = target;
	for (let i = 0; i < 3; i += 1) {
		const parts = zonedParts(new Date(guess));
		const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
		guess += target - represented;
	}
	return new Date(guess);
}

function addCalendarDays({ year, month, day }, amount) {
	const date = new Date(Date.UTC(year, month - 1, day + amount));
	return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

async function saveElection(openAt, closesAt, announcementAt, type) {
	const [record] = await sql`INSERT INTO elections (election_at) VALUES (${announcementAt.toISOString()})
		ON CONFLICT (election_at) DO UPDATE SET election_at = EXCLUDED.election_at RETURNING id`;
	return { id: record.id, type, opensAt: openAt.toISOString(), closesAt: closesAt.toISOString(), announcementAt: announcementAt.toISOString(), electionAt: announcementAt.toISOString() };
}

async function getElectionContext() {
	const [settings] = await sql`SELECT first_election_at FROM election_settings WHERE id = 1`;
	const firstElectionAt = new Date(settings.first_election_at);
	const firstLocal = zonedParts(firstElectionAt);
	const firstEnd = new Date(firstElectionAt.getTime() + 60 * 60 * 1000);
	let daysUntilSaturday = (6 - firstLocal.weekday + 7) % 7;
	if (daysUntilSaturday === 0) daysUntilSaturday = 7;
	const firstRegularDate = addCalendarDays(firstLocal, daysUntilSaturday);
	const firstRegularAt = amsterdamDateTimeToUtc(firstRegularDate.year, firstRegularDate.month, firstRegularDate.day, 0, 0);
	const now = Date.now();
	let current;
	let next;

	if (now < firstRegularAt.getTime()) {
		current = await saveElection(firstElectionAt, firstEnd, firstEnd, 'special');
		current.phase = now < firstElectionAt.getTime() ? 'scheduled' : now < firstEnd.getTime() ? 'open' : 'closed';
		const regularCloseDate = addCalendarDays(firstRegularDate, 1);
		const regularClose = amsterdamDateTimeToUtc(regularCloseDate.year, regularCloseDate.month, regularCloseDate.day, 0, 0);
		const regularAnnouncement = amsterdamDateTimeToUtc(regularCloseDate.year, regularCloseDate.month, regularCloseDate.day, 20, 0);
		next = await saveElection(firstRegularAt, regularClose, regularAnnouncement, 'regular');
		next.phase = now < firstRegularAt.getTime() ? 'scheduled' : 'open';
		next.resultsVisible = now >= regularAnnouncement.getTime();
		current.resultsVisible = now >= firstEnd.getTime();
	} else {
		const nowLocal = zonedParts(new Date(now));
		const dayDifference = Math.floor((Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day) - Date.UTC(firstRegularDate.year, firstRegularDate.month - 1, firstRegularDate.day)) / DAY_MS);
		const cycle = Math.max(0, Math.floor(dayDifference / REGULAR_INTERVAL_DAYS));
		const regularDate = addCalendarDays(firstRegularDate, cycle * REGULAR_INTERVAL_DAYS);
		const opensAt = amsterdamDateTimeToUtc(regularDate.year, regularDate.month, regularDate.day, 0, 0);
		const closesDate = addCalendarDays(regularDate, 1);
		const closesAt = amsterdamDateTimeToUtc(closesDate.year, closesDate.month, closesDate.day, 0, 0);
		const announcementAt = amsterdamDateTimeToUtc(closesDate.year, closesDate.month, closesDate.day, 20, 0);
		current = await saveElection(opensAt, closesAt, announcementAt, 'regular');
		current.phase = now < opensAt.getTime() ? 'scheduled' : now < closesAt.getTime() ? 'open' : 'closed';
		current.resultsVisible = now >= announcementAt.getTime();
		const nextDate = addCalendarDays(regularDate, REGULAR_INTERVAL_DAYS);
		const nextCloseDate = addCalendarDays(nextDate, 1);
		const nextOpensAt = amsterdamDateTimeToUtc(nextDate.year, nextDate.month, nextDate.day, 0, 0);
		const nextClosesAt = amsterdamDateTimeToUtc(nextCloseDate.year, nextCloseDate.month, nextCloseDate.day, 0, 0);
		const nextAnnouncementAt = amsterdamDateTimeToUtc(nextCloseDate.year, nextCloseDate.month, nextCloseDate.day, 20, 0);
		next = await saveElection(nextOpensAt, nextClosesAt, nextAnnouncementAt, 'regular');
		next.phase = now < nextOpensAt.getTime() ? 'scheduled' : 'open';
		next.resultsVisible = now >= nextAnnouncementAt.getTime();
	}

	current.firstElectionAt = firstElectionAt.toISOString();
	if (current.phase === 'closed') current.nextElection = next;
	return current;
}

async function getResults(electionId) {
	return sql`SELECT c.id, c.name, c.party, COUNT(v.id)::int AS votes
		FROM candidates c
		LEFT JOIN votes v ON v.candidate_id = c.id AND v.election_id = ${electionId}
		WHERE c.active = TRUE OR v.id IS NOT NULL
		GROUP BY c.id
		ORDER BY votes DESC, c.name ASC`;
}

app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.get('/api/public', async (_req, res) => {
	try {
		const election = await getElectionContext();
		const resultsVisible = election.resultsVisible;
		const [players, candidates, results] = await Promise.all([
			sql`SELECT id, name FROM players WHERE active = TRUE ORDER BY name ASC`,
			sql`SELECT id, name, party FROM candidates WHERE active = TRUE ORDER BY name ASC`,
			resultsVisible ? getResults(election.id) : Promise.resolve([])
		]);
		const [totals] = resultsVisible ? await sql`SELECT COUNT(*)::int AS total FROM votes WHERE election_id = ${election.id}` : [{ total: 0 }];
		res.json({ players, candidates, results, total: totals.total, topThree: results.slice(0, 3), resultsVisible, election });
	} catch (error) {
		console.error('Publieke gegevens ophalen mislukt:', error);
		res.status(500).json({ error: 'De gegevens konden niet worden opgehaald.' });
	}
});

app.post('/api/vote', async (req, res) => {
	const { playerId, candidateId } = req.body || {};
	if (!Number.isInteger(Number(playerId)) || !Number.isInteger(Number(candidateId))) {
		return res.status(400).json({ error: 'Kies je naam en een kandidaat.' });
	}

	try {
		const election = await getElectionContext();
		if (election.phase !== 'open') return res.status(403).json({ error: election.phase === 'scheduled' ? 'De stemronde is nog niet geopend.' : 'Deze verkiezingsronde is gesloten.' });
		const player = Number(playerId);
		const candidate = Number(candidateId);
		const [existingVote] = await sql`SELECT id FROM votes WHERE player_id = ${player} AND election_id = ${election.id}`;
		if (existingVote) return res.status(409).json({ error: 'Met deze naam is al gestemd.' });

		const [eligible] = await sql`SELECT p.id AS player_id, c.id AS candidate_id
			FROM players p CROSS JOIN candidates c
			WHERE p.id = ${player} AND p.active = TRUE
				AND c.id = ${candidate} AND c.active = TRUE`;
		if (!eligible) return res.status(400).json({ error: 'Deze naam of kandidaat is niet beschikbaar.' });

		const inserted = await sql`INSERT INTO votes (player_id, candidate_id, election_id)
			VALUES (${player}, ${candidate}, ${election.id}) ON CONFLICT (election_id, player_id) DO NOTHING RETURNING id`;
		if (!inserted.length) return res.status(409).json({ error: 'Met deze naam is al gestemd.' });
		res.json({ message: 'Je stem is veilig opgeslagen. Bedankt!' });
	} catch (error) {
		console.error('Stem opslaan mislukt:', error);
		res.status(500).json({ error: 'Je stem kon niet worden opgeslagen. Probeer het opnieuw.' });
	}
});

app.post('/api/admin/login', (req, res) => {
	const password = req.body?.password;
	if (typeof password !== 'string' || !safeEqual(password, adminPassword)) {
		return res.status(401).json({ error: 'Onjuist wachtwoord.' });
	}
	const token = crypto.randomBytes(32).toString('hex');
	sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
	res.json({ token });
});

app.get('/api/admin/data', requireAdmin, async (_req, res) => {
	try {
		const election = await getElectionContext();
		const [players, candidates, results] = await Promise.all([
			sql`SELECT id, name, active FROM players ORDER BY name ASC`,
			sql`SELECT id, name, party, active FROM candidates ORDER BY name ASC`,
			getResults(election.id)
		]);
		const [totals] = await sql`SELECT COUNT(*)::int AS total FROM votes WHERE election_id = ${election.id}`;
		res.json({ players, candidates, results, total: totals.total, election });
	} catch (error) {
		console.error('Beheerdersgegevens ophalen mislukt:', error);
		res.status(500).json({ error: 'Beheerdersgegevens konden niet worden opgehaald.' });
	}
});

app.put('/api/admin/schedule', requireAdmin, async (req, res) => {
	const firstElectionAt = new Date(req.body?.firstElectionAt);
	if (!Number.isFinite(firstElectionAt.getTime()) || firstElectionAt.getTime() <= Date.now()) {
		return res.status(400).json({ error: 'Kies een datum en tijd in de toekomst.' });
	}
	try {
		await sql`UPDATE election_settings SET first_election_at = ${firstElectionAt.toISOString()} WHERE id = 1`;
		const election = await getElectionContext();
		res.json({ message: 'Verkiezingsschema voor om de week opgeslagen.', election });
	} catch (error) {
		console.error('Verkiezingsschema opslaan mislukt:', error);
		res.status(500).json({ error: 'Het verkiezingsschema kon niet worden opgeslagen.' });
	}
});

app.put('/api/admin/players', requireAdmin, async (req, res) => {
	const names = req.body?.names;
	if (!Array.isArray(names) || names.length > 500 || names.some(name => typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 32)) {
		return res.status(400).json({ error: 'Vul maximaal 500 geldige Minecraft-namen in.' });
	}
	try {
		await sql`UPDATE players SET active = FALSE`;
		for (const name of [...new Set(names.map(value => value.trim()))]) {
			await sql`INSERT INTO players (name, active) VALUES (${name}, TRUE)
				ON CONFLICT (name) DO UPDATE SET active = TRUE`;
		}
		res.json({ message: 'Spelerslijst opgeslagen.' });
	} catch (error) {
		console.error('Spelers opslaan mislukt:', error);
		res.status(500).json({ error: 'De spelerslijst kon niet worden opgeslagen.' });
	}
});

app.put('/api/admin/candidates', requireAdmin, async (req, res) => {
	const candidates = req.body?.candidates;
	if (!Array.isArray(candidates) || candidates.length > 100 || candidates.some(item =>
		!item || typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 60 ||
		typeof (item.party || '') !== 'string' || (item.party || '').trim().length > 60)) {
		return res.status(400).json({ error: 'Voeg maximaal 100 geldige kandidaten toe.' });
	}
	try {
		await sql`UPDATE candidates SET active = FALSE`;
		for (const item of candidates) {
			const name = item.name.trim();
			const party = (item.party || '').trim();
			await sql`INSERT INTO candidates (name, party, active) VALUES (${name}, ${party}, TRUE)
				ON CONFLICT (name) DO UPDATE SET party = EXCLUDED.party, active = TRUE`;
		}
		res.json({ message: 'Kandidaten opgeslagen.' });
	} catch (error) {
		console.error('Kandidaten opslaan mislukt:', error);
		res.status(500).json({ error: 'De kandidaten konden niet worden opgeslagen.' });
	}
});

app.get('/api/admin/results.csv', requireAdmin, async (_req, res) => {
	try {
		const election = await getElectionContext();
		const rows = await getResults(election.id);
		const csv = ['Kandidaat,Partij,Stemmen', ...rows.map(row =>
			[row.name, row.party, row.votes].map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')
		)].join('\r\n');
		res.type('text/csv').attachment('stemresultaten.csv').send(csv);
	} catch (error) {
		console.error('CSV export mislukt:', error);
		res.status(500).json({ error: 'Resultaten konden niet worden geëxporteerd.' });
	}
});

initializeDatabase()
	.then(() => app.listen(port, () => console.log(`Stemsite draait op http://localhost:${port}`)))
	.catch(error => {
		console.error('Database initialiseren mislukt:', error);
		process.exit(1);
	});
