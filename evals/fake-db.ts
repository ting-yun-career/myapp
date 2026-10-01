import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

const SCHEMA = readFileSync(resolve(import.meta.dirname, '../schema/db-schema-setup.sql'), 'utf8')

export type FakeDb = {
  // Drop-in for the worker's D1 binding.
  d1: D1Database
  // Direct access for seeding and for reading the trace back.
  sqlite: DatabaseSync
  // Make every statement whose SQL matches throw, like a D1 outage. Pass null to clear.
  failWhen: (matcher: RegExp | null) => void
}

type Row = Record<string, unknown>

// An in-memory SQLite database built from the real schema file, wrapped in the small part of the
// D1 API the worker uses (prepare/bind/run/all/first and batch). Nothing here can reach a real
// database: there is no D1 binding in the eval environment.
export function createFakeDb(): FakeDb {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA)

  let failing: RegExp | null = null

  const statement = (sql: string, params: SQLInputValue[]) => {
    const guard = () => {
      if (failing?.test(sql)) throw new Error('injected-fault: simulated D1 failure')
    }
    return {
      bind: (...values: SQLInputValue[]) => statement(sql, values),
      run: async () => {
        guard()
        sqlite.prepare(sql).run(...params)
        return { success: true, meta: {} }
      },
      all: async <T = Row>() => {
        guard()
        return { results: sqlite.prepare(sql).all(...params) as T[], success: true, meta: {} }
      },
      first: async <T = Row>() => {
        guard()
        return (sqlite.prepare(sql).get(...params) as T | undefined) ?? null
      },
    }
  }

  const d1 = {
    prepare: (sql: string) => statement(sql, []),
    // D1 runs a batch as one transaction.
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const entry of statements) results.push(await entry.run())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database

  return { d1, sqlite, failWhen: (matcher) => (failing = matcher) }
}

export function seedAppointment(db: FakeDb, appointment: { startAtUtc: string; endAtUtc: string; timezone: string }) {
  db.sqlite
    .prepare(`INSERT INTO appointments (id, status, start_at_utc, end_at_utc, timezone, name, email, meeting_contact, notes, created_at) VALUES (?, 'confirmed', ?, ?, ?, 'Eval Seed', 'seed@example.invalid', 'n/a', NULL, ?)`)
    .run(crypto.randomUUID(), appointment.startAtUtc, appointment.endAtUtc, appointment.timezone, new Date().toISOString())
}
