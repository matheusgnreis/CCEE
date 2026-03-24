import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis } from "recharts";

export default function Home() {

  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("http://localhost:3000/inteligencia/SALITRE")
      .then(r => r.json())
      .then(setData)
      .catch(err => console.error(err));
  }, []);

  if (!data) return <div>Carregando...</div>;

  const chartData = (data.curva || []).map((v, i) => ({
    hora: i,
    consumo: v
  }));

  return (
    <div style={{ padding: 40 }}>
      <h1>{data.agente || "Sem nome"}</h1>

      <p>{data.insight}</p>

      <LineChart width={800} height={300} data={chartData}>
        <XAxis dataKey="hora" />
        <YAxis />
        <Line dataKey="consumo" />
      </LineChart>
    </div>
  );
}