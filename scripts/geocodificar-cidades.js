// scripts/geocodificar-cidades.js
// Geocodifica todas as cidades de ccee_cargas usando Nominatim (OpenStreetMap)
// e salva lat/lon em ccee_cidades_geo.
//
// Regras Nominatim: máx 1 req/s, User-Agent obrigatório
//
// Uso:
//   node scripts/geocodificar-cidades.js          # geocodifica só as novas
//   node scripts/geocodificar-cidades.js --force  # re-geocodifica todas

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const fetch = require("node-fetch");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const DELAY_MS  = 1100;
const USER_AGENT = "CCEEMonitor/1.0 (github.com/matheusgnreis/CCEE)";
const FORCE      = process.argv.includes("--force");

const UF_NOME = {
  AC:"Acre",AM:"Amazonas",AP:"Amapá",PA:"Pará",RO:"Rondônia",RR:"Roraima",TO:"Tocantins",
  AL:"Alagoas",BA:"Bahia",CE:"Ceará",MA:"Maranhão",PB:"Paraíba",PE:"Pernambuco",
  PI:"Piauí",RN:"Rio Grande do Norte",SE:"Sergipe",
  DF:"Distrito Federal",GO:"Goiás",MT:"Mato Grosso",MS:"Mato Grosso do Sul",
  ES:"Espírito Santo",MG:"Minas Gerais",RJ:"Rio de Janeiro",SP:"São Paulo",
  PR:"Paraná",RS:"Rio Grande do Sul",SC:"Santa Catarina",
};

const delay = ms => new Promise(r => setTimeout(r, ms));

async function geocodar(cidade, estadoUf) {
  const estado = UF_NOME[estadoUf] || estadoUf;
  const q      = `${cidade}, ${estado}, Brasil`;
  const url    = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=br`;

  try {
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    const data = await resp.json();
    if (data.length) return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
    return null;
  } catch {
    return null;
  }
}

async function main() {
  // Garante que a tabela existe
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ccee_cidades_geo (
      cidade    TEXT    NOT NULL,
      estado_uf CHAR(2) NOT NULL,
      lat       DOUBLE PRECISION,
      lon       DOUBLE PRECISION,
      geocoded_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (cidade, estado_uf)
    )
  `);

  // Cidades a geocodificar
  let query;
  if (FORCE) {
    query = `
      SELECT DISTINCT cidade, estado_uf
      FROM ccee_cargas
      WHERE cidade IS NOT NULL AND estado_uf IS NOT NULL
      ORDER BY estado_uf, cidade
    `;
  } else {
    query = `
      SELECT DISTINCT c.cidade, c.estado_uf
      FROM ccee_cargas c
      LEFT JOIN ccee_cidades_geo g ON g.cidade = c.cidade AND g.estado_uf = c.estado_uf
      WHERE c.cidade IS NOT NULL AND c.estado_uf IS NOT NULL
        AND g.cidade IS NULL
      ORDER BY c.estado_uf, c.cidade
    `;
  }

  const { rows } = await pool.query(query);
  console.log(`\n${rows.length} cidades para geocodificar${FORCE ? " (--force)" : " (novas)"}\n`);

  if (!rows.length) {
    console.log("Nenhuma cidade nova. Use --force para re-geocodificar.");
    await pool.end();
    return;
  }

  let ok = 0, falhou = 0;

  for (let i = 0; i < rows.length; i++) {
    const { cidade, estado_uf } = rows[i];
    process.stdout.write(`[${String(i + 1).padStart(4)}/${rows.length}] ${estado_uf} / ${cidade.padEnd(40)} `);

    const geo = await geocodar(cidade, estado_uf);

    if (geo) {
      await pool.query(`
        INSERT INTO ccee_cidades_geo (cidade, estado_uf, lat, lon, geocoded_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (cidade, estado_uf) DO UPDATE
          SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, geocoded_at = NOW()
      `, [cidade, estado_uf, geo.lat, geo.lon]);
      console.log(`✅  ${geo.lat.toFixed(4)}, ${geo.lon.toFixed(4)}`);
      ok++;
    } else {
      console.log("⚠  não encontrada");
      falhou++;
    }

    if (i < rows.length - 1) await delay(DELAY_MS);
  }

  const { rows: total } = await pool.query("SELECT COUNT(*) FROM ccee_cidades_geo WHERE lat IS NOT NULL");
  console.log(`\n✅ ${ok} geocodificadas | ⚠ ${falhou} falhou | Total no banco: ${total[0].count}`);
  await pool.end();
}

main().catch(async e => { console.error(e.message); await pool.end(); process.exit(1); });
