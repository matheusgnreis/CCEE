/** @type {import('next').NextConfig} */
const nextConfig = {
  // Vercel não precisa de output: "export" — rotas dinâmicas funcionam nativamente.
  // Se um dia quiser GitHub Pages (static), adicione output: "export" aqui e
  // troque [agente].js por query params (?agente=NOME).
  images: { unoptimized: true },
};

module.exports = nextConfig;
