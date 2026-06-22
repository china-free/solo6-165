declare module 'sql.js' {
  interface SqlJsStatic {
    Database: new (data: ArrayLike<number>) => Database;
  }
  interface Database {
    exec(sql: string): QueryExecResult[];
    close(): void;
  }
  interface QueryExecResult {
    columns: string[];
    values: any[][];
  }
  export default function initSqlJs(): Promise<SqlJsStatic>;
}
