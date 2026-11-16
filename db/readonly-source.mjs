// Validate the dedicated source role before reading production or changing development.
export async function assertReadOnlySource(client) {
  const { rows } = await client.query(`SELECT
    current_setting('default_transaction_read_only') = 'on' AS readonly,
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication)) AS privileged,
    has_database_privilege(current_database(), 'CREATE') OR
    EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
      AND has_schema_privilege(oid, 'CREATE')) OR
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')
      AND (has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(c.oid, 'INSERT,UPDATE,REFERENCES'))) AS writable`);
  const role = rows[0];
  if (!role || role.readonly !== true || role.privileged !== false || role.writable !== false) {
    throw new Error('Production source must use a dedicated read-only role with default_transaction_read_only=on and no write/admin privileges');
  }
}
