import Database from 'better-sqlite3'

let db: Database.Database | null = null

export function dbPath(): string {
  return process.env.PEC_DB_PATH || './db/pec.db'
}

export function openDb(path = dbPath()): Database.Database {
  if (!db) db = new Database(path, { readonly: true, fileMustExist: true })
  return db
}

/** 测试/评测用：切换数据文件。 */
export function resetDb(): void {
  if (db) db.close()
  db = null
}

/** 只读查询，统一返回行数组 */
export function all<T = unknown>(sql: string, params: unknown[] = []): T[] {
  return openDb().prepare(sql).all(...params) as T[]
}

export function one<T = unknown>(sql: string, params: unknown[] = []): T | undefined {
  return openDb().prepare(sql).get(...params) as T | undefined
}
