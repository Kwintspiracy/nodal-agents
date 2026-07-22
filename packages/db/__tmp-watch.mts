import postgres from 'postgres';
const sql = postgres('postgres://nodalai:nodalai@127.0.0.1:25435/nodalai');
const seen = new Set<string>();
const start = Date.now();
console.log('Surveillance appels cogni_cortex (durée / issue) — H7 OK si <5s...');
while (Date.now() - start < 300000) {
  const tc =
    await sql`select t.id, t.tool_name, t.duration_ms, left(t.tool_output::text, 60) as out, t.created_at
    from tool_calls t where t.tool_name ilike '%cogni%' and t.created_at > now() - interval '8 minutes'
    order by t.created_at`;
  for (const r of tc) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const verdict =
      r.duration_ms >= 55000
        ? '❌ HANG 60s (H7 ÉCHOUE)'
        : r.duration_ms < 5000
          ? '✅ rapide (H7 OK)'
          : '⚠️ lent';
    console.log(
      `  [${r.created_at.toISOString().slice(11, 19)}] ${r.tool_name} : ${r.duration_ms}ms ${verdict} | ${r.out}`,
    );
  }
  // arrêt si la session Cortex est finie
  const running =
    await sql`select count(*) as n from agent_jobs where status='processing' and created_at > now() - interval '10 minutes'`;
  if (Number(running[0].n) === 0 && seen.size > 0) {
    console.log('(session Cortex terminée)');
    break;
  }
  await new Promise((r) => setTimeout(r, 4000));
}
console.log(`FIN surveillance — ${seen.size} appels cogni observés.`);
await sql.end();
