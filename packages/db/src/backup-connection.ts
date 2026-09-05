// libpq reads PGDATABASE as a database name, not as a connection URI.
// Keep connection values in its documented environment fields, never argv.
const queryEnvironment: Readonly<Record<string, string>> = {
  host: "PGHOST", hostaddr: "PGHOSTADDR", port: "PGPORT", dbname: "PGDATABASE",
  user: "PGUSER", password: "PGPASSWORD", passfile: "PGPASSFILE", service: "PGSERVICE",
  options: "PGOPTIONS", application_name: "PGAPPNAME", connect_timeout: "PGCONNECT_TIMEOUT",
  client_encoding: "PGCLIENTENCODING", sslmode: "PGSSLMODE", requiressl: "PGREQUIRESSL",
  sslnegotiation: "PGSSLNEGOTIATION", sslcompression: "PGSSLCOMPRESSION",
  sslcert: "PGSSLCERT", sslkey: "PGSSLKEY", sslcertmode: "PGSSLCERTMODE",
  sslrootcert: "PGSSLROOTCERT", sslcrl: "PGSSLCRL", sslcrldir: "PGSSLCRLDIR",
  sslsni: "PGSSLSNI", ssl_min_protocol_version: "PGSSLMINPROTOCOLVERSION",
  ssl_max_protocol_version: "PGSSLMAXPROTOCOLVERSION", requirepeer: "PGREQUIREPEER",
  require_auth: "PGREQUIREAUTH", channel_binding: "PGCHANNELBINDING",
  gssencmode: "PGGSSENCMODE", krbsrvname: "PGKRBSRVNAME", gsslib: "PGGSSLIB",
  gssdelegation: "PGGSSDELEGATION", target_session_attrs: "PGTARGETSESSIONATTRS",
  load_balance_hosts: "PGLOADBALANCEHOSTS",
};

export function nativeBackupConnectionEnv(connectionString: string, connectTimeout: number): NodeJS.ProcessEnv {
  let url: URL;
  try {
    url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash) throw new Error();
  } catch {
    throw new Error("Native backup requires a valid PostgreSQL connection URL.");
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  const decode = (value: string) => {
    try { return decodeURIComponent(value); }
    catch { throw new Error("Native backup connection URL has invalid percent encoding."); }
  };
  if (url.hostname) env.PGHOST = decode(url.hostname.replace(/^\[|\]$/g, ""));
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decode(url.username);
  if (url.password) env.PGPASSWORD = decode(url.password);
  if (url.pathname.length > 1) env.PGDATABASE = decode(url.pathname.slice(1));
  for (const [key, value] of url.searchParams) {
    const name = queryEnvironment[key];
    if (!name) throw new Error("Native backup connection option has no supported libpq environment mapping.");
    env[name] = value;
  }
  env.PGCONNECT_TIMEOUT = String(connectTimeout);
  return env;
}
