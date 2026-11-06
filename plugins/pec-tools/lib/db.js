import Database from "better-sqlite3";
let db = null;
function dbPath() {
  return process.env.PEC_DB_PATH || "./db/pec.db";
}
function openDb(path = dbPath()) {
  if (!db) db = new Database(path, { readonly: true, fileMustExist: true });
  return db;
}
function resetDb() {
  if (db) db.close();
  db = null;
}
function all(sql, params = []) {
  return openDb().prepare(sql).all(...params);
}
function one(sql, params = []) {
  return openDb().prepare(sql).get(...params);
}
export {
  all,
  dbPath,
  one,
  openDb,
  resetDb
};
//# sourceMappingURL=db.js.map
