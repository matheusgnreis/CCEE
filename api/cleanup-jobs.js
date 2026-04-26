// api/cleanup-jobs.js
// Corrige jobs que ficaram presos em 'running' após reinício do servidor.
// Chamado automaticamente no startup e pode ser chamado manualmente via
// POST /admin/cleanup-jobs.

async function limparJobsTravados(pool) {
  const r = await pool.query(`
    UPDATE ccee_jobs
    SET
      status     = 'error',
      erro       = 'Interrompido por reinício do servidor',
      updated_at = NOW()
    WHERE status IN ('running', 'pending')
      AND updated_at < NOW() - INTERVAL '10 minutes'
    RETURNING id, agente, mes, status, updated_at
  `);

  if (r.rows.length > 0) {
    console.warn(`[cleanup-jobs] ${r.rows.length} job(s) travado(s) marcado(s) como erro:`);
    r.rows.forEach(j =>
      console.warn(`  → ${j.id} | ${j.agente} ${j.mes} | travado desde ${j.updated_at}`)
    );
  } else {
    console.log("[cleanup-jobs] Nenhum job travado encontrado.");
  }

  return r.rows;
}

module.exports = { limparJobsTravados };
