import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** One row per finished multiplayer game. */
export const gameResult = sqliteTable('game_result', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	game: text('game').notNull(),
	players: integer('players').notNull(),
	/** Null when a game ends level. */
	winnerSeat: integer('winner_seat'),
	endedAt: integer('ended_at', { mode: 'timestamp_ms' }).notNull()
});
