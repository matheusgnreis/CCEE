import { useEffect } from "react";
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";

// Fix ícone padrão quebrado no Next.js
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

function FitBounds({ bounds }) {
  const map = useMap();
  useEffect(() => {
    if (bounds?.length) map.fitBounds(bounds, { padding: [40, 40] });
  }, [JSON.stringify(bounds)]);
  return null;
}

export default function MapaRota({ rotaGeojson, origem, destino, cidadesMapa }) {
  if (!rotaGeojson || !origem || !destino) return null;

  // OSRM retorna [lon, lat]; Leaflet usa [lat, lon]
  const polyline = rotaGeojson.coordinates.map(([lon, lat]) => [lat, lon]);

  const bounds = [
    [origem.lat, origem.lon],
    [destino.lat, destino.lon],
    ...polyline,
  ];

  return (
    <MapContainer
      center={[origem.lat, origem.lon]}
      zoom={7}
      style={{ height: 420, width: "100%", borderRadius: 10, zIndex: 0 }}
      scrollWheelZoom
    >
      <FitBounds bounds={bounds} />

      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors'
      />

      {/* Rota */}
      <Polyline
        positions={polyline}
        pathOptions={{ color: "#2563eb", weight: 4, opacity: 0.85 }}
      />

      {/* Cidades no raio */}
      {cidadesMapa?.map(c => (
        <CircleMarker
          key={`${c.cidade}|${c.estado_uf}`}
          center={[c.lat, c.lon]}
          radius={c.nAgentes > 0 ? Math.min(6 + c.nAgentes * 2, 20) : 5}
          pathOptions={{
            color:       c.nAgentes > 0 ? "#d97706" : "#94a3b8",
            fillColor:   c.nAgentes > 0 ? "#f59e0b" : "#cbd5e1",
            fillOpacity: 0.85,
            weight:      1.5,
          }}
        >
          <Tooltip>
            <span style={{ fontWeight: 700 }}>{c.cidade} ({c.estado_uf})</span><br />
            {c.nAgentes > 0
              ? <span style={{ color: "#d97706" }}>{c.nAgentes} agente{c.nAgentes > 1 ? "s" : ""}</span>
              : <span style={{ color: "#94a3b8" }}>Sem agentes no filtro</span>
            }<br />
            <span style={{ color: "#64748b" }}>Dist. rota: {c.distKm} km</span>
          </Tooltip>
        </CircleMarker>
      ))}

      {/* Origem */}
      <CircleMarker
        center={[origem.lat, origem.lon]}
        radius={11}
        pathOptions={{ color: "#15803d", fillColor: "#16a34a", fillOpacity: 1, weight: 2 }}
      >
        <Tooltip permanent direction="top" offset={[0, -8]}>
          <span style={{ fontWeight: 700 }}>Origem</span>
        </Tooltip>
      </CircleMarker>

      {/* Destino */}
      <CircleMarker
        center={[destino.lat, destino.lon]}
        radius={11}
        pathOptions={{ color: "#b91c1c", fillColor: "#dc2626", fillOpacity: 1, weight: 2 }}
      >
        <Tooltip permanent direction="top" offset={[0, -8]}>
          <span style={{ fontWeight: 700 }}>Destino</span>
        </Tooltip>
      </CircleMarker>
    </MapContainer>
  );
}
