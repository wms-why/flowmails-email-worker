import app from '../hono/hono';
import result from '../utils/result';
import emailService from '../service/email-service';

app.get('/email/junkList', async (c) => {
	// Junk mailbox list. Same shape as `/email/list` (page +
	// total), same repeated `to=` localpart-narrowing contract.
	// The worker filters on `to_domain = ?` since junk rows are
	// always inbound.
	const params = c.req.query();
	const to = c.req.queries('to');
	const data = await emailService.listJunk(c, { ...params, to });
	return c.json(result.ok(data));
});

app.post('/email/junkRestore', async (c) => {
	// User clicked "Not junk" on a junk row. Worker drops the
	// junk row and inserts a fresh row in `email` with the
	// spam fields stripped. Returns the new email row id so
	// the UI can jump the user to it.
	const body = await c.req.json();
	const data = await emailService.restoreFromJunk(c, body);
	return c.json(result.ok(data));
});

app.delete('/email/junkDelete', async (c) => {
	// Hard-delete one or more junk rows by id. Same
	// comma-separated / repeated-param tolerance as
	// `/email/delete`.
	await emailService.deleteJunk(c, c.req.query());
	return c.json(result.ok());
});

app.post('/email/countJunk', async (c) => {
	// Per-domain unread-junk totals for the Junk-tab badge.
	// Mirrors `/email/countUnread`'s shape.
	const { domains } = await c.req.json();
	const data = await emailService.countJunkByDomains(c, domains);
	return c.json(result.ok(data));
});
